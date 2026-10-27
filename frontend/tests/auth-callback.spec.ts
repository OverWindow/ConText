import { expect, test, type Page } from '@playwright/test';

async function prepareExchange(page: Page) {
  await page.context().addCookies([{
    name: 'sb-127-auth-token-code-verifier',
    value: 'base64-' + Buffer.from(JSON.stringify('test-only-valid-verifier-abcdefghijklmnopqrstuvwxyz')).toString('base64url'),
    domain: 'localhost', path: '/',
  }]);
  await page.route('http://localhost:3102/v2/**', route => route.fulfill({
    json: route.request().url().endsWith('/me')
      ? { id: '00000000-0000-0000-0000-000000000001', email: 'test@example.test', display_name: '테스트 사용자' }
      : { workspaces: [] },
    headers: { 'access-control-allow-origin': '*' },
  }));
}

for (const path of ['/', '/auth/callback']) {
  test(`OAuth code arriving at ${path} creates a session and opens workspaces`, async ({ page }) => {
    await prepareExchange(page);
    await page.goto(`${path}?code=test-only-valid-code`);
    await expect(page).toHaveURL(/\/workspaces$/, { timeout: 15000 });
    await expect(page.getByRole('heading', { name: '나의 워크스페이스', exact: true })).toBeVisible();
    expect((await page.context().cookies()).some(cookie => /^sb-127-auth-token(?:\.\d+)?$/.test(cookie.name))).toBe(true);
    // A new request must retain the session, rather than briefly rendering a protected page.
    await page.reload();
    await expect(page).toHaveURL(/\/workspaces$/);
    await expect(page.getByRole('heading', { name: '나의 워크스페이스', exact: true })).toBeVisible();
  });
}

test('a rejected code on the home URL shows the login error without creating a session', async ({ page }) => {
  await prepareExchange(page);
  await page.goto('/?code=test-only-rejected-code&next=https://untrusted.invalid');
  await expect(page).toHaveURL(/\/login\?error=callback$/, { timeout: 15000 });
  await expect(page.getByRole('alert').filter({ hasText: '로그인을 완료하지 못했습니다' })).toBeVisible();
  expect((await page.context().cookies()).some(cookie => /^sb-127-auth-token(?:\.\d+)?$/.test(cookie.name))).toBe(false);
});
