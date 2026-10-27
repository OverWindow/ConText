import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exec=promisify(execFile);
test('smoke CLI verifies discovery/auth/CORS and exits nonzero when readiness fails',async()=>{
  let origin='',healthy=true;
  const key='sb_publishable_synthetic';
  const server=createServer((request,response)=>{
    let body={status:'ok'};
    if(request.url==='/ready'){response.statusCode=healthy?200:503;body={status:healthy?'ok':'unavailable',protocol:2};}
    else if(request.url==='/api/desktop/auth/config')body={unified_api_url:origin,web_base_url:origin,supabase_url:'https://auth.unit',publishable_key:key};
    else if(request.url==='/api/workspaces')response.statusCode=410;
    else if(request.url==='/v2/workspaces'){
      if(request.method==='OPTIONS'){response.setHeader('access-control-allow-origin',origin);response.statusCode=204;}
      else response.statusCode=401;
    } else if(!['/health','/login'].includes(request.url))response.statusCode=404;
    response.setHeader('content-type','application/json');response.end(JSON.stringify(body));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');origin=`http://127.0.0.1:${server.address().port}`;
  const directory=await mkdtemp(path.join(tmpdir(),'context-deploy-smoke-'));
  try {
    const frontend={APP_ORIGIN:origin,NEXT_PUBLIC_API_URL:origin,NEXT_PUBLIC_WORKSPACE_API_URL:origin,NEXT_PUBLIC_SUPABASE_URL:'https://auth.unit',NEXT_PUBLIC_SUPABASE_ANON_KEY:key,CONTEXT_DEPLOYMENT_MODE:'local'};
    const backend={NODE_ENV:'production',DATABASE_URL:'postgresql://synthetic@db/service',SUPABASE_URL:'https://auth.unit',SUPABASE_PUBLISHABLE_KEY:key,AWS_S3_BUCKET:'synthetic',AWS_ACCESS_KEY_ID:'synthetic-access',AWS_SECRET_ACCESS_KEY:'synthetic-secret',WEB_BASE_URL:origin,UNIFIED_API_URL:origin,UNIFIED_PYTHON_URL:origin,INTERNAL_WORKER_TOKEN:'synthetic-private-token'.repeat(3),AI_CREDENTIALS_KEY:'A'.repeat(43)+'=',LEGACY_WORKSPACE_API_ENABLED:'false',CORS_ORIGINS:JSON.stringify([origin])};
    const files=[];
    for(const [name,values] of [['backend',backend],['frontend',frontend]]){const filename=path.join(directory,name);await writeFile(filename,Object.entries(values).map(([key,value])=>`${key}=${value}`).join('\n'),{mode:0o600});files.push(filename);}
    const result=await exec(process.execPath,['scripts/deploy/smoke.mjs',...files]);
    assert.equal(result.stdout.split('\n').filter(line=>line.startsWith('PASS')).length,7);
    assert.ok(!result.stdout.includes(backend.INTERNAL_WORKER_TOKEN));
    healthy=false;
    await assert.rejects(exec(process.execPath,['scripts/deploy/smoke.mjs',...files]),error=>error.code===1&&error.stdout.includes('FAIL Unified DB/storage/processor'));
  } finally {await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
