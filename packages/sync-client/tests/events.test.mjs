import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeWorkspaceChanges } from '../../../apps/desktop/core/sync-client/src/index.js';
const until = async predicate => { const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)assert.fail('notification did not arrive');await new Promise(resolve=>setTimeout(resolve,5));} };
const event = (cursor,extra={}) => `data: ${JSON.stringify({cursor,epoch:1,deleted_at:null,...extra})}\n\n`;

test('chunked SSE hints wake cursor pull and disconnect reconnects without treating hints as state',async()=>{
  let calls=0,controller;const hints=[];
  const stop=subscribeWorkspaceChanges(async()=>{calls++;return new Response(new ReadableStream({start(c){controller=c;if(calls===1){c.enqueue(new TextEncoder().encode(event(4).slice(0,11)));c.enqueue(new TextEncoder().encode(event(4).slice(11)));c.close();}else c.enqueue(new TextEncoder().encode(': heartbeat\n\n'+event(9)));}}),{headers:{'Content-Type':'text/event-stream'}});},hint=>hints.push(hint),{retryMs:5});
  try{await until(()=>hints.length===2);assert.deepEqual(hints.map(h=>h.cursor),[4,9]);assert.equal(calls,2);}finally{stop();}
  assert.throws(()=>controller.enqueue(new Uint8Array()),/closed|invalid/i);
});

test('authorization failure terminates the stream while periodic pull remains a separate fallback',async()=>{
  let requests=0,errors=0;const stop=subscribeWorkspaceChanges(async()=>{requests++;return new Response(null,{status:403});},()=>assert.fail('forbidden hint'),{retryMs:1,onError:()=>errors++});
  try{await until(()=>errors===1);await new Promise(r=>setTimeout(r,20));assert.equal(requests,1);}finally{stop();}
});

test('deletion is a final wakeup and stop prevents late callbacks',async()=>{
  let controller,requests=0;const hints=[];
  const stop=subscribeWorkspaceChanges(async()=>{requests++;return new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode(event(12,{deleted_at:new Date().toISOString()})));}}),{headers:{'Content-Type':'text/event-stream'}});},hint=>hints.push(hint),{retryMs:1});
  await until(()=>hints.length===1);await new Promise(r=>setTimeout(r,20));stop();assert.equal(requests,1);assert.throws(()=>controller.enqueue(new Uint8Array()),/closed|invalid/i);
});

test('invalid or oversized notification frames cannot update workspace state',async()=>{
  let errors=0,hints=0;const stop=subscribeWorkspaceChanges(async()=>new Response('data: '+ 'x'.repeat(17000),{headers:{'Content-Type':'text/event-stream'}}),()=>hints++,{retryMs:1000,onError:()=>errors++});
  try{await until(()=>errors===1);assert.equal(hints,0);}finally{stop();}
});
