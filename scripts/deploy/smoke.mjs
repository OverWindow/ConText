import { loadDeployment, validateDeployment } from './config.mjs';
async function get(url, init = {}) { return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
try {
  const { backend, frontend } = await loadDeployment();
  if (validateDeployment(backend, frontend).length) throw new Error('Run check.mjs and resolve environment errors first');
  const python = frontend.NEXT_PUBLIC_API_URL.replace(/\/$/, ''), unified = frontend.NEXT_PUBLIC_WORKSPACE_API_URL.replace(/\/$/, ''), web = frontend.APP_ORIGIN.replace(/\/$/, '');
  const checks = [
    ['Web login', async () => (await get(`${web}/login`)).ok],
    ['Python database', async () => (await get(`${python}/health`)).ok],
    ['Unified DB/storage/processor', async () => { const response = await get(`${unified}/ready`); const value = await response.json(); return response.ok && value.protocol === 2 && value.status === 'ok'; }],
    ['Desktop discovery', async () => { const response = await get(`${python}/api/desktop/auth/config`); const value = await response.json(); return response.ok && value.unified_api_url === unified && value.web_base_url === web && value.supabase_url === frontend.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '') && value.publishable_key === frontend.NEXT_PUBLIC_SUPABASE_ANON_KEY; }],
    ['Retired workspace API', async () => (await get(`${python}/api/workspaces`)).status === 410],
    ['Unified authentication', async () => (await get(`${unified}/v2/workspaces`)).status === 401],
    ['Browser CORS', async () => { const response = await get(`${unified}/v2/workspaces`, { method: 'OPTIONS', headers: { Origin: web, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,content-type' } }); return response.ok && response.headers.get('access-control-allow-origin') === web; }],
  ];
  let failed = false;
  for (const [name, check] of checks) {
    let ok = false; try { ok = await check(); } catch { /* Never print credentials, URLs or response bodies. */ }
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`); failed ||= !ok;
  }
  if (failed) process.exitCode = 1;
} catch (error) { process.stderr.write(error.code ? 'Deployment environment files could not be read.\n' : `${error.message}\n`); process.exitCode = 1; }
