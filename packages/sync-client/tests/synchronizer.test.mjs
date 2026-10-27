import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WorkspaceSynchronizer } from '../../../apps/desktop/core/sync-client/src/index.js';

function fixture({ linked = true } = {}) {
  const workspace = { id: randomUUID(), name: '로컬 폴더', root_entry_id: randomUUID(), epoch: 1, revision: 1 };
  const device = randomUUID(), events = [], queue = [], calls = [];
  let cursor = 0, applied = false;
  const state = { workspace, versions: {}, conflicts: {} };
  const local = {
    prepare: async () => calls.push('prepare'), identity: async () => ({workspace: state.workspace, device_id: device, cursor, linked}),
    pending: async () => queue, blob: async () => new Uint8Array([1,2]), uploaded: async () => {},
    acknowledge: async receipts => { for (const receipt of receipts) queue.splice(queue.findIndex(item => item.command.operation_id === receipt.operation_id), 1); },
    bootstrap: async (snapshot, next) => { state.workspace = snapshot.workspace; cursor = next; linked = true; },
    receive: async (changes, next) => { for (const event of changes) { const i=queue.findIndex(item=>item.command.operation_id===event.operation_id); if(i>=0)queue.splice(i,1); } cursor = next; },
    state: async () => state, missing: async () => [], receiveBlob: async () => {},
    applyFiles: async () => { applied = true; return { failures: [] }; },
  };
  const remote = {
    request: async (method, path, body) => {
      calls.push([method,path,body]);
      if(path.endsWith('/bootstrap'))return {state,cursor};
      if(path.includes('/changes?')) {
        const after=Number(new URL('https://local.test'+path).searchParams.get('after'));
        const changes=events.filter(event=>event.sequence>after).slice(0,1);
        return {changes,cursor:changes.at(-1)?.sequence??after,has_more:events.some(event=>event.sequence>(changes.at(-1)?.sequence??after))};
      }
      if(path.endsWith('/commands'))return {results:body.commands.map(command=>{
        events.push({sequence:events.length+1,operation_id:command.operation_id,changes:[],epoch:1});
        return {operation_id:command.operation_id,status:'applied'};
      })};
      return {};
    }, upload:async()=>{},download:async()=>new Uint8Array(),
  };
  const enqueue = () => { const command = {schema_version:2,operation_id:randomUUID(),workspace_id:workspace.id,device_id:device,workspace_epoch:1,type:'RenameWorkspace',payload:{name:'새 이름'},base_revisions:{[`workspace:${workspace.id}`]:1}};queue.push({command});return command; };
  return {local,remote,enqueue,events,queue,calls,state,get cursor(){return cursor;},get applied(){return applied;}};
}

test('pulls every committed page before push and ACKs only after safe file application', async()=>{
  const f=fixture(); f.events.push({sequence:1,operation_id:randomUUID(),changes:[],epoch:1},{sequence:2,operation_id:randomUUID(),changes:[],epoch:1}); f.enqueue();
  const result=await new WorkspaceSynchronizer(f.local,f.remote).run();
  assert.equal(f.cursor,3); assert.equal(f.queue.length,0); assert.equal(f.applied,true); assert.equal(result.deleted,false);
  const push=f.calls.findIndex(call=>Array.isArray(call)&&call[1].endsWith('/commands'));
  assert.equal(f.calls.slice(0,push).filter(call=>Array.isArray(call)&&call[1].includes('/changes?')).length,2);
  assert.equal(f.calls.at(-1)[1].endsWith('/ack'),true); assert.equal(f.calls.at(-1)[2].cursor,3);
});

test('lost command response is recovered from the operation echo without a second execution',async()=>{
  const f=fixture(),operation=f.enqueue(),request=f.remote.request;let executions=0;
  f.remote.request=async(method,path,body)=>{const result=await request(method,path,body);if(path.endsWith('/commands')){executions++;throw new Error('ACK lost');}return result;};
  await assert.rejects(new WorkspaceSynchronizer(f.local,f.remote).run(),/ACK lost/);
  assert.equal(f.queue[0].command.operation_id,operation.operation_id);
  await new WorkspaceSynchronizer(f.local,f.remote).run();assert.equal(executions,1);assert.equal(f.queue.length,0);assert.equal(f.cursor,1);
});

test('first link recovers an existing renamed server workspace without recreating it',async()=>{
  const f=fixture({linked:false});f.state.workspace.name='서버에서 바뀐 이름';
  await new WorkspaceSynchronizer(f.local,f.remote).run();
  assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==='POST'&&call[1]==='/v2/workspaces'),false);
  assert.equal(f.calls.filter(call=>Array.isArray(call)&&call[1].endsWith('/devices')).length,1);
});

test('deleted workspace stops pending edits before push and keeps them recoverable locally',async()=>{
  const f=fixture();f.enqueue();f.state.workspace.deleted_at=new Date().toISOString();
  assert.equal((await new WorkspaceSynchronizer(f.local,f.remote).run()).deleted,true);
  assert.equal(f.queue.length,1);assert.equal(f.applied,false);assert.equal(f.calls.some(call=>Array.isArray(call)&&call[1].endsWith('/commands')),false);
});

test('rejected command and wrong receipts never acknowledge local work',async()=>{
  const f=fixture();f.enqueue();const request=f.remote.request;
  f.remote.request=(method,path,body)=>path.endsWith('/commands')?{results:[{operation_id:randomUUID(),status:'applied'}]}:request(method,path,body);
  await assert.rejects(new WorkspaceSynchronizer(f.local,f.remote).run(),{code:'INVALID_RECEIPT'});assert.equal(f.queue.length,1);
});

test('one permanent rejection does not block unrelated later batches',async()=>{
  const f=fixture();for(let i=0;i<102;i++)f.enqueue();const denied=f.queue[0].command.operation_id,request=f.remote.request;let batches=0;
  const receipts=[];const acknowledge=f.local.acknowledge;f.local.acknowledge=async result=>{receipts.push(...result);await acknowledge(result);};
  f.remote.request=async(method,path,body)=>{
    const result=await request(method,path,body);if(path.endsWith('/commands')){batches++;for(const receipt of result.results)if(receipt.operation_id===denied){receipt.status='rejected';receipt.error={code:'ENTRY_DELETED',message:'Entry is deleted'};}}
    return result;
  };
  const result=await new WorkspaceSynchronizer(f.local,f.remote).run();assert.equal(batches,2);assert.equal(f.queue.length,0);
  assert.equal(result.rejected[0].operation_id,denied);assert.equal(receipts.filter(r=>r.status==='applied').length,101);assert.equal(f.applied,true);
});
