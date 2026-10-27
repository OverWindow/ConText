import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
const backendFile = '.env.backend.production', frontendFile = '.env.frontend.production';
let frontend;
try { frontend = parseEnv(await readFile(frontendFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await writeFile(frontendFile, await readFile(`${frontendFile}.example`), { flag: 'wx', mode: 0o600 });
  frontend = parseEnv(await readFile(frontendFile, 'utf8'));
}
const text = await readFile(`${backendFile}.example`, 'utf8');
const web = (frontend.APP_ORIGIN || '').replace(/\/$/, '');
const values = {
  POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
  INTERNAL_WORKER_TOKEN: randomBytes(32).toString('hex'),
  AI_CREDENTIALS_KEY: randomBytes(32).toString('base64url') + '=',
  WEB_BASE_URL: web,
  CORS_ORIGINS: JSON.stringify(web ? [web] : []),
  SUPABASE_URL: frontend.NEXT_PUBLIC_SUPABASE_URL || '',
  SUPABASE_PUBLISHABLE_KEY: frontend.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
};
const output = text.split('\n').map(line => { const key = line.split('=')[0]; return Object.hasOwn(values, key) ? `${key}=${values[key]}` : line; }).join('\n');
try {
  await writeFile(backendFile, output, { flag: 'wx', mode: 0o600 });
  process.stdout.write('Created private backend environment with new internal/encryption/database keys. Fill cloud URLs and credentials, then run check.mjs.\n');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  process.stdout.write('Existing backend environment preserved; no keys were replaced.\n');
}
