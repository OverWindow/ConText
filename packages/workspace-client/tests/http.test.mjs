import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { HttpWorkspaceRepository } from '../src/http.ts';
import { applyCommand, createWorkspaceState } from '../../domain/src/index.ts';
function setup() {
  let actor = randomUUID(); const id = randomUUID(), root = randomUUID(), now = new Date().toISOString();
  let state = createWorkspaceState({ id, name: 'Fixture', root_entry_id: root, epoch: 1, revision: 1, created_at: now, updated_at: now, deleted_at: null });
  let sequence = 0, lose = false; const log = [], receipts = new Map(), operations = [], values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const request = async (path, init) => {
    if (path === '/me') return { id: actor };
    if (path.endsWith('/devices')) return {};
    if (path.endsWith('/bootstrap')) return { state: structuredClone(state), cursor: sequence, epoch: state.workspace.epoch, role: 'OWNER' };
    if (path.includes('/changes?')) { const after = Number(new URL(path, 'http://fixture').searchParams.get('after')); const changes = log.filter(item => item.sequence > after); return { changes: structuredClone(changes), cursor: changes.at(-1)?.sequence || after, has_more: false }; }
    if (path.endsWith('/commands')) {
      const { commands } = JSON.parse(init.body); const results = [];
      for (const command of commands) {
        operations.push(command); let receipt = receipts.get(command.operation_id);
        if (!receipt) { const result = applyCommand(state, command, { actor_id: actor, role: 'OWNER', now: new Date().toISOString() }); state = result.state; if (result.changes.length) log.push({ sequence: ++sequence, changes: result.changes }); receipt = { operation_id: command.operation_id, status: result.status, changes: result.changes, conflict_ids: result.conflict_ids, sequence, error: result.error }; receipts.set(command.operation_id, receipt); }
        results.push(receipt);
      }
      await new Promise(resolve => setTimeout(resolve, 3));
      if (lose) { lose = false; throw new Error('lost response'); }
      return { results: structuredClone(results), cursor: sequence, epoch: state.workspace.epoch };
    }
    throw new Error(`Unexpected ${path}`);
  };
  return { id, root, request, storage, operations, values, state: () => state, actor: () => actor, update: value => { state = value; }, lose: () => { lose = true; }, account: value => { actor = value; } };
}
function setupText(t, bytes = Buffer.from('Original\n')) {
  const f = setup(), entryId = randomUUID(), documentId = randomUUID(), versionId = randomUUID(), blobs = new Map(), prepared = [], transfers = [];
  const storeBlob = data => { const blob = { id: randomUUID(), sha256: createHash('sha256').update(data).digest('hex'), size: data.length, mime_type: 'text/markdown' }; blobs.set(blob.id, Buffer.from(data)); return blob; };
  const initial = f.state();
  initial.entries[entryId] = { id: entryId, workspace_id: f.id, parent_id: f.root, kind: 'file', name: '원본.md', document_id: documentId, revision: 1, position_revision: 0, x: null, y: null, area_positioned: false, deleted_at: null };
  initial.documents[documentId] = { id: documentId, workspace_id: f.id, content_head_id: versionId, reference_head_id: versionId, reference_pinned: false, revision: 1, deleted_at: null };
  initial.versions[versionId] = { id: versionId, workspace_id: f.id, document_id: documentId, blob: storeBlob(bytes), parent_version_ids: [], sources: [], created_at: new Date().toISOString(), created_by: f.actor(), change_note: 'Initial' };
  const request = async (path, init) => {
    if (path.endsWith('/download')) { const version = f.state().versions[path.split('/').at(-2)]; return { url: `http://bytes.test/${version.blob.id}`, version }; }
    if (path.endsWith('/blobs/prepare')) { const blob = JSON.parse(init.body); prepared.push(blob); return { blob, upload_url: `http://bytes.test/${blob.id}`, already_uploaded: false }; }
    if (path.endsWith('/blobs/complete')) return { verified: true };
    return f.request(path, init);
  };
  t.mock.method(globalThis, 'fetch', async (input, init) => { const id = String(input).split('/').at(-1); transfers.push({ id, method: init?.method || 'GET' }); if (init?.method === 'PUT') { blobs.set(id, Buffer.from(init.body)); return new Response(null, { status: 200 }); } return new Response(blobs.get(id)); });
  const repo = new HttpWorkspaceRepository(f.id, request, f.storage); t.after(() => repo.dispose());
  return { ...f, request, repo, blobs, prepared, transfers, entryId, documentId, versionId, storeBlob, remote: async data => {
    const version = { ...f.state().versions[versionId], id: randomUUID(), blob: storeBlob(data), parent_version_ids: [f.state().documents[documentId].content_head_id], created_at: new Date().toISOString() };
    await f.request(`/workspaces/${f.id}/commands`, { body: JSON.stringify({ commands: [{ schema_version: 2, operation_id: randomUUID(), workspace_id: f.id, device_id: randomUUID(), workspace_epoch: 1, type: 'AppendDocumentVersion', payload: { version, select_head: true }, base_revisions: { [`documents:${documentId}`]: f.state().documents[documentId].revision } }] }) }); return version;
  } };
}

test('change notifications wake the durable cursor path and disposal closes subscriptions', async t => {
  const f = setup(); let hint, closed = false;
  const repo = new HttpWorkspaceRepository(f.id, f.request, f.storage, { subscribe: onHint => { hint = onHint; return () => { closed = true; }; } });
  t.after(() => repo.dispose()); await repo.load();
  await f.request(`/workspaces/${f.id}/commands`, { body: JSON.stringify({ commands: [{ schema_version: 2, operation_id: randomUUID(), workspace_id: f.id, device_id: randomUUID(), workspace_epoch: 1, type: 'CreateEntry', payload: { id: randomUUID(), parent_id: f.root, name: '원격 알림', kind: 'folder' }, base_revisions: {} }] }) });
  assert.equal(repo.status().cursor, 0); const updated = new Promise(resolve => { const off = repo.onChanged(() => { off(); resolve(); }); });
  hint(); await updated; assert.equal(repo.status().cursor, 1);
  assert.equal((await repo.refresh()).entries.some(entry => entry.name === '원격 알림'), true); repo.dispose(); assert.equal(closed, true);
});
test('concurrent independent UI actions retain every operation and ACK', async t => {
  const f = setup(), repo = new HttpWorkspaceRepository(f.id, f.request, f.storage); t.after(() => repo.dispose()); await repo.load();
  await Promise.all([repo.createFolder('First', ''), repo.createFolder('Second', ''), repo.createFolder('Third', '')]);
  assert.deepEqual(Object.values(f.state().entries).filter(e => e.parent_id === f.root).map(e => e.name).sort(), ['First', 'Second', 'Third']);
  assert.equal(f.operations.length, 3); assert.equal(repo.status().pending, 0);
});
test('lost command response is replayed with the identical immutable operation on reload', async t => {
  const f = setup(), repo = new HttpWorkspaceRepository(f.id, f.request, f.storage); await repo.load(); f.lose(); await assert.rejects(repo.createFolder('Lost ACK', ''), /lost response/); repo.dispose();
  const reloaded = new HttpWorkspaceRepository(f.id, f.request, f.storage); t.after(() => reloaded.dispose()); await reloaded.load();
  assert.equal(Object.values(f.state().entries).filter(e => e.name === 'Lost ACK').length, 1);
  assert.equal(f.operations.length, 2); assert.deepEqual(f.operations[0], f.operations[1]); assert.equal(reloaded.status().pending, 0);
});
test('a different signed-in actor cannot replay another account pending writes', async t => {
  const f = setup(), repo = new HttpWorkspaceRepository(f.id, f.request, f.storage); await repo.load(); f.lose(); await assert.rejects(repo.createFolder('Account A', '')); repo.dispose();
  f.account(randomUUID()); const second = new HttpWorkspaceRepository(f.id, f.request, f.storage); t.after(() => second.dispose()); await second.load();
  assert.equal(f.operations.length, 1); assert.equal([...f.values].filter(([key,value]) => key.includes('.pending.') && JSON.parse(value).length === 1).length, 1);
});
test('conflicting canvas edits preserve candidate and resolve with current entity revision', async t => {
  const f = setup(), note = randomUUID(); const current = f.state(); current.canvas_elements[note] = { id: note, workspace_id: f.id, scope_id: f.root, kind: 'text', content: 'original', color: 'yellow', x: 0, y: 0, width: 320, height: 140, sources: [], revision: 1, deleted_at: null };
  const repo = new HttpWorkspaceRepository(f.id, f.request, f.storage); t.after(() => repo.dispose()); await repo.load();
  f.update({ ...f.state(), canvas_elements: { ...f.state().canvas_elements, [note]: { ...current.canvas_elements[note], content: 'remote saved', revision: 2 } } });
  await assert.rejects(repo.putCanvasItem(f.id, '', 'element', { id: note, kind: 'text', text: 'local preserved', x: 0, y: 0, width: 320, height: 140, color: 'yellow', font_size: 24 }, 1), /충돌/);
  assert.equal((await repo.conflicts()).length, 1); assert.equal(f.state().canvas_elements[note].content, 'remote saved');
  await assert.rejects(repo.putCanvasItem(f.id, '', 'element', { id: note, kind: 'text', text: 'auto-save retry', x:0,y:0,width:320,height:140,color:'yellow',font_size:24 },2), /해결하지 않은 충돌/); assert.equal(f.state().canvas_elements[note].content,'remote saved');
  // A normal pull supplies the latest remote state before conflict application.
  const fresh = new HttpWorkspaceRepository(f.id, f.request, f.storage); t.after(() => fresh.dispose()); await fresh.load(); const [conflict] = await fresh.conflicts(); await fresh.resolveConflict(conflict.id, 'keep_local');
  assert.equal(f.state().canvas_elements[note].content, 'local preserved'); assert.equal(f.state().conflicts[conflict.id].status, 'resolved');
});
test('text save keeps the loaded document CAS after pulling a newer remote head', async t => {
  const f = setupText(t), snapshot = await f.repo.load(), editor = f.repo.text(snapshot.entries.find(entry => entry.id === f.entryId)), loaded = await editor.load();
  const remote = await f.remote(Buffer.from('Remote B\n')); await f.repo.refresh();
  assert.equal((await f.repo.document(snapshot.entries[0])).file_version_id, remote.id);
  await assert.rejects(editor.save(loaded.revision, 'Local C\n'), /충돌/);
  const command = f.operations.at(-1), candidate = command.payload.version;
  assert.equal(command.base_revisions[`documents:${f.documentId}`], 1); assert.deepEqual(candidate.parent_version_ids, [f.versionId]);
  assert.equal(f.state().documents[f.documentId].content_head_id, remote.id);
  assert.ok(f.state().versions[f.versionId]); assert.ok(f.state().versions[remote.id]); assert.ok(f.state().versions[candidate.id]);
  assert.equal(f.blobs.get(candidate.blob.id).toString(), 'Local C\n');
  const [conflict] = await f.repo.conflicts(); assert.equal(f.state().conflicts[conflict.id].reason, 'concurrent_versions');
  assert.equal(f.state().conflicts[conflict.id].expected_revision, 1); assert.equal(f.state().conflicts[conflict.id].actual_revision, 2);
});
test('text edits preserve UTF-8 BOM and CRLF bytes across repeated saves', async t => {
  const f = setupText(t, Buffer.from('\ufeff첫 줄\r\n둘째 줄\r\n')), snapshot = await f.repo.load(), editor = f.repo.text(snapshot.entries[0]), loaded = await editor.load();
  assert.equal(loaded.text, '첫 줄\n둘째 줄\n');
  const saved = await editor.save(loaded.revision, '수정한 줄\n다음 줄\n'), version = f.state().versions[saved.revision];
  assert.deepEqual(f.blobs.get(version.blob.id), Buffer.from('\ufeff수정한 줄\r\n다음 줄\r\n'));
  const second = await editor.save(saved.revision, saved.text + '끝\n');
  assert.deepEqual(f.blobs.get(f.state().versions[second.revision].blob.id), Buffer.from('\ufeff수정한 줄\r\n다음 줄\r\n끝\r\n'));
  assert.equal(f.operations.at(-1).base_revisions[`documents:${f.documentId}`], 2);
});
test('text load rejects corrupted downloads before making bytes editable', async t => {
  const f = setupText(t), snapshot = await f.repo.load(); f.blobs.set(f.state().versions[f.versionId].blob.id, Buffer.from('Tampered\n'));
  await assert.rejects(f.repo.text(snapshot.entries[0]).load(), /무결성/); assert.equal(f.prepared.length, 0);
});
for (const [name, bytes, error] of [['invalid UTF-8', Buffer.from([0xc3, 0x28]), /UTF-8 파일/], ['binary NUL', Buffer.from('a\0b'), /텍스트 파일/]]) {
  test(`text load rejects ${name} without lossy decoding`, async t => { const f = setupText(t, bytes), snapshot = await f.repo.load(); await assert.rejects(f.repo.text(snapshot.entries[0]).load(), error); assert.equal(f.operations.length, 0); });
}
test('text editing enforces 2 MiB on declared, streamed and encoded bytes', async t => {
  const f = setupText(t, Buffer.from('\ufeffa\r\n')), snapshot = await f.repo.load(), editor = f.repo.text(snapshot.entries[0]), loaded = await editor.load();
  await assert.rejects(editor.save(loaded.revision, '가'.repeat(700000)), /최대 2MB/);
  await assert.rejects(editor.save(loaded.revision, '\n'.repeat(1024 * 1024)), /줄바꿈과 BOM/); assert.equal(f.prepared.length, 0);
  f.blobs.set(f.state().versions[f.versionId].blob.id, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(editor.load(), /2MB 이하/);
  const oversized = f.state(); oversized.versions[f.versionId].blob.size = 2 * 1024 * 1024 + 1; f.update(oversized);
  const before = f.transfers.length; const fresh = new HttpWorkspaceRepository(f.id, f.request, f.storage); t.after(() => fresh.dispose()); const largeSnapshot = await fresh.load();
  await assert.rejects(fresh.text(largeSnapshot.entries[0]).load(), /2MB 이하/); assert.equal(f.transfers.length, before);
});
test('a valid 2 MiB UTF-8 file remains editable without adding BOM or changing LF', async t => {
  const bytes = Buffer.from('a\n'.repeat(1024 * 1024)), f = setupText(t, bytes), snapshot = await f.repo.load(), editor = f.repo.text(snapshot.entries[0]), loaded = await editor.load();
  const saved = await editor.save(loaded.revision, 'b' + loaded.text.slice(1));
  assert.deepEqual(f.blobs.get(f.state().versions[saved.revision].blob.id), Buffer.from('b' + bytes.toString().slice(1)));
});


test('rejected browser input survives reload outside the send queue and independent edits continue', async t => {
  const f = setup(), repo = new HttpWorkspaceRepository(f.id, f.request, f.storage); await repo.load();
  await repo.createFolder('same', ''); await assert.rejects(repo.createFolder('same', ''), /보존/);
  const [saved] = await repo.recovery(); assert.equal(saved.candidate.payload.name, 'same');
  assert.equal(repo.status().pending, 0); await repo.createFolder('independent', ''); repo.dispose();
  const next = new HttpWorkspaceRepository(f.id, f.request, f.storage); t.after(() => next.dispose()); await next.load();
  assert.equal((await next.recovery())[0].id, saved.id); assert.equal(next.status().state, 'conflict');
  f.account(randomUUID()); const other = new HttpWorkspaceRepository(f.id, f.request, f.storage); t.after(() => other.dispose()); await other.load(); assert.deepEqual(await other.recovery(), []);
});
test('full recovery storage cannot discard the original pending browser command', async t => {
  const f = setup(), repo = new HttpWorkspaceRepository(f.id, f.request, f.storage); await repo.load(); await repo.createFolder('same', '');
  const original = f.storage.setItem; f.storage.setItem = (key, value) => { if (key.includes('.recovery.')) throw new Error('storage quota'); original(key, value); };
  await assert.rejects(repo.createFolder('same', ''), /storage quota/); assert.equal(repo.status().pending, 1); repo.dispose();
  f.storage.setItem = original;
  const next = new HttpWorkspaceRepository(f.id, f.request, f.storage); t.after(() => next.dispose()); await next.load(); assert.equal(next.status().pending, 0); assert.equal((await next.recovery()).length, 1);
});
test('conflict resolution uses the state the browser user reviewed even after a newer pull', async t => {
  const f = setup(), note = randomUUID(); f.state().canvas_elements[note] = { id: note, workspace_id: f.id, scope_id: f.root, kind: 'text', content: 'base', color: 'yellow', x: 0, y: 0, width: 320, height: 140, sources: [], revision: 1, deleted_at: null };
  const repo = new HttpWorkspaceRepository(f.id, f.request, f.storage); t.after(() => repo.dispose()); await repo.load();
  f.state().canvas_elements[note].content = 'remote B'; f.state().canvas_elements[note].revision = 2;
  await assert.rejects(repo.putCanvasItem(f.id, '', 'element', { id: note, kind: 'text', text: 'local C', x:0,y:0,width:320,height:140,color:'yellow' }, 1));
  await repo.refresh(); const [reviewed] = await repo.conflicts();
  f.state().canvas_elements[note].content = 'remote D'; f.state().canvas_elements[note].revision = 3;
  const reload = new HttpWorkspaceRepository(f.id, f.request, f.storage); t.after(() => reload.dispose()); await reload.load();
  await assert.rejects(reload.resolveConflict(reviewed.id, 'keep_local', reviewed.base_revisions));
  assert.equal(f.state().canvas_elements[note].content, 'remote D'); assert.equal(f.state().conflicts[reviewed.id].status, 'open');
});


test('a rejected browser file version exposes its verified original recovery path', async t => {
  const f = setupText(t), links = [], calls = [];
  const request = async (path, init) => {
    calls.push(path);
    if (path.endsWith('/commands')) { const commands = JSON.parse(init.body).commands; return { results: commands.map(command => ({ operation_id: command.operation_id, status: 'rejected', changes: [], conflict_ids: [], error: { code:'FORBIDDEN', message:'Permission changed' } })) }; }
    if (path.endsWith('/recovery')) return { url:'https://private.example.test/signed', blob:f.prepared.at(-1) };
    return f.request(path, init);
  };
  const original = globalThis.document; globalThis.document = { createElement: () => { const link = { click: () => links.push(link) }; return link; } }; t.after(() => { globalThis.document = original; });
  const repo = new HttpWorkspaceRepository(f.id, request, f.storage); t.after(() => repo.dispose()); const snapshot = await repo.load(), editor = repo.text(snapshot.entries[0]), loaded = await editor.load();
  await assert.rejects(editor.save(loaded.revision, 'rejected but preserved')); const [saved] = await repo.recovery(); assert.equal(saved.has_original, true);
  await repo.downloadRecoveryOriginal(saved.id); assert.equal(links[0].href, 'https://private.example.test/signed'); assert.ok(calls.some(path => path.endsWith(`/blobs/${f.prepared.at(-1).id}/recovery`)));
  assert.equal(f.blobs.get(f.prepared.at(-1).id).toString(), 'rejected but preserved');
});

test('retrying an old ACK cannot overwrite a newer bootstrapped rename', async t => {
  const f = setup(), repo = new HttpWorkspaceRepository(f.id, f.request, f.storage);
  await repo.load(); f.lose(); await assert.rejects(repo.createFolder('Before', ''), /lost response/); repo.dispose();
  const entry = Object.values(f.state().entries).find(item => item.name === 'Before');
  await f.request(`/workspaces/${f.id}/commands`, { body: JSON.stringify({ commands: [{ schema_version: 2, operation_id: randomUUID(), workspace_id: f.id, device_id: randomUUID(), workspace_epoch: 1, type: 'MoveEntry', payload: { id: entry.id, parent_id: f.root, name: 'After' }, base_revisions: { [`entries:${entry.id}`]: entry.revision } }] }) });
  const next = new HttpWorkspaceRepository(f.id, f.request, f.storage); t.after(() => next.dispose());
  const snapshot = await next.load(); assert.equal(snapshot.entries.find(item => item.id === entry.id).name, 'After');
  assert.equal(next.status().pending, 0); assert.equal(next.status().cursor, 2);
});
test('manual synchronization retries durable writes without restarting the repository', async t => {
  const f = setup(), repo = new HttpWorkspaceRepository(f.id, f.request, f.storage); t.after(() => repo.dispose());
  await repo.load(); f.lose(); await assert.rejects(repo.createFolder('Retry', ''), /lost response/);
  assert.equal(repo.status().pending, 1); await repo.synchronize();
  assert.equal(repo.status().pending, 0); assert.equal(repo.status().state, 'synced');
  assert.equal(Object.values(f.state().entries).filter(item => item.name === 'Retry').length, 1);
  assert.deepEqual(f.operations[0], f.operations[1]);
});
