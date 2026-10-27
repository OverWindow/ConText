import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function origin(value, field, { local = false } = {}) {
  if (!value || /REPLACE_|<|>|example\.(com|test|invalid)/i.test(value)) throw new Error(`${field}: set an actual origin`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${field}: invalid origin`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(local && loopback && url.protocol === 'http:')) || (!local && loopback)) throw new Error(`${field}: use a public HTTPS origin without a path or credentials`);
  return url.origin;
}
export function validateFrontend(env, { local = false } = {}) {
  const problems = [];
  for (const field of ['APP_ORIGIN', 'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_WORKSPACE_API_URL', 'NEXT_PUBLIC_SUPABASE_URL']) {
    try { origin(env[field], field, { local }); } catch (error) { problems.push(error.message); }
  }
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!key || key.startsWith('sb_secret_')) problems.push('NEXT_PUBLIC_SUPABASE_ANON_KEY: use the public publishable/anon key');
  if (!local && !key.startsWith('sb_publishable_') && key.split('.').length !== 3) problems.push('NEXT_PUBLIC_SUPABASE_ANON_KEY: expected a publishable key or anon JWT');
  if (key.split('.').length === 3) {
    try { if (JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role !== 'anon') problems.push('NEXT_PUBLIC_SUPABASE_ANON_KEY: JWT must have the anon role'); }
    catch { problems.push('NEXT_PUBLIC_SUPABASE_ANON_KEY: invalid public JWT'); }
  }
  return problems;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.VERCEL === '1' || process.env.CONTEXT_VALIDATE_DEPLOYMENT === '1') {
    const local = process.env.VERCEL !== '1' && process.env.CONTEXT_DEPLOYMENT_MODE === 'local';
    const problems = validateFrontend(process.env, { local });
    if (problems.length) { process.stderr.write(`Deployment configuration is incomplete:\n${problems.join('\n')}\n`); process.exitCode = 1; }
    else process.stdout.write('Public deployment origins and Supabase key validated.\n');
  }
}
