import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {validateDeployment} from './config.mjs';
import {validateFrontend} from '../../frontend/scripts/check-production-env.mjs';
const frontend={APP_ORIGIN:'https://web.unit',NEXT_PUBLIC_API_URL:'https://api.unit',NEXT_PUBLIC_WORKSPACE_API_URL:'https://sync.unit',NEXT_PUBLIC_SUPABASE_URL:'https://auth.unit',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic'};
const backend={NODE_ENV:'production',DATABASE_URL:'postgresql://user:synthetic@db/service',SUPABASE_URL:'https://auth.unit',SUPABASE_PUBLISHABLE_KEY:frontend.NEXT_PUBLIC_SUPABASE_ANON_KEY,AWS_S3_BUCKET:'private-documents',WEB_BASE_URL:'https://web.unit',UNIFIED_API_URL:'https://sync.unit',UNIFIED_PYTHON_URL:'http://processor.railway.internal:8000',INTERNAL_WORKER_TOKEN:'synthetic-private-token'.repeat(3),AI_CREDENTIALS_KEY:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',LEGACY_WORKSPACE_API_ENABLED:'false',CORS_ORIGINS:'["https://web.unit"]'};
backend.AWS_ACCESS_KEY_ID='synthetic-access';backend.AWS_SECRET_ACCESS_KEY='synthetic-secret';
test('deployment accepts a complete shared environment and rejects mismatched discovery',()=>{
  assert.deepEqual(validateDeployment(backend,frontend),[]);
  for(const [key,value] of [['UNIFIED_API_URL','https://other.unit'],['WEB_BASE_URL','https://other.unit'],['SUPABASE_URL','https://other.unit'],['CORS_ORIGINS','["*"]'],['LEGACY_WORKSPACE_API_ENABLED','true'],['INTERNAL_WORKER_TOKEN','short']]) assert.ok(validateDeployment({...backend,[key]:value},frontend).length>0,key);
});
test('cloud build rejects absent workspace origins, loopback, paths and privileged Supabase keys',()=>{
  for(const url of ['', 'http://localhost:8001', 'https://sync.unit/v2', 'https://user:private@sync.unit', 'https://REPLACE_WITH_DOMAIN']) assert.ok(validateFrontend({...frontend,NEXT_PUBLIC_WORKSPACE_API_URL:url}).length>0);
  const key='header.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.signature';
  assert.ok(validateFrontend({...frontend,NEXT_PUBLIC_SUPABASE_ANON_KEY:key}).length>0);
  assert.ok(validateFrontend({...frontend,NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_secret_private'}).length>0);
  const build=spawnSync(process.execPath,['frontend/scripts/check-production-env.mjs'],{env:{...frontend,VERCEL:'1',NEXT_PUBLIC_WORKSPACE_API_URL:''},encoding:'utf8'});
  assert.equal(build.status,1);assert.match(build.stderr,/NEXT_PUBLIC_WORKSPACE_API_URL/);
});
