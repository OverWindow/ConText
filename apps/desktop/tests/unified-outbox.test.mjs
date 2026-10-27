import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceEngine } from '../electron/engine.mjs';

test('rejected commands survive restart in recovery without blocking independent pending edits', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'context-outbox-recovery-')), root = path.join(base, 'files'), data = path.join(base, 'data');
  await mkdir(root); let engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  const workspaceId = (await engine.connect(root)).workspace.id, store = engine.unified.store;
  const create = text => store.command(workspaceId, 'CreateDraft', { id: randomUUID(), scope_id: store.state(workspaceId).workspace.root_entry_id, title: text, content: text });
  const rejected = create('복구할 초안'), independent = create('다른 초안'); store.enqueue(workspaceId, rejected); store.enqueue(workspaceId, independent);
  const receipt = { operation_id: rejected.operation_id, status: 'rejected', error: { code: 'FORBIDDEN', message: 'Permission changed' } };
  store.acknowledge(workspaceId, [receipt]); store.rebuild(workspaceId);
  assert.equal(store.status(workspaceId).blocked_count, 1);
  assert.equal(store.pending(workspaceId).some(row => row.operation_id === rejected.operation_id), false);
  assert.equal(store.pending(workspaceId).some(row => row.operation_id === independent.operation_id), true);
  await engine.close(); engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  const saved = engine.db.prepare('SELECT command,result,state FROM unified_outbox WHERE operation_id=?').get(rejected.operation_id);
  const [visible] = engine.unifiedRecovery(workspaceId); assert.equal(visible.id, rejected.operation_id);
  const exported = path.join(base, 'recovery.json'); await engine.unifiedWriteRecovery(workspaceId, visible.id, exported, null);
  const record = JSON.parse(await readFile(exported, 'utf8')); assert.equal(record.candidate.command.payload.content, '복구할 초안');
  assert.equal(saved.state, 'blocked'); assert.equal(JSON.parse(saved.command).payload.content, '복구할 초안'); assert.deepEqual(JSON.parse(saved.result), receipt);
  assert.equal(engine.unified.store.pending(workspaceId).some(row => row.operation_id === independent.operation_id), true);
});


test('a rejected immutable file version can be exported without a cloud permission', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'context-outbox-original-')), root = path.join(base, 'files'); await mkdir(root); await writeFile(path.join(root, 'original.txt'), 'preserved original');
  const engine = await new WorkspaceEngine(path.join(base, 'data')).init({ watchFiles: false }); t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  const id = (await engine.connect(root)).workspace.id; await engine.unified.prepare(id); const store = engine.unified.store, state = store.state(id), version = Object.values(state.versions)[0], doc = state.documents[version.document_id];
  const command = store.command(id, 'AppendDocumentVersion', { version: { ...version, id: randomUUID(), parent_version_ids: [version.id] } }, { [`documents:${doc.id}`]: doc.revision }); store.enqueue(id, command);
  store.acknowledge(id, [{ operation_id: command.operation_id, status: 'rejected', error: { code: 'FORBIDDEN', message: 'Revoked' } }]);
  const saved = engine.unifiedRecovery(id).find(item => item.id === command.operation_id); assert.equal(saved.has_original, true);
  const destination = path.join(base, 'recovered.bin'); await engine.unifiedWriteRecoveryOriginal(id, saved.id, destination, null); assert.equal(await readFile(destination, 'utf8'), 'preserved original');
  assert.throws(() => engine.unifiedRecoveryOriginal(id, randomUUID()), /원본 파일/);
});
