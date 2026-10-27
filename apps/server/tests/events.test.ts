import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.ts';

test('authenticated SSE wakes committed cursor pull, closes after deletion and releases on shutdown', {timeout:15000}, async()=>{
  const f=await fixture(),controller=new AbortController();let closed=false;
  try {
    const workspace=await f.workspace();await f.app.listen({host:'127.0.0.1',port:0});
    const address=f.app.server.address();if(!address||typeof address==='string')throw new Error('Missing fixture port');
    const origin=`http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${origin}/v2/workspaces/${workspace.id}/events`)).status,401);
    const response=await fetch(`${origin}/v2/workspaces/${workspace.id}/events`,{headers:f.headers,signal:controller.signal});assert.equal(response.status,200);
    const reader=response.body!.getReader();let buffer='';const decoder=new TextDecoder();
    async function next():Promise<{cursor:number;epoch:number;deleted_at:string|null}|null> {
      for(;;){const end=buffer.indexOf('\n\n');if(end!==-1){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const line=block.split('\n').find(l=>l.startsWith('data:'));if(line)return JSON.parse(line.slice(5));continue;}const part=await reader.read();if(part.done)return null;buffer+=decoder.decode(part.value,{stream:true});}
    }
    assert.equal((await next())!.cursor,0);
    const command={schema_version:2,operation_id:randomUUID(),workspace_id:workspace.id,device_id:workspace.device_id,workspace_epoch:1,type:'CreateEntry',payload:{id:randomUUID(),parent_id:workspace.root_entry_id,kind:'folder',name:'Committed'},base_revisions:{}};
    assert.equal((await f.request('POST',`/v2/workspaces/${workspace.id}/commands`,{commands:[command]})).json().results[0].status,'applied');
    assert.equal((await next())!.cursor,1);
    const bootstrap=(await f.request('GET',`/v2/workspaces/${workspace.id}/bootstrap`)).json();
    const remove={...command,operation_id:randomUUID(),type:'DeleteWorkspace',payload:{},base_revisions:{[`workspace:${workspace.id}`]:bootstrap.state.workspace.revision}};
    assert.equal((await f.request('POST',`/v2/workspaces/${workspace.id}/commands`,{commands:[remove]})).json().results[0].status,'applied');
    assert.ok((await next())!.deleted_at);assert.equal(await next(),null);reader.releaseLock();
    const other=await f.workspace('Shutdown');const open=await fetch(`${origin}/v2/workspaces/${other.id}/events`,{headers:f.headers,signal:controller.signal});const openReader=open.body!.getReader();await openReader.read();
    await f.close();closed=true;assert.equal((await openReader.read()).done,true);openReader.releaseLock();
  }finally{controller.abort();if(!closed)await f.close();}
});

test('SSE membership is revalidated while the connection remains open', {timeout:10000}, async()=>{
  const f=await fixture(),controller=new AbortController();
  try {
    const workspace=await f.workspace(),otherHeaders={authorization:`Bearer ${await f.token()}`};
    const other=(await f.request('GET','/v2/me',undefined,otherHeaders)).json();await f.request('PUT',`/v2/workspaces/${workspace.id}/members`,{email:other.email,role:'VIEWER'});
    await f.app.listen({host:'127.0.0.1',port:0});const address=f.app.server.address();if(!address||typeof address==='string')throw new Error('Missing fixture port');
    const response=await fetch(`http://127.0.0.1:${address.port}/v2/workspaces/${workspace.id}/events`,{headers:otherHeaders,signal:controller.signal}),reader=response.body!.getReader();await reader.read();
    await f.request('DELETE',`/v2/workspaces/${workspace.id}/members/${other.id}`);assert.equal((await reader.read()).done,true);reader.releaseLock();
  }finally{controller.abort();await f.close();}
});
