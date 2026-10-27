export interface ServerConfig {
  databaseUrl: string; port: number; host: string; supabaseUrl: string;
  supabaseJwtSecret: string; audience: string; corsOrigins: string[];
  bucket: string; region: string; s3Endpoint?: string; storageFixture: boolean;
  maxUploadBytes: number; maxWorkspaceBytes: number; urlTtl: number;
  pythonUrl: string; internalWorkerToken: string; testMode: boolean;
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = (env.UNIFIED_DATABASE_URL || env.DATABASE_URL || '').replace('postgresql+psycopg://','postgresql://');
  if (!databaseUrl) throw new Error('UNIFIED_DATABASE_URL is required');
  const testMode = env.UNIFIED_TEST_MODE === '1';
  const production = env.NODE_ENV === 'production';
  if (production && testMode) throw new Error('Production cannot use UNIFIED_TEST_MODE');
  let database: string;
  try {
    const url = new URL(databaseUrl);
    if (!['postgresql:','postgres:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error();
    database = url.pathname.slice(1);
  } catch { throw new Error('UNIFIED_DATABASE_URL must be a valid PostgreSQL connection URL'); }
  if (testMode && !database.endsWith('_test')) throw new Error('Fixture mode requires a disposable _test database');
  let corsOrigins: string[];
  try { corsOrigins = JSON.parse(env.CORS_ORIGINS || '["http://localhost:3000"]'); } catch { throw new Error('CORS_ORIGINS must be a JSON list'); }
  if (!Array.isArray(corsOrigins) || corsOrigins.some(v => typeof v !== 'string')) throw new Error('Invalid CORS_ORIGINS');
  const s3Endpoint = env.UNIFIED_S3_ENDPOINT || undefined;
  if (s3Endpoint) {
    const url = new URL(s3Endpoint);
    if (!testMode || !['localhost','127.0.0.1','::1','[::1]','moto'].includes(url.hostname)) throw new Error('S3 endpoint override is restricted to test fixtures');
  }
  const supabaseUrl = (env.SUPABASE_URL || '').replace(/\/$/,'');
  if (supabaseUrl && !supabaseUrl.startsWith('https://') && !testMode) throw new Error('SUPABASE_URL must use HTTPS');
  const port = Number(env.PORT || env.UNIFIED_PORT || 8001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const pythonUrl = (env.UNIFIED_PYTHON_URL || 'http://127.0.0.1:8000').replace(/\/$/,'');
  if (production) {
    for (const key of ['SUPABASE_URL','AWS_S3_BUCKET','CORS_ORIGINS','UNIFIED_PYTHON_URL','INTERNAL_WORKER_TOKEN']) {
      if (!env[key]?.trim()) throw new Error(`${key} is required in production`);
    }
    if (env.INTERNAL_WORKER_TOKEN!.length < 32) throw new Error('INTERNAL_WORKER_TOKEN must contain at least 32 characters');
    if (!corsOrigins.length) throw new Error('CORS_ORIGINS must contain the web origin');
    for (const origin of [...corsOrigins, supabaseUrl, pythonUrl]) {
      let url: URL;
      try { url = new URL(origin); } catch { throw new Error('Service URLs and CORS_ORIGINS must be valid origins'); }
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Service URLs and CORS_ORIGINS must be origins without paths or credentials');
      if (corsOrigins.includes(origin) && url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Public CORS origins must use HTTPS');
    }
  }
  return {
    databaseUrl, port, host: env.UNIFIED_HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    supabaseUrl, supabaseJwtSecret: env.SUPABASE_JWT_SECRET || '', audience: env.SUPABASE_JWT_AUDIENCE || 'authenticated', corsOrigins,
    bucket: env.AWS_S3_BUCKET || '', region: env.AWS_REGION || 'ap-northeast-2', s3Endpoint,
    storageFixture: testMode, maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || 52428800),
    maxWorkspaceBytes: Number(env.SYNC_MAX_WORKSPACE_BYTES || 2147483648), urlTtl: Number(env.S3_PRESIGNED_URL_TTL || 600),
    pythonUrl,
    internalWorkerToken: env.INTERNAL_WORKER_TOKEN || '', testMode,
  };
}
