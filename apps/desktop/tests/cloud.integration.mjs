import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { WorkspaceEngine } from '../electron/engine.mjs';
import { CloudTransfer } from '../electron/cloud-transfer.mjs';

test('real desktop engine → HTTP API → PostgreSQL/S3 → web snapshot, with restart and lost ACK', async () => {
  const baseURL = process.env.CONTEXT_SYNC_TEST_URL || 'http://127.0.0.1:18000';
  const { token, other_token } = await (await fetch(baseURL + '/__fixture/config')).json();
  const request = async (url, init = {}) => {
    const response = await fetch(url, init), body = await response.json();
    if (!response.ok) throw Object.assign(new Error(JSON.stringify(body.detail)), { status: response.status });
    return body;
  };
  const user = await request(baseURL + '/api/me', { headers: { Authorization: `Bearer ${token}` } });
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-cloud-http-')), root = path.join(base, '프로젝트'), data = path.join(base, 'data');
  await mkdir(path.join(root, '기획'), { recursive: true }); await mkdir(path.join(root, '빈폴더'));
  const filename = path.join(root, '기획', '보고서.md');
  await writeFile(filename, '# 첫 버전\n\n보존할 원본'); await writeFile(path.join(root, '빈파일.bin'), '');
  let engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  let uploads = 0, lost = false, failPrepare = false;
  try {
    const workspace = (await engine.connect(root)).workspace.id;
    const entry = engine.snapshot(workspace).entries.find(e => e.name === '보고서.md');
    const first = await engine.openDocument(workspace, entry.id);
    await writeFile(filename, '# 두번째 버전\n\n나중의 원본'); await engine.scan(workspace); await engine.openDocument(workspace, entry.id);
    const document = engine.getDocument(workspace, entry.id); engine.setCurrentVersion(workspace, document.id, first.version_id, document.revision);
    await engine.importDraft(workspace, entry.id, randomUUID(), first.version_id);
    engine.putCanvasItem(workspace, '기획', 'element', { id: randomUUID(), kind: 'text', text: '클라우드에서도 볼 메모', x: 450, y: 20, width: 320, height: 180, color: 'violet', font_size: 24 }, 0);
    const config = { serverBaseUrl: baseURL, session: { identity: randomUUID(), user } };
    const transfer = new CloudTransfer({ read: async () => structuredClone(config), token: async () => token,
      fetcher: async (url, init) => { if (failPrepare && url.endsWith('/items')) throw Object.assign(new Error('synthetic interrupted preparation'), { status: 400 }); const result = await request(url, init); if (lost && url.endsWith('/commit')) throw Object.assign(new Error('synthetic lost commit response'), { status: 400 }); return result; } },
      async (method, ...args) => engine[method](...args), { uploader: async (url, init) => { uploads++; assert.ok(!init.headers.Authorization); return fetch(url, init); } });
    const result = await transfer.start(workspace);
    assert.equal(result.phase, 'complete'); assert.equal(uploads, 3);
    const state = engine.cloudState(workspace, { server: baseURL, user_id: user.id }), cloudId = state.binding.workspace_id;
    const get = route => request(baseURL + '/api' + route, { headers: { Authorization: `Bearer ${token}` } });
    const scene = await get(`/workspaces/${cloudId}/sync-scene`);
    assert.equal(scene.revision, 1); assert.equal(scene.entries.length, 4);
    assert.ok(scene.entries.some(e => e.name === '빈폴더'));
    assert.ok(scene.scopes.some(s => s.elements.some(e => e.text === '클라우드에서도 볼 메모')));
    assert.equal(scene.drafts.length, 1);
    assert.ok(!JSON.stringify(scene).includes(root));
    const remote = await get(`/documents/${document.id}`);
    assert.equal(remote.current_version_id, first.version_id); assert.equal(remote.versions.length, 2);
    for (const version of remote.versions) {
      const ticket = await request(baseURL + `/api/versions/${version.id}/download-url`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const bytes = Buffer.from(await (await fetch(ticket.download_url)).arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), version.sha256);
    }
    assert.equal((await fetch(baseURL + `/api/workspaces/${cloudId}/sync-scene`, { headers: { Authorization: `Bearer ${other_token}` } })).status, 404);
    const firstUploadCount = uploads; await transfer.start(workspace); assert.equal(uploads, firstUploadCount);
    await writeFile(filename, '# 세번째 버전\n\n전송 중에도 보존'); await engine.scan(workspace);
    lost = true; await assert.rejects(transfer.start(workspace), /lost commit/);
    const beforeResume = uploads; assert.ok(engine.cloudState(workspace, { server: baseURL, user_id: user.id }).pending);
    await engine.close(); engine = await new WorkspaceEngine(data).init({ watchFiles: false });
    lost = false; assert.equal((await transfer.start(workspace)).phase, 'complete'); assert.equal(uploads, beforeResume);
    assert.equal((await get(`/workspaces/${cloudId}/sync-scene`)).revision, 3);
    assert.equal(await readFile(filename, 'utf8'), '# 세번째 버전\n\n전송 중에도 보존');
    failPrepare = true;
    await assert.rejects(transfer.start(workspace), /interrupted preparation/);
    await writeFile(filename, '# 다시 준비한 최신 내용'); await engine.scan(workspace);
    failPrepare = false;
    assert.equal((await transfer.restart(workspace)).phase, 'complete');
    assert.equal((await get(`/workspaces/${cloudId}/sync-scene`)).revision, 4);
    assert.equal(await readFile(filename, 'utf8'), '# 다시 준비한 최신 내용');
  } finally { await engine.close(); await rm(base, { recursive: true, force: true }); }
});
