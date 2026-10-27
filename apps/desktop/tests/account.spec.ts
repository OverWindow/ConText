import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';

const profile = { id: 'f040d193-e1a0-4b78-8c29-f1f393791ad2', email: 'desktop-test@example.com', display_name: '테스트 사용자' };

// Exercise real Electron IPC, loopback PKCE and OS secure storage. Only the external
// identity provider and verified backend profile are synthetic; no real account is used.
test('guest workspace survives account login, restart and local-only logout', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-account-e2e-'));
  const root = path.join(base, '로컬 자료'); await mkdir(root);
  await writeFile(path.join(root, '메모.md'), '# 로그인 없이 만든 문서');
  let requests = 0;
  const server = createServer((req, res) => {
    requests++; res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/desktop/auth/config') res.end(JSON.stringify({ supabase_url: 'https://auth.example.test', publishable_key: 'synthetic-publishable-key' }));
    else if (req.url === '/api/me' && req.headers.authorization === 'Bearer synthetic-access-token') res.end(JSON.stringify(profile));
    else { res.statusCode = 401; res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverBaseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data'), CONTEXT_SERVER_URL: serverBaseUrl } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
    expect(requests).toBe(0);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.getByRole('button', { name: '로그인 없이 계속', exact: true }).click();
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    await expect(page.getByTestId('file-메모.md')).toBeVisible();
    const snapshot = () => page.evaluate(async () => { const api = window.contextDesktop; const [workspace] = await api.list(); const value = await api.snapshot(workspace.id); return { id: workspace.id, entries: value.entries.map(({ id, name, x, y }) => ({ id, name, x, y })) }; });
    const before = await snapshot(); expect(requests).toBe(0);
    await app.evaluate(({ shell }) => {
      const originalFetch = globalThis.fetch;
      (globalThis as any).__logoutURL = '';
      globalThis.fetch = async (input: any, init: any) => {
        const url = String(input);
        if (url.startsWith('https://auth.example.test/auth/v1/token')) {
          const body = JSON.parse(init.body);
          if (!body.code_verifier || body.auth_code !== 'synthetic-code') throw new Error('invalid PKCE exchange');
          (globalThis as any).__pkceVerified = body.code_verifier.length >= 43;
          return new Response(JSON.stringify({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', expires_in: 3600 }), { status: 200 });
        }
        if (url.startsWith('https://auth.example.test/auth/v1/logout')) { (globalThis as any).__logoutURL = url; return new Response(null, { status: 204 }); }
        return originalFetch(input, init);
      };
      shell.openExternal = async target => {
        const url = new URL(target);
        if (url.searchParams.get('provider') !== 'google' || url.searchParams.get('code_challenge_method') !== 's256') throw new Error('invalid authorize request');
        const callback = new URL(url.searchParams.get('redirect_to')!); callback.searchParams.set('code', 'synthetic-code');
        await originalFetch(callback);
      };
    });
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.getByRole('button', { name: '로그인 서버 설정' }).click();
    await expect(page.getByRole('textbox', { name: '로그인 서버 주소' })).toHaveValue(serverBaseUrl);
    await page.getByRole('button', { name: '로그인 서버 설정' }).click();
    expect((await page.getByRole('dialog', { name: '로그인', exact: true }).boundingBox())!.height).toBeLessThan(500);
    await page.screenshot({ path: 'test-results/desktop-account-guest.png' });
    await page.getByRole('button', { name: 'Google로 계속하기' }).click();
    await expect(page.getByRole('dialog', { name: 'ConText 계정' })).toContainText(profile.email);
    const state = await page.evaluate(() => window.contextDesktop.accountStatus());
    expect(state.status).toBe('signed_in'); expect(state.user).toEqual(profile);
    expect(JSON.stringify(state)).not.toContain('synthetic-access-token');
    expect(await app.evaluate(() => (globalThis as any).__pkceVerified)).toBe(true);
    const sealed = await readFile(path.join(base, 'data', 'ai-connection.enc'));
    expect(sealed.toString()).not.toContain('synthetic-refresh-token');
    await page.screenshot({ path: 'test-results/desktop-account-signed-in.png' });
    await page.getByRole('button', { name: '완료', exact: true }).click();
    expect(await snapshot()).toEqual(before);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '계정 관리' })).toContainText(profile.display_name);
    expect((await page.evaluate(() => window.contextDesktop.accountRefresh())).user?.id).toBe(profile.id);
    expect(await snapshot()).toEqual(before);
    await app.evaluate(() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: any, init: any) => {
        if (String(input).startsWith('https://auth.example.test/auth/v1/logout')) { (globalThis as any).__logoutURL = String(input); return new Response(null, { status: 204 }); }
        return originalFetch(input, init);
      };
    });
    await page.getByRole('button', { name: '계정 관리' }).click();
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Google로 계속하기' })).toBeVisible();
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__logoutURL)).toBe('https://auth.example.test/auth/v1/logout?scope=local');
    await page.getByRole('button', { name: '로그인 없이 계속' }).click();
    expect(await snapshot()).toEqual(before);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
    await expect(page.getByTestId('file-메모.md')).toBeVisible();
    expect((await page.evaluate(() => window.contextDesktop.accountStatus())).status).toBe('guest');
    expect(await readFile(path.join(root, '메모.md'), 'utf8')).toBe('# 로그인 없이 만든 문서');
    expect(errors).toEqual([]);
  } finally { if (app) await app.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(base, { recursive: true, force: true }); }
});

test('browser login can be cancelled and server errors keep guest mode usable', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-account-cancel-'));
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + base] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: base, CONTEXT_SERVER_URL: 'http://127.0.0.1:8000' } });
    const page = await app.firstWindow();
    await app.evaluate(({ shell }) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: any, init: any) => String(input).endsWith('/api/desktop/auth/config') ? new Response(JSON.stringify({ supabase_url: 'https://auth.example.test', publishable_key: 'synthetic-key' })) : originalFetch(input, init);
      shell.openExternal = async value => { (globalThis as any).__authorizeURL = value; };
    });
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.getByRole('button', { name: 'Google로 계속하기' }).click();
    await expect.poll(() => app!.evaluate(() => !!(globalThis as any).__authorizeURL)).toBe(true);
    await page.getByRole('button', { name: '취소하고 로컬로 계속' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '첫 폴더 연결하기' })).toBeEnabled();
    expect((await page.evaluate(() => window.contextDesktop.accountStatus())).status).toBe('guest');
    expect(await app.evaluate(async () => {
      const callback = new URL(new URL((globalThis as any).__authorizeURL).searchParams.get('redirect_to')!);
      try { await fetch(callback); return 'listening'; } catch { return 'closed'; }
    })).toBe('closed');
    await app.evaluate(() => { globalThis.fetch = async () => { throw new TypeError('synthetic offline'); }; });
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.getByRole('button', { name: 'Google로 계속하기' }).click();
    await expect(page.getByRole('alert')).toContainText('로그인 서버에 연결하지 못했습니다');
    await page.getByRole('button', { name: '로그인 없이 계속' }).click();
    await expect(page.getByRole('button', { name: '첫 폴더 연결하기' })).toBeEnabled();
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});
