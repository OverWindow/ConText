import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
test('packaged IPC publishes, resolves a conflict, attaches cloud files and preserves originals after deletion', async () => {
    const fixtureURL = process.env.CONTEXT_UNIFIED_TEST_URL;
    test.skip(!fixtureURL, 'Set CONTEXT_UNIFIED_TEST_URL to the disposable unified fixture.');
    const { token, user } = await (await fetch(`${fixtureURL}/__fixture/config`)).json(), headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    async function request(method: string, route: string, payload?: unknown) { const r = await fetch(`${fixtureURL}/v2${route}`, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) }), body = await r.json(); expect(r.ok, JSON.stringify(body)).toBe(true); return body; }
    const base = await mkdtemp(path.join(os.tmpdir(), 'context-unified-ui-')), root = path.join(base, `UI 원본 ${randomUUID().slice(0, 8)}`), clone = path.join(base, '클라우드 받기'), data = path.join(base, 'data');
    await mkdir(root);
    await mkdir(clone);
    const original = '# 실제 IPC 동기화\n\n원본을 보존합니다.';
    await writeFile(path.join(root, '원본.md'), original);
    const proxy = createServer((req, res) => { if (req.url === '/api/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(user));
    }
    else {
        res.writeHead(404);
        res.end();
    } });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string')
        throw new Error('Missing proxy');
    const serverURL = `http://127.0.0.1:${address.port}`;
    const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE, launch = () => electron.launch({ executablePath, args: executablePath ? [`--user-data-dir=${data}`] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: data, CONTEXT_SERVER_URL: serverURL, CONTEXT_UNIFIED_API_URL: fixtureURL, CONTEXT_WEB_URL: 'http://localhost:3000' } });
    let app: ElectronApplication | undefined;
    try {
        app = await launch();
        let page = await app.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await app.evaluate(async ({ app, safeStorage, dialog }, { token, user, serverURL, fixtureURL, root }) => { const fs = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises'), path = process.getBuiltinModule('node:path') as typeof import('node:path'); const config = { mode: 'managed', model: '', serverBaseUrl: serverURL, personalKey: null, auth: { url: 'https://auth.example.test', key: 'test-only-key', unified_api_url: fixtureURL, web_base_url: 'http://localhost:3000' }, session: { access_token: token, refresh_token: 'synthetic-refresh', expires_at: Date.now() / 1000 + 3600, identity: 'native-ui-fixture', email: user.email, user } }; await fs.writeFile(path.join(app.getPath('userData'), 'ai-connection.enc'), await safeStorage.encryptStringAsync(JSON.stringify(config)), { mode: 0o600 }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }, { token, user, serverURL, fixtureURL, root });
        await page.evaluate(() => window.contextDesktop.accountRefresh());
        await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
        await expect(page.getByTestId('file-원본.md')).toBeVisible();
        const localId = await page.evaluate(async () => { const [w] = await window.contextDesktop.list(); return w.id; });
        await page.locator('.cloud-control > button').click();
        await page.locator('.cloud-popover').getByRole('button', { name: /(?:지금|이어서) 동기화/ }).click();
        await expect.poll(() => page.evaluate(id => window.contextDesktop.syncStatus(id), localId), { timeout: 45000 }).toEqual(expect.objectContaining({ phase: 'complete' }));
        const published = (await request('GET', `/workspaces/${localId}/bootstrap`)).state;
        expect(Object.values(published.entries).some(v => (v as {
            name: string;
        }).name === '원본.md')).toBe(true);
        const noteId = randomUUID(), note = { id: noteId, kind: 'text' as const, text: '기기 메모 원본', x: -350, y: 0, width: 320, height: 160, color: 'violet', font_size: 24 };
        await page.evaluate(async ({ id, note }) => { await window.contextDesktop.putCanvasItem(id, '', 'element', note, 0); await window.contextDesktop.syncStart(id); }, { id: localId, note });
        const before = (await request('GET', `/workspaces/${localId}/bootstrap`)).state, remote = before.canvas_elements[noteId], deviceId = randomUUID();
        await request('POST', `/workspaces/${localId}/devices`, { device_id: deviceId, name: 'Browser fixture' });
        await request('POST', `/workspaces/${localId}/commands`, { commands: [{ schema_version: 2, operation_id: randomUUID(), workspace_id: localId, device_id: deviceId, workspace_epoch: before.workspace.epoch, type: 'PutCanvasElement', payload: { element: { ...remote, content: '웹에서 쓴 메모' } }, base_revisions: { [`canvas_elements:${noteId}`]: remote.revision } }] });
        await page.evaluate(({ id, note }) => window.contextDesktop.putCanvasItem(id, '', 'element', { ...note, text: '오프라인 기기 메모' }, 1), { id: localId, note });
        await page.locator('.cloud-popover').getByRole('button', { name: /(?:지금|이어서) 동기화/ }).click();
        await expect.poll(() => page.evaluate(id => window.contextDesktop.syncStatus(id).then(s => s.phase), localId), { timeout: 30000 }).toBe('conflict');
        await page.getByRole('button', { name: '충돌과 복구 자료', exact: true }).click();
        const comparison = page.getByRole('dialog', { name: '동기화 상태와 충돌' });
        await expect(comparison.getByText('오프라인 기기 메모', { exact: true })).toBeVisible();
        await expect(comparison.getByText('웹에서 쓴 메모', { exact: true })).toBeVisible();
        await comparison.getByRole('button', { name: '보존된 변경 적용', exact: true }).click();
        await expect(comparison.getByText('미해결 충돌이 없습니다.', { exact: false })).toBeVisible();
        await comparison.getByRole('button', { name: '충돌 창 닫기' }).click();
        expect((await request('GET', `/workspaces/${localId}/bootstrap`)).state.canvas_elements[noteId].content).toBe('오프라인 기기 메모');
        const cloud = (await request('POST', '/workspaces', { name: `Picker ${randomUUID().slice(0, 8)}` })).workspace, cloudDevice = randomUUID();
        await request('POST', `/workspaces/${cloud.id}/devices`, { device_id: cloudDevice, name: 'Web creator' });
        const bytes = Buffer.from('웹에서 만든 원본'), blob = { id: randomUUID(), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mime_type: 'text/plain' }, prepared = await request('POST', `/workspaces/${cloud.id}/blobs/prepare`, blob);
        expect((await fetch(prepared.upload_url, { method: 'PUT', headers: prepared.headers, body: bytes })).ok).toBe(true);
        await request('POST', `/workspaces/${cloud.id}/blobs/complete`, { id: blob.id });
        const entryId = randomUUID(), docId = randomUUID(), versionId = randomUUID(), envelope = (type: string, payload: unknown, bases = {}) => ({ schema_version: 2, operation_id: randomUUID(), workspace_id: cloud.id, device_id: cloudDevice, workspace_epoch: cloud.epoch, type, payload, base_revisions: bases });
        await request('POST', `/workspaces/${cloud.id}/commands`, { commands: [envelope('CreateEntry', { id: entryId, parent_id: cloud.root_entry_id, kind: 'file', name: '웹 원본.txt', document_id: docId }), envelope('AppendDocumentVersion', { version: { id: versionId, workspace_id: cloud.id, document_id: docId, blob, parent_version_ids: [], sources: [], created_at: new Date().toISOString(), created_by: user.id, change_note: 'Web fixture' }, select_head: true }, { [`documents:${docId}`]: 0 })] });
        await app.evaluate(({ dialog }, clone) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [clone] }); }, clone);
        await page.getByRole('button', { name: '나의 워크스페이스', exact: true }).click();
        await page.getByRole('button', { name: '클라우드 워크스페이스 열기', exact: true }).click();
        const library = page.getByRole('dialog', { name: '클라우드 워크스페이스', exact: true });
        await library.getByRole('listitem').filter({ hasText: cloud.name }).getByRole('button', { name: '이 기기에서 열기' }).click();
        await expect(page.getByTestId('file-웹 원본.txt')).toBeVisible({ timeout: 30000 });
        expect(await readFile(path.join(clone, '웹 원본.txt'), 'utf8')).toBe('웹에서 만든 원본');
        // A web deletion followed by a fresh UUID at the same name is legal.
        // Pulling both entries must preserve history without a legacy path collision.
        const priorReuse = (await request('GET', `/workspaces/${cloud.id}/bootstrap`)).state;
        const replacementEntry = randomUUID(), replacementDocument = randomUUID(), replacementVersion = randomUUID();
        await request('POST', `/workspaces/${cloud.id}/commands`, { commands: [
          envelope('TrashEntry', { id: entryId, observed_heads: { [docId]: versionId } }, { [`entries:${entryId}`]: priorReuse.entries[entryId].revision, [`documents:${docId}`]: priorReuse.documents[docId].revision }),
          envelope('CreateEntry', { id: replacementEntry, parent_id: cloud.root_entry_id, kind: 'file', name: '웹 원본.txt', document_id: replacementDocument }),
          envelope('AppendDocumentVersion', { version: { id: replacementVersion, workspace_id: cloud.id, document_id: replacementDocument, blob, parent_version_ids: [], sources: [], created_at: new Date().toISOString(), created_by: user.id, change_note: 'Recreated at the same path' }, select_head: true }, { [`documents:${replacementDocument}`]: 0 }),
        ] });
        await page.evaluate(id => window.contextDesktop.syncStart(id), cloud.id);
        await expect.poll(() => page.evaluate(async id => (await window.contextDesktop.snapshot(id)).entries.filter(entry => entry.relative_path === '웹 원본.txt').map(entry => entry.id), cloud.id)).toEqual([replacementEntry]);
        expect(await readFile(path.join(clone, '웹 원본.txt'), 'utf8')).toBe('웹에서 만든 원본');
        // Receiving a file may also create its first native placement. The
        // owner can delete the cloud space while that independent edit is pending.
        await page.evaluate(({ id, entry }) => window.contextDesktop.savePositions(id, [{ id: entry, x: 42, y: 64 }]), { id: cloud.id, entry: replacementEntry });
        const received = await page.evaluate(id => window.contextDesktop.syncStatus(id), cloud.id);
        expect(received.linked).toBe(true);
        if (received.pending) {
          const pending = await app.evaluate(({ app }, id) => {
            const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
            const path = process.getBuiltinModule('node:path') as typeof import('node:path');
            const db = new DatabaseSync(path.join(app.getPath('userData'), 'workspace.sqlite'), { readOnly: true });
            try { return db.prepare("SELECT command FROM unified_outbox WHERE workspace_id=? AND state='pending'").all(id).map(row => JSON.parse(String(row.command)).type); } finally { db.close(); }
          }, cloud.id);
          expect(pending.filter(type => type !== 'SetEntryPositions')).toEqual([]);
        }
        await page.locator('.cloud-control > button').click();
        await page.getByRole('button', { name: '워크스페이스 삭제', exact: true }).click();
        await expect(page.getByRole('button', { name: '삭제된 워크스페이스', exact: true })).toBeVisible();
        expect((await page.evaluate(id => window.contextDesktop.snapshot(id), cloud.id)).status).toBe('ready');
        expect((await request('GET', '/workspaces')).workspaces.some((w: {
            id: string;
        }) => w.id === cloud.id)).toBe(false);
        expect(await readFile(path.join(clone, '웹 원본.txt'), 'utf8')).toBe('웹에서 만든 원본');
        expect(await readFile(path.join(root, '원본.md'), 'utf8')).toBe(original);
        await page.screenshot({ path: '../../docs/images/unified-desktop.png' });
        await app.close();
        app = await launch();
        page = await app.firstWindow();
        await expect.poll(() => page.evaluate(id => window.contextDesktop.syncStatus(id).then(s => s.phase), cloud.id)).toBe('deleted');
        expect((await page.evaluate(id => window.contextDesktop.snapshot(id), cloud.id)).status).toBe('ready');
        expect(await readFile(path.join(clone, '웹 원본.txt'), 'utf8')).toBe('웹에서 만든 원본');
        expect(errors).toEqual([]);
    }
    catch (error) {
        if (app) { const currentPage = await app.firstWindow(); console.log('Native failure public state', await currentPage.evaluate(async () => { const items = await window.contextDesktop.list(); return Promise.all(items.map(async item => ({id:item.id,label:item.label,state:await window.contextDesktop.syncStatus(item.id)}))); })); await currentPage.screenshot({path:'/private/tmp/context-v2-native-ui-failure.png'}).catch(() => {}); }
        throw error;
    }
    finally {
        if (app)
            await app.close();
        await new Promise<void>(resolve => proxy.close(() => resolve()));
        await rm(base, { recursive: true, force: true });
    }
});
