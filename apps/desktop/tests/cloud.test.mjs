import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { WorkspaceEngine } from '../electron/engine.mjs';
import { CloudTransfer } from '../electron/cloud-transfer.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-cloud-')), root = path.join(base, '자료'), data = path.join(base, 'data');
  await mkdir(path.join(root, '빈폴더'), { recursive: true });
  await writeFile(path.join(root, '노트.md'), '# 한글\n\n원본 내용');
  await writeFile(path.join(root, '빈파일.bin'), '');
  await writeFile(path.join(root, '이미지.png'), Buffer.from([1, 2, 3, 4]));
  const f = { base, root, data, engine: await new WorkspaceEngine(data, { unifiedCommands: false }).init({ watchFiles: false }) };
  f.id = (await f.engine.connect(root)).workspace.id;
  f.owner = { server: 'https://api.example.test', user_id: randomUUID() };
  f.call = async (method, ...args) => f.engine[method](...args);
  t.after(async () => { await f.engine.close(); await rm(base, { recursive: true, force: true }); });
  return f;
}

test('portable immutable snapshot contains empty folders, raw files, sources and selected heads without local paths', async t => {
  const f = await fixture(t), file = f.engine.snapshot(f.id).entries.find(e => e.name === '노트.md');
  const first = await f.engine.openDocument(f.id, file.id);
  await writeFile(path.join(f.root, file.name), '# 두번째 내용'); await f.engine.scan(f.id);
  await f.engine.openDocument(f.id, file.id);
  const doc = f.engine.getDocument(f.id, file.id);
  f.engine.setCurrentVersion(f.id, doc.id, first.version_id, doc.revision);
  f.engine.createDraft(f.id, randomUUID());
  const snapshot = await f.engine.cloudPrepare(f.id, f.owner);
  assert.ok(snapshot.items.some(i => i.entity_type === 'entry' && JSON.parse(i.content).name === '빈폴더'));
  assert.ok(snapshot.items.some(i => i.entity_type === 'version' && JSON.parse(i.content).size === 0));
  const head = JSON.parse(snapshot.items.find(i => i.entity_type === 'document' && i.entity_id === doc.id).content);
  assert.equal(head.current_version_id, first.version_id); assert.notEqual(head.file_version_id, first.version_id);
  const wire = JSON.stringify(snapshot.items);
  for (const privateValue of [f.root, f.data, 'relative_path', 'identity', 'access_token']) assert.ok(!wire.includes(privateValue));
  assert.equal(snapshot.manifest_hash, createHash('sha256').update(snapshot.items.map(i => `${i.entity_type}:${i.entity_id}:${createHash('sha256').update(i.content).digest('hex')}\n`).join('')).digest('hex'));
  await writeFile(path.join(f.root, file.name), '업로드 중에 편집한 새 내용');
  const blob = await readFile(f.engine.cloudBlob(f.id, f.owner, snapshot.request_id, first.version_id));
  assert.equal(blob.toString(), '# 한글\n\n원본 내용');
  await f.engine.close(); f.engine = await new WorkspaceEngine(f.data, { unifiedCommands: false }).init({ watchFiles: false });
  assert.equal((await f.engine.cloudPrepare(f.id, f.owner)).request_id, snapshot.request_id);
  await assert.rejects(f.engine.cloudPrepare(f.id, { ...f.owner, user_id: randomUUID() }), /다른 서버 또는 계정/);
});

test('missing originals retain prior bytes and symlinks are excluded', async t => {
  const f = await fixture(t), initial = await f.engine.cloudPrepare(f.id, f.owner);
  await f.engine.cloudDiscard(f.id, f.owner);
  await rm(path.join(f.root, '이미지.png')); await f.engine.scan(f.id);
  const next = await f.engine.cloudPrepare(f.id, f.owner);
  const missing = next.items.find(i => i.entity_type === 'entry' && JSON.parse(i.content).name === '이미지.png');
  assert.equal(JSON.parse(missing.content).available, false);
  const original = initial.items.find(i => i.entity_type === 'document' && i.entity_id === JSON.parse(missing.content).document_id);
  assert.deepEqual(next.items.find(i => i.entity_type === 'document' && i.entity_id === original.entity_id).content, original.content);
  await f.engine.cloudDiscard(f.id, f.owner);
  await symlink(path.join(f.base, 'outside'), path.join(f.root, '비밀링크')); await f.engine.scan(f.id);
  assert.ok(!(await f.engine.cloudPrepare(f.id, f.owner)).items.some(i => i.content.includes('비밀링크')));
});

test('indexing a raw sync snapshot preserves its version UUID and does not invent another change', async t => {
  const f = await fixture(t), pending = await f.engine.cloudPrepare(f.id, f.owner);
  const entry = f.engine.snapshot(f.id).entries.find(e => e.name === '노트.md');
  const before = f.engine.getDocument(f.id, entry.id), sequence = pending.source_sequence;
  const parsed = await f.engine.openDocument(f.id, entry.id);
  assert.equal(parsed.version_id, before.file_version_id);
  assert.equal(f.engine.getDocument(f.id, entry.id).versions.length, 1);
  assert.equal(f.engine.db.prepare('SELECT max(device_sequence) AS n FROM local_changes WHERE workspace_id=?').get(f.id).n, sequence);
  assert.ok(parsed.normalized.blocks.length > 0);
});

function server(f, { lostCommit = false, changeAccountOnUpload = false } = {}) {
  const binding = { id: randomUUID(), workspace_id: randomUUID(), generation: 1, revision: 0, state: 'ACTIVE' };
  binding.web_url = `https://web.example.test/workspaces/${binding.workspace_id}`;
  const sessions = new Map(), uploaded = new Set(), calls = [];
  const config = { serverBaseUrl: f.owner.server, session: { identity: randomUUID(), user: { id: f.owner.user_id } } };
  let lost = lostCommit, offline = false, expired = false;
  const connections = { read: async () => structuredClone(config), token: async () => 'synthetic-session-token', fetcher: async (url, init) => {
    assert.equal(new URL(url).origin, f.owner.server); assert.equal(init.headers.Authorization, 'Bearer synthetic-session-token');
    calls.push([init.method, new URL(url).pathname]);
    if (offline) throw Object.assign(new Error('offline'), { status: 503 });
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.endsWith('/sync/bindings')) return structuredClone(binding);
    if (url.endsWith(`/sync/bindings/${binding.id}`)) {
      if (binding.state === 'DELETED') throw Object.assign(new Error('deleted'), { status: 410, code: 'WORKSPACE_DELETED' });
      return structuredClone(binding);
    }
    if (url.endsWith(`/workspaces/${binding.workspace_id}`) && init.method === 'DELETE') { binding.state = 'DELETED'; return null; }
    if (url.endsWith('/sync-sessions')) {
      let session = sessions.get(body.request_id);
      if (!session) { session = { ...body, id: randomUUID(), state: 'PREPARING', expires_at: new Date(Date.now() + 3600000).toISOString() }; sessions.set(body.request_id, session); }
      return { ...session };
    }
    const session = [...sessions.values()].find(s => url.includes(s.id));
    if (url.endsWith('/items')) {
      if (expired) throw Object.assign(new Error('session expired'), { status: 410 });
      return { session, uploads: body.items.filter(i => i.entity_type === 'version' && !uploaded.has(i.entity_id)).map(i => ({ ordinal: i.ordinal, version_id: i.entity_id, upload_url: `https://storage.example.test/${i.entity_id}`, headers: {} })) };
    }
    if (url.endsWith('/uploads/complete')) return { ...session };
    if (url.endsWith('/commit')) {
      if (session.state !== 'COMMITTED') { session.state = 'COMMITTED'; session.revision = ++binding.revision; }
      if (lost) throw Object.assign(new Error('lost response'), { status: 400 });
      return { ...session };
    }
    throw new Error(`Unhandled test route ${url}`);
  } };
  const transfer = new CloudTransfer(connections, f.call, { uploader: async (url, init) => {
    assert.ok(!init.headers.Authorization); uploaded.add(url.split('/').at(-1));
    if (changeAccountOnUpload) config.session.identity = randomUUID();
    return new Response('', { status: 200 });
  } });
  return { transfer, calls, sessions, uploaded, restore: () => { lost = false; }, deleted: () => { binding.state = 'DELETED'; }, offline: () => { offline = true; }, expired: () => { expired = true; } };
}

test('lost commit response resumes the same request after restart without duplicate upload or ACK loss', async t => {
  const f = await fixture(t), mock = server(f, { lostCommit: true });
  await assert.rejects(mock.transfer.start(f.id), /lost response/);
  const pending = f.engine.cloudState(f.id, f.owner).pending, count = mock.uploaded.size;
  assert.ok(pending); assert.equal(mock.sessions.size, 1);
  await f.engine.close(); f.engine = await new WorkspaceEngine(f.data, { unifiedCommands: false }).init({ watchFiles: false });
  mock.restore(); const result = await mock.transfer.start(f.id);
  assert.equal(result.phase, 'complete'); assert.equal(mock.uploaded.size, count); assert.equal(mock.sessions.size, 1);
  assert.equal(f.engine.cloudState(f.id, f.owner).pending, null);
  assert.equal(f.engine.cloudState(f.id, f.owner).binding.revision, 1);
});

test('account changes stop transport before commit and leave a recoverable pending snapshot', async t => {
  const f = await fixture(t), mock = server(f, { changeAccountOnUpload: true });
  await assert.rejects(mock.transfer.start(f.id), /계정 연결이 변경/);
  assert.ok(!mock.calls.some(([, route]) => route.endsWith('/commit')));
  assert.ok(f.engine.cloudState(f.id, f.owner).pending);
});

test('deleting the cloud workspace discards only staging and preserves local originals and history', async t => {
  const f = await fixture(t), mock = server(f);
  await mock.transfer.start(f.id);
  const before = f.engine.db.prepare('SELECT count(*) AS n FROM local_versions').get().n;
  await f.engine.cloudPrepare(f.id, f.owner);
  assert.equal((await mock.transfer.remove(f.id)).phase, 'deleted');
  assert.equal(f.engine.cloudState(f.id, f.owner).pending, null);
  assert.equal(f.engine.cloudState(f.id, f.owner).binding.state, 'DELETED');
  assert.equal(f.engine.db.prepare('SELECT count(*) AS n FROM local_versions').get().n, before);
  assert.equal(await readFile(path.join(f.root, '노트.md'), 'utf8'), '# 한글\n\n원본 내용');
  assert.equal((await mock.transfer.status(f.id)).phase, 'deleted');
});

test('web deletion is detected by desktop status and retained across app restarts', async t => {
  const f = await fixture(t), mock = server(f);
  await mock.transfer.start(f.id);
  await f.engine.cloudPrepare(f.id, f.owner);
  mock.deleted();
  assert.equal((await mock.transfer.status(f.id)).phase, 'deleted');
  assert.equal(f.engine.cloudState(f.id, f.owner).pending, null);
  await f.engine.close(); f.engine = await new WorkspaceEngine(f.data, { unifiedCommands: false }).init({ watchFiles: false });
  assert.equal((await mock.transfer.status(f.id)).phase, 'deleted');
});

test('an unreachable server is not shown as a confirmed completed sync', async t => {
  const f = await fixture(t), mock = server(f);
  await mock.transfer.start(f.id); mock.offline();
  assert.equal((await mock.transfer.status(f.id)).phase, 'offline');
  assert.ok(f.engine.cloudState(f.id, f.owner).binding);
});

test('an expired upload session is never treated as a deleted workspace', async t => {
  const f = await fixture(t), mock = server(f); mock.expired();
  await assert.rejects(mock.transfer.start(f.id), /session expired/);
  assert.notEqual(f.engine.cloudState(f.id, f.owner).binding.state, 'DELETED');
  assert.ok(f.engine.cloudState(f.id, f.owner).pending);
});
