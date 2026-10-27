import { createHash, randomUUID } from 'node:crypto';
import { createWorkspaceState, applyCommand } from '@context/domain';
import { validateCommand, validatePortableName, type Workspace, type WorkspaceState, type EntityChange, type CommandEnvelope, type Role, type BlobReference } from '@context/contracts';
import type { Database, DB } from './database.ts';
import type { Actor } from './auth.ts';
import { ApiError, assert, uuid } from './errors.ts';
export const collections = ['entries','documents','versions','canvas_elements','relations','drafts','proposals','chat_sessions','chat_messages','artifacts','conflicts'] as const;
export interface WorkspaceRow { id:string; metadata:Workspace; epoch:string; cursor:string; deleted_at:string|null; role:Role; }
export interface Receipt { operation_id:string; status:'applied'|'conflict'|'rejected'; sequence:number|null; changes:EntityChange[]; conflict_ids:string[]; error?:unknown; }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function stableUuid(value:string) { const b=createHash('sha256').update(value).digest().subarray(0,16); b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;const s=b.toString('hex');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`; }
export class WorkspaceStore {
  constructor(readonly db: Database) {}
  async member(db:DB,id:string,actor:Actor,lock=false,includeDeleted=false):Promise<WorkspaceRow> {
    const result=await db.query(`SELECT w.*, m.role FROM unified.workspaces w JOIN unified.workspace_members m ON m.workspace_id=w.id WHERE w.id=$1 AND m.user_id=$2${lock?' FOR UPDATE OF w':''}`,[id,actor.id]);
    const row=result.rows[0] as WorkspaceRow|undefined;
    if (!row) throw new ApiError(404,'WORKSPACE_NOT_FOUND','Workspace not found');
    if (row.deleted_at && !includeDeleted) throw new ApiError(410,'WORKSPACE_DELETED','Workspace has been deleted');
    return row;
  }
  async state(db:DB,row:WorkspaceRow):Promise<WorkspaceState> {
    const state=createWorkspaceState(row.metadata);
    for (const collection of collections) state[collection]={};
    for (const item of (await db.query('SELECT collection,id,payload FROM unified.entities WHERE workspace_id=$1',[row.id])).rows) (state[item.collection as typeof collections[number]] as Record<string,unknown>)[item.id]=item.payload;
    return state;
  }
  async persist(db:DB,workspaceId:string,changes:EntityChange[]) {
    const entityRows:Record<string,unknown>[]=[];
    for (const change of changes) {
      if (change.collection==='workspace') {
        const w=change.value as Workspace;
        await db.query('UPDATE unified.workspaces SET metadata=$2,epoch=$3,deleted_at=$4,updated_at=now() WHERE id=$1',[workspaceId,w,w.epoch,w.deleted_at]);
        continue;
      }
      if (change.value===null) { await db.query('DELETE FROM unified.entities WHERE workspace_id=$1 AND collection=$2 AND id=$3',[workspaceId,change.collection,change.id]); continue; }
      const entry=change.collection==='entries'?change.value as WorkspaceState['entries'][string]:undefined;
      entityRows.push({workspace_id:workspaceId,collection:change.collection,id:change.id,payload:change.value,parent_id:entry?.parent_id||null,name_key:entry?entry.name.normalize('NFC'):null,deleted:'deleted_at' in change.value && !!change.value.deleted_at});
    }
    // Named tree commands validate their final graph as a unit. The live sibling
    // unique index must see that same final graph rather than an intermediate
    // rename (A→B before B→A). Portable references live in JSON and have no FK to
    // entity rows, so replacing only changed entry rows inside the locked editing
    // transaction preserves identity and atomic visibility without cloud aliases.
    const changedEntries=entityRows.filter(row=>row.collection==='entries').map(row=>row.id);
    if(changedEntries.length)await db.query("DELETE FROM unified.entities WHERE workspace_id=$1 AND collection='entries' AND id=ANY($2::uuid[])",[workspaceId,changedEntries]);
    for(let start=0;start<entityRows.length;start+=1000)await db.query(`INSERT INTO unified.entities(workspace_id,collection,id,payload,parent_id,name_key,deleted)
      SELECT workspace_id,collection,id,payload,parent_id,name_key,deleted FROM jsonb_to_recordset($1::jsonb)
      AS item(workspace_id uuid,collection text,id uuid,payload jsonb,parent_id uuid,name_key text,deleted boolean)
      ON CONFLICT(workspace_id,collection,id) DO UPDATE SET payload=EXCLUDED.payload,parent_id=EXCLUDED.parent_id,name_key=EXCLUDED.name_key,deleted=EXCLUDED.deleted`,[JSON.stringify(entityRows.slice(start,start+1000))]);
  }
  async create(actor:Actor,input:{id?:string;name:string;root_entry_id?:string}) {
    validatePortableName(input.name);
    assert(input.name.length<=200,'INVALID_NAME','Workspace name is too long');
    const id=input.id?uuid(input.id):randomUUID(); const root=input.root_entry_id?uuid(input.root_entry_id):randomUUID();
    return this.db.transaction(async db=>{
      const existing=await db.query('SELECT * FROM unified.workspaces WHERE id=$1 FOR UPDATE',[id]);
      if (existing.rows.length) {
        const row=await this.member(db,id,actor,false,true);
        assert(!row.deleted_at,'WORKSPACE_DELETED','Deleted workspace UUID cannot be reused',410);
        assert((!input.root_entry_id||row.metadata.root_entry_id===root) && row.metadata.name===input.name,'ID_REUSE','Workspace ID already exists',409);
        return {...row.metadata,role:row.role,cursor:Number(row.cursor)};
      }
      const now=new Date().toISOString(); const workspace:Workspace={id,name:input.name,root_entry_id:root,epoch:1,revision:0,created_at:now,updated_at:now,deleted_at:null};
      await db.query('INSERT INTO unified.workspaces(id,owner_id,metadata) VALUES($1,$2,$3)',[id,actor.id,workspace]);
      await db.query("INSERT INTO unified.workspace_members(workspace_id,user_id,role) VALUES($1,$2,'OWNER')",[id,actor.id]);
      const state=createWorkspaceState(workspace);
      await this.persist(db,id,[{collection:'entries',id:root,value:state.entries[root]}]);
      return {...workspace,role:'OWNER' as const,cursor:0};
    });
  }
  async bind(actor:Actor,id:string,input:{device_id:string;name?:string;platform?:string}) {
    const deviceId=uuid(input.device_id,'device_id');
    return this.db.transaction(async db=>{
      const row=await this.member(db,id,actor,true);
      const existing=(await db.query('SELECT * FROM unified.device_bindings WHERE workspace_id=$1 AND device_id=$2',[id,deviceId])).rows[0];
      assert(!existing || existing.user_id===actor.id,'DEVICE_OWNERSHIP','Device ID belongs to another account',409);
      const binding=(await db.query(`INSERT INTO unified.device_bindings(workspace_id,device_id,user_id,name,platform,epoch) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(workspace_id,device_id) DO UPDATE SET name=EXCLUDED.name,platform=EXCLUDED.platform,epoch=EXCLUDED.epoch,revoked_at=NULL,last_seen_at=now() RETURNING *`,
      [id,deviceId,actor.id,(input.name||'Device').slice(0,200),(input.platform||'unknown').slice(0,30),row.epoch])).rows[0];
      return {...binding,epoch:Number(binding.epoch),ack_cursor:Number(binding.ack_cursor),cursor:Number(row.cursor)};
    });
  }
  async device(db:DB,row:WorkspaceRow,actor:Actor,deviceId:string) {
    const binding=(await db.query('SELECT * FROM unified.device_bindings WHERE workspace_id=$1 AND device_id=$2 AND user_id=$3',[row.id,deviceId,actor.id])).rows[0];
    assert(binding && !binding.revoked_at,'DEVICE_DETACHED','Register this device before publishing changes',409);
    assert(Number(binding.epoch)===Number(row.epoch),'EPOCH_MISMATCH','Device belongs to an old workspace generation',409);
    return binding;
  }
  async blobReferences(db:DB,id:string,command:CommandEnvelope) {
    const blobs:BlobReference[]=[];
    if(command.type==='AppendDocumentVersion') blobs.push(command.payload.version.blob);
    if(command.type==='PutDerivedArtifact') blobs.push(command.payload.artifact.blob);
    if(command.type==='CompleteAIRequest') blobs.push(...(command.payload.artifacts||[]).map(v=>v.blob));
    if(command.type==='ImportWorkspace')blobs.push(...Object.values(command.payload.state.versions).map(v=>v.blob),...Object.values(command.payload.state.artifacts).map(v=>v.blob));
    const storedById=new Map((await db.query('SELECT * FROM unified.blobs WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND verified_at IS NOT NULL',[id,[...new Set(blobs.map(v=>v.id))]])).rows.map(row=>[row.id,row]));
    for(const ref of blobs) {
      const stored=storedById.get(ref.id);
      assert(stored && stored.sha256===ref.sha256 && Number(stored.size)===ref.size && stored.mime_type===ref.mime_type,'BLOB_UNAVAILABLE','Upload and verify the exact original file before publishing it',409);
    }
    return new Set(blobs.map(v=>v.id));
  }
  async execute(actor:Actor,id:string,commands:CommandEnvelope[]) {
    return this.db.transaction(async db=>{
      const row=await this.member(db,id,actor,true,true);
      let state=await this.state(db,row); let cursor=Number(row.cursor);
      const results:Receipt[]=[];
      for(const raw of commands) {
        const command=validateCommand(raw);
        assert(command.workspace_id===id,'WORKSPACE_MISMATCH','Command belongs to another workspace');
        const fingerprint=createHash('sha256').update(canonical(command)).digest('hex');
        const previous=(await db.query('SELECT * FROM unified.command_receipts WHERE workspace_id=$1 AND operation_id=$2',[id,command.operation_id])).rows[0];
        if(previous) {
          assert(previous.actor_id===actor.id && previous.fingerprint===fingerprint,'OPERATION_ID_REUSE','Operation ID was already used for different content',409);
          results.push(previous.result);continue;
        }
        assert(!state.workspace.deleted_at,'WORKSPACE_DELETED','Workspace has been deleted',410);
        await this.device(db,{...row,epoch:String(state.workspace.epoch)},actor,command.device_id);
        const blobs=await this.blobReferences(db,id,command);
        const result=applyCommand(state,command,{actor_id:actor.id,role:row.role,now:new Date().toISOString(),available_blobs:blobs});
        const receipt:Receipt={operation_id:command.operation_id,status:result.status,sequence:result.changes.length?++cursor:null,changes:result.changes,conflict_ids:result.conflict_ids,...(result.error?{error:result.error}:{})};
        if(result.changes.length) {
          await this.persist(db,id,result.changes);
          await db.query('INSERT INTO unified.workspace_changes(workspace_id,sequence,operation_id,epoch,changes) VALUES($1,$2,$3,$4,$5)',[id,cursor,command.operation_id,result.state.workspace.epoch,JSON.stringify(result.changes)]);
          await db.query('UPDATE unified.workspaces SET cursor=$2 WHERE id=$1',[id,cursor]);
          const jobs=result.changes.filter(change=>change.collection==='versions'&&change.value).map(change=>{
            const version=change.value as WorkspaceState['versions'][string];
            return {id:randomUUID(),workspace_id:id,requested_by:actor.id,request_id:stableUuid(`parse:${version.id}`),version_id:version.id,input:{kind:'parse',version_id:version.id}};
          });
          for(let offset=0;offset<jobs.length;offset+=1000)await db.query(`INSERT INTO unified.processing_jobs(id,workspace_id,requested_by,request_id,kind,version_id,input)
            SELECT id,workspace_id,requested_by,request_id,'parse',version_id,input FROM jsonb_to_recordset($1::jsonb)
            AS job(id uuid,workspace_id uuid,requested_by uuid,request_id uuid,version_id uuid,input jsonb)
            ON CONFLICT(workspace_id,request_id) DO NOTHING`,[JSON.stringify(jobs.slice(offset,offset+1000))]);
        }
        await db.query('INSERT INTO unified.command_receipts(workspace_id,operation_id,actor_id,fingerprint,result,sequence) VALUES($1,$2,$3,$4,$5,$6)',[id,command.operation_id,actor.id,fingerprint,receipt,receipt.sequence]);
        state=result.state;results.push(receipt);
      }
      return {results,cursor,epoch:state.workspace.epoch};
    });
  }
}
