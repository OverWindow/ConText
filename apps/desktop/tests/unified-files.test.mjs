import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, symlink, link, lstat, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { WorkspaceEngine } from '../electron/engine.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, { hooks = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-unified-files-')), root = path.join(base, '자료'), data = path.join(base, 'app-data');
  await mkdir(path.join(root, '하위'), { recursive: true }); await writeFile(path.join(root, '원본.txt'), '원본 A'); await writeFile(path.join(root, '하위', '자식.txt'), '중첩 원본');
  const f = { base, root, data, engine: await new WorkspaceEngine(data, { unifiedCommands: hooks }).init({ watchFiles: false }) };
  f.id = (await f.engine.connect(root)).workspace.id; await f.engine.unified.prepare(f.id);
  f.store = f.engine.unified.store; f.service = f.engine.unified; f.files = f.service.files;
  f.entry = f.engine.db.prepare("SELECT * FROM entries WHERE workspace_id=? AND name='원본.txt'").get(f.id);
  f.document = Object.values(f.store.state(f.id).documents).find(d => Object.values(f.store.state(f.id).entries).some(e => e.id === f.entry.id && e.document_id === d.id));
  t.after(async () => { await f.engine.close(); await rm(base, { recursive: true, force: true }); });
  return f;
}
function enqueue(f, type, payload, bases = {}) { return f.store.enqueue(f.id, f.store.command(f.id, type, payload, bases)); }
function remoteVersion(f, text = '웹에서 수정 B', { documentId = f.document.id, parents } = {}) {
  const state = f.store.state(f.id), id = randomUUID(), data = Buffer.from(text), blob = { id, sha256: hash(data), size: data.length, mime_type: 'text/plain' };
  const version = { id, workspace_id: f.id, document_id: documentId, blob, parent_version_ids: parents || (state.documents[documentId].content_head_id ? [state.documents[documentId].content_head_id] : []),
    sources: [], created_at: new Date().toISOString(), created_by: f.store.row(f.id).actor_id, display_number: 1, change_note: '원격 변경' };
  const result = enqueue(f, 'AppendDocumentVersion', { version }, { [`documents:${documentId}`]: state.documents[documentId].revision }); assert.equal(result.status, 'applied');
  return { version, blob, data };
}
const absent = async filename => assert.rejects(access(filename), error => error.code === 'ENOENT');

test('deletion after pull is preserved as a conflict until an explicit choice restores or trashes the remote head', async t => {
  const f=await fixture(t),remote=remoteVersion(f);f.files.receiveBlob(f.id,remote.blob,remote.data);f.service.bridge.project(f.id);
  await rm(path.join(f.root,'원본.txt'));const applied=await f.service.apply(f.id);assert.ok(applied.failures.some(item=>item.entry_id===f.entry.id));await absent(path.join(f.root,'원본.txt'));
  await f.service.prepare(f.id);const state=f.store.state(f.id),conflict=Object.values(state.conflicts).find(c=>c.reason==='delete_vs_unobserved_version');assert.ok(conflict);assert.equal(state.entries[f.entry.id].deleted_at,null);
  const count=f.store.pending(f.id).length;await f.service.prepare(f.id);assert.equal(f.store.pending(f.id).length,count,'deletion cannot create endless duplicate conflicts');
  const review=f.service.conflicts(f.id).find(c=>c.id===conflict.id);await f.service.resolve(f.id,'ResolveConflict',{id:conflict.id,resolution:'keep_current'},review.base_revisions);
  assert.equal(await readFile(path.join(f.root,'원본.txt'),'utf8'),remote.data.toString());assert.equal(f.engine.db.prepare('SELECT status FROM unified_file_mappings WHERE entry_id=?').get(f.entry.id).status,'ready');
  await rm(path.join(f.root,'원본.txt'));await f.service.prepare(f.id);assert.ok(f.store.state(f.id).entries[f.entry.id].deleted_at,'a subsequent deliberate deletion is a fresh action');
});

test('a file removed before its first content observation is not published as a live empty ghost',async t=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'context-delete-unobserved-')),root=path.join(base,'files'),data=path.join(base,'data');await mkdir(root);await writeFile(path.join(root,'new.bin'),'not uploaded');const engine=await new WorkspaceEngine(data).init({watchFiles:false});t.after(async()=>{await engine.close();await rm(base,{recursive:true,force:true});});
  const id=(await engine.connect(root)).workspace.id;const entry=engine.snapshot(id).entries[0];await rm(path.join(root,'new.bin'));await engine.unified.prepare(id);assert.ok(engine.unified.store.state(id).entries[entry.id].deleted_at);assert.equal(Object.keys(engine.unified.store.state(id).versions).length,0);
});

test('a remote file-name cycle converges on disk without overwriting either original', async t => {
  const f = await fixture(t), state = f.store.state(f.id), first = state.entries[f.entry.id], second = Object.values(state.entries).find(e => e.name === '자식.txt');
  enqueue(f, 'MoveEntries', { moves: [
    { id: first.id, parent_id: second.parent_id, name: second.name },
    { id: second.id, parent_id: first.parent_id, name: first.name },
  ] }, { [`entries:${first.id}`]: first.revision, [`entries:${second.id}`]: second.revision });
  const result = await f.service.apply(f.id); assert.deepEqual(result.failures, []);
  assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), '중첩 원본');
  assert.equal(await readFile(path.join(f.root, '하위', '자식.txt'), 'utf8'), '원본 A');
  assert.equal(f.engine.db.prepare('SELECT relative_path FROM unified_file_mappings WHERE entry_id=?').get(first.id).relative_path, '하위/자식.txt');
  const pending = f.store.pending(f.id).length; await f.service.prepare(f.id); assert.equal(f.store.pending(f.id).length, pending);
});

test('a remote folder-name cycle preserves every descendant and stable logical identity', async t => {
  const f = await fixture(t); await mkdir(path.join(f.root, '별도')); await writeFile(path.join(f.root, '별도', '보관.txt'), '별도 폴더 내용');
  await f.service.prepare(f.id); const state = f.store.state(f.id), first = Object.values(state.entries).find(e => e.name === '하위'), second = Object.values(state.entries).find(e => e.name === '별도');
  enqueue(f, 'MoveEntries', { moves: [{ id: first.id, parent_id: first.parent_id, name: second.name }, { id: second.id, parent_id: second.parent_id, name: first.name }] }, { [`entries:${first.id}`]: first.revision, [`entries:${second.id}`]: second.revision });
  const result = await f.service.apply(f.id); assert.deepEqual(result.failures, []);
  assert.equal(await readFile(path.join(f.root, '별도', '자식.txt'), 'utf8'), '중첩 원본');
  assert.equal(await readFile(path.join(f.root, '하위', '보관.txt'), 'utf8'), '별도 폴더 내용');
  assert.equal(f.engine.db.prepare('SELECT relative_path FROM unified_file_mappings WHERE entry_id=?').get(first.id).relative_path, '별도');
});

for (const kind of ['file', 'folder']) test(`restart recovers a ${kind} cycle interrupted between physical staging and SQLite mapping`, async t => {
  const f = await fixture(t, { hooks: true });
  if (kind === 'folder') { await mkdir(path.join(f.root, '두번째')); await writeFile(path.join(f.root, '두번째', '보관.txt'), '다른 폴더'); await f.service.prepare(f.id); }
  const state = f.store.state(f.id), first = kind === 'file' ? state.entries[f.entry.id] : Object.values(state.entries).find(e => e.name === '하위');
  const second = Object.values(state.entries).find(e => e.name === (kind === 'file' ? '자식.txt' : '두번째'));
  enqueue(f, 'MoveEntries', { moves: [{ id: first.id, parent_id: second.parent_id, name: second.name }, { id: second.id, parent_id: first.parent_id, name: first.name }] }, { [`entries:${first.id}`]: first.revision, [`entries:${second.id}`]: second.revision });
  const pending = f.store.pending(f.id).length, stage = f.files.moves.moveToStaging.bind(f.files.moves); let interrupted = false;
  f.files.moves.moveToStaging = async (...args) => { await stage(...args); if (!interrupted) { interrupted = true; throw new Error('SIMULATED_EXIT_AFTER_STAGE_BEFORE_MAPPING'); } };
  const result = await f.service.apply(f.id); assert.ok(result.failures.length); assert.ok((await readdir(f.root)).some(name => name.endsWith('.move')));
  await f.engine.close(); f.engine = await new WorkspaceEngine(f.data).init({ watchFiles: false });
  assert.equal(f.engine.unified.store.pending(f.id).length, pending, 'recovery cannot publish deletion or watcher echo');
  assert.equal(f.engine.db.prepare("SELECT count(*) AS n FROM unified_apply_journal WHERE workspace_id=? AND state!='complete'").get(f.id).n, 0);
  assert.equal((await readdir(f.root)).some(name => name.endsWith('.move')), false);
  if (kind === 'file') { assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), '중첩 원본'); assert.equal(await readFile(path.join(f.root, '하위', '자식.txt'), 'utf8'), '원본 A'); }
  else { assert.equal(await readFile(path.join(f.root, '두번째', '자식.txt'), 'utf8'), '중첩 원본'); assert.equal(await readFile(path.join(f.root, '하위', '보관.txt'), 'utf8'), '다른 폴더'); }
});

test('folder and child name cycles recover together after the first parent is staged', async t => {
  const f = await fixture(t, { hooks: true }); await mkdir(path.join(f.root, '두번째')); await writeFile(path.join(f.root, '두번째', '보관.txt'), '보관'); await writeFile(path.join(f.root, '하위', '다른.txt'), '다른 자식'); await f.service.prepare(f.id);
  const state = f.store.state(f.id), find = name => Object.values(state.entries).find(e => e.name === name), a = find('하위'), b = find('두번째'), x = find('자식.txt'), y = find('다른.txt');
  const moves = [{ id: a.id, parent_id: a.parent_id, name: b.name }, { id: b.id, parent_id: b.parent_id, name: a.name }, { id: x.id, parent_id: x.parent_id, name: y.name }, { id: y.id, parent_id: y.parent_id, name: x.name }];
  enqueue(f, 'MoveEntries', { moves }, Object.fromEntries([a,b,x,y].map(e => [`entries:${e.id}`, e.revision])));
  const stage = f.files.moves.moveToStaging.bind(f.files.moves); let stopped = false;
  f.files.moves.moveToStaging = async (...args) => { await stage(...args); if (!stopped) { stopped = true; throw new Error('INTERRUPTED_PARENT'); } };
  await f.service.apply(f.id); await f.engine.close(); f.engine = await new WorkspaceEngine(f.data).init({ watchFiles: false });
  assert.equal(await readFile(path.join(f.root, '두번째', '다른.txt'), 'utf8'), '중첩 원본'); assert.equal(await readFile(path.join(f.root, '두번째', '자식.txt'), 'utf8'), '다른 자식');
  assert.equal(await readFile(path.join(f.root, '하위', '보관.txt'), 'utf8'), '보관');
  assert.equal(f.engine.db.prepare("SELECT count(*) AS n FROM unified_apply_journal WHERE workspace_id=? AND state!='complete'").get(f.id).n, 0);
});

test('unknown destination occupants stop staging before any original is moved', async t => {
  const f = await fixture(t), state = f.store.state(f.id), entry = state.entries[f.entry.id];
  enqueue(f, 'MoveEntry', { id: entry.id, parent_id: entry.parent_id, name: '점유.txt' }, { [`entries:${entry.id}`]: entry.revision });
  await writeFile(path.join(f.root, '점유.txt'), '외부에서 생성한 파일'); const result = await f.service.apply(f.id);
  assert.ok(result.failures.some(item => item.entry_id === entry.id)); assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), '원본 A');
  assert.equal(await readFile(path.join(f.root, '점유.txt'), 'utf8'), '외부에서 생성한 파일'); assert.equal((await readdir(f.root)).some(name => name.endsWith('.move')), false);
});

test('workspace deletion restores a staged original without applying pending remote names or bytes', async t => {
  const f = await fixture(t), state = f.store.state(f.id), entry = state.entries[f.entry.id];
  enqueue(f, 'MoveEntry', { id: entry.id, parent_id: entry.parent_id, name: '원격 이름.txt' }, { [`entries:${entry.id}`]: entry.revision });
  const stage = f.files.moves.moveToStaging.bind(f.files.moves); let interrupted = false;
  f.files.moves.moveToStaging = async (...args) => { await stage(...args); if (!interrupted) { interrupted = true; throw new Error('STAGED_BEFORE_DELETION'); } };
  await f.service.apply(f.id); assert.ok((await readdir(f.root)).some(name => name.endsWith('.move')));
  const current = f.store.state(f.id); enqueue(f, 'DeleteWorkspace', {}, { [`workspace:${f.id}`]: current.workspace.revision });
  const result = await f.service.apply(f.id); assert.deepEqual(result.failures, []); assert.equal(result.applied, 0);
  assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), '원본 A'); await absent(path.join(f.root, '원격 이름.txt'));
  assert.equal((await readdir(f.root)).some(name => name.endsWith('.move')), false);
});

test('external edits made inside staging are kept when a workspace is deleted', async t => {
  const f = await fixture(t), state = f.store.state(f.id), entry = state.entries[f.entry.id];
  enqueue(f, 'MoveEntry', { id: entry.id, parent_id: entry.parent_id, name: '원격 이름.txt' }, { [`entries:${entry.id}`]: entry.revision });
  const stage = f.files.moves.moveToStaging.bind(f.files.moves);
  f.files.moves.moveToStaging = async (id, payload) => { await stage(id, payload); await writeFile(path.join(f.root, payload.staging), '계속 열려 있던 편집기의 새 내용'); throw new Error('EXTERNAL_EDITOR_AT_STAGE'); };
  await f.service.apply(f.id); const current = f.store.state(f.id); enqueue(f, 'DeleteWorkspace', {}, { [`workspace:${f.id}`]: current.workspace.revision });
  await f.service.apply(f.id); assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), '계속 열려 있던 편집기의 새 내용');
});

test('verified remote bytes install the same UUID once and apply through durable file journal', async t => {
  const f = await fixture(t), before = f.store.state(f.id), oldId = before.documents[f.document.id].content_head_id, remote = remoteVersion(f);
  assert.throws(() => f.files.receiveBlob(f.id, remote.blob, Buffer.from('변조')), /크기 또는 해시/);
  assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), '원본 A');
  f.files.receiveBlob(f.id, remote.blob, remote.data); const result = await f.service.apply(f.id);
  assert.deepEqual(result.failures, []); assert.equal(hash(await readFile(path.join(f.root, '원본.txt'))), remote.blob.sha256);
  const saved = f.engine.db.prepare('SELECT * FROM local_versions WHERE id=?').get(remote.version.id); assert.equal(Buffer.from(saved.bytes).toString(), remote.data.toString());
  assert.ok(f.engine.db.prepare('SELECT id FROM local_versions WHERE id=?').get(oldId));
  assert.equal(f.engine.db.prepare('SELECT local_version_id,data FROM unified_blobs WHERE id=?').get(remote.blob.id).local_version_id, remote.version.id);
  assert.equal(f.engine.db.prepare('SELECT data FROM unified_blobs WHERE id=?').get(remote.blob.id).data, null);
  const mapping = f.engine.db.prepare('SELECT * FROM unified_file_mappings WHERE entry_id=?').get(f.entry.id); assert.equal(mapping.observed_version_id, remote.version.id); assert.equal(mapping.observed_hash, remote.blob.sha256);
  assert.equal(f.engine.db.prepare("SELECT count(*) AS n FROM save_journal WHERE workspace_id=? AND state='complete'").get(f.id).n, 1);
  assert.equal(f.engine.db.prepare("SELECT count(*) AS n FROM unified_apply_journal WHERE workspace_id=? AND state!='complete'").get(f.id).n, 0);
  await f.service.apply(f.id); assert.equal(f.engine.db.prepare('SELECT count(*) AS n FROM local_versions WHERE id=?').get(remote.version.id).n, 1);
});

test('file and folder renames preserve bytes and update every descendant physical mapping', async t => {
  const f = await fixture(t); let state = f.store.state(f.id), folder = Object.values(state.entries).find(e => e.name === '하위'), child = Object.values(state.entries).find(e => e.name === '자식.txt');
  enqueue(f, 'MoveEntry', { id: f.entry.id, parent_id: folder.id, name: '웹 이름.txt' }, { [`entries:${f.entry.id}`]: state.entries[f.entry.id].revision });
  state = f.store.state(f.id); enqueue(f, 'MoveEntry', { id: folder.id, parent_id: state.workspace.root_entry_id, name: '새 폴더' }, { [`entries:${folder.id}`]: folder.revision });
  const result = await f.service.apply(f.id); assert.deepEqual(result.failures, []);
  await absent(path.join(f.root, '원본.txt')); await absent(path.join(f.root, '하위'));
  assert.equal(await readFile(path.join(f.root, '새 폴더', '웹 이름.txt'), 'utf8'), '원본 A'); assert.equal(await readFile(path.join(f.root, '새 폴더', '자식.txt'), 'utf8'), '중첩 원본');
  assert.equal(f.engine.db.prepare('SELECT relative_path FROM unified_file_mappings WHERE entry_id=?').get(child.id).relative_path, '새 폴더/자식.txt');
  assert.equal(f.engine.db.prepare('SELECT relative_path FROM unified_file_mappings WHERE entry_id=?').get(f.entry.id).relative_path, '새 폴더/웹 이름.txt');
});

test('unobserved external edits preserve both local physical content and downloaded remote branch', async t => {
  const f = await fixture(t), remote = remoteVersion(f); f.files.receiveBlob(f.id, remote.blob, remote.data);
  await writeFile(path.join(f.root, '원본.txt'), '동기화 사이에 외부 앱에서 쓴 내용'); const originalMapping = f.engine.db.prepare('SELECT * FROM unified_file_mappings WHERE entry_id=?').get(f.entry.id);
  const result = await f.service.apply(f.id); assert.ok(result.failures.some(failure => failure.entry_id === f.entry.id));
  assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), '동기화 사이에 외부 앱에서 쓴 내용');
  assert.equal(f.engine.db.prepare('SELECT observed_version_id FROM unified_file_mappings WHERE entry_id=?').get(f.entry.id).observed_version_id, originalMapping.observed_version_id);
  assert.equal(Buffer.from(f.engine.db.prepare('SELECT bytes FROM local_versions WHERE id=?').get(remote.version.id).bytes).toString(), remote.data.toString());
  assert.equal(f.engine.db.prepare("SELECT state FROM unified_apply_journal WHERE entry_id=? AND version_id=?").get(f.entry.id, remote.version.id).state, 'needs_review');
});

test('symlink leaf and changed parent symlink are refused without touching outside bytes', async t => {
  const f = await fixture(t), outside = path.join(f.base, 'outside'); await mkdir(outside); await writeFile(path.join(outside, '원본.txt'), '외부 원본');
  const remote = remoteVersion(f); f.files.receiveBlob(f.id, remote.blob, remote.data);
  await rm(path.join(f.root, '원본.txt')); await symlink(path.join(outside, '원본.txt'), path.join(f.root, '원본.txt'));
  let result = await f.service.apply(f.id); assert.ok(result.failures.some(failure => failure.entry_id === f.entry.id)); assert.equal(await readFile(path.join(outside, '원본.txt'), 'utf8'), '외부 원본');
  await rm(path.join(f.root, '원본.txt')); await writeFile(path.join(f.root, '원본.txt'), '원본 A');
  const state = f.store.state(f.id), folder = Object.values(state.entries).find(e => e.name === '하위');
  enqueue(f, 'MoveEntry', { id: f.entry.id, parent_id: folder.id, name: '원본.txt' }, { [`entries:${f.entry.id}`]: state.entries[f.entry.id].revision });
  await rename(path.join(f.root, '하위'), path.join(f.root, '원래 하위')); await symlink(outside, path.join(f.root, '하위'));
  result = await f.service.apply(f.id); assert.ok(result.failures.length); assert.equal(await readFile(path.join(outside, '원본.txt'), 'utf8'), '외부 원본'); assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), '원본 A');
  await assert.rejects(f.files.checked(f.id, '../outside/원본.txt'), /경로|폴더/);
});

test('prepared application journal survives restart and resumes verified content without duplicate versions', async t => {
  const f = await fixture(t), remote = remoteVersion(f); f.files.receiveBlob(f.id, remote.blob, remote.data); f.service.bridge.project(f.id);
  const entry = f.store.state(f.id).entries[f.entry.id]; f.files.journal(f.id, entry, remote.version.id, 'file', { relative: '원본.txt', previous: '원본.txt', expected_hash: hash('원본 A'), desired_hash: remote.blob.sha256 });
  await f.engine.close(); f.engine = await new WorkspaceEngine(f.data, { unifiedCommands: false }).init({ watchFiles: false }); f.store = f.engine.unified.store;
  assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), remote.data.toString());
  assert.equal(f.engine.db.prepare('SELECT count(*) AS n FROM local_versions WHERE id=?').get(remote.version.id).n, 1);
  assert.equal(f.engine.db.prepare("SELECT count(*) AS n FROM unified_apply_journal WHERE workspace_id=? AND state!='complete'").get(f.id).n, 0);
});

test('crash after durable publication but before mapping ACK converges on restart without rewriting bytes', async t => {
  const f = await fixture(t), remote = remoteVersion(f); f.files.receiveBlob(f.id, remote.blob, remote.data);
  const originalWrite = f.engine.documents.writeFile.bind(f.engine.documents); let interrupted = false;
  f.engine.documents.writeFile = async (...args) => { const result = await originalWrite(...args); if (!interrupted && args[1] === f.document.id) { interrupted = true; throw new Error('SIMULATED_PROCESS_EXIT_AFTER_PUBLICATION'); } return result; };
  const result = await f.service.apply(f.id); assert.ok(result.failures.some(item => item.entry_id === f.entry.id));
  assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), remote.data.toString());
  assert.notEqual(f.engine.db.prepare('SELECT observed_version_id FROM unified_file_mappings WHERE entry_id=?').get(f.entry.id).observed_version_id, remote.version.id);
  const before = await lstat(path.join(f.root, '원본.txt'));
  await f.engine.close(); f.engine = await new WorkspaceEngine(f.data, { unifiedCommands: false }).init({ watchFiles: false });
  const after = await lstat(path.join(f.root, '원본.txt')); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(f.engine.db.prepare('SELECT observed_version_id FROM unified_file_mappings WHERE entry_id=?').get(f.entry.id).observed_version_id, remote.version.id);
  assert.equal(f.engine.db.prepare("SELECT count(*) AS n FROM unified_apply_journal WHERE workspace_id=? AND state!='complete'").get(f.id).n, 0);
});

test('interrupted hardlink rename removes the old path after recovery while retaining destination bytes', async t => {
  const f = await fixture(t), state = f.store.state(f.id), entry = state.entries[f.entry.id];
  enqueue(f, 'MoveEntry', { id: entry.id, parent_id: entry.parent_id, name: '이동 완료.txt' }, { [`entries:${entry.id}`]: entry.revision });
  await link(path.join(f.root, '원본.txt'), path.join(f.root, '이동 완료.txt'));
  f.files.journal(f.id, entry, state.documents[entry.document_id].content_head_id, 'file', { relative: '이동 완료.txt', previous: '원본.txt', expected_hash: hash('원본 A'), desired_hash: hash('원본 A') });
  await f.engine.close(); f.engine = await new WorkspaceEngine(f.data, { unifiedCommands: false }).init({ watchFiles: false });
  assert.equal(await readFile(path.join(f.root, '이동 완료.txt'), 'utf8'), '원본 A'); await absent(path.join(f.root, '원본.txt'));
  assert.equal(f.engine.db.prepare('SELECT relative_path FROM unified_file_mappings WHERE entry_id=?').get(entry.id).relative_path, '이동 완료.txt');
});

test('parent replacement at the write boundary cannot redirect a remote update outside the connected root', async t => {
  const f = await fixture(t), state = f.store.state(f.id), child = Object.values(state.entries).find(e => e.name === '자식.txt');
  const remote = remoteVersion(f, '웹 자식 변경', { documentId: child.document_id }); f.files.receiveBlob(f.id, remote.blob, remote.data);
  const outside = path.join(f.base, 'outside'), parent = path.join(f.root, '하위'); await mkdir(outside); await writeFile(path.join(outside, '자식.txt'), '중첩 원본');
  const originalWrite = f.engine.documents.writeFile.bind(f.engine.documents); let replaced = false;
  f.engine.documents.writeFile = async (...args) => { if (!replaced && args[1] === child.document_id) { replaced = true; await rename(parent, `${parent}-preserved`); await symlink(outside, parent); } return originalWrite(...args); };
  const result = await f.service.apply(f.id);
  assert.equal(await readFile(path.join(outside, '자식.txt'), 'utf8'), '중첩 원본', 'an ancestor path change must not redirect publication outside the selected folder');
  assert.ok(result.failures.some(item => item.entry_id === child.id)); assert.equal(await readFile(path.join(`${parent}-preserved`, '자식.txt'), 'utf8'), '중첩 원본');
});

test('logical remote trash preserves disk originals and no later prepare resurrects their IDs', async t => {
  const f = await fixture(t), state = f.store.state(f.id), entry = state.entries[f.entry.id], document = state.documents[entry.document_id];
  enqueue(f, 'TrashEntry', { id: entry.id }, { [`entries:${entry.id}`]: entry.revision, [`documents:${document.id}`]: document.revision });
  const result = await f.service.apply(f.id); assert.deepEqual(result.failures, []); assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), '원본 A');
  await f.service.prepare(f.id); assert.ok(f.store.state(f.id).entries[entry.id].deleted_at); assert.ok(f.store.state(f.id).documents[document.id].deleted_at);
  assert.equal(f.engine.db.prepare('SELECT status FROM unified_file_mappings WHERE entry_id=?').get(entry.id).status, 'remote_deleted');
});

test('workspace tombstone never applies a previously downloaded pending update to the original folder', async t => {
  const f = await fixture(t), remote = remoteVersion(f); f.files.receiveBlob(f.id, remote.blob, remote.data);
  const state = f.store.state(f.id); enqueue(f, 'DeleteWorkspace', {}, { [`workspace:${f.id}`]: state.workspace.revision });
  const result = await f.service.apply(f.id);
  assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), '원본 A', 'deleting cloud workspace must leave original bytes unchanged');
  assert.equal(result.applied, 0); assert.ok(f.store.state(f.id).workspace.deleted_at);
});

test('case-colliding remote names cannot be reported as two applied files on an insensitive volume', async t => {
  const f = await fixture(t), probe = path.join(f.base, 'CaseProbe'); await writeFile(probe, 'x');
  let insensitive = false; try { insensitive = (await lstat(path.join(f.base, 'caseprobe'))).ino === (await lstat(probe)).ino; } catch { /* Case-sensitive filesystem. */ }
  if (!insensitive) { t.skip('Host volume can represent both names; cross-OS application needs an insensitive volume fixture.'); return; }
  const ids = [], state = f.store.state(f.id), bytes = Buffer.from('동일 내용');
  for (const name of ['Collision.txt', 'collision.txt']) {
    const entryId = randomUUID(), documentId = randomUUID(), versionId = randomUUID(); ids.push(entryId);
    enqueue(f, 'CreateEntry', { id: entryId, document_id: documentId, parent_id: state.workspace.root_entry_id, kind: 'file', name });
    const blob = { id: versionId, sha256: hash(bytes), size: bytes.length, mime_type: 'text/plain' }, version = { id: versionId, workspace_id: f.id, document_id: documentId, blob, parent_version_ids: [], sources: [], created_at: new Date().toISOString(), created_by: f.store.row(f.id).actor_id, change_note: '' };
    enqueue(f, 'AppendDocumentVersion', { version }, { [`documents:${documentId}`]: 0 }); f.files.receiveBlob(f.id, blob, bytes);
  }
  const result = await f.service.apply(f.id); assert.ok(result.failures.some(failure => ids.includes(failure.entry_id)), 'one physical file cannot satisfy two distinct logical entries');
  const ready = f.engine.db.prepare("SELECT count(*) AS n FROM unified_file_mappings WHERE entry_id IN (?,?) AND status='ready'").get(...ids).n; assert.ok(ready < 2);
});

test('initial binding reauthors fresh unsent operations while immutable imported history keeps its author', async t => {
  const f = await fixture(t), before = f.store.state(f.id), importedId = before.documents[f.document.id].content_head_id, oldAuthor = before.versions[importedId].created_by;
  const pending = remoteVersion(f), pendingRow = f.store.pending(f.id).find(row => row.command.type === 'AppendDocumentVersion'); const owner = { server: 'https://api.example.test', user_id: randomUUID() };
  f.service.bind(f.id, owner);
  let state = f.store.state(f.id); assert.equal(state.versions[importedId].created_by, oldAuthor); assert.equal(state.versions[pending.version.id].created_by, owner.user_id);
  const authored = f.store.pending(f.id).find(row => row.operation_id === pendingRow.operation_id); assert.equal(authored.command.payload.version.created_by, owner.user_id);
  const fingerprint = JSON.stringify(authored.command); f.service.bind(f.id, owner); assert.equal(JSON.stringify(f.store.pending(f.id).find(row => row.operation_id === pendingRow.operation_id).command), fingerprint, 'already bound/sent commands cannot be rewritten');
  assert.throws(() => f.service.bind(f.id, { ...owner, user_id: randomUUID() }), /다른 서버 또는 계정/);
});

test('production native mutation hooks emit common draft/canvas/position/rename commands and survive restart without echo', async t => {
  const f = await fixture(t, { hooks: true }); const initial = f.store.pending(f.id).length;
  const draft = f.engine.createDraft(f.id, randomUUID()), content = { title: '직접 저장한 초안', blocks: [{ id: 'paragraph1', type: 'paragraph', text: '기기 편집 내용', level: 2, items: [], rows: [], source_ids: [] }] };
  const saved = f.engine.saveDraft(f.id, draft.id, draft.revision, content); let state = f.store.state(f.id);
  assert.equal(state.drafts[draft.id].revision, saved.revision); assert.equal(JSON.parse(state.drafts[draft.id].content).title, content.title);
  const elementId = randomUUID(); f.engine.putCanvasItem(f.id, '', 'element', { id: elementId, kind: 'triangle', text: '공통 메모', x: 12, y: 34, width: 240, height: 180, color: 'violet', font_size: 28 }, 0);
  f.engine.savePositions(f.id, [{ id: f.entry.id, x: 150, y: 260 }]);
  await f.engine.renameFile(f.id, f.entry.id, '기기 이름.txt'); state = f.store.state(f.id);
  assert.equal(state.canvas_elements[elementId].kind, 'triangle'); assert.equal(state.entries[f.entry.id].name, '기기 이름.txt'); assert.equal(state.entries[f.entry.id].x, 150);
  assert.equal(await readFile(path.join(f.root, '기기 이름.txt'), 'utf8'), '원본 A');
  assert.equal(f.engine.db.prepare('SELECT relative_path FROM unified_file_mappings WHERE entry_id=?').get(f.entry.id).relative_path, '기기 이름.txt');
  const pending = f.store.pending(f.id), types = pending.slice(initial).map(row => row.command.type);
  for (const type of ['CreateDraft', 'SaveDraft', 'PutCanvasElement', 'SetEntryPositions', 'MoveEntry']) assert.ok(types.includes(type), type);
  f.service.bridge.capture(f.id); assert.equal(f.store.pending(f.id).length, pending.length);
  await f.engine.close(); f.engine = await new WorkspaceEngine(f.data, { unifiedCommands: true }).init({ watchFiles: false });
  assert.equal(f.engine.unified.store.pending(f.id).length, pending.length); assert.equal(f.engine.unified.store.state(f.id).drafts[draft.id].content, state.drafts[draft.id].content);
});

function atomicSnapshot(f) {
  const db = f.engine.db;
  return {
    drafts: db.prepare('SELECT * FROM local_drafts WHERE workspace_id=? ORDER BY id').all(f.id),
    canvas: db.prepare('SELECT * FROM local_canvas WHERE workspace_id=? ORDER BY id').all(f.id),
    positions: db.prepare('SELECT p.* FROM positions p JOIN entries e ON e.id=p.entry_id WHERE e.workspace_id=? ORDER BY p.entry_id').all(f.id),
    changes: db.prepare('SELECT * FROM local_changes WHERE workspace_id=? ORDER BY device_sequence').all(f.id),
    sequence: db.prepare("SELECT value FROM local_settings WHERE key='change-sequence'").get(),
    outbox: db.prepare('SELECT * FROM unified_outbox WHERE workspace_id=? ORDER BY sequence').all(f.id),
    common: f.engine.unified.store.state(f.id),
  };
}
function failAfterCommonCapture(f) {
  const bridge = f.engine.unified.bridge, original = bridge.capture.bind(bridge);
  bridge.capture = (...args) => { original(...args); throw new Error('INJECTED_COMMON_STORAGE_FAILURE'); };
  return () => { bridge.capture = original; };
}

test('native draft save and common outbox roll back together when capture fails before commit', async t => {
  const f = await fixture(t, { hooks: true }), draft = f.engine.createDraft(f.id, randomUUID()), before = atomicSnapshot(f);
  const typed = { title: '아직 저장하지 못한 입력', blocks: [{ id: 'p1', type: 'paragraph', text: '호출자가 보존하는 내용', level: 2, items: [], rows: [], source_ids: [] }] };
  const restore = failAfterCommonCapture(f);
  try { assert.throws(() => f.engine.saveDraft(f.id, draft.id, draft.revision, typed), /INJECTED_COMMON_STORAGE_FAILURE/); } finally { restore(); }
  assert.deepEqual(atomicSnapshot(f), before); assert.equal(typed.blocks[0].text, '호출자가 보존하는 내용'); assert.equal(f.engine.db.isTransaction, false);
  const saved = f.engine.saveDraft(f.id, draft.id, draft.revision, typed); assert.equal(saved.revision, draft.revision + 1);
});

test('native canvas and position edits cannot commit without their common commands', async t => {
  const f = await fixture(t, { hooks: true }), elementId = randomUUID();
  f.engine.putCanvasItem(f.id, '', 'element', { id: elementId, kind: 'text', text: '이전 메모', x: 10, y: 20, width: 240, height: 180, color: 'violet', font_size: 24 }, 0);
  let before = atomicSnapshot(f), restore = failAfterCommonCapture(f);
  try { assert.throws(() => f.engine.putCanvasItem(f.id, '', 'element', { id: elementId, kind: 'text', text: '실패한 수정', x: 10, y: 20, width: 240, height: 180, color: 'violet', font_size: 24 }, 1), /INJECTED_COMMON_STORAGE_FAILURE/); } finally { restore(); }
  assert.deepEqual(atomicSnapshot(f), before);
  before = atomicSnapshot(f); restore = failAfterCommonCapture(f);
  try { assert.throws(() => f.engine.savePositions(f.id, [{ id: f.entry.id, x: 999, y: 888 }]), /INJECTED_COMMON_STORAGE_FAILURE/); } finally { restore(); }
  assert.deepEqual(atomicSnapshot(f), before); assert.equal(f.engine.db.isTransaction, false);
});

test('chat creation, assistant completion and failure share their common-command transaction', async t => {
  const f = await fixture(t, { hooks: true }), db = f.engine.db;
  const chatRows = () => ({ sessions: db.prepare('SELECT * FROM local_chat_sessions WHERE workspace_id=? ORDER BY id').all(f.id), messages: db.prepare('SELECT m.* FROM local_chat_messages m JOIN local_chat_sessions s ON s.id=m.session_id WHERE s.workspace_id=? ORDER BY m.id').all(f.id), ...atomicSnapshot(f) });
  let before = chatRows(), restore = failAfterCommonCapture(f);
  try { assert.throws(() => f.engine.createChatSession(f.id, { requestId: randomUUID(), title: '실패한 대화' }), /INJECTED_COMMON_STORAGE_FAILURE/); } finally { restore(); }
  assert.deepEqual(chatRows(), before);
  const session = f.engine.createChatSession(f.id, { requestId: randomUUID(), title: '원자적 대화' });
  f.engine.chat.evidence = async () => ({ scope: 'current', as_of: null, sources: [], warnings: [] });
  const prepared = await f.engine.prepareChat(f.id, session.id, { requestId: randomUUID(), question: '질문', scope: 'current' });
  before = chatRows(); restore = failAfterCommonCapture(f);
  try { assert.throws(() => f.engine.finishChat(f.id, session.id, prepared, { claims: [], insufficient: true }), /INJECTED_COMMON_STORAGE_FAILURE/); } finally { restore(); }
  assert.deepEqual(chatRows(), before);
  before = chatRows(); restore = failAfterCommonCapture(f);
  try { assert.throws(() => f.engine.failChat(f.id, session.id, prepared, 'AI_TIMEOUT'), /INJECTED_COMMON_STORAGE_FAILURE/); } finally { restore(); }
  assert.deepEqual(chatRows(), before);
});

test('asynchronous chat preparation persists user/assistant pair and outbox atomically after evidence lookup', async t => {
  const f = await fixture(t, { hooks: true }), db = f.engine.db, session = f.engine.createChatSession(f.id, { requestId: randomUUID(), title: '준비 중인 요청' });
  f.engine.chat.evidence = async () => ({ scope: 'current', as_of: null, sources: [], warnings: [] });
  const before = { atomic: atomicSnapshot(f), messages: db.prepare('SELECT * FROM local_chat_messages WHERE session_id=?').all(session.id) }, restore = failAfterCommonCapture(f);
  try { await assert.rejects(f.engine.prepareChat(f.id, session.id, { requestId: randomUUID(), question: '아직 전송되지 않은 질문', scope: 'current' }), /INJECTED_COMMON_STORAGE_FAILURE/); } finally { restore(); }
  assert.deepEqual({ atomic: atomicSnapshot(f), messages: db.prepare('SELECT * FROM local_chat_messages WHERE session_id=?').all(session.id) }, before);
});

test('asynchronous chat retry cannot change request identity without its common command', async t => {
  const f = await fixture(t, { hooks: true }), db = f.engine.db, session = f.engine.createChatSession(f.id, { requestId: randomUUID(), title: '재시도 요청' });
  f.engine.chat.evidence = async () => ({ scope: 'current', as_of: null, sources: [], warnings: [] });
  const prepared = await f.engine.prepareChat(f.id, session.id, { requestId: randomUUID(), question: '질문', scope: 'current' }); f.engine.failChat(f.id, session.id, prepared, 'AI_TIMEOUT');
  const before = { atomic: atomicSnapshot(f), messages: db.prepare('SELECT * FROM local_chat_messages WHERE session_id=? ORDER BY sequence').all(session.id) }, restore = failAfterCommonCapture(f);
  try { await assert.rejects(f.engine.prepareChatRetry(f.id, session.id, prepared.messageId), /INJECTED_COMMON_STORAGE_FAILURE/); } finally { restore(); }
  assert.deepEqual({ atomic: atomicSnapshot(f), messages: db.prepare('SELECT * FROM local_chat_messages WHERE session_id=? ORDER BY sequence').all(session.id) }, before);
});

test('a production copy of a pinned history publishes provenance in its first immutable version', async t => {
  const f = await fixture(t, { hooks: true }), original = await f.engine.openDocument(f.id, f.entry.id);
  await writeFile(path.join(f.root, '원본.txt'), '현재 디스크 B'); await f.engine.scan(f.id); await f.engine.openDocument(f.id, f.entry.id);
  const document = f.engine.getDocument(f.id, f.entry.id); f.engine.setCurrentVersion(f.id, document.id, original.version_id, document.revision);
  const count = f.store.pending(f.id).length, copy = await f.engine.copyFile(f.id, f.entry.id, randomUUID());
  assert.equal(await readFile(path.join(f.root, copy.name), 'utf8'), '원본 A'); assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), '현재 디스크 B');
  const state = f.store.state(f.id), copiedEntry = state.entries[copy.id], copiedDocument = state.documents[copiedEntry.document_id], version = state.versions[copiedDocument.content_head_id];
  assert.ok(version); assert.equal(version.sources.length, 1); assert.equal(version.sources[0].kind, 'document'); assert.equal(version.sources[0].document_id, document.id); assert.equal(version.sources[0].version_id, original.version_id);
  assert.equal(version.change_note, '복사본 생성'); const raw = f.engine.db.prepare('SELECT * FROM local_versions WHERE id=?').get(version.id);
  assert.equal(raw.source_version_id, original.version_id); assert.equal(Buffer.from(raw.bytes).toString(), '원본 A');
  const firstAppend = f.store.pending(f.id).slice(count).find(item => item.command.type === 'AppendDocumentVersion' && item.command.payload.version.document_id === copiedDocument.id);
  assert.ok(firstAppend); assert.equal(firstAppend.command.payload.version.sources[0].version_id, original.version_id, 'provenance must exist before the immutable version is first queued');
});

test('pin then unpin follows canonical content head while a pending remote target never echoes the old observed file', async t => {
  const f = await fixture(t, { hooks: true }), state = f.store.state(f.id), a = state.documents[f.document.id].content_head_id;
  const remote = remoteVersion(f); f.files.receiveBlob(f.id, remote.blob, remote.data); await f.service.apply(f.id);
  let native = f.engine.getDocument(f.id, f.entry.id); f.engine.setCurrentVersion(f.id, native.id, a, native.revision);
  assert.equal(f.store.state(f.id).documents[native.id].reference_head_id, a); assert.equal(f.store.state(f.id).documents[native.id].reference_pinned, true);
  native = f.engine.getDocument(f.id, f.entry.id); f.engine.setCurrentVersion(f.id, native.id, null, native.revision);
  assert.equal(f.store.state(f.id).documents[native.id].reference_pinned, false); assert.equal(f.store.state(f.id).documents[native.id].reference_head_id, remote.version.id);
  // A newer logical head is available before its bytes reach this disk.
  const pending = remoteVersion(f, '아직 내려받지 않은 원격 C'); f.service.bridge.project(f.id); const before = f.store.pending(f.id).length;
  f.service.bridge.capture(f.id); assert.equal(f.store.pending(f.id).length, before);
  assert.equal(f.store.state(f.id).documents[native.id].content_head_id, pending.version.id); assert.equal(f.store.state(f.id).documents[native.id].reference_head_id, pending.version.id);
  assert.equal(f.engine.db.prepare('SELECT observed_version_id FROM unified_file_mappings WHERE entry_id=?').get(f.entry.id).observed_version_id, remote.version.id);
  assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), remote.data.toString());
});

test('one external scan reconciles renamed C, fresh C and an existing file moved into fresh C atomically', async t => {
  const f = await fixture(t, { hooks: true }); await mkdir(path.join(f.root, 'C')); await f.engine.scan(f.id);
  const before = f.store.state(f.id), oldFolder = Object.values(before.entries).find(entry => entry.name === 'C'), count = f.store.pending(f.id).length;
  await rename(path.join(f.root, 'C'), path.join(f.root, 'D')); await mkdir(path.join(f.root, 'C')); await rename(path.join(f.root, '원본.txt'), path.join(f.root, 'C', '원본.txt'));
  await f.engine.scan(f.id); const snapshot = f.engine.snapshot(f.id); assert.equal(snapshot.status, 'ready'); assert.deepEqual(snapshot.warnings, []);
  const state = f.store.state(f.id), replacement = Object.values(state.entries).find(entry => entry.name === 'C' && entry.kind === 'folder');
  assert.ok(replacement); assert.notEqual(replacement.id, oldFolder.id); assert.equal(state.entries[oldFolder.id].name, 'D'); assert.equal(state.entries[f.entry.id].parent_id, replacement.id);
  assert.equal(await readFile(path.join(f.root, 'C', '원본.txt'), 'utf8'), '원본 A'); assert.equal(f.engine.db.prepare('SELECT relative_path FROM unified_file_mappings WHERE entry_id=?').get(f.entry.id).relative_path, 'C/원본.txt');
  const commands = f.store.pending(f.id).slice(count); assert.equal(commands.length, 1); assert.equal(commands[0].command.type, 'ReconcileEntries'); assert.equal(commands[0].command.payload.creates.length, 1); assert.equal(commands[0].command.payload.moves.length, 2);
});

test('500 new native folders after initial import use one reconciliation command and one canonical persistence', async t => {
  const f = await fixture(t, { hooks: true }), count = f.store.pending(f.id).length; let next = 0;
  await Promise.all(Array.from({ length: 128 }, async () => { for (;;) { const n = next++; if (n >= 500) return; await mkdir(path.join(f.root, `추가-${String(n).padStart(3, '0')}`)); } }));
  const originalPersist = f.store.persist.bind(f.store); let persistence = 0;
  f.store.persist = (...args) => { persistence++; return originalPersist(...args); };
  try { await f.engine.scan(f.id); } finally { f.store.persist = originalPersist; }
  assert.equal(f.engine.snapshot(f.id).status, 'ready'); const commands = f.store.pending(f.id).slice(count);
  assert.equal(commands.length, 1); assert.equal(commands[0].command.type, 'ReconcileEntries'); assert.equal(commands[0].command.payload.creates.length, 500); assert.equal(persistence, 1, 'one scan must not persist an ever-growing state once per entry');
  assert.ok(Object.values(f.store.state(f.id).entries).find(entry => entry.name === '추가-499'));
  f.service.bridge.capture(f.id); assert.equal(f.store.pending(f.id).length, count + 1);
});


for (const scenario of ['occupied-source', 'missing-stage']) test(`workspace deletion retains actionable recovery for ${scenario}`, async t => {
  const f = await fixture(t), state = f.store.state(f.id), entry = state.entries[f.entry.id];
  enqueue(f, 'MoveEntry', { id: entry.id, parent_id: entry.parent_id, name: 'remote-name.txt' }, { [`entries:${entry.id}`]: entry.revision });
  const stage = f.files.moves.moveToStaging.bind(f.files.moves); f.files.moves.moveToStaging = async (...args) => { await stage(...args); throw new Error('EXIT_AFTER_STAGE'); };
  await f.service.apply(f.id); const staged = (await readdir(f.root)).find(name => name.endsWith('.move')); assert.ok(staged);
  if (scenario === 'occupied-source') await writeFile(path.join(f.root, '원본.txt'), 'externally created'); else await rm(path.join(f.root, staged));
  const current = f.store.state(f.id); enqueue(f, 'DeleteWorkspace', {}, { [`workspace:${f.id}`]: current.workspace.revision });
  const result = await f.service.apply(f.id); assert.ok(result.failures.length);
  assert.ok(f.engine.unifiedRecovery(f.id).some(item => item.reason.includes(scenario === 'occupied-source' ? '다른 파일' : '위치')));
  if (scenario === 'occupied-source') { assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), 'externally created'); assert.equal(await readFile(path.join(f.root, staged), 'utf8'), '원본 A'); }
});

function replaceRemoteFile(f, original, name = original.name) {
  const before = f.store.state(f.id), doc = before.documents[original.document_id];
  assert.equal(enqueue(f, 'TrashEntry', { id: original.id, observed_heads: { [doc.id]: doc.content_head_id } }, { [`entries:${original.id}`]: original.revision, [`documents:${doc.id}`]: doc.revision }).status, 'applied');
  const id = randomUUID(), documentId = randomUUID();
  assert.equal(enqueue(f, 'CreateEntry', { id, parent_id: original.parent_id, name, kind: 'file', document_id: documentId }).status, 'applied');
  const replacement = remoteVersion(f, '같은 이름의 새 원본', { documentId });
  f.files.receiveBlob(f.id, replacement.blob, replacement.data);
  return { id, documentId, ...replacement };
}

test('a deleted file and a new remote file at the same path project and apply without losing either history', async t => {
  const f = await fixture(t), before = f.store.state(f.id), original = before.entries[f.entry.id], oldVersion = before.documents[original.document_id].content_head_id;
  await rm(path.join(f.root, '원본.txt'));
  const replacement = replaceRemoteFile(f, original), pending = f.store.pending(f.id).length;
  f.service.bridge.project(f.id);
  const result = await f.service.apply(f.id); assert.deepEqual(result.failures, []);
  assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), replacement.data.toString());
  assert.equal(f.engine.snapshot(f.id).entries.find(entry => entry.relative_path === '원본.txt').id, replacement.id);
  const archived = f.engine.db.prepare('SELECT * FROM entries WHERE id=?').get(original.id);
  assert.equal(archived.present, 0); assert.equal(archived.name, original.name);
  assert.equal(Buffer.from(f.store.blob(f.id, before.versions[oldVersion].blob.id).data).toString(), '원본 A');
  await f.service.prepare(f.id); assert.deepEqual(f.store.pending(f.id).slice(pending).map(item => item.command.type).filter(type => type !== 'SetEntryPositions'), [], 'projected history must not become a new local file');
  assert.ok(f.store.state(f.id).entries[original.id].deleted_at);
  await f.engine.close(); f.engine = await new WorkspaceEngine(f.data).init({ watchFiles: false });
  assert.equal(f.engine.snapshot(f.id).entries.find(entry => entry.relative_path === '원본.txt').id, replacement.id);
});

test('reusing a remote name never overwrites an original that remains on the device', async t => {
  const f = await fixture(t), original = f.store.state(f.id).entries[f.entry.id];
  replaceRemoteFile(f, original); f.service.bridge.project(f.id);
  const result = await f.service.apply(f.id); assert.ok(result.failures.length);
  assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), '원본 A');
  assert.equal(Object.values(f.store.state(f.id).versions).length, 3);
});

test('an empty device can attach a workspace containing deleted and live entries with the same path', async t => {
  const f = await fixture(t), original = f.store.state(f.id).entries[f.entry.id];
  const replacement = replaceRemoteFile(f, original), remote = f.store.state(f.id);
  const root = path.join(f.base, 'clone'), data = path.join(f.base, 'clone-data'); await mkdir(root);
  const clone = await new WorkspaceEngine(data).init({ watchFiles: false }); t.after(() => clone.close());
  await clone.unified.attach(root, remote, 5, { server: 'http://localhost:8001', user_id: remote.versions[replacement.version.id].created_by });
  for (const version of Object.values(remote.versions)) clone.unified.files.receiveBlob(f.id, version.blob, f.store.blob(f.id, version.blob.id).data);
  const result = await clone.unified.apply(f.id); assert.deepEqual(result.failures, []);
  assert.equal(await readFile(path.join(root, '원본.txt'), 'utf8'), replacement.data.toString());
  assert.equal(clone.snapshot(f.id).entries.filter(entry => entry.relative_path === '원본.txt').length, 1);
  assert.ok(clone.unified.store.state(f.id).entries[original.id].deleted_at);
  assert.equal(clone.db.prepare('SELECT count(*) AS n FROM local_versions').get().n, 3);
});

test('a rename followed by a new file at the old name releases pending projection slots after disk application', async t => {
  const f = await fixture(t), before = f.store.state(f.id), original = before.entries[f.entry.id];
  assert.equal(enqueue(f, 'MoveEntry', { id: original.id, parent_id: original.parent_id, name: '옮긴 원본.txt' }, { [`entries:${original.id}`]: original.revision }).status, 'applied');
  const id = randomUUID(), documentId = randomUUID();
  enqueue(f, 'CreateEntry', { id, parent_id: original.parent_id, name: original.name, kind: 'file', document_id: documentId });
  const replacement = remoteVersion(f, '새 파일', { documentId }); f.files.receiveBlob(f.id, replacement.blob, replacement.data);
  f.service.bridge.project(f.id); assert.equal(f.engine.db.prepare('SELECT present FROM entries WHERE id=?').get(id).present, 0);
  const result = await f.service.apply(f.id); assert.deepEqual(result.failures, []);
  assert.equal(await readFile(path.join(f.root, '옮긴 원본.txt'), 'utf8'), '원본 A');
  assert.equal(await readFile(path.join(f.root, '원본.txt'), 'utf8'), '새 파일');
  assert.equal(f.engine.snapshot(f.id).entries.find(entry => entry.id === id).relative_path, '원본.txt');
});

test('reusing a deleted folder path preserves old canvas scope and nested file histories', async t => {
  const f = await fixture(t), before = f.store.state(f.id), folder = Object.values(before.entries).find(entry => entry.name === '하위'), child = Object.values(before.entries).find(entry => entry.parent_id === folder.id), doc = before.documents[child.document_id];
  const noteId = randomUUID(); enqueue(f, 'PutCanvasElement', { element: { id: noteId, workspace_id: f.id, scope_id: folder.id, kind: 'text', content: '이전 폴더 메모', revision: 0, deleted_at: null, x: 0, y: 0, width: 320, height: 160, sources: [], color: 'violet' } });
  f.service.bridge.project(f.id);
  enqueue(f, 'TrashEntry', { id: folder.id, observed_heads: { [doc.id]: doc.content_head_id } }, { [`entries:${folder.id}`]: folder.revision, [`entries:${child.id}`]: child.revision, [`documents:${doc.id}`]: doc.revision });
  const newFolder = randomUUID(), newChild = randomUUID(), newDocument = randomUUID();
  enqueue(f, 'CreateEntry', { id: newFolder, parent_id: folder.parent_id, name: folder.name, kind: 'folder' });
  enqueue(f, 'CreateEntry', { id: newChild, parent_id: newFolder, name: child.name, kind: 'file', document_id: newDocument });
  const replacement = remoteVersion(f, '새 하위 원본', { documentId: newDocument }); f.files.receiveBlob(f.id, replacement.blob, replacement.data);
  await rm(path.join(f.root, folder.name), { recursive: true });
  f.service.bridge.project(f.id);
  const result = await f.service.apply(f.id); assert.deepEqual(result.failures, []);
  assert.equal(await readFile(path.join(f.root, folder.name, child.name), 'utf8'), '새 하위 원본');
  assert.equal(f.engine.canvasSnapshot(f.id, folder.name).elements.some(item => item.id === noteId), false);
  const pending = f.store.pending(f.id).length; await f.service.prepare(f.id);
  assert.deepEqual(f.store.pending(f.id).slice(pending).map(item => item.command.type).filter(type => type !== 'SetEntryPositions'), []);
  assert.equal(f.store.state(f.id).canvas_elements[noteId].scope_id, folder.id);
});
