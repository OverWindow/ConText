import Fastify, {type FastifyInstance, type FastifyRequest} from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { ContractError, validateBlob, validateCommand, type CommandEnvelope, type DocumentVersion, type SourceSnapshot } from '@context/contracts';
import { Authenticator, type Actor } from './auth.ts';
import type { ServerConfig } from './config.ts';
import { Database } from './database.ts';
import { ApiError, assert, pageLimit, record, uuid } from './errors.ts';
import { WorkspaceStore } from './store.ts';
import { BlobStorage, type StoredBlob } from './storage.ts';
import { ProcessingService } from './processing.ts';
import {searchEvidence} from './search.ts';

declare module 'fastify' {interface FastifyRequest {actor:Actor}}
function params(request:FastifyRequest) {return request.params as Record<string,string>;}
function query(request:FastifyRequest) {return request.query as Record<string,string|undefined>;}
function cursorEncode(v:Record<string,unknown>) {return Buffer.from(JSON.stringify(v)).toString('base64url');}
function cursorDecode(value:string|undefined,context:string) {
  if(!value)return undefined;
  try {const result=record(JSON.parse(Buffer.from(value,'base64url').toString()));assert(result.context===context&&typeof result.name==='string'&&typeof result.id==='string','INVALID_CURSOR','Cursor belongs to another query');uuid(result.id);return result as {name:string;id:string};}
  catch {throw new ApiError(422,'INVALID_CURSOR','Invalid page cursor');}
}
export interface ServerServices {app:FastifyInstance;db:Database;store:WorkspaceStore;storage:BlobStorage;processing:ProcessingService;}
export async function createServer(config:ServerConfig,options:{migrate?:boolean;worker?:boolean;logger?:boolean}={}):Promise<ServerServices> {
  const db=new Database(config.databaseUrl);
  if(options.migrate!==false)await db.migrate();
  const store=new WorkspaceStore(db),storage=new BlobStorage(config),auth=new Authenticator(config,db),processing=new ProcessingService(db,store,storage,config);
  const app=Fastify({logger:options.logger?{redact:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie']}:false,bodyLimit:8*1024*1024,requestTimeout:180000});
  const eventStreams=new Set<()=>void>();
  app.addHook('preClose',async()=>{for(const close of eventStreams)close();});
  await app.register(cors,{origin:config.corsOrigins,credentials:false,allowedHeaders:['Authorization','Content-Type'],methods:['GET','POST','PUT','DELETE','OPTIONS']});
  app.decorateRequest('actor');
  app.addHook('preHandler',async request=>{
    if(request.url.startsWith('/v2/'))request.actor=await auth.authenticate(request.headers.authorization);
  });
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof ApiError)return reply.status(error.statusCode).send({error:{code:error.code,message:error.message}});
    if(error instanceof ContractError)return reply.status(422).send({error:{code:'INVALID_COMMAND',message:error.message}});
    const typed=error as {code?:string;statusCode?:number};
    if(typed.code==='23505')return reply.status(409).send({error:{code:'NAME_OR_ID_CONFLICT',message:'An entry name or identifier is already in use'}});
    if(typed.statusCode&&typed.statusCode<500)return reply.status(typed.statusCode).send({error:{code:'INVALID_REQUEST',message:error instanceof Error?error.message:'Invalid request'}});
    request.log.error({code:typed.code||(error instanceof Error?error.name:'UNKNOWN')},'Unified workspace request failed');
    return reply.status(503).send({error:{code:'SERVICE_UNAVAILABLE',message:'Workspace service is unavailable'}});
  });
  app.get('/health',async()=>{await db.pool.query('SELECT 1');return {status:'ok',protocol:2};});
  app.get('/v2/me',async request=>request.actor);
  app.get('/v2/workspaces',async request=>{
    const result=await db.pool.query('SELECT w.metadata,m.role,w.cursor FROM unified.workspaces w JOIN unified.workspace_members m ON w.id=m.workspace_id WHERE m.user_id=$1 AND w.deleted_at IS NULL ORDER BY w.created_at,w.id',[request.actor.id]);
    return {workspaces:result.rows.map(r=>({...r.metadata,role:r.role,cursor:Number(r.cursor)}))};
  });
  app.post('/v2/workspaces',async(request,reply)=>{
    const body=record(request.body);assert(typeof body.name==='string','INVALID_NAME','Workspace name is required');
    const workspace=await store.create(request.actor,{id:body.id as string|undefined,name:body.name,root_entry_id:body.root_entry_id as string|undefined});
    return reply.status(201).send({workspace});
  });
  app.get('/v2/workspaces/:id/bootstrap',async request=>{
    const id=uuid(params(request).id);
    return db.transaction(async client=>{const row=await store.member(client,id,request.actor,false,true);const state=await store.state(client,row);return {workspace:row.metadata,state,cursor:Number(row.cursor),epoch:Number(row.epoch),role:row.role};},'REPEATABLE READ');
  });
  app.post('/v2/workspaces/:id/devices',async request=>{const body=record(request.body);return {binding:await store.bind(request.actor,uuid(params(request).id),{device_id:String(body.device_id||''),name:typeof body.name==='string'?body.name:undefined,platform:typeof body.platform==='string'?body.platform:undefined})};});
  app.get('/v2/workspaces/:id/devices',async request=>db.transaction(async client=>{const id=uuid(params(request).id);await store.member(client,id,request.actor);const rows=(await client.query('SELECT device_id,user_id,name,platform,epoch,ack_cursor,revoked_at,last_seen_at FROM unified.device_bindings WHERE workspace_id=$1 ORDER BY created_at',[id])).rows;return {devices:rows.map(r=>({...r,epoch:Number(r.epoch),ack_cursor:Number(r.ack_cursor)}))};}));
  app.post('/v2/workspaces/:id/devices/:deviceId/ack',async request=>db.transaction(async client=>{
    const id=uuid(params(request).id),deviceId=uuid(params(request).deviceId);const row=await store.member(client,id,request.actor,true);await store.device(client,row,request.actor,deviceId);const body=record(request.body);const cursor=Number(body.cursor);
    assert(Number.isSafeInteger(cursor)&&cursor>=0&&cursor<=Number(row.cursor),'INVALID_CURSOR','ACK cursor is beyond the committed change stream');
    const binding=(await client.query('UPDATE unified.device_bindings SET ack_cursor=GREATEST(ack_cursor,$3),last_seen_at=now() WHERE workspace_id=$1 AND device_id=$2 RETURNING ack_cursor',[id,deviceId,cursor])).rows[0];return {cursor:Number(binding.ack_cursor),epoch:Number(row.epoch)};
  }));
  app.delete('/v2/workspaces/:id/devices/:deviceId',async request=>db.transaction(async client=>{
    const id=uuid(params(request).id),deviceId=uuid(params(request).deviceId);const row=await store.member(client,id,request.actor,true,true);
    const binding=(await client.query('SELECT * FROM unified.device_bindings WHERE workspace_id=$1 AND device_id=$2',[id,deviceId])).rows[0];assert(binding&&(binding.user_id===request.actor.id||row.role==='OWNER'),'DEVICE_NOT_FOUND','Device not found',404);
    await client.query('UPDATE unified.device_bindings SET revoked_at=COALESCE(revoked_at,now()) WHERE workspace_id=$1 AND device_id=$2',[id,deviceId]);return {detached:true};
  }));
  app.post('/v2/workspaces/:id/commands',async request=>{
    const body=record(request.body);assert(Array.isArray(body.commands)&&body.commands.length>0&&body.commands.length<=200,'INVALID_BATCH','Submit 1–200 named commands');
    return store.execute(request.actor,uuid(params(request).id),body.commands.map(validateCommand));
  });
  app.post('/v2/workspaces/:id/import',{bodyLimit:128*1024*1024},async request=>{
    const command=validateCommand(request.body);assert(command.type==='ImportWorkspace','INVALID_IMPORT','Use the named ImportWorkspace command');
    return store.execute(request.actor,uuid(params(request).id),[command]);
  });
  app.delete('/v2/workspaces/:id',async request=>{
    const id=uuid(params(request).id),body=record(request.body);const command=validateCommand({schema_version:2,operation_id:body.operation_id||randomUUID(),workspace_id:id,device_id:body.device_id,workspace_epoch:body.workspace_epoch,type:'DeleteWorkspace',payload:{},base_revisions:body.base_revisions});
    return store.execute(request.actor,id,[command]);
  });
  app.get('/v2/workspaces/:id/changes',async request=>db.transaction(async client=>{
    const id=uuid(params(request).id),q=query(request);const row=await store.member(client,id,request.actor,false,true);const after=Number(q.after||0),limit=pageLimit(q.limit);
    assert(Number.isSafeInteger(after)&&after>=0&&after<=Number(row.cursor),'INVALID_CURSOR','Change cursor is beyond the committed stream',409);
    const rows=(await client.query('SELECT sequence,operation_id,epoch,changes,created_at FROM unified.workspace_changes WHERE workspace_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',[id,after,limit+1])).rows;
    const changes=rows.slice(0,limit).map(r=>({...r,sequence:Number(r.sequence),epoch:Number(r.epoch)}));
    return {changes,cursor:changes.length?changes.at(-1)!.sequence:after,has_more:rows.length>limit,epoch:Number(row.epoch),deleted_at:row.deleted_at};
  },'REPEATABLE READ'));
  app.get('/v2/workspaces/:id/entries',async request=>db.transaction(async client=>{
    const id=uuid(params(request).id),q=query(request),row=await store.member(client,id,request.actor),parent=q.parent_id?uuid(q.parent_id):row.metadata.root_entry_id,limit=pageLimit(q.limit);const cursor=cursorDecode(q.cursor,`parent:${parent}`);
    const rows=(await client.query(`SELECT id,name_key,payload FROM unified.entities WHERE workspace_id=$1 AND collection='entries' AND parent_id=$2 AND NOT deleted ${cursor?'AND (name_key,id)>($4,$5)':''} ORDER BY name_key,id LIMIT $3`,cursor?[id,parent,limit+1,cursor.name,cursor.id]:[id,parent,limit+1])).rows;
    const page=rows.slice(0,limit),last=page.at(-1);return {entries:page.map(r=>r.payload),has_more:rows.length>limit,next_cursor:rows.length>limit&&last?cursorEncode({context:`parent:${parent}`,name:last.name_key,id:last.id}):null,workspace_cursor:Number(row.cursor)};
  }));
  app.get('/v2/workspaces/:id/search',async request=>db.transaction(async client=>{
    const id=uuid(params(request).id),q=query(request);await store.member(client,id,request.actor);const needle=(q.q||'').normalize('NFC').toLocaleLowerCase('en-US');assert(needle.length>0&&needle.length<=300,'INVALID_QUERY','Search query must contain 1–300 characters');const limit=pageLimit(q.limit),cursor=cursorDecode(q.cursor,`search:${needle}`);
    const rows=(await client.query(`SELECT id,name_key,payload FROM unified.entities WHERE workspace_id=$1 AND collection='entries' AND NOT deleted AND position($2 IN lower(name_key))>0 ${cursor?'AND (name_key,id)>($4,$5)':''} ORDER BY name_key,id LIMIT $3`,cursor?[id,needle,limit+1,cursor.name,cursor.id]:[id,needle,limit+1])).rows;const page=rows.slice(0,limit),last=page.at(-1);return {entries:page.map(r=>r.payload),has_more:rows.length>limit,next_cursor:rows.length>limit&&last?cursorEncode({context:`search:${needle}`,name:last.name_key,id:last.id}):null};
  }));
  app.get('/v2/workspaces/:id/conflicts',async request=>db.transaction(async client=>{const id=uuid(params(request).id);await store.member(client,id,request.actor);return {conflicts:(await client.query("SELECT payload FROM unified.entities WHERE workspace_id=$1 AND collection='conflicts' AND payload->>'status'='open' ORDER BY id",[id])).rows.map(r=>r.payload)};}));
  app.post('/v2/workspaces/:id/conflicts/:conflictId/resolve',async request=>{const id=uuid(params(request).id),body=record(request.body);return store.execute(request.actor,id,[validateCommand({schema_version:2,operation_id:body.operation_id||randomUUID(),workspace_id:id,device_id:body.device_id,workspace_epoch:body.workspace_epoch,type:'ResolveConflict',base_revisions:body.base_revisions,payload:{id:uuid(params(request).conflictId),resolution:body.resolution,...(body.merged_content!==undefined?{merged_content:body.merged_content}:{})}})]);});
  app.put('/v2/workspaces/:id/members',async request=>db.transaction(async client=>{const id=uuid(params(request).id),row=await store.member(client,id,request.actor,true);assert(row.role==='OWNER','FORBIDDEN','Owner permission is required',403);const body=record(request.body);assert(typeof body.email==='string'&&['EDITOR','VIEWER'].includes(String(body.role)),'INVALID_MEMBER','Provide an account email and EDITOR or VIEWER role');const user=(await client.query('SELECT id FROM unified.users WHERE lower(email)=lower($1)',[body.email])).rows[0];assert(user&&user.id!==request.actor.id,'MEMBER_NOT_FOUND','Ask the user to sign in before adding them',404);await client.query('INSERT INTO unified.workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=EXCLUDED.role',[id,user.id,body.role]);return {user_id:user.id,role:body.role};}));
  app.delete('/v2/workspaces/:id/members/:userId',async request=>db.transaction(async client=>{const id=uuid(params(request).id),row=await store.member(client,id,request.actor,true);assert(row.role==='OWNER','FORBIDDEN','Owner permission is required',403);const userId=uuid(params(request).userId);assert(userId!==request.actor.id,'OWNER_REQUIRED','Workspace owner cannot be removed');await client.query('DELETE FROM unified.workspace_members WHERE workspace_id=$1 AND user_id=$2',[id,userId]);await client.query('UPDATE unified.device_bindings SET revoked_at=COALESCE(revoked_at,now()) WHERE workspace_id=$1 AND user_id=$2',[id,userId]);return {removed:true};}));
  app.post('/v2/workspaces/:id/blobs/prepare',async request=>{
    const id=uuid(params(request).id),blob=validateBlob(request.body);assert(blob.size<=config.maxUploadBytes,'FILE_TOO_LARGE','File exceeds original upload size limit',413);assert(blob.mime_type.length<=255,'INVALID_MIME','MIME type is too long');
    const stored=await db.transaction(async client=>{const row=await store.member(client,id,request.actor,true);assert(row.role!=='VIEWER','FORBIDDEN','Workspace editing permission is required',403);const existing=(await client.query('SELECT * FROM unified.blobs WHERE workspace_id=$1 AND id=$2',[id,blob.id])).rows[0];if(existing){assert(existing.sha256===blob.sha256&&Number(existing.size)===blob.size&&existing.mime_type===blob.mime_type,'IMMUTABLE_BLOB','Blob ID already used for different bytes',409);return {...existing,size:Number(existing.size)} as StoredBlob;}
      const used=Number((await client.query('SELECT COALESCE(sum(size),0) AS used FROM unified.blobs WHERE workspace_id=$1',[id])).rows[0].used);assert(used+blob.size<=config.maxWorkspaceBytes,'QUOTA_EXCEEDED','Workspace private file quota exceeded',413);const key=`teams/unified/workspaces/${id}/blobs/${blob.id}`;await client.query('INSERT INTO unified.blobs(workspace_id,id,sha256,size,mime_type,storage_key,uploader_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,blob.id,blob.sha256,blob.size,blob.mime_type,key,request.actor.id]);return {...blob,storage_key:key};});
    return {blob,already_uploaded:!!stored.verified_at,verified:!!stored.verified_at,...(stored.verified_at?{}:await storage.prepare(stored))};
  });
  app.post('/v2/workspaces/:id/blobs/complete',async request=>{
    const id=uuid(params(request).id),body=record(request.body),blobId=uuid(body.id);const blob=await db.transaction(async client=>{const row=await store.member(client,id,request.actor);assert(row.role!=='VIEWER','FORBIDDEN','Workspace editing permission is required',403);const b=(await client.query('SELECT * FROM unified.blobs WHERE workspace_id=$1 AND id=$2',[id,blobId])).rows[0];assert(b,'BLOB_NOT_FOUND','Upload metadata not found',404);return {...b,size:Number(b.size)} as StoredBlob;});
    await storage.verify(blob);
    await db.transaction(async client=>{await store.member(client,id,request.actor,true);await client.query('UPDATE unified.blobs SET verified_at=COALESCE(verified_at,now()) WHERE workspace_id=$1 AND id=$2',[id,blobId]);});return {blob:{id:blob.id,sha256:blob.sha256,size:blob.size,mime_type:blob.mime_type},verified:true};
  });
  app.get('/v2/workspaces/:id/blobs/:blobId/recovery',async request=>{
    const id=uuid(params(request).id),blobId=uuid(params(request).blobId);
    const blob=await db.transaction(async client=>{const member=await store.member(client,id,request.actor);const row=(await client.query('SELECT * FROM unified.blobs WHERE workspace_id=$1 AND id=$2 AND verified_at IS NOT NULL',[id,blobId])).rows[0];assert(row,'BLOB_NOT_FOUND','Verified original not found',404);assert(row.uploader_id===request.actor.id||member.role==='OWNER','FORBIDDEN','Only the uploader or workspace owner can recover an unpublished original',403);return {...row,size:Number(row.size)} as StoredBlob;});
    return {url:await storage.download(blob,`recovered-${blob.id}`),expires_in:config.urlTtl,blob:{id:blob.id,sha256:blob.sha256,size:blob.size,mime_type:blob.mime_type}};
  });
  async function versionBlob(request:FastifyRequest) {
    const id=uuid(params(request).id),versionId=uuid(params(request).versionId);return db.transaction(async client=>{await store.member(client,id,request.actor);const version=(await client.query("SELECT payload FROM unified.entities WHERE workspace_id=$1 AND collection='versions' AND id=$2",[id,versionId])).rows[0]?.payload as DocumentVersion|undefined;assert(version,'VERSION_NOT_FOUND','Document version not found',404);const blob=(await client.query('SELECT * FROM unified.blobs WHERE workspace_id=$1 AND id=$2 AND verified_at IS NOT NULL',[id,version.blob.id])).rows[0];assert(blob,'BLOB_UNAVAILABLE','Document file is not available',409);const entry=(await client.query("SELECT payload FROM unified.entities WHERE workspace_id=$1 AND collection='entries' AND payload->>'document_id'=$2 ORDER BY deleted LIMIT 1",[id,version.document_id])).rows[0]?.payload;return {version,blob:{...blob,size:Number(blob.size)} as StoredBlob,filename:entry?.name||'document'};});
  }
  app.get('/v2/workspaces/:id/versions/:versionId/download',async request=>{const {version,blob,filename}=await versionBlob(request);return {url:await storage.download(blob,filename),expires_in:config.urlTtl,version};});
  app.get('/v2/workspaces/:id/artifacts/:artifactId/download',async request=>{
    const id=uuid(params(request).id),artifactId=uuid(params(request).artifactId);
    const result=await db.transaction(async client=>{await store.member(client,id,request.actor);const artifact=(await client.query("SELECT payload FROM unified.entities WHERE workspace_id=$1 AND collection='artifacts' AND id=$2",[id,artifactId])).rows[0]?.payload;assert(artifact,'ARTIFACT_NOT_FOUND','Derived file not found',404);const blob=(await client.query('SELECT * FROM unified.blobs WHERE workspace_id=$1 AND id=$2 AND verified_at IS NOT NULL',[id,artifact.blob.id])).rows[0];assert(blob,'BLOB_UNAVAILABLE','Derived file is unavailable',409);return {artifact,blob:{...blob,size:Number(blob.size)} as StoredBlob};});
    return {artifact:result.artifact,url:await storage.download(result.blob,`document.${result.artifact.kind.split(':')[1]||'json'}`),expires_in:config.urlTtl};
  });
  app.get('/v2/workspaces/:id/versions/:versionId/normalized',async request=>{
    const id=uuid(params(request).id),versionId=uuid(params(request).versionId);await versionBlob(request);
    const artifact=(await db.pool.query("SELECT payload FROM unified.entities WHERE workspace_id=$1 AND collection='artifacts' AND payload->>'version_id'=$2 AND payload->>'kind'='normalized' ORDER BY payload->>'created_at' DESC LIMIT 1",[id,versionId])).rows[0]?.payload;
    if(artifact){const blob=(await db.pool.query('SELECT * FROM unified.blobs WHERE workspace_id=$1 AND id=$2',[id,artifact.blob.id])).rows[0];const data=JSON.parse((await storage.bytes({...blob,size:Number(blob.size)})).toString());return {state:'ready',...data,artifact};}
    const job=(await db.pool.query("SELECT request_id,status,error FROM unified.processing_jobs WHERE workspace_id=$1 AND version_id=$2 AND kind='parse' ORDER BY created_at DESC LIMIT 1",[id,versionId])).rows[0];return {state:job?.status==='failed'?'failed':'pending',job:job||null};
  });
  app.get('/v2/workspaces/:id/versions/:versionId/content',async request=>{
    const {version,filename}=await versionBlob(request),id=uuid(params(request).id);
    const artifact=(await db.pool.query("SELECT payload FROM unified.entities WHERE workspace_id=$1 AND collection='artifacts' AND payload->>'version_id'=$2 AND payload->>'kind'='normalized' ORDER BY payload->>'created_at' DESC LIMIT 1",[id,version.id])).rows[0]?.payload;
    assert(artifact,'ARTIFACT_PENDING','Document text is still being processed',409);const blob=(await db.pool.query('SELECT * FROM unified.blobs WHERE workspace_id=$1 AND id=$2',[id,artifact.blob.id])).rows[0];const data=JSON.parse((await storage.bytes({...blob,size:Number(blob.size)})).toString());
    const entry=(await db.pool.query("SELECT id FROM unified.entities WHERE workspace_id=$1 AND collection='entries' AND payload->>'document_id'=$2 ORDER BY deleted LIMIT 1",[id,version.document_id])).rows[0];
    return {document_id:version.document_id,entry_id:entry?.id,version_id:version.id,version_number:version.display_number||1,filename,sha256:version.blob.sha256,created_at:Date.parse(version.created_at),normalized:data.normalized};
  });
  app.post('/v2/workspaces/:id/drafts/:draftId/export',async request=>processing.exportDraft(request.actor,uuid(params(request).id),uuid(params(request).draftId),record(request.body)));
  app.post('/v2/workspaces/:id/versions/:versionId/processing',async(request,reply)=>{const body=record(request.body);return reply.status(202).send({job:await processing.request(request.actor,uuid(params(request).id),{...body,version_id:uuid(params(request).versionId),kind:body.kind||'parse'})});});
  app.get('/v2/workspaces/:id/jobs/:requestId',async request=>processing.job(request.actor,uuid(params(request).id),uuid(params(request).requestId)));
  app.post('/v2/workspaces/:id/ai/context',async request=>processing.ai(request.actor,uuid(params(request).id),record(request.body),request.headers.authorization!));
  app.get('/v2/workspaces/:id/ai/index-status',async request=>db.transaction(async client=>{const id=uuid(params(request).id);await store.member(client,id,request.actor);const rows=(await client.query('SELECT kind,status,count(*)::int AS count FROM unified.processing_jobs WHERE workspace_id=$1 GROUP BY kind,status',[id])).rows;return {jobs:rows,ready:Number((await client.query("SELECT count(*) FROM unified.entities WHERE workspace_id=$1 AND collection='artifacts' AND payload->>'kind'='normalized'",[id])).rows[0].count)};}));
  app.post('/v2/workspaces/:id/ai/reindex',async request=>{const id=uuid(params(request).id);const versions=await db.transaction(async client=>{const row=await store.member(client,id,request.actor);assert(row.role!=='VIEWER','FORBIDDEN','Workspace editing permission is required',403);return (await client.query("SELECT payload->>'reference_head_id' AS version FROM unified.entities WHERE workspace_id=$1 AND collection='documents' AND NOT deleted AND payload->>'reference_head_id' IS NOT NULL",[id])).rows;});const jobs=[];for(const row of versions)jobs.push(await processing.request(request.actor,id,{kind:'parse',version_id:row.version}));return {jobs};});
  app.get('/v2/workspaces/:id/ai/search',async request=>{
    const id=uuid(params(request).id),q=query(request),limit=pageLimit(q.limit,100);
    return db.transaction(async client=>{await store.member(client,id,request.actor);return searchEvidence(client,id,q.q||'',q.scope||'auto',q.as_of,limit);});
  });
  app.get('/v2/workspaces/:id/events',async(request,reply)=>{
    const id=uuid(params(request).id);await db.transaction(client=>store.member(client,id,request.actor,false,true));
    reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':config.corsOrigins.includes(String(request.headers.origin))?String(request.headers.origin):config.corsOrigins[0]});
    let last=-1,closed=false,busy=false;
    let timer:ReturnType<typeof setInterval>|undefined,expiry:ReturnType<typeof setTimeout>|undefined;
    const close=()=>{if(closed)return;closed=true;if(timer)clearInterval(timer);if(expiry)clearTimeout(expiry);eventStreams.delete(close);reply.raw.end();};
    eventStreams.add(close);reply.raw.on('close',close);
    const poll=async()=>{if(closed||busy)return;busy=true;try {
      const row=await db.transaction(client=>store.member(client,id,request.actor,false,true));if(closed)return;
      if(Number(row.cursor)!==last){last=Number(row.cursor);reply.raw.write(`data: ${JSON.stringify({cursor:last,epoch:Number(row.epoch),deleted_at:row.deleted_at})}\n\n`);}else reply.raw.write(': keep-alive\n\n');
      if(row.deleted_at)close();
    }catch{close();}finally{busy=false;}};
    await poll();if(!closed){timer=setInterval(()=>void poll(),3000);expiry=setTimeout(close,45000);timer.unref();expiry.unref();}
  });
  app.addHook('onClose',async()=>{processing.stop();storage.client.destroy();await db.close();});
  if(options.worker)processing.start();
  return {app,db,store,storage,processing};
}
