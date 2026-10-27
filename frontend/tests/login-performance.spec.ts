import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const resolveDependency = createRequire(path.join(process.cwd(), 'package.json')), nextRoot = path.dirname(resolveDependency.resolve('next/package.json'));
async function signedIn(page: Page) {
  const user = { id: '00000000-0000-0000-0000-000000000001', email: 'test@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} };
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, exp: expires, role: 'authenticated' })}.test-signature`;
  await page.context().addCookies([{ name: 'sb-127-auth-token', value: 'base64-' + encode({ access_token: token, refresh_token: 'test-refresh', expires_at: expires, expires_in: 3600, token_type: 'bearer', user }), domain: 'localhost', path: '/' }]);
  await page.route('http://localhost:3102/v2/**', route => route.fulfill({ json: route.request().url().endsWith('/me') ? { id: user.id, email: user.email, display_name: '테스트 사용자' } : { workspaces: [] }, headers: { 'access-control-allow-origin': '*' } }));
}

test('installed RSC clients skip negative Login measures in the real browser', async ({ page }) => {
  await page.goto('/login');
  const sources = [];
  for (const client of ['react-server-dom-turbopack', 'react-server-dom-turbopack-experimental', 'react-server-dom-webpack', 'react-server-dom-webpack-experimental']) {
    const source = await readFile(path.join(nextRoot, 'dist/compiled', client, 'cjs', `${client.replace('-experimental', '')}-client.browser.development.js`), 'utf8');
    const start = source.indexOf('    function flushComponentPerformance('), end = source.indexOf('    function flushInitialRenderPerformance(', start);
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start); sources.push(source.slice(start, end));
  }
  const result = await page.evaluate(bodies => {
    let browserRejectsNegative = false;
    try { performance.measure('invalid-timing-test', { start: 0, end: -10 }); } catch { browserRejectsNegative = true; }
    for (const body of bodies) {
      const flush = new Function('isArrayImpl', 'supportsUserTiming', 'trackNames', 'performance', 'console', `return (${body});`)(Array.isArray, true, Array.from({ length: 10 }, (_, i) => `test-${i}`), performance, console);
      for (const status of ['rejected', 'pending']) for (const end of [-Infinity, -10]) {
        const reason = new Error('NEXT_REDIRECT'), root = { status, reason, _children: [], _debugInfo: status === 'rejected' ? [{ time: -20 }, { name: 'Login', env: 'Server' }, { time: end }] : [{ time: end }, { name: 'Login', env: 'Server' }] };
        flush({ _rootEnvironmentName: 'Server', _closedReason: null }, root, 0, -Infinity, -Infinity);
        if (root.reason !== reason || root.status !== status) throw new Error('Redirect/error state changed');
      }
    }
    return browserRejectsNegative;
  }, sources);
  expect(result).toBe(true);
});

test('anonymous login and protected-route redirects remain usable', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto('/');
    await page.getByRole('link', { name: '웹에서 시작하기' }).first().click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Google로 계속하기', exact: true })).toBeEnabled();
  }
  expect(errors).toEqual([]);
});

test('signed-in Login redirects into the workspace home on soft navigation', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await signedIn(page);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto('/');
    await page.getByRole('link', { name: /^로그인/ }).click();
    await expect(page).toHaveURL(/\/workspaces$/);
    await expect(page.getByRole('heading', { name: '나의 워크스페이스', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '계정 관리', exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('OAuth callback failure still displays its real login error', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/auth/callback?error=access_denied');
  await expect(page).toHaveURL(/\/login\?error=callback$/);
  await expect(page.getByRole('alert').filter({ hasText: '로그인을 완료하지 못했습니다' })).toBeVisible();
  expect(errors).toEqual([]);
});
