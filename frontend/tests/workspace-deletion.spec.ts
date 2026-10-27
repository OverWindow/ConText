import { expect, test, type Page } from '@playwright/test';

async function prepare(page: Page, mode: 'none' | 'desktop' = 'none', role = 'OWNER') {
  const user = { id: '00000000-0000-0000-0000-000000000001', email: 'test@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} };
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.test-signature`;
  await page.context().addCookies([{ name: 'sb-127-auth-token', value: 'base64-' + encode({ access_token: token, refresh_token: 'test-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }), domain: 'localhost', path: '/' }]);
  let deleted = false, attempts = 0, fail = false;
  await page.route('http://localhost:3102/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'DELETE') {
      expect(url.pathname).toBe('/api/workspaces/workspace-one'); attempts++;
      if (fail) { await route.fulfill({ status: 503, json: { detail: '삭제를 완료하지 못했습니다. 다시 시도해 주세요.' } }); return; }
      deleted = true; await route.fulfill({ status: 204 }); return;
    }
    await route.fulfill({ json: url.pathname.endsWith('/me') ? user : deleted ? [] : [{ id: 'workspace-one', name: '기획 자료', role, sync_mode: mode }] });
  });
  await page.goto('/workspaces');
  await expect(page.getByRole('heading', { name: '기획 자료' })).toBeVisible();
  return { attempts: () => attempts, fail: (value: boolean) => { fail = value; } };
}

for (const mode of ['none', 'desktop'] as const) test(`${mode} workspace requires its name before deletion and removes the card`, async ({ page }, info) => {
  const state = await prepare(page, mode);
  await page.getByRole('button', { name: '기획 자료 워크스페이스 삭제' }).click();
  const dialog = page.getByRole('dialog', { name: '워크스페이스 삭제', exact: true });
  const remove = dialog.getByRole('button', { name: '워크스페이스 삭제', exact: true });
  await expect(remove).toBeDisabled();
  if (mode === 'desktop') await expect(dialog).toContainText('데스크톱 원본 폴더와 로컬 작업 내용은 유지됩니다');
  await dialog.getByLabel('확인을 위해 워크스페이스 이름을 입력하세요').fill('다른 이름');
  await expect(remove).toBeDisabled();
  await dialog.getByLabel('확인을 위해 워크스페이스 이름을 입력하세요').fill('기획 자료');
  if (mode === 'desktop') await page.screenshot({ path: `../docs/images/workspace-delete-${info.project.name}.png` });
  await remove.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '기획 자료' })).toHaveCount(0);
  expect(state.attempts()).toBe(1);
});

test('failed deletion keeps the workspace and cancel never sends a deletion', async ({ page }) => {
  const state = await prepare(page); state.fail(true);
  await page.getByRole('button', { name: '기획 자료 워크스페이스 삭제' }).click();
  const dialog = page.getByRole('dialog', { name: '워크스페이스 삭제', exact: true });
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  expect(state.attempts()).toBe(0);
  await page.getByRole('button', { name: '기획 자료 워크스페이스 삭제' }).click();
  await dialog.getByLabel('확인을 위해 워크스페이스 이름을 입력하세요').fill('기획 자료');
  await dialog.getByRole('button', { name: '워크스페이스 삭제', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('삭제를 완료하지 못했습니다');
  await expect(page.getByRole('heading', { name: '기획 자료' })).toBeVisible();
  state.fail(false);
  await dialog.getByRole('button', { name: '워크스페이스 삭제', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.attempts()).toBe(2);
});

test('an editor sees no workspace deletion action', async ({ page }) => {
  await prepare(page, 'desktop', 'EDITOR');
  await expect(page.getByRole('button', { name: '기획 자료 워크스페이스 삭제' })).toHaveCount(0);
});
