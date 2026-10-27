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
  const database = new URL(databaseUrl).pathname.slice(1);
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
  return {
    databaseUrl, port: Number(env.UNIFIED_PORT || 8001), host: env.UNIFIED_HOST || '127.0.0.1',
    supabaseUrl, supabaseJwtSecret: env.SUPABASE_JWT_SECRET || '', audience: env.SUPABASE_JWT_AUDIENCE || 'authenticated', corsOrigins,
    bucket: env.AWS_S3_BUCKET || '', region: env.AWS_REGION || 'ap-northeast-2', s3Endpoint,
    storageFixture: testMode, maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || 52428800),
    maxWorkspaceBytes: Number(env.SYNC_MAX_WORKSPACE_BYTES || 2147483648), urlTtl: Number(env.S3_PRESIGNED_URL_TTL || 600),
    pythonUrl: (env.UNIFIED_PYTHON_URL || 'http://127.0.0.1:8000').replace(/\/$/,''),
    internalWorkerToken: env.INTERNAL_WORKER_TOKEN || '', testMode,
  };
}
