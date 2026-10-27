import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {CreateBucketCommand, HeadObjectCommand} from '@aws-sdk/client-s3';
import {fixture} from './helpers.ts';
import type {CommandEnvelope} from '../../../packages/contracts/src/index.ts';
function command(w:{id:string;device_id:string;epoch:number},type:string,payload:unknown,bases:Record<string,number>={}):CommandEnvelope {return {schema_version:2,operation_id:randomUUID(),workspace_id:w.id,device_id:w.device_id,workspace_epoch:w.epoch,type,payload,base_revisions:bases} as CommandEnvelope;}

test('real PostgreSQL commands are ordered, idempotent and preserve stale edits',async()=>{
  const f=await fixture();try {
    const w=await f.workspace(),id=randomUUID(),draft=randomUUID();
    const create=command(w,'CreateEntry',{id,parent_id:w.root_entry_id,kind:'folder',name:'Nested'});
    let response=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[create]});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().cursor,1);
    response=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[create]});assert.equal(response.json().cursor,1);assert.equal(response.json().results[0].sequence,1);
    response=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[{...create,payload:{...create.payload,name:'changed'}}]});assert.equal(response.statusCode,409);
    const createDraft=command(w,'CreateDraft',{id:draft,scope_id:id,title:'Draft',content:'original'});
    response=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[createDraft]});assert.equal(response.json().results[0].status,'applied',response.body);
    const revision=response.json().results[0].changes.find((v:{collection:string})=>v.collection==='drafts').value.revision;
    const a=command(w,'SaveDraft',{id:draft,title:'Draft',content:'first',sources:[]},{[`drafts:${draft}`]:revision});
    const b=command(w,'SaveDraft',{id:draft,title:'Draft',content:'offline second',sources:[]},{[`drafts:${draft}`]:revision});
    const replies=await Promise.all([a,b].map(c=>f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[c]})));
    assert.deepEqual(replies.map(r=>r.json().results[0].status).sort(),['applied','conflict']);
    const boot=(await f.request('GET',`/v2/workspaces/${w.id}/bootstrap`)).json();assert.equal(boot.cursor,4);assert.equal(Object.keys(boot.state.conflicts).length,1);assert.equal(Object.keys(boot.state.proposals).length,1);
    const first=(await f.request('GET',`/v2/workspaces/${w.id}/changes?after=0&limit=2`)).json();assert.equal(first.has_more,true);assert.deepEqual(first.changes.map((c:{sequence:number})=>c.sequence),[1,2]);
    const second=(await f.request('GET',`/v2/workspaces/${w.id}/changes?after=${first.cursor}&limit=2`)).json();assert.equal(second.has_more,false);assert.deepEqual(second.changes.map((c:{sequence:number})=>c.sequence),[3,4]);
  } finally {await f.close();}
});

test('authentication, membership, role revocation and deletion epoch guard every path',async()=>{
  const f=await fixture();try {
    assert.equal((await f.app.inject({url:'/v2/me'})).statusCode,401);
    const anonymous=await f.token(undefined,{is_anonymous:true});assert.equal((await f.request('GET','/v2/me',undefined,{authorization:`Bearer ${anonymous}`})).statusCode,401);
    const w=await f.workspace();const otherToken=await f.token(),otherHeaders={authorization:`Bearer ${otherToken}`};
    assert.equal((await f.request('GET',`/v2/workspaces/${w.id}/bootstrap`,undefined,otherHeaders)).statusCode,404);
    const other=(await f.request('GET','/v2/me',undefined,otherHeaders)).json();
    assert.equal((await f.request('PUT',`/v2/workspaces/${w.id}/members`,{email:other.email,role:'VIEWER'})).statusCode,200);
    const device=randomUUID();await f.request('POST',`/v2/workspaces/${w.id}/devices`,{device_id:device},otherHeaders);
    let result=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[command({...w,device_id:device},'CreateEntry',{id:randomUUID(),parent_id:w.root_entry_id,name:'Denied',kind:'folder'})]},otherHeaders);assert.equal(result.json().results[0].status,'rejected');
    await f.request('DELETE',`/v2/workspaces/${w.id}/members/${other.id}`);
    assert.equal((await f.request('GET',`/v2/workspaces/${w.id}/changes`,undefined,otherHeaders)).statusCode,404);
    const del=command(w,'DeleteWorkspace',{}, {[`workspace:${w.id}`]:0});result=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[del]});assert.equal(result.json().epoch,2,result.body);
    const changes=(await f.request('GET',`/v2/workspaces/${w.id}/changes`)).json();assert.ok(changes.deleted_at);assert.equal(changes.epoch,2);
    assert.equal((await f.request('POST',`/v2/workspaces/${w.id}/devices`,{device_id:w.device_id})).statusCode,410);
    assert.equal((await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[command(w,'RenameWorkspace',{name:'resurrect'},{[`workspace:${w.id}`]:1})]})).statusCode,410);
    assert.equal((await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[del]})).json().results[0].status,'applied');
  } finally {await f.close();}
});

test('S3 signed PUT verifies immutable checksum and real HTTP private download before versions publish',async()=>{
  const f=await fixture();try {
    await f.storage.client.send(new CreateBucketCommand({Bucket:f.config.bucket}));
    await f.app.listen({host:'127.0.0.1',port:0});
    const base=f.app.listeningOrigin,headers={...f.headers,'Content-Type':'application/json'};
    const w=await f.workspace(),entry=randomUUID(),doc=randomUUID(),version=randomUUID(),blobId=randomUUID();const bytes=Buffer.from('Desktop and web share these exact bytes.\n');const sha256=createHash('sha256').update(bytes).digest('hex');
    const prep=await fetch(`${base}/v2/workspaces/${w.id}/blobs/prepare`,{method:'POST',headers,body:JSON.stringify({id:blobId,sha256,size:bytes.length,mime_type:'text/plain'})});assert.equal(prep.status,200);const upload=await prep.json() as {upload_url:string;headers:Record<string,string>};assert.ok(upload.upload_url.startsWith(f.config.s3Endpoint!));
    const missing=await f.request('POST',`/v2/workspaces/${w.id}/blobs/complete`,{id:blobId});assert.equal(missing.statusCode,409);
    const put=await fetch(upload.upload_url,{method:'PUT',headers:upload.headers,body:bytes});assert.ok(put.ok,await put.text());
    const completed=await f.request('POST',`/v2/workspaces/${w.id}/blobs/complete`,{id:blobId});assert.equal(completed.statusCode,200,completed.body+JSON.stringify(await f.storage.client.send(new HeadObjectCommand({Bucket:f.config.bucket,Key:`teams/unified/workspaces/${w.id}/blobs/${blobId}`,ChecksumMode:'ENABLED'}))));
    const recoveryPath=`/v2/workspaces/${w.id}/blobs/${blobId}/recovery`;
    const recovered=await f.request('GET',recoveryPath);assert.equal(recovered.statusCode,200);assert.deepEqual(Buffer.from(await (await fetch(recovered.json().url)).arrayBuffer()),bytes,'unpublished original remains downloadable');
    const otherHeaders={authorization:`Bearer ${await f.token()}`},other=(await f.request('GET','/v2/me',undefined,otherHeaders)).json();
    assert.equal((await f.request('GET',recoveryPath,undefined,otherHeaders)).statusCode,404);
    await f.request('PUT',`/v2/workspaces/${w.id}/members`,{email:other.email,role:'EDITOR'});
    assert.equal((await f.request('GET',recoveryPath,undefined,otherHeaders)).statusCode,403,'another editor cannot access unpublished uploads');
    const second=await f.workspace();assert.equal((await f.request('GET',`/v2/workspaces/${second.id}/blobs/${blobId}/recovery`)).statusCode,404);
    assert.equal((await f.request('POST',`/v2/workspaces/${w.id}/blobs/prepare`,{id:blobId,sha256:'a'.repeat(64),size:bytes.length,mime_type:'text/plain'})).statusCode,409);
    const create=command(w,'CreateEntry',{id:entry,parent_id:w.root_entry_id,kind:'file',name:'shared.txt',document_id:doc});const result=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[create]});const revision=result.json().results[0].changes.find((v:{collection:string})=>v.collection==='documents').value.revision;
    const append=command(w,'AppendDocumentVersion',{version:{id:version,workspace_id:w.id,document_id:doc,blob:{id:blobId,sha256,size:bytes.length,mime_type:'text/plain'},parent_version_ids:[],sources:[],created_at:new Date().toISOString(),created_by:f.me.id,change_note:'Cross-platform fixture'},select_head:true},{[`documents:${doc}`]:revision});
    const committed=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[append]});assert.equal(committed.json().results[0].status,'applied',committed.body);
    const download=(await f.request('GET',`/v2/workspaces/${w.id}/versions/${version}/download`)).json();const fetched=await fetch(download.url);assert.equal(fetched.status,200);assert.deepEqual(Buffer.from(await fetched.arrayBuffer()),bytes);
    assert.match(fetched.headers.get('content-disposition')||'',/attachment/);
  } finally {await f.close();}
});

test('initial import preserves 25,001 entries and pages all 2,001+ siblings without a hidden cap',async()=>{
  const f=await fixture();try{
    const w=await f.workspace('Large fixture');
    const state=(await f.request('GET',`/v2/workspaces/${w.id}/bootstrap`)).json().state;
    for(let i=0;i<25001;i++){
      const id=randomUUID();state.entries[id]={id,workspace_id:w.id,parent_id:w.root_entry_id,kind:'folder',name:`Folder ${String(i).padStart(5,'0')}`,document_id:null,revision:1,position_revision:0,x:null,y:null,area_positioned:false,deleted_at:null};
    }
    const imported=await f.request('POST',`/v2/workspaces/${w.id}/import`,command(w,'ImportWorkspace',{state},{[`workspace:${w.id}`]:0}));assert.equal(imported.statusCode,200,imported.body.slice(0,500));assert.equal(imported.json().results[0].status,'applied');
    let cursor:string|undefined,seen=0;const ids=new Set();
    do{
      const page=(await f.request('GET',`/v2/workspaces/${w.id}/entries?limit=1000${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`)).json();assert.ok(page.entries.length<=1000);for(const entry of page.entries){assert.ok(!ids.has(entry.id));ids.add(entry.id);}seen+=page.entries.length;cursor=page.next_cursor||undefined;
    }while(cursor);
    assert.equal(seen,25001);assert.equal(Object.keys((await f.request('GET',`/v2/workspaces/${w.id}/bootstrap`)).json().state.entries).length,25002);
    const page=(await f.request('GET',`/v2/workspaces/${w.id}/search?q=folder&limit=1000`)).json();assert.equal(page.entries.length,1000);assert.ok(page.has_more);
    const forbidden=await f.request('POST',`/v2/workspaces/${w.id}/import`,command(w,'ImportWorkspace',{state},{[`workspace:${w.id}`]:1}));assert.equal(forbidden.json().results[0].status,'rejected');
  }finally{await f.close();}
});

test('PostgreSQL persists folder name swaps and mixed rename/create/reparent as one final graph',async()=>{
  const f=await fixture();try{
    const w=await f.workspace(),a=randomUUID(),b=randomUUID(),c=randomUUID(),file=randomUUID(),document=randomUUID();
    const creates=[{id:a,parent_id:w.root_entry_id,kind:'folder',name:'A'},{id:b,parent_id:w.root_entry_id,kind:'folder',name:'B'},{id:c,parent_id:w.root_entry_id,kind:'folder',name:'C'},{id:file,parent_id:c,kind:'file',name:'kept.txt',document_id:document}];
    const created=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:creates.map(payload=>command(w,'CreateEntry',payload))});assert.ok(created.json().results.every((r:{status:string})=>r.status==='applied'),created.body);
    const swap=command(w,'MoveEntries',{moves:[{id:a,parent_id:w.root_entry_id,name:'B'},{id:b,parent_id:w.root_entry_id,name:'A'}]},{[`entries:${a}`]:1,[`entries:${b}`]:1});
    const swapped=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[swap]});assert.equal(swapped.statusCode,200,swapped.body);assert.equal(swapped.json().results[0].status,'applied',swapped.body);
    let boot=(await f.request('GET',`/v2/workspaces/${w.id}/bootstrap`)).json();assert.equal(boot.state.entries[a].name,'B');assert.equal(boot.state.entries[b].name,'A');assert.equal(boot.state.entries[a].revision,2);
    const newC=randomUUID(),mixed=command(w,'ReconcileEntries',{creates:[{id:newC,parent_id:w.root_entry_id,kind:'folder',name:'C'}],moves:[{id:c,parent_id:w.root_entry_id,name:'D'},{id:file,parent_id:newC,name:'kept.txt'}]},{[`entries:${c}`]:1,[`entries:${file}`]:1});
    const reconciled=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[mixed]});assert.equal(reconciled.statusCode,200,reconciled.body);assert.equal(reconciled.json().results[0].status,'applied',reconciled.body);
    boot=(await f.request('GET',`/v2/workspaces/${w.id}/bootstrap`)).json();assert.equal(boot.state.entries[c].name,'D');assert.equal(boot.state.entries[newC].name,'C');assert.equal(boot.state.entries[file].parent_id,newC);assert.equal(boot.state.entries[file].document_id,document);assert.equal(Object.keys(boot.state.documents).length,1);
    const duplicate=command(w,'MoveEntries',{moves:[{id:a,parent_id:w.root_entry_id,name:'A'},{id:b,parent_id:w.root_entry_id,name:'A'}]},{[`entries:${a}`]:2,[`entries:${b}`]:2});
    const rejected=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[duplicate]});assert.equal(rejected.json().results[0].status,'rejected',rejected.body);
    const after=(await f.request('GET',`/v2/workspaces/${w.id}/bootstrap`)).json();assert.deepEqual(after.state,boot.state);assert.equal(after.cursor,boot.cursor,'Invalid final tree must not publish a partial rename');
    const events=(await f.request('GET',`/v2/workspaces/${w.id}/changes?after=4&limit=100`)).json().changes;assert.equal(events.length,2);assert.deepEqual(events[0].changes.filter((change:{collection:string})=>change.collection==='entries').map((change:{value:{name:string}})=>change.value.name).sort(),['A','B']);assert.equal(events[1].operation_id,mixed.operation_id);assert.ok(!JSON.stringify(events).includes(':temporary'));
  }finally{await f.close();}
});
