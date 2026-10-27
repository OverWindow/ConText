import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('real Electron account/IPC publishes a folder and reopens its web workspace after restart', async () => {
  const apiURL = process.env.CONTEXT_SYNC_TEST_URL || 'http://127.0.0.1:18000';
  const { token } = await (await fetch(apiURL + '/__fixture/config')).json();
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-cloud-electron-')), root = path.join(base, '클라우드 자료');
  await mkdir(path.join(root, '빈 하위 폴더'), { recursive: true });
  await writeFile(path.join(root, '기획.md'), '# 웹에서도 볼 기획\n\n같은 폴더의 같은 문서');
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data'), CONTEXT_SERVER_URL: apiURL } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog, shell }, { root, token }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      const original = globalThis.fetch;
      globalThis.fetch = async (input: any, init: any) => {
        const url = String(input);
        if (url.endsWith('/api/desktop/auth/config')) return new Response(JSON.stringify({ supabase_url: 'https://auth.example.test', publishable_key: 'fixture-key' }));
        if (url.startsWith('https://auth.example.test/auth/v1/token')) return new Response(JSON.stringify({ access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600 }));
        return original(input, init);
      };
      shell.openExternal = async target => {
        const url = new URL(target);
        if (!url.searchParams.has('redirect_to')) { (globalThis as any).__cloudOpenedURL = target; return; }
        const callback = new URL(url.searchParams.get('redirect_to')!); callback.searchParams.set('code', 'synthetic-code'); await original(callback);
      };
    }, { root, token });
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    await expect(page.getByTestId('file-기획.md')).toBeVisible();
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.getByRole('button', { name: 'Google로 계속하기' }).click();
    await expect(page.getByRole('dialog', { name: 'ConText 계정' })).toContainText('cloud-fixture@example.test');
    await page.getByRole('button', { name: '완료', exact: true }).click();
    await page.getByRole('button', { name: '클라우드 동기화', exact: true }).click();
    await page.getByRole('button', { name: '지금 동기화', exact: true }).click();
    await expect(page.getByText('클라우드 동기화를 완료했습니다.', { exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: '웹에서 열기', exact: true }).click();
    const webURL = await app.evaluate(() => (globalThis as any).__cloudOpenedURL as string);
    const cloudId = new URL(webURL).pathname.split('/').at(-1);
    const scene = await (await fetch(apiURL + `/api/workspaces/${cloudId}/sync-scene`, { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(scene.entries.map((entry: any) => entry.name)).toContain('기획.md'); expect(scene.entries.map((entry: any) => entry.name)).toContain('빈 하위 폴더');
    await page.screenshot({ path: '../../docs/images/cloud-sync-desktop.png' });
    const publicState = await page.evaluate(async () => { const [workspace] = await window.contextDesktop.list(); return window.contextDesktop.syncStatus(workspace.id); });
    expect(JSON.stringify(publicState)).not.toContain(token); expect(publicState.linked).toBe(true);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '동기화 완료', exact: true })).toBeVisible();
    await writeFile(path.join(root, '추가.txt'), '나중에 추가한 문서');
    await expect(page.getByRole('button', { name: '변경 있음', exact: true })).toBeVisible({ timeout: 15000 });
    expect(await readFile(path.join(root, '기획.md'), 'utf8')).toBe('# 웹에서도 볼 기획\n\n같은 폴더의 같은 문서');
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
    await page.getByRole('button', { name: '변경 있음', exact: true }).click();
    await page.getByRole('button', { name: '클라우드 워크스페이스 삭제', exact: true }).click();
    expect((await fetch(apiURL + `/api/workspaces/${cloudId}`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await page.getByRole('button', { name: '클라우드 워크스페이스 삭제', exact: true }).click();
    await expect(page.getByRole('button', { name: '클라우드 공간 삭제됨', exact: true })).toBeVisible();
    expect((await fetch(apiURL + `/api/workspaces/${cloudId}`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(404);
    await expect(page.getByTestId('file-기획.md')).toBeVisible();
    expect(await readFile(path.join(root, '기획.md'), 'utf8')).toBe('# 웹에서도 볼 기획\n\n같은 폴더의 같은 문서');
    await page.screenshot({ path: '../../docs/images/cloud-workspace-deleted-desktop.png' });
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '클라우드 공간 삭제됨', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});
