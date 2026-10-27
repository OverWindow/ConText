import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from '../../apps/server/tests/helpers.ts';
const exec = promisify(execFile);
async function wait(url) {
  for (let i=0;i<60;i++) {
    try { const response=await fetch(url,{signal:AbortSignal.timeout(1500)});if(response.ok)return response; } catch {}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('Production image did not become healthy');
}
test('production images boot as non-root users, honor PORT, expose desktop discovery and reject missing configuration',{timeout:120000},async()=>{
  const f=await fixture(),directory=await mkdtemp(path.join(tmpdir(),'context-production-images-')),containers=[];
  const token='synthetic-private-internal-token'.repeat(2);
  const url=new URL(f.config.databaseUrl);url.hostname='host.docker.internal';
  async function run(name,image,port,values) {
    const filename=path.join(directory,`${name}.env`);
    await writeFile(filename,Object.entries(values).map(([key,value])=>`${key}=${value}`).join('\n'),{mode:0o600});
    await exec('docker',['run','-d','--name',name,'--env-file',filename,'-p',`127.0.0.1:${port}:${values.PORT}`,image]);containers.push(name);
  }
  try {
    await run('context-production-python-fixture','context-production-python-20261027',18005,{
      PORT:'9124',DATABASE_URL:url.toString(),SUPABASE_URL:'https://auth.unit',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic',LEGACY_WORKSPACE_API_ENABLED:'false',WEB_BASE_URL:'https://web.unit',UNIFIED_API_URL:'https://sync.unit',INTERNAL_WORKER_TOKEN:token,
    });
    await wait('http://127.0.0.1:18005/health');
    await exec('docker',['exec','context-production-python-fixture','alembic','upgrade','head']);
    const python=await fetch('http://127.0.0.1:18005/internal/v2/health',{headers:{Authorization:`Bearer ${token}`}});
    assert.equal(python.status,200);assert.equal((await python.json()).protocol,2);
    const discovery=await fetch('http://127.0.0.1:18005/api/desktop/auth/config').then(r=>r.json());
    assert.equal(discovery.unified_api_url,'https://sync.unit');assert.equal(discovery.web_base_url,'https://web.unit');assert.ok(!JSON.stringify(discovery).includes(token));
    assert.equal((await fetch('http://127.0.0.1:18005/api/workspaces')).status,410);
    await run('context-production-node-fixture','context-production-node-20261027',18004,{
      PORT:'9123',UNIFIED_PORT:'8001',NODE_ENV:'production',DATABASE_URL:url.toString(),SUPABASE_URL:'https://auth.unit',AWS_S3_BUCKET:'synthetic-no-storage-requests',CORS_ORIGINS:'["https://web.unit"]',UNIFIED_PYTHON_URL:'http://host.docker.internal:18005',INTERNAL_WORKER_TOKEN:token,
    });
    assert.equal((await (await wait('http://127.0.0.1:18004/health')).json()).protocol,2);
    await exec('docker',['exec','context-production-node-fixture','node','--import','tsx','src/migrate.ts']);
    assert.equal((await fetch('http://127.0.0.1:18004/v2/workspaces')).status,401);
    const cors=await fetch('http://127.0.0.1:18004/v2/workspaces',{method:'OPTIONS',headers:{Origin:'https://web.unit','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization,content-type'}});
    assert.equal(cors.headers.get('access-control-allow-origin'),'https://web.unit');
    await run('context-production-web-fixture','context-production-web-20261027',18006,{PORT:'3000',APP_ORIGIN:'https://web.unit'});
    assert.equal((await wait('http://127.0.0.1:18006/login')).status,200);
    for(const [name,expected] of [['context-production-node-fixture','1000'],['context-production-python-fixture','10001'],['context-production-web-fixture','1000']]) {
      assert.equal((await exec('docker',['exec',name,'id','-u'])).stdout.trim(),expected);
    }
    await assert.rejects(exec('docker',['run','--rm','-e','DATABASE_URL=postgresql://synthetic@database/service','context-production-node-20261027']),error=>error.code!==0&&error.stderr.includes('SUPABASE_URL is required'));
  } finally {
    for(const name of containers.reverse())await exec('docker',['rm','-f',name]).catch(()=>{});
    await f.close();await rm(directory,{recursive:true,force:true});
  }
});
