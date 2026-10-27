import { createHash, randomUUID } from 'node:crypto';
import {validateSourceSnapshot, validateWorkerInput, validateWorkerResult, type CommandEnvelope, type DerivedArtifact, type DocumentVersion, type SourceSnapshot} from '@context/contracts';
import type { Actor } from './auth.ts';
import type { ServerConfig } from './config.ts';
import type { Database } from './database.ts';
import { ApiError, assert, record, uuid } from './errors.ts';
import { canonical, stableUuid, type WorkspaceStore } from './store.ts';
import type { BlobStorage, StoredBlob } from './storage.ts';
import {searchEvidence} from './search.ts';

interface Job {id:string;workspace_id:string;requested_by:string;request_id:string;kind:'parse'|'convert'|'ai';version_id:string|null;input:Record<string,unknown>;status:string;attempts:number;result:unknown;created_at:Date;}
export class ProcessingService {
  private timer?:NodeJS.Timeout; private busy=false;
  constructor(private db:Database,private store:WorkspaceStore,private storage:BlobStorage,private config:ServerConfig) {}
  start(onError:(error:unknown)=>void=()=>{}) { this.timer=setInterval(()=>void this.tick().catch(onError),1500); this.timer.unref(); }
  stop() { if(this.timer)clearInterval(this.timer); }
  async request(actor:Actor,workspaceId:string,input:Record<string,unknown>) {
    const requestId=input.request_id?uuid(input.request_id,'request_id'):randomUUID();
    return this.db.transaction(async db=>{
      const row=await this.store.member(db,workspaceId,actor,true);
      assert(row.role!=='VIEWER','FORBIDDEN','Workspace editing permission is required',403);
      const kind=input.kind;
      assert(kind==='parse'||kind==='convert'||kind==='ai','INVALID_JOB','Unsupported processing job');
      const normalized={...input,request_id:requestId};
      const existing=(await db.query('SELECT * FROM unified.processing_jobs WHERE workspace_id=$1 AND request_id=$2',[workspaceId,requestId])).rows[0];
      if(existing) {
        assert(existing.requested_by===actor.id&&canonical(existing.input)===canonical(normalized),'REQUEST_ID_REUSE','Request ID already used for different input',409);
        return existing as Job;
      }
      let versionId:string|null=null;
      if(kind!=='ai') {
        versionId=uuid(input.version_id,'version_id');
        assert((await db.query("SELECT 1 FROM unified.entities WHERE workspace_id=$1 AND collection='versions' AND id=$2",[workspaceId,versionId])).rowCount,'VERSION_NOT_FOUND','Document version not found',404);
        if(kind==='convert') assert(['docx','pdf','txt','md','hwpx'].includes(String(input.format)),'INVALID_FORMAT','Unsupported conversion format');
      }
      return (await db.query('INSERT INTO unified.processing_jobs(id,workspace_id,requested_by,request_id,kind,version_id,input) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),workspaceId,actor.id,requestId,kind,versionId,normalized])).rows[0] as Job;
    });
  }
  async job(actor:Actor,workspaceId:string,requestId:string) {
    return this.db.transaction(async db=>{
      await this.store.member(db,workspaceId,actor);
      const job=(await db.query('SELECT id,request_id,kind,version_id,status,attempts,result,error,created_at,updated_at FROM unified.processing_jobs WHERE workspace_id=$1 AND request_id=$2',[workspaceId,requestId])).rows[0];
      if(!job)throw new ApiError(404,'JOB_NOT_FOUND','Processing request not found');
      return job;
    });
  }
  async tick() {
    if(this.busy||!this.config.internalWorkerToken)return; this.busy=true;
    try {
      const job=await this.db.transaction(async db=>{
        await db.query("UPDATE unified.processing_jobs SET status='failed',error=$1,lease_until=NULL,updated_at=now() WHERE status='running' AND lease_until<now() AND attempts>=3",[{code:'PROCESSOR_INTERRUPTED',message:'Document processing was interrupted repeatedly. Request processing again.'}]);
        const claimed=(await db.query(`SELECT j.* FROM unified.processing_jobs j JOIN unified.workspaces w ON w.id=j.workspace_id
          WHERE j.kind IN ('parse','convert') AND NOT (w.deleted_at IS NOT NULL) AND (j.status='queued' OR (j.status='running' AND j.lease_until<now())) AND j.attempts<3
          ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`)).rows[0] as Job|undefined;
        if(!claimed)return;
        await db.query("UPDATE unified.processing_jobs SET status='running',attempts=attempts+1,lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=$1",[claimed.id]);
        return {...claimed,attempts:claimed.attempts+1};
      });
      if(job) await this.runDocument(job);
    } finally {this.busy=false;}
  }
  private async actor(id:string):Promise<Actor> {
    const actor=(await this.db.pool.query('SELECT * FROM unified.users WHERE id=$1',[id])).rows[0];
    if(!actor)throw new Error('Processing actor missing'); return actor;
  }
  private async complete(job:Job,payload:CommandEnvelope['payload'],type:'PutDerivedArtifact'|'CompleteAIRequest',bases:Record<string,number>={}) {
    const actor=await this.actor(job.requested_by);
    const binding=await this.store.bind(actor,job.workspace_id,{device_id:stableUuid(`worker:${actor.id}:${job.workspace_id}`),name:'Document worker',platform:'service'});
    const result=await this.store.execute(actor,job.workspace_id,[{schema_version:2,operation_id:stableUuid(`complete:${job.id}`),workspace_id:job.workspace_id,device_id:binding.device_id,workspace_epoch:binding.epoch,type,payload,base_revisions:bases} as CommandEnvelope]);
    assert(result.results[0].status==='applied','COMPLETION_REJECTED','Processing output could not be published',409);
    return result;
  }
  private async runDocument(job:Job) {
    try {
      const staged=(job.result as {pending_artifact?:DerivedArtifact;pending_text?:string}|null)?.pending_artifact;
      if(staged){
        const b=(await this.db.pool.query('SELECT * FROM unified.blobs WHERE workspace_id=$1 AND id=$2 AND verified_at IS NOT NULL',[job.workspace_id,staged.blob.id])).rows[0];
        if(b){await this.finishArtifact(job,staged,(job.result as {pending_text?:string}).pending_text);return;}
        const candidate:StoredBlob={...staged.blob,storage_key:`teams/unified/workspaces/${job.workspace_id}/artifacts/${staged.blob.id}`};
        try{
          await this.storage.verify(candidate);
          await this.db.pool.query('INSERT INTO unified.blobs(workspace_id,id,sha256,size,mime_type,storage_key,uploader_id,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(workspace_id,id) DO NOTHING',[job.workspace_id,candidate.id,candidate.sha256,candidate.size,candidate.mime_type,candidate.storage_key,job.requested_by]);
          await this.finishArtifact(job,staged,(job.result as {pending_text?:string}).pending_text);return;
        }catch(error){if(!(error instanceof ApiError&&error.code==='UPLOAD_MISSING'))throw error;}
      }
      const actor=await this.actor(job.requested_by);
      const input=await this.db.transaction(async db=>{
        await this.store.member(db,job.workspace_id,actor);
        const version=(await db.query("SELECT payload FROM unified.entities WHERE workspace_id=$1 AND collection='versions' AND id=$2",[job.workspace_id,job.version_id])).rows[0]?.payload as DocumentVersion|undefined;
        assert(version,'VERSION_NOT_FOUND','Document version no longer exists',404);
        const entry=(await db.query("SELECT payload FROM unified.entities WHERE workspace_id=$1 AND collection='entries' AND payload->>'document_id'=$2 ORDER BY deleted LIMIT 1",[job.workspace_id,version.document_id])).rows[0]?.payload;
        const blob=(await db.query('SELECT * FROM unified.blobs WHERE workspace_id=$1 AND id=$2 AND verified_at IS NOT NULL',[job.workspace_id,version.blob.id])).rows[0];
        assert(blob,'BLOB_UNAVAILABLE','Original file has not been verified',409);
        return {version,filename:entry?.name||'document',blob:{...blob,size:Number(blob.size)} as StoredBlob};
      });
      const download_url=await this.storage.download(input.blob,input.filename);
      const version={id:input.version.id,document_id:input.version.document_id,blob:input.version.blob};
      const response=await fetch(`${this.config.pythonUrl}/internal/v2/process`,{method:'POST',headers:{Authorization:`Bearer ${this.config.internalWorkerToken}`,'Content-Type':'application/json'},body:JSON.stringify(validateWorkerInput({schema_version:2,job_id:job.id,workspace_id:job.workspace_id,actor_id:job.requested_by,kind:job.kind,version,download_url,filename:input.filename,...(job.kind==='convert'?{format:job.input.format}:{})})),signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw new ApiError(response.status>=500?503:422,'PROCESSOR_UNAVAILABLE',`Document processor returned ${response.status}`);
      const result=validateWorkerResult(await response.json());
      assert(result.schema_version===2&&result.job_id===job.id,'INVALID_PROCESSOR_RESULT','Document processor returned a different request');
      assert(result.status==='complete','PROCESSING_FAILED','error' in result?result.error.message:'Document processing failed');
      assert(job.kind==='parse'?'normalized' in result:'output' in result,'INVALID_PROCESSOR_RESULT','Document processor returned a different output kind');
      const parsed='normalized' in result?result:undefined;
      const artifactKind=job.kind==='parse'?'normalized':`conversion:${job.input.format}`;
      const fingerprint=String(result.processor_fingerprint||'python-v2');
      const priorArtifact=(await this.db.pool.query("SELECT payload FROM unified.entities WHERE workspace_id=$1 AND collection='artifacts' AND payload->>'version_id'=$2 AND payload->>'kind'=$3 AND payload->>'processor_fingerprint'=$4 LIMIT 1",[job.workspace_id,input.version.id,artifactKind,fingerprint])).rows[0]?.payload as DerivedArtifact|undefined;
      if(priorArtifact){
        if(job.kind==='parse')await this.db.pool.query(`INSERT INTO unified.document_texts(workspace_id,version_id,document_id,artifact_id,processor_fingerprint,body) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,version_id) DO UPDATE SET artifact_id=EXCLUDED.artifact_id,processor_fingerprint=EXCLUDED.processor_fingerprint,body=EXCLUDED.body`,[job.workspace_id,input.version.id,input.version.document_id,priorArtifact.id,fingerprint,String(parsed?.text||'')]);
        await this.db.pool.query("UPDATE unified.processing_jobs SET status='complete',result=$2,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id,{artifact_id:priorArtifact.id}]);return;
      }
      const output='output' in result?result.output:undefined;
      const bytes=job.kind==='parse'?Buffer.from(JSON.stringify({normalized:parsed?.normalized,text:parsed?.text||'',processor_fingerprint:result.processor_fingerprint})):Buffer.from(output?.content_base64||'','base64');
      assert(bytes.length<=this.config.maxUploadBytes,'ARTIFACT_TOO_LARGE','Derived output exceeds file size limit');
      const blob:StoredBlob={id:stableUuid(`artifact-blob:${job.id}`),sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,mime_type:job.kind==='parse'?'application/json':String(output?.mime_type||'application/octet-stream'),storage_key:`teams/unified/workspaces/${job.workspace_id}/artifacts/${stableUuid(`artifact-blob:${job.id}`)}`};
      const artifact:DerivedArtifact={id:stableUuid(`artifact:${job.id}`),workspace_id:job.workspace_id,document_id:input.version.document_id,version_id:input.version.id,kind:artifactKind,processor_fingerprint:fingerprint,blob:{id:blob.id,sha256:blob.sha256,size:blob.size,mime_type:blob.mime_type},created_at:new Date(job.created_at).toISOString()};
      await this.db.pool.query('UPDATE unified.processing_jobs SET result=$2,updated_at=now() WHERE id=$1',[job.id,{pending_artifact:artifact,...(job.kind==='parse'?{pending_text:String(parsed?.text||'')}:{})}]);
      const existing=(await this.db.pool.query('SELECT * FROM unified.blobs WHERE workspace_id=$1 AND id=$2',[job.workspace_id,blob.id])).rows[0];
      if(existing?.verified_at) { assert(existing.sha256===blob.sha256&&Number(existing.size)===blob.size,'ARTIFACT_MISMATCH','Retried processor output changed immutable artifact'); }
      else {
        await this.storage.put(blob,bytes);
        await this.db.pool.query('INSERT INTO unified.blobs(workspace_id,id,sha256,size,mime_type,storage_key,uploader_id,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(workspace_id,id) DO UPDATE SET verified_at=now()',[job.workspace_id,blob.id,blob.sha256,blob.size,blob.mime_type,blob.storage_key,job.requested_by]);
      }
      await this.finishArtifact(job,artifact,job.kind==='parse'?String(parsed?.text||''):undefined,output?.filename);
    } catch(error) {
      const permanent=error instanceof ApiError&&error.statusCode<500;
      await this.db.pool.query("UPDATE unified.processing_jobs SET status=$2,error=$3,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id,permanent||job.attempts>=3?'failed':'queued',{code:error instanceof ApiError?error.code:'PROCESSOR_UNAVAILABLE',message:error instanceof ApiError?error.message:'Document processor is unavailable'}]);
    }
  }
  private async finishArtifact(job:Job,artifact:DerivedArtifact,text?:string,filename?:string) {
    try{await this.complete(job,{artifact},'PutDerivedArtifact');}
    catch(error){
      const prior=(await this.db.pool.query("SELECT payload FROM unified.entities WHERE workspace_id=$1 AND collection='artifacts' AND payload->>'version_id'=$2 AND payload->>'kind'=$3 AND payload->>'processor_fingerprint'=$4 LIMIT 1",[job.workspace_id,artifact.version_id,artifact.kind,artifact.processor_fingerprint])).rows[0]?.payload as DerivedArtifact|undefined;
      if(!prior)throw error;artifact=prior;
    }
    if(job.kind==='parse')await this.db.pool.query(`INSERT INTO unified.document_texts(workspace_id,version_id,document_id,artifact_id,processor_fingerprint,body) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(workspace_id,version_id) DO UPDATE SET artifact_id=EXCLUDED.artifact_id,processor_fingerprint=EXCLUDED.processor_fingerprint,body=EXCLUDED.body`,[job.workspace_id,artifact.version_id,artifact.document_id,artifact.id,artifact.processor_fingerprint,text||'']);
    await this.db.pool.query("UPDATE unified.processing_jobs SET status='complete',result=$2,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id,{artifact_id:artifact.id,...(filename?{filename}:{})}]);
  }
  async ai(actor:Actor,workspaceId:string,input:Record<string,unknown>,authorization:string) {
    assert(input.task==='chat'||input.task==='write'||input.task==='summary','INVALID_TASK','Unsupported AI task');
    assert(typeof input.prompt==='string'&&input.prompt.trim()&&input.prompt.length<=4000,'INVALID_PROMPT','Prompt must contain 1–4000 characters');
    const draftRevision=input.base_revision??input.revision;
    if(input.draft_id)assert(Number.isSafeInteger(draftRevision)&&Number(draftRevision)>=0,'REVISION_REQUIRED','Draft generation requires its starting revision');
    let sources=(input.sources||[]) as SourceSnapshot[];
    assert(Array.isArray(sources)&&sources.length<=20,'INVALID_SOURCES','At most 20 sources are allowed');
    // Capture automatically chosen excerpts once per request. Retrying a lost
    // provider response must use the same evidence even if documents changed.
    const {auto_sources:_ignored,...requested}=input;input=requested;
    if(!sources.length){
      const existing=input.request_id?(await this.db.pool.query("SELECT requested_by,input FROM unified.processing_jobs WHERE workspace_id=$1 AND request_id=$2 AND kind='ai'",[workspaceId,uuid(input.request_id,'request_id')])).rows[0]:undefined;
      if(existing?.requested_by===actor.id&&existing.input.auto_sources)sources=existing.input.sources;
      else sources=await this.db.transaction(async db=>{
        await this.store.member(db,workspaceId,actor);
        const evidence=await searchEvidence(db,workspaceId,String(input.prompt),typeof input.scope==='string'?input.scope:'auto',typeof input.as_of==='string'?input.as_of:undefined,12,{fallback:true});
        return evidence.results.map(hit=>({id:hit.id,kind:'document' as const,document_id:hit.document_id,version_id:hit.version_id,version_number:hit.version_number,quote:hit.text,label:hit.document_title,locations:hit.locations}));
      });
      input={...input,sources,auto_sources:true};
    }
    sources.forEach((source,index)=>validateSourceSnapshot(source,`sources[${index}]`));
    const job=await this.request(actor,workspaceId,{...input,kind:'ai'});
    if(job.status==='complete')return this.job(actor,workspaceId,job.request_id);
    const claimed=await this.db.pool.query("UPDATE unified.processing_jobs SET status='running',attempts=attempts+1,lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=$1 AND (status IN ('queued','failed') OR (status='running' AND lease_until<now())) RETURNING id",[job.id]);
    if(!claimed.rowCount)return this.job(actor,workspaceId,job.request_id);
    try {
      const legacySources=sources.map(s=>({id:s.id,kind:s.kind,document_title:s.label,text:s.quote.slice(0,4000),...s.kind==='document'?{document_id:s.document_id,version_id:s.version_id,version_number:s.version_number||1}: {},locations:(s.locations||[]).slice(0,20).map(location=>Object.fromEntries(Object.entries(location).filter(([,value])=>typeof value==='string'||Number.isInteger(value))))}));
      const body={request_id:job.request_id,task:input.task,prompt:input.prompt,sources:legacySources,...(input.current?{current:input.current}:{}),...(input.model?{model:input.model}:{}),...(input.connection?{connection:input.connection}:{})};
      const response=await fetch(`${this.config.pythonUrl}/api/ai/context`,{method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(150000)});
      if(!response.ok)throw new ApiError(response.status,'AI_UNAVAILABLE',`AI service returned ${response.status}`);
      const result=record(await response.json());
      const claims=Array.isArray(result.claims)?result.claims as {text:string}[]:undefined;
      const content=typeof result.answer==='string'?result.answer:typeof result.content==='string'?result.content:claims?claims.map(c=>c.text).join('\n\n'):JSON.stringify(result.content||result);
      let payload:CommandEnvelope['payload']|undefined;
      if(input.task==='chat'&&input.session_id)payload={request_id:job.request_id,message:{id:stableUuid(`ai-message:${job.id}`),workspace_id:workspaceId,session_id:uuid(input.session_id,'session_id'),role:'assistant',content,sources,request_id:job.request_id,created_at:new Date(job.created_at).toISOString(),created_by:actor.id,metadata:{state:'COMPLETED',result:result as never}}};
      else if(input.draft_id)payload={request_id:job.request_id,proposal:{id:stableUuid(`ai-proposal:${job.id}`),draft_id:uuid(input.draft_id,'draft_id'),content,sources,review:result as never}};
      if(payload)await this.complete(job,payload,'CompleteAIRequest',input.draft_id?{[`drafts:${input.draft_id}`]:Number(draftRevision)}:{});
      const publication=input.task==='chat'&&input.session_id?{message_id:stableUuid(`ai-message:${job.id}`)}:input.draft_id?{proposal_id:stableUuid(`ai-proposal:${job.id}`),draft_id:input.draft_id}:{};
      await this.db.pool.query("UPDATE unified.processing_jobs SET status='complete',result=$2,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id,{...result,...publication}]);
    } catch(error) {
      await this.db.pool.query("UPDATE unified.processing_jobs SET status='failed',error=$2,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id,{code:error instanceof ApiError?error.code:'AI_UNAVAILABLE',message:error instanceof ApiError?error.message:'AI service is unavailable'}]);
    }
    return this.job(actor,workspaceId,job.request_id);
  }
  async exportDraft(actor:Actor,workspaceId:string,draftId:string,input:Record<string,unknown>) {
    assert(this.config.internalWorkerToken,'PROCESSOR_UNAVAILABLE','Document processing is not configured',503);
    assert(['docx','hwpx','pdf','txt','md'].includes(String(input.format)),'INVALID_FORMAT','Unsupported export format');
    const draft=await this.db.transaction(async db=>{
      await this.store.member(db,workspaceId,actor);
      const item=(await db.query("SELECT payload FROM unified.entities WHERE workspace_id=$1 AND collection='drafts' AND id=$2 AND NOT deleted",[workspaceId,draftId])).rows[0]?.payload;
      assert(item,'DRAFT_NOT_FOUND','Draft not found',404);assert(item.revision===input.revision,'REVISION_CONFLICT','The draft changed before export',409);return item;
    });
    let content;try{content=JSON.parse(draft.content);}catch{content={title:draft.title,blocks:[{id:randomUUID(),type:'paragraph',text:draft.content,level:1,items:[],rows:[],source_ids:[]}]};}
    const jobId=stableUuid(`export:${workspaceId}:${draftId}:${draft.revision}:${input.format}`);
    const blobId=stableUuid(`export-blob:${jobId}`);
    let blob=(await this.db.pool.query('SELECT * FROM unified.blobs WHERE workspace_id=$1 AND id=$2 AND verified_at IS NOT NULL',[workspaceId,blobId])).rows[0];
    let filename=`${draft.title}.${input.format}`;
    if(!blob){
      const response=await fetch(`${this.config.pythonUrl}/internal/v2/process`,{method:'POST',headers:{Authorization:`Bearer ${this.config.internalWorkerToken}`,'Content-Type':'application/json'},body:JSON.stringify(validateWorkerInput({schema_version:2,job_id:jobId,workspace_id:workspaceId,actor_id:actor.id,kind:'export',content,sources:draft.sources,format:input.format,filename:'draft'})),signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw new ApiError(503,'PROCESSOR_UNAVAILABLE','Draft exporter is unavailable');
      const result=validateWorkerResult(await response.json());assert(result.status==='complete'&&'output' in result&&result.job_id===jobId,'EXPORT_FAILED','Draft could not be exported');
      const output=record(result.output),bytes=Buffer.from(String(output.content_base64||''),'base64');
      assert(bytes.length>0&&bytes.length<=this.config.maxUploadBytes,'INVALID_EXPORT','Exported file exceeds size limits');
      filename=String(output.filename||filename);
      const candidate:StoredBlob={id:blobId,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,mime_type:String(output.mime_type||'application/octet-stream'),storage_key:`teams/unified/workspaces/${workspaceId}/exports/${blobId}`};
      await this.storage.put(candidate,bytes);
      await this.db.transaction(async db=>{await this.store.member(db,workspaceId,actor,true);await db.query('INSERT INTO unified.blobs(workspace_id,id,sha256,size,mime_type,storage_key,uploader_id,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(workspace_id,id) DO NOTHING',[workspaceId,candidate.id,candidate.sha256,candidate.size,candidate.mime_type,candidate.storage_key,actor.id]);});blob=candidate;
    }
    return {url:await this.storage.download({...blob,size:Number(blob.size)},filename),filename,expires_in:this.config.urlTtl};
  }
}
