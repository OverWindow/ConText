import { expect, test, type Page } from '@playwright/test';

const workspaceId = '00000000-0000-0000-0000-000000000002';
async function prepare(page: Page) {
  const user = { id: '00000000-0000-0000-0000-000000000001', email: 'test@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} };
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.test-signature`;
  await page.context().addCookies([{ name: 'sb-127-auth-token', value: 'base64-' + encode({ access_token: token, refresh_token: 'test-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }), domain: 'localhost', path: '/' }]);
  const entry = (id: string, name: string, parent_path = '', kind = 'file', x = 0) => ({ id, workspace_id: workspaceId, relative_path: parent_path ? parent_path + '/' + name : name, parent_path, kind, name, document_id: kind === 'file' ? id : null, x, y: 0, area_positioned: false, size: 0, extension: kind === 'file' ? '.bin' : '', excluded: 0, mtime: 1700000000000, available: true });
  let revision = 1;
  const mutations: string[] = [];
  await page.route('http://localhost:3102/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (req.method() !== 'GET') mutations.push(path);
    let data: unknown;
    if (path.endsWith('/sync-scene')) data = { revision, entries: [entry('root-file', '원본.bin'), entry('folder', '기획', '', 'directory'), entry('nested-file', '내부.bin', '기획', 'file', 140)], scopes: [{ id: 'root', directory: '', elements: [{ id: 'note', kind: 'text', text: revision === 1 ? '동기화된 메모' : '갱신된 메모', x: -500, y: 0, width: 320, height: 180, color: 'violet', font_size: 24 }], relations: [] }, { id: 'folder', directory: '기획', elements: [], relations: [] }], total: 3, focus: url.searchParams.has('scope_id') ? '기획' : '', drafts: [] };
    else if (path.includes('/documents/')) {
      const id = path.split('/').at(-1); data = { id, title: id === 'root-file' ? '원본.bin' : '내부.bin', current_version_id: 'version', versions: [{ id: 'version', version_number: 1, original_filename: '원본.bin', status: 'UPLOADED', size: 0, sha256: 'a'.repeat(64) }] };
    } else if (path.endsWith('/chat/index-status')) data = { total: 0, indexed: 0 };
    else data = { id: workspaceId, name: '동기화 프로젝트', role: 'OWNER', sync_mode: 'desktop', sync_revision: revision };
    await route.fulfill({ json: data });
  });
  await page.goto(`/workspaces/${workspaceId}`);
  await expect(page.getByRole('region', { name: '동기화된 작업 공간' })).toBeVisible();
  return { mutations, update: () => { revision++; } };
}

test('synced folders, saved notes and originals open without source mutations', async ({ page }, info) => {
  const { mutations } = await prepare(page);
  await expect(page.getByText('동기화된 메모', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '원본.bin 미리보기' }).click();
  await expect(page.getByRole('heading', { name: '원본.bin' })).toBeVisible();
  await expect(page.getByRole('button', { name: '원본 다운로드' })).toBeVisible();
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  await page.getByRole('navigation', { name: '동기화된 폴더' }).getByRole('button', { name: '기획' }).click();
  await expect(page.getByRole('button', { name: '내부.bin 미리보기' })).toBeVisible();
  await expect(page.getByRole('button', { name: '캔버스 수정', exact: true })).toHaveCount(0);
  expect(mutations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `../docs/images/cloud-sync-web-${info.project.name}.png` });
});

test('web refresh displays the next committed workspace revision', async ({ page }) => {
  const state = await prepare(page);
  await expect(page.getByText('동기화된 메모', { exact: true })).toBeVisible();
  state.update(); await page.getByRole('button', { name: '클라우드 새로고침' }).click();
  await expect(page.getByText('갱신된 메모', { exact: true })).toBeVisible();
  await expect(page.getByText('동기화된 메모', { exact: true })).toHaveCount(0);
});
