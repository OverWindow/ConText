import test from 'node:test';
import assert from 'node:assert/strict';
import {configFromEnv} from '../src/config.ts';
import {Readiness} from '../src/readiness.ts';
const production = { NODE_ENV:'production', UNIFIED_DATABASE_URL:'postgresql://user:secret@database/service', SUPABASE_URL:'https://auth.unit', AWS_S3_BUCKET:'private-documents', CORS_ORIGINS:'["https://web.unit"]', UNIFIED_PYTHON_URL:'http://processor.railway.internal:8000', INTERNAL_WORKER_TOKEN:'a'.repeat(64) };
test('production listens on the platform port and validates required dependencies before startup',()=>{
  const config=configFromEnv({...production,PORT:'9123',UNIFIED_PORT:'8001'});
  assert.equal(config.port,9123);assert.equal(config.host,'0.0.0.0');
  for(const key of ['SUPABASE_URL','AWS_S3_BUCKET','CORS_ORIGINS','UNIFIED_PYTHON_URL','INTERNAL_WORKER_TOKEN']) assert.throws(()=>configFromEnv({...production,[key]:''}),new RegExp(key));
  assert.throws(()=>configFromEnv({...production,UNIFIED_TEST_MODE:'1'}),/Production cannot/);
  assert.throws(()=>configFromEnv({...production,INTERNAL_WORKER_TOKEN:'short'}),/32 characters/);
  for(const PORT of ['abc','0','65536','1.5']) assert.throws(()=>configFromEnv({...production,PORT}),/PORT/);
  assert.throws(()=>configFromEnv({...production,UNIFIED_DATABASE_URL:'invalid private database password'}),error=>error instanceof Error && error.message === 'UNIFIED_DATABASE_URL must be a valid PostgreSQL connection URL');
  for(const CORS_ORIGINS of ['[]','["*"]','["http://web.unit"]','["https://web.unit/path"]']) assert.throws(()=>configFromEnv({...production,CORS_ORIGINS}));
});
test('readiness reports each failed dependency without leaking its exception and shares probes',async()=>{
  let release!:()=>void,calls=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const readiness=new Readiness({database:async()=>{calls++;await gate;},storage:async()=>{throw new Error('private access key');},processor:async()=>{} });
  const first=readiness.check(),second=readiness.check();release();
  const expected={status:'unavailable',protocol:2,checks:{database:'ok',storage:'unavailable',processor:'ok'}};
  assert.deepEqual(await first,expected);assert.deepEqual(await second,expected);assert.deepEqual(await readiness.check(),expected);assert.equal(calls,1);
  assert.ok(!JSON.stringify(await first).includes('private access key'));
});
test('readiness recovers after its cache expires',async()=>{
  let healthy=false;
  const readiness=new Readiness({database:async()=>{},storage:async()=>{if(!healthy)throw new Error();},processor:async()=>{}},0);
  assert.equal((await readiness.check()).status,'unavailable');healthy=true;assert.equal((await readiness.check()).status,'ok');
});
test('a stalled dependency cannot keep deployment readiness pending forever',async()=>{
  const readiness=new Readiness({database:()=>new Promise(()=>{}),storage:async()=>{},processor:async()=>{}},0,10);
  assert.deepEqual(await readiness.check(),{status:'unavailable',protocol:2,checks:{database:'unavailable',storage:'ok',processor:'ok'}});
});
