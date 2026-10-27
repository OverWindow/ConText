import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sampleData } from '../assets/harulab-sample.ts';
const root=fileURLToPath(new URL('../../../test-data/하루랩_스타트업_샘플/',import.meta.url));
async function files(directory,prefix='') {
  const result=[];
  for(const item of await readdir(directory,{withFileTypes:true})) {
    if(item.name.startsWith('.')||item.isSymbolicLink())continue;
    const name=prefix+item.name;
    if(item.isDirectory())result.push(...await files(path.join(directory,item.name),name+'/'));
    else if(item.isFile())result.push(name);
  }
  return result.sort();
}
test('bundled preview matches every visible fictional source and includes no answer sheets or local paths',async()=>{
  assert.deepEqual(sampleData.documents.map(item=>item.path).sort(),await files(root));
  assert.equal(new Set(sampleData.entries.map(entry=>entry.id)).size,sampleData.entries.length);
  for(const item of sampleData.documents) {
    const bytes=await readFile(path.join(root,item.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256,item.path);
    if(item.image_url)assert.deepEqual(Buffer.from(item.image_url.split(',')[1],'base64'),bytes);
    else if(bytes.length)assert.ok(item.content?.blocks.length,item.path);
    const entry=sampleData.entries.find(entry=>entry.id===item.entry_id);assert.equal(entry.relative_path,item.path);
  }
  assert.ok(!JSON.stringify(sampleData).includes('/Users/'));
  assert.ok(!sampleData.documents.some(item=>/테스트정답|테스트안내|^\./.test(item.path)));
});
