import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {SignJWT} from 'jose';
import {configFromEnv} from '../src/config.ts';
import {createServer} from '../src/app.ts';
export async function fixture(options:{live?:boolean}={}) {
  const database=`unified_${randomUUID().replaceAll('-','')}_test`;
  const adminUrl=process.env.UNIFIED_TEST_ADMIN_URL||`postgresql://${encodeURIComponent(process.env.POSTGRES_USER||'workspace')}:${encodeURIComponent(process.env.POSTGRES_PASSWORD||'')}@127.0.0.1:${process.env.POSTGRES_PORT||5432}/postgres`;
  const admin=new pg.Pool({connectionString:adminUrl});
  if(!database.endsWith('_test'))throw new Error('Refusing to create a non-test database');
  await admin.query(`CREATE DATABASE "${database}"`);
  const url=new URL(adminUrl);url.pathname=`/${database}`;
  const secret='test-only-unified-secret-no-user-credential';
  const config=configFromEnv({UNIFIED_DATABASE_URL:url.toString(),UNIFIED_TEST_MODE:'1',SUPABASE_URL:'http://127.0.0.1:19999',SUPABASE_JWT_SECRET:secret,AWS_S3_BUCKET:`unified-test-${randomUUID()}`,UNIFIED_S3_ENDPOINT:process.env.UNIFIED_TEST_S3_ENDPOINT||'http://127.0.0.1:15001',UNIFIED_PYTHON_URL:process.env.UNIFIED_TEST_PROCESSOR_URL,INTERNAL_WORKER_TOKEN:process.env.UNIFIED_TEST_PROCESSOR_URL?'test-only-unified-worker-token':''});
  const services=await createServer(config);
  async function token(id=randomUUID(),extra:Record<string,unknown>={}) {return new SignJWT({role:'authenticated',email:`${id}@example.test`,...extra}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setSubject(id).setAudience('authenticated').setIssuer(`${config.supabaseUrl}/auth/v1`).setExpirationTime('1h').sign(new TextEncoder().encode(secret));}
  const ownerToken=await token(),headers={authorization:`Bearer ${ownerToken}`};
  let fixtureUser:unknown;
  if(options.live)services.app.get('/__fixture/config',async()=>({token:ownerToken,user:fixtureUser,protocol:2}));
  const me=(await services.app.inject({url:'/v2/me',headers})).json();
  fixtureUser=me;
  async function request(method:'GET'|'POST'|'PUT'|'DELETE',path:string,payload?:unknown,authHeaders=headers) {return services.app.inject({method,url:path,headers:{...authHeaders,...(payload===undefined?{}:{'content-type':'application/json'})},payload:payload===undefined?undefined:JSON.stringify(payload)});}
  async function workspace(name='Fixture') {const response=await request('POST','/v2/workspaces',{name});if(response.statusCode!==201)throw new Error(response.body);const w=response.json().workspace;const device_id=randomUUID();await request('POST',`/v2/workspaces/${w.id}/devices`,{device_id,name:'Test PC'});return {...w,device_id};}
  async function close() {await services.app.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();}
  return {...services,config,token,headers,me,request,workspace,close};
}
