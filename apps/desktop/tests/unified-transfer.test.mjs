import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {UnifiedTransfer, unifiedURL, unifiedWebURL} from '../electron/unified-transfer.mjs';
import {createWorkspaceState, applyChanges} from '../core/domain/src/index.js';

function fixture({upload=false}={}) {
  const id=randomUUID(),user=randomUUID(),device=randomUUID(),now=new Date().toISOString();
  let state=createWorkspaceState({id,name:'Original',root_entry_id:randomUUID(),epoch:1,revision:0,created_at:now,updated_at:now,deleted_at:null}),cursor=0,pending=[];
  const config={serverBaseUrl:'https://api.example.test',session:{identity:randomUUID(),user:{id:user}},auth:{unified_api_url:'https://workspace.example.test',web_base_url:'https://web.example.test'}};
  const blob={id:randomUUID(),sha256:createHash('sha256').update('original').digest('hex'),size:8,mime_type:'text/plain'},bytes=Buffer.from('original');
  const command={schema_version:2,operation_id:randomUUID(),workspace_id:id,device_id:device,workspace_epoch:1,type:upload?'AppendDocumentVersion':'RenameWorkspace',payload:upload?{version:{id:randomUUID(),workspace_id:id,document_id:randomUUID(),blob,parent_version_ids:[],sources:[],created_at:now,created_by:user,change_note:'fixture'},select_head:true}:{name:'Renamed'},base_revisions:{[`workspace:${id}`]:0}};
  pending=[{command}]; const localCalls=[],networkCalls=[],events=[],receipts=new Map(); let loss=false,executions=0,changeOnUpload=false;
  const connections={read:async()=>structuredClone(config),token:async()=>'fixture-jwt'};
  const call=async(method,workspace,...args)=>{
    assert.equal(workspace,id);localCalls.push(method);
    if(method==='unifiedBind'||method==='unifiedPrepare'||method==='unifiedUploaded')return;
    if(method==='unifiedIdentity')return {workspace:state.workspace,device_id:device,cursor,linked:true};
    if(method==='unifiedPending')return structuredClone(pending);
    if(method==='unifiedBlob')return {...blob,data:bytes};
    if(method==='unifiedAcknowledge'){pending=pending.filter(item=>!args[0].some(r=>r.operation_id===item.command.operation_id));return;}
    if(method==='unifiedReceive'){const [changes,next]=args;for(const event of changes){state=applyChanges(state,event.changes);pending=pending.filter(item=>item.command.operation_id!==event.operation_id);}cursor=next;return;}
    if(method==='unifiedBootstrap'){[state,cursor]=args;return;}
    if(method==='unifiedState')return structuredClone(state);
    if(method==='unifiedMissing')return [];
    if(method==='unifiedApply')return {failures:[]};
    if(method==='unifiedStatus')return {linked:true,pending:!!pending.length,pending_count:pending.length,cursor,conflicts:0,applying:0};
    throw new Error(`Unexpected local call ${method}`);
  };
  const fetcher=async(url,init)=>{
    assert.equal(new URL(url).origin,'https://workspace.example.test');assert.equal(init.headers.Authorization,'Bearer fixture-jwt');networkCalls.push([url,init]);
    const path=new URL(url).pathname;
    if(path==='/v2/me')return Response.json({id:user});
    if(path.endsWith('/devices/ack'))return Response.json({cursor});
    if(path.endsWith('/ack'))return Response.json({cursor});
    if(path.includes('/changes')){const after=Number(new URL(url).searchParams.get('after'));const changes=events.filter(e=>e.sequence>after);return Response.json({changes,cursor:changes.at(-1)?.sequence||after,has_more:false,epoch:1});}
    if(path.endsWith('/blobs/prepare'))return Response.json({verified:false,upload_url:'https://storage.example.test/original',headers:{'x-amz-checksum-sha256':Buffer.from(blob.sha256,'hex').toString('base64'),'Content-Type':'text/plain'}});
    if(path.endsWith('/blobs/complete'))return Response.json({verified:true});
    if(path.endsWith('/commands')){
      const request=JSON.parse(init.body).commands[0];assert.equal(request.operation_id,command.operation_id);
      if(!receipts.has(request.operation_id)){executions++;const changes=[{collection:'workspace',id,value:{...state.workspace,name:'Renamed',revision:1}}];const receipt={operation_id:request.operation_id,status:'applied',sequence:1,changes,conflict_ids:[]};receipts.set(request.operation_id,receipt);events.push({sequence:1,epoch:1,operation_id:request.operation_id,changes});}
      if(loss)throw Object.assign(new Error('response lost'),{status:503});return Response.json({results:[receipts.get(request.operation_id)],cursor:1,epoch:1});
    }
    throw new Error(`Unexpected route ${url}`);
  };
  const uploader=async(url,init)=>{assert.equal(init.headers?.Authorization,undefined);assert.equal(init.headers?.authorization,undefined);if(changeOnUpload)config.session.identity=randomUUID();return new Response('',{status:200});};
  const transfer=()=>new UnifiedTransfer(connections,call,{fetcher,uploader});
  return {id,user,config,command,transfer,connections,call,localCalls,networkCalls,blob,bytes,lose:()=>{loss=true;},restore:()=>{loss=false;},changeOnUpload:()=>{changeOnUpload=true;},get pending(){return pending;},get executions(){return executions;},get state(){return state;}};
}

test('unified endpoint and web URL resolve configured origins and dev ports without weakening transport',()=>{
  assert.equal(unifiedURL({serverBaseUrl:'http://localhost:8000'}),'http://localhost:8001');
  assert.equal(unifiedURL({serverBaseUrl:'https://example.test',auth:{unified_api_url:'https://api.example.test/v2'}}),'https://api.example.test');
  assert.equal(unifiedWebURL({},'workspace-id','http://127.0.0.1:8001'),'http://127.0.0.1:3000/workspaces/workspace-id');
  assert.throws(()=>unifiedURL({serverBaseUrl:'http://public.example.test'}),/주소/);
  assert.throws(()=>unifiedURL({serverBaseUrl:'https://token@example.test'}),/주소/);
});

test('native change hints use the main-only credential and close on account changes',async t=>{
  const f=fixture(),transfer=f.transfer();let controller,hints=0,events=0;
  const fetcher=transfer.fetcher;
  transfer.fetcher=async(url,init)=>{
    if(!url.endsWith('/events'))return fetcher(url,init);
    events++;assert.equal(init.headers.Authorization,'Bearer fixture-jwt');assert.equal(new URL(url).search,'');
    return new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'Content-Type':'text/event-stream'}});
  };
  const until=async condition=>{const end=Date.now()+2000;while(!condition()){if(Date.now()>end)assert.fail('hint timeout');await new Promise(r=>setTimeout(r,5));}};
  t.after(()=>transfer.stopWatching());transfer.watch(f.id,()=>hints++);await until(()=>!!controller);
  controller.enqueue(new TextEncoder().encode('data: {"cursor":1,"epoch":1,"deleted_at":null}\n\n'));await until(()=>hints===1);
  transfer.watch(f.id,()=>hints++);assert.equal(events,1,'one subscription per linked workspace');
  f.config.session.identity=randomUUID();controller.enqueue(new TextEncoder().encode('data: {"cursor":2,"epoch":1,"deleted_at":null}\n\n'));
  await until(()=>transfer.watches.size===0);assert.equal(hints,1);
});

test('manual sync joins an already running notification-triggered sync for the same workspace',async()=>{
  const f=fixture(),transfer=f.transfer(),first=transfer.start(f.id),second=transfer.start(f.id);
  assert.strictEqual(first,second);assert.equal(transfer.states.get(f.id).phase,'preparing');assert.equal((await first).phase,'complete');assert.equal(f.executions,1);
});

test('lost command ACK resumes from preserved operation echo without duplicate execution',async()=>{
  const f=fixture();f.lose();await assert.rejects(f.transfer().start(f.id),/response lost/);assert.equal(f.pending.length,1);assert.equal(f.executions,1);
  f.restore();const result=await f.transfer().start(f.id);assert.equal(result.phase,'complete');assert.equal(f.executions,1);assert.equal(f.pending.length,0);assert.equal(f.state.workspace.name,'Renamed');
});

test('an account switch during signed upload stops before publishing and keeps pending work',async()=>{
  const f=fixture({upload:true});f.changeOnUpload();await assert.rejects(f.transfer().start(f.id),/계정 연결이 변경/);
  assert.equal(f.pending.length,1);assert.equal(f.executions,0);assert.ok(!f.networkCalls.some(([url])=>url.endsWith('/blobs/complete')));assert.ok(!f.networkCalls.some(([url])=>url.endsWith('/commands')));
});

test('raw transport accepts large bootstrap and rejects oversized or corrupt storage responses',async()=>{
  const f=fixture(),transfer=f.transfer(),job=await transfer.identity({id:f.id,controller:new AbortController()});
  transfer.fetcher=async()=>Response.json({text:'x'.repeat(3*1024*1024)});assert.equal((await transfer.request(job,'/v2/large')).text.length,3*1024*1024);
  transfer.fetcher=async()=>new Response('{}',{headers:{'Content-Length':String(129*1024*1024)}});await assert.rejects(transfer.request(job,'/v2/too-large'),/한도/);
  transfer.uploader=async(_url,init)=>{assert.equal(init.headers,undefined);return new Response('changed');};await assert.rejects(transfer.download(job,'https://storage.example.test/original',f.blob),/체크섬|기록/);
});
