import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {CreateBucketCommand} from '@aws-sdk/client-s3';
import {fixture} from './helpers.ts';

test('real Python normalization, indexed search, immutable conversion and draft export publish through common commands',{skip:!process.env.UNIFIED_TEST_PROCESSOR_URL},async()=>{
  const f=await fixture();try{
    await f.storage.client.send(new CreateBucketCommand({Bucket:f.config.bucket}));
    const w=await f.workspace(),entry=randomUUID(),document=randomUUID(),version=randomUUID(),blob=randomUUID(),bytes=Buffer.from('Shared architecture keeps original documents safe.\n\n한국어 문서 검색도 유지합니다.');
    const ref={id:blob,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,mime_type:'text/plain'};
    const prepared=(await f.request('POST',`/v2/workspaces/${w.id}/blobs/prepare`,ref)).json();const put=await fetch(prepared.upload_url,{method:'PUT',headers:prepared.headers,body:bytes});assert.ok(put.ok);assert.equal((await f.request('POST',`/v2/workspaces/${w.id}/blobs/complete`,{id:blob})).statusCode,200);
    const envelope=(type:string,payload:unknown,bases={})=>({schema_version:2,operation_id:randomUUID(),workspace_id:w.id,device_id:w.device_id,workspace_epoch:1,type,payload,base_revisions:bases});
    const created=(await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[envelope('CreateEntry',{id:entry,parent_id:w.root_entry_id,kind:'file',name:'architecture.txt',document_id:document})]})).json();
    const revision=created.results[0].changes.find((c:{collection:string})=>c.collection==='documents').value.revision;
    const appended=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[envelope('AppendDocumentVersion',{version:{id:version,workspace_id:w.id,document_id:document,blob:ref,parent_version_ids:[],sources:[],created_at:new Date().toISOString(),created_by:f.me.id,change_note:'integration'},select_head:true},{[`documents:${document}`]:revision})]});assert.equal(appended.json().results[0].status,'applied',appended.body);
    await f.processing.tick();
    const normalized=await f.request('GET',`/v2/workspaces/${w.id}/versions/${version}/normalized`);assert.equal(normalized.json().state,'ready',normalized.body);assert.match(normalized.json().text,/Shared architecture/);assert.match(normalized.json().processor_fingerprint,/context-python-v2:/);
    const source=(await f.request('GET',`/v2/workspaces/${w.id}/ai/search?q=architecture&limit=20`)).json();assert.equal(source.results.length,1);assert.equal(source.results[0].document_id,document);
    const content=(await f.request('GET',`/v2/workspaces/${w.id}/versions/${version}/content`)).json();assert.equal(content.document_id,document);assert.ok(content.normalized.blocks.length);
    const request_id=randomUUID();const requested=await f.request('POST',`/v2/workspaces/${w.id}/versions/${version}/processing`,{request_id,kind:'convert',format:'docx'});assert.equal(requested.statusCode,202,requested.body);
    await f.processing.tick();
    const job=await f.request('GET',`/v2/workspaces/${w.id}/jobs/${request_id}`);assert.equal(job.json().status,'complete',job.body);const converted=(await f.request('GET',`/v2/workspaces/${w.id}/artifacts/${job.json().result.artifact_id}/download`)).json();const docx=Buffer.from(await (await fetch(converted.url)).arrayBuffer());assert.equal(docx.subarray(0,2).toString(),'PK');
    const draft=randomUUID(),writing={title:'Export draft',blocks:[{id:randomUUID(),type:'paragraph',text:'Preserved draft content',level:1,items:[],rows:[],source_ids:[]}]};
    const made=await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[envelope('CreateDraft',{id:draft,scope_id:w.root_entry_id,title:writing.title,content:JSON.stringify(writing)})]});assert.equal(made.json().results[0].status,'applied');
    const draftRevision=made.json().results[0].changes.find((c:{collection:string})=>c.collection==='drafts').value.revision;
    const exported=await f.request('POST',`/v2/workspaces/${w.id}/drafts/${draft}/export`,{revision:draftRevision,format:'hwpx'});assert.equal(exported.statusCode,200,exported.body);const hwpx=Buffer.from(await(await fetch(exported.json().url)).arrayBuffer());assert.equal(hwpx.subarray(0,2).toString(),'PK');
    const changes=(await f.request('GET',`/v2/workspaces/${w.id}/changes`)).json();assert.equal(changes.changes.filter((c:{changes:{collection:string}[]})=>c.changes.some(i=>i.collection==='artifacts')).length,2);
    const session=randomUUID();await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[envelope('CreateChatSession',{id:session,scope_id:w.root_entry_id,title:'Shared chat',sync:'shared'})]});
    const aiRequest=randomUUID(),aiInput={request_id:aiRequest,task:'chat',session_id:session,prompt:'Summarize the architecture',sources:[]};
    const answered=await f.request('POST',`/v2/workspaces/${w.id}/ai/context`,aiInput);assert.equal(answered.json().status,'complete',answered.body);const message=answered.json().result.message_id;assert.ok(message);
    await f.db.pool.query("UPDATE unified.processing_jobs SET status='queued',result=NULL WHERE workspace_id=$1 AND request_id=$2",[w.id,aiRequest]);
    const replayed=await f.request('POST',`/v2/workspaces/${w.id}/ai/context`,aiInput);assert.equal(replayed.json().result.message_id,message,replayed.body);
    const state=(await f.request('GET',`/v2/workspaces/${w.id}/bootstrap`)).json().state;assert.equal(Object.values(state.chat_messages).length,1);assert.equal(state.chat_messages[message].content,'Shared result survives retry.');assert.equal(state.chat_messages[message].sources[0].version_id,version,'Empty explicit sources must capture canonical document evidence once per request');
    const draftAnswer=await f.request('POST',`/v2/workspaces/${w.id}/ai/context`,{request_id:randomUUID(),task:'write',draft_id:draft,base_revision:draftRevision,prompt:'Improve this draft',sources:[],current:writing});assert.equal(draftAnswer.json().status,'complete',draftAnswer.body);assert.ok(draftAnswer.json().result.proposal_id);
  }finally{await f.close();}
});
