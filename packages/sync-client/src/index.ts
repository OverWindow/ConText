import type { BlobReference, CommandEnvelope, EntityChange, WorkspaceState } from '../../contracts/src/index.ts';
export { subscribeWorkspaceChanges } from './events.ts';

export interface Receipt {
  operation_id: string; status: 'applied' | 'conflict' | 'rejected'; sequence?: number;
  changes?: EntityChange[]; conflict_ids?: string[]; error?: {code:string;message:string};
}
export interface ChangeEvent { sequence: number; operation_id: string; changes: EntityChange[]; epoch: number }
export interface LocalSyncAdapter {
  prepare(): Promise<void>;
  identity(): Promise<{workspace: WorkspaceState['workspace']; device_id: string; cursor: number; linked: boolean}>;
  pending(): Promise<{command: CommandEnvelope}[]>;
  blob(id: string): Promise<Uint8Array>;
  uploaded(id: string): Promise<void>;
  /** Persist all receipts; rejected commands remain in recovery outside the active send queue. */
  acknowledge(receipts: Receipt[]): Promise<void>;
  bootstrap(state: WorkspaceState, cursor: number): Promise<void>;
  receive(changes: ChangeEvent[], cursor: number): Promise<void>;
  state(): Promise<WorkspaceState>;
  missing(): Promise<{version_id:string;blob:BlobReference}[]>;
  receiveBlob(blob:BlobReference,bytes:Uint8Array):Promise<void>;
  applyFiles():Promise<{failures: {entry_id:string;message:string}[]}>;
}
export interface RemoteSyncAdapter {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  upload(url: string, headers: Record<string,string>, bytes: Uint8Array): Promise<void>;
  download(url: string, expected: BlobReference): Promise<Uint8Array>;
}
export interface SyncProgress {phase: 'preparing'|'uploading'|'pulling'|'downloading'|'applying';completed?:number;total?:number;message:string}
const fail = (code:string,message:string):never => {const error=new Error(message) as Error&{code:string};error.code=code;throw error;};
function blobs(command:CommandEnvelope):BlobReference[] {
  if(command.type==='ImportWorkspace') return [...Object.values(command.payload.state.versions).map(v=>v.blob),...Object.values(command.payload.state.artifacts).map(v=>v.blob)];
  if(command.type==='AppendDocumentVersion')return [command.payload.version.blob];
  if(command.type==='PutDerivedArtifact')return [command.payload.artifact.blob];
  if(command.type==='CompleteAIRequest')return command.payload.artifacts?.map(a=>a.blob)||[];
  return [];
}

/** Same cursor/receipt algorithm for native clients and future browser offline repositories. */
export class WorkspaceSynchronizer {
  constructor(private local:LocalSyncAdapter,private remote:RemoteSyncAdapter,private progress:(state:SyncProgress)=>void=()=>{}){}
  async run() {
    this.progress({phase:'preparing',message:'로컬 변경과 전송 대기를 확인하고 있습니다.'});
    await this.local.prepare(); let identity=await this.local.identity();const id=identity.workspace.id,base=`/v2/workspaces/${id}`;
    if(!identity.linked) {
      let snapshot:{state:WorkspaceState;cursor:number};
      try { snapshot=await this.remote.request('GET',base+'/bootstrap'); }
      catch(error) {
        if ((error as {status?:number}).status!==404) throw error;
        await this.remote.request('POST','/v2/workspaces',{id,name:identity.workspace.name,root_entry_id:identity.workspace.root_entry_id});
        snapshot=await this.remote.request('GET',base+'/bootstrap');
      }
      await this.remote.request('POST',base+'/devices',{device_id:identity.device_id,name:'ConText Desktop',platform:'desktop'});
      await this.local.bootstrap(snapshot.state,snapshot.cursor);
    }
    const pull=async()=>{
      for(;;){
        identity=await this.local.identity();
        const page=await this.remote.request<{changes:ChangeEvent[];cursor:number;has_more:boolean}>('GET',`${base}/changes?after=${identity.cursor}&limit=500`);
        if(page.changes.length||page.cursor!==identity.cursor)await this.local.receive(page.changes,page.cursor);
        if(!page.has_more)break;
      }
    };
    this.progress({phase:'pulling',message:'웹과 다른 기기의 변경을 받고 있습니다.'});await pull();
    if((await this.local.state()).workspace.deleted_at)return {deleted:true,conflicts:0,failures:[]};
    let sent=0;const rejectedReceipts:Receipt[]=[];
    for(;;) {
      const pending=await this.local.pending();if(!pending.length)break;
      const first=pending[0].command,commands:CommandEnvelope[]=[];let bytes=0;
      for(const item of pending){
        const size=JSON.stringify(item.command).length*3;
        if(item.command.type==='ImportWorkspace'){if(!commands.length)commands.push(item.command);break;}
        if(commands.length>=100||commands.length&&bytes+size>4*1024*1024)break;
        commands.push(item.command);bytes+=size;
      }
      const needed=new Map(commands.flatMap(command=>blobs(command)).map(blob=>[blob.id,blob]));let uploaded=0;
      for(const blob of needed.values()) {
        this.progress({phase:'uploading',completed:uploaded,total:needed.size,message:`새 원본 확인 ${uploaded}/${needed.size}`});
        const ticket=await this.remote.request<{verified?:boolean;upload_url?:string;headers?:Record<string,string>}>('POST',base+'/blobs/prepare',blob);
        if(!ticket.verified){
          const uploadUrl=ticket.upload_url ?? fail('INVALID_UPLOAD','원본 업로드 응답이 올바르지 않습니다.');
          const headers=ticket.headers ?? fail('INVALID_UPLOAD','원본 업로드 응답이 올바르지 않습니다.');
          const data=await this.local.blob(blob.id);if(data.length!==blob.size)fail('INVALID_LOCAL_BLOB','보관된 원본의 크기가 변경되었습니다.');
          await this.remote.upload(uploadUrl,headers,data);
          await this.remote.request('POST',base+'/blobs/complete',{id:blob.id});
        }
        await this.local.uploaded(blob.id);uploaded++;
      }
      const result=await this.remote.request<{results:Receipt[]}>('POST',first.type==='ImportWorkspace'?base+'/import':base+'/commands',first.type==='ImportWorkspace'?first:{commands});
      if(result.results.length!==commands.length||result.results.some((r,i)=>r.operation_id!==commands[i].operation_id))fail('INVALID_RECEIPT','동기화 확인 응답이 요청과 일치하지 않습니다.');
      await this.local.acknowledge(result.results);
      rejectedReceipts.push(...result.results.filter(receipt=>receipt.status==='rejected'));
      sent+=commands.length;
      this.progress({phase:'pulling',message:`변경 ${sent}개를 확인했습니다. 서버 결과를 반영하고 있습니다.`});await pull();
    }
    await pull();const state=await this.local.state();
    if(state.workspace.deleted_at)return {deleted:true,conflicts:0,failures:[]};
    const missing=await this.local.missing();let downloaded=0;
    for(const item of missing){
      this.progress({phase:'downloading',completed:downloaded,total:missing.length,message:`원본 받기 ${downloaded}/${missing.length}`});
      const ticket=await this.remote.request<{url:string;version:{blob:BlobReference}}>('GET',base+`/versions/${item.version_id}/download`);
      if(ticket.version.blob.id!==item.blob.id||ticket.version.blob.sha256!==item.blob.sha256||ticket.version.blob.size!==item.blob.size)fail('INVALID_DOWNLOAD','받을 원본의 정보가 서버 기록과 일치하지 않습니다.');
      await this.local.receiveBlob(item.blob,await this.remote.download(ticket.url,item.blob));downloaded++;
    }
    this.progress({phase:'applying',message:'받은 내용을 로컬 폴더에 안전하게 적용하고 있습니다.'});
    const applied=await this.local.applyFiles();identity=await this.local.identity();
    await this.remote.request('POST',base+`/devices/${identity.device_id}/ack`,{cursor:identity.cursor});
    return {deleted:false,conflicts:Object.values(state.conflicts).filter(c=>c.status==='open').length,failures:applied.failures,rejected:rejectedReceipts};
  }
}
