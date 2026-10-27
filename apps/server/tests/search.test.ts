import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {fixture} from './helpers.ts';

test('current, full history and KST as-of searches select canonical versions and report pinned-reference identity',async()=>{
  const f=await fixture();try{
    const w=await f.workspace(),entry=randomUUID(),document=randomUUID(),blob=randomUUID(),sha=createHash('sha256').update('same fixture bytes').digest('hex');
    await f.db.pool.query('INSERT INTO unified.blobs(workspace_id,id,sha256,size,mime_type,storage_key,uploader_id,verified_at) VALUES($1,$2,$3,18,$4,$5,$6,now())',[w.id,blob,sha,'text/plain',`fixture/${blob}`,f.me.id]);
    const envelope=(type:string,payload:unknown,bases:Record<string,number>={})=>({schema_version:2,operation_id:randomUUID(),workspace_id:w.id,device_id:w.device_id,workspace_epoch:1,type,payload,base_revisions:bases});
    let result=(await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[envelope('CreateEntry',{id:entry,parent_id:w.root_entry_id,kind:'file',name:'History.txt',document_id:document})]})).json();
    let revision=result.results[0].changes.find((c:{collection:string})=>c.collection==='documents').value.revision;
    let parent:string|undefined;const versions=[];
    for(const [date,text]of [['2020-12-31T15:30:00.000Z','Unique historical architecture'],['2024-05-01T01:00:00.000Z','Unique current architecture']]){
      const version={id:randomUUID(),workspace_id:w.id,document_id:document,blob:{id:blob,sha256:sha,size:18,mime_type:'text/plain'},parent_version_ids:parent?[parent]:[],sources:[],created_at:date,created_by:f.me.id,change_note:'history fixture'};
      result=(await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[envelope('AppendDocumentVersion',{version,select_head:true},{[`documents:${document}`]:revision})]})).json();assert.equal(result.results[0].status,'applied');revision=result.results[0].changes.find((c:{collection:string})=>c.collection==='documents').value.revision;
      await f.db.pool.query('INSERT INTO unified.document_texts(workspace_id,version_id,document_id,artifact_id,processor_fingerprint,body) VALUES($1,$2,$3,$4,$5,$6)',[w.id,version.id,document,randomUUID(),'fixture',text]);parent=version.id;versions.push(version);
    }
    let response=(await f.request('GET',`/v2/workspaces/${w.id}/ai/search?q=architecture&scope=current`)).json();assert.equal(response.results.length,1);assert.equal(response.results[0].version_id,versions[1].id);assert.equal(response.results[0].is_current,true);assert.equal(response.results[0].version_number,2);
    response=(await f.request('GET',`/v2/workspaces/${w.id}/ai/search?q=architecture&scope=history`)).json();assert.equal(response.results.length,2);
    response=(await f.request('GET',`/v2/workspaces/${w.id}/ai/search?q=architecture&scope=as_of&as_of=2021-01-01`)).json();assert.equal(response.results.length,1);assert.equal(response.results[0].version_id,versions[0].id);assert.equal(response.results[0].is_current,false);
    response=(await f.request('GET',`/v2/workspaces/${w.id}/ai/search?q=architecture&scope=as_of&as_of=2020-12-31`)).json();assert.equal(response.results.length,0,'KST midnight cutoff must not include Jan 1 morning');
    assert.equal((await f.request('GET',`/v2/workspaces/${w.id}/ai/search?q=architecture&scope=as_of&as_of=2099-01-01`)).statusCode,422);
    result=(await f.request('POST',`/v2/workspaces/${w.id}/commands`,{commands:[envelope('SelectReferenceHead',{document_id:document,version_id:versions[0].id,pinned:true},{[`documents:${document}`]:revision})]})).json();assert.equal(result.results[0].status,'applied');
    response=(await f.request('GET',`/v2/workspaces/${w.id}/ai/search?q=architecture&scope=current`)).json();assert.equal(response.results[0].version_id,versions[0].id);assert.equal(response.results[0].is_current,true);assert.equal(response.results[0].version_number,1);
  }finally{await f.close();}
});
