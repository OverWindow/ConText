import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { origin, validateFrontend } from '../../frontend/scripts/check-production-env.mjs';

export async function loadDeployment(args = process.argv.slice(2)) {
  const backendFile = args[0] || '.env.backend.production', frontendFile = args[1] || '.env.frontend.production';
  return { backend: parseEnv(await readFile(backendFile, 'utf8')), frontend: parseEnv(await readFile(frontendFile, 'utf8')) };
}
export function validateDeployment(backend, frontend) {
  const local = frontend.CONTEXT_DEPLOYMENT_MODE === 'local', problems = validateFrontend(frontend, { local });
  const required = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'AWS_S3_BUCKET', 'WEB_BASE_URL', 'UNIFIED_API_URL', 'UNIFIED_PYTHON_URL', 'INTERNAL_WORKER_TOKEN', 'AI_CREDENTIALS_KEY'];
  for (const field of required) if (!backend[field] || /REPLACE_|^<|^\$\{/.test(backend[field])) problems.push(`${field}: required in the backend environment`);
  for (const field of ['WEB_BASE_URL', 'UNIFIED_API_URL', 'SUPABASE_URL']) {
    try { origin(backend[field], field, { local }); } catch (error) { problems.push(error.message); }
  }
  for (const [left, right] of [['WEB_BASE_URL', 'APP_ORIGIN'], ['UNIFIED_API_URL', 'NEXT_PUBLIC_WORKSPACE_API_URL'], ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL']]) {
    if (backend[left]?.replace(/\/$/, '') !== frontend[right]?.replace(/\/$/, '')) problems.push(`${left} and ${right} must match`);
  }
  if (backend.SUPABASE_PUBLISHABLE_KEY !== frontend.NEXT_PUBLIC_SUPABASE_ANON_KEY) problems.push('Public Supabase keys must match across web and Python');
  if ((backend.INTERNAL_WORKER_TOKEN || '').length < 32) problems.push('INTERNAL_WORKER_TOKEN: generate at least 32 random characters and share only between Node and Python');
  if (!/^[A-Za-z0-9_-]{43}=$/.test(backend.AI_CREDENTIALS_KEY || '') || Buffer.from(backend.AI_CREDENTIALS_KEY || '', 'base64url').length !== 32) problems.push('AI_CREDENTIALS_KEY: generate a 32-byte URL-safe base64 Fernet key');
  if (backend.LEGACY_WORKSPACE_API_ENABLED !== 'false') problems.push('LEGACY_WORKSPACE_API_ENABLED must be false');
  if (backend.NODE_ENV !== 'production') problems.push('NODE_ENV must be production on Node');
  if (!!backend.AWS_ACCESS_KEY_ID !== !!backend.AWS_SECRET_ACCESS_KEY) problems.push('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be configured together');
  if (!backend.AWS_ACCESS_KEY_ID && !backend.AWS_PROFILE && !(backend.AWS_ROLE_ARN && backend.AWS_WEB_IDENTITY_TOKEN_FILE) && !backend.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI && !backend.AWS_CONTAINER_CREDENTIALS_FULL_URI) problems.push('AWS credentials: configure a server key pair or an explicit SDK role provider');
  if (!local || backend.DATABASE_URL) {
    try { const url = new URL((backend.DATABASE_URL || '').replace('postgresql+psycopg://', 'postgresql://')); if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.pathname.slice(1)) throw new Error(); }
    catch { problems.push('DATABASE_URL: set the resolved PostgreSQL connection URL'); }
  } else if (!backend.POSTGRES_PASSWORD) problems.push('POSTGRES_PASSWORD: required for local Compose');
  try {
    const cors = JSON.parse(backend.CORS_ORIGINS || 'null');
    if (!Array.isArray(cors) || !cors.includes(origin(frontend.APP_ORIGIN, 'APP_ORIGIN', { local }))) throw new Error();
    for (const item of cors) origin(item, 'CORS_ORIGINS', { local });
  } catch { problems.push('CORS_ORIGINS: include the exact APP_ORIGIN in a JSON array'); }
  try { const url = new URL(backend.UNIFIED_PYTHON_URL); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(); }
  catch { problems.push('UNIFIED_PYTHON_URL: use the Python service origin on the private network'); }
  return [...new Set(problems)];
}
