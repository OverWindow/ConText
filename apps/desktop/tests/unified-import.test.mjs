import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { WorkspaceEngine } from '../electron/engine.mjs';
import { UnifiedStore, migrateUnified } from '../electron/unified-store.mjs';
import { UnifiedLegacyBridge, buildLegacyState } from '../electron/unified-import.mjs';
import { applyCommand } from '../core/domain/src/index.js';

const content = title => ({ title, blocks: [{ id: 'p1', type: 'paragraph', text: '본문', level: 2, items: [], rows: [], source_ids: [] }] });
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-unified-import-')), root = path.join(base, '자료'), data = path.join(base, 'data');
  await mkdir(path.join(root, '안쪽'), { recursive: true }); await writeFile(path.join(root, '문서.txt'), '첫번째 원본'); await writeFile(path.join(root, '안쪽', '아직열지않음.bin'), Buffer.from([1, 2, 3]));
  const engine = await new WorkspaceEngine(data, { unifiedCommands: false }).init({ watchFiles: false }); const workspaceId = (await engine.connect(root)).workspace.id;
  await migrateUnified(engine.db, data); const store = new UnifiedStore(engine), bridge = new UnifiedLegacyBridge(engine, store);
  const entry = engine.db.prepare("SELECT * FROM entries WHERE workspace_id=? AND name='문서.txt'").get(workspaceId);
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  return { base, root, data, engine, workspaceId, store, bridge, entry };
}
function installVersion(f, data, { id = randomUUID(), documentId, source = null, number } = {}) {
  const db = f.engine.db, document = documentId ? db.prepare('SELECT * FROM local_documents WHERE id=?').get(documentId) : db.prepare('SELECT * FROM local_documents WHERE entry_id=?').get(f.entry.id);
  const docId = document?.id || randomUUID(); if (!document) db.prepare('INSERT INTO local_documents(id,workspace_id,entry_id) VALUES(?,?,?)').run(docId, f.workspaceId, f.entry.id);
  const n = number || db.prepare('SELECT coalesce(max(version_number),0)+1 AS n FROM local_versions WHERE document_id=?').get(docId).n;
  const bytes = Buffer.from(data), sha256 = createHash('sha256').update(bytes).digest('hex');
  db.prepare('INSERT INTO local_versions(id,document_id,version_number,filename,sha256,bytes,normalized,created_at,source_version_id,change_note) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, docId, n, '문서.txt', sha256, bytes, JSON.stringify({ title: '문서', blocks: [{ id: 0, text: data }] }), Date.now(), source, '기존 이력');
  db.prepare('UPDATE local_documents SET file_version_id=?,current_version_id=?,revision=revision+1 WHERE id=?').run(id, id, docId); return { id, document_id: docId, bytes, sha256 };
}

test('preservation import keeps bytes, UUID histories, pins, mixed citations, draft checks/proposal and chats', async t => {
  const f = await fixture(t), v1 = installVersion(f, '첫번째 원본'), v2 = installVersion(f, '두번째 원본', { source: v1.id });
  f.engine.db.prepare('UPDATE local_documents SET current_version_id=?,current_is_pinned=1 WHERE id=?').run(v1.id, v1.document_id);
  const noteId = randomUUID(), rootScope = f.engine.canvas.scope(f.workspaceId, '');
  f.engine.db.prepare('INSERT INTO local_canvas VALUES(?,?,?,?,?,?,?)').run(noteId, f.workspaceId, rootScope, 'element', JSON.stringify({ id: noteId, kind: 'triangle', text: '메모 인용', x: 1, y: 2, width: 240, height: 180, color: 'violet', font_size: 32 }), 3, 0);
  const session = f.engine.createChatSession(f.workspaceId, { requestId: randomUUID(), title: '기존 대화' }), userId = randomUUID(), messageId = randomUUID(), requestId = randomUUID();
  const insert = f.engine.db.prepare('INSERT INTO local_chat_messages VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  insert.run(userId, session.id, requestId, 1, 'user', 'COMPLETED', '질문', null, '{}', null, Date.now());
  insert.run(messageId, session.id, requestId, 2, 'assistant', 'FAILED', '', null, '{"scope":"history"}', 'AI_TIMEOUT', Date.now());
  const source = { id: `note-${noteId}-3`, kind: 'note', document_title: '메모', text: '인용 그대로', locations: [] };
  const draft = f.engine.documents.create(f.workspaceId, randomUUID(), { content: { ...content('기존 초안'), blocks: [{ ...content('x').blocks[0], source_ids: [source.id] }] }, sources: [source], checks: ['검토 필요'] });
  const next = f.engine.saveDraft(f.workspaceId, draft.id, draft.revision, content('저장한 초안'));
  f.engine.db.prepare('UPDATE local_drafts SET proposal=? WHERE id=?').run(JSON.stringify({ content: content('승인 대기'), sources: [source], checks: ['제안 검사'] }), draft.id);
  const rawBefore = f.engine.db.prepare('SELECT id,bytes FROM local_versions ORDER BY id').all().map(v => [v.id, Buffer.from(v.bytes).toString('hex')]);
  const state = f.bridge.capture(f.workspaceId);
  assert.equal(state.documents[v1.document_id].content_head_id, v2.id); assert.equal(state.documents[v1.document_id].reference_head_id, v1.id);
  assert.deepEqual(state.versions[v2.id].parent_version_ids, [v1.id]); assert.equal(state.versions[v2.id].sources[0].version_id, v1.id);
  assert.equal(state.canvas_elements[noteId].kind, 'triangle'); assert.equal(state.canvas_elements[noteId].font_size, 32);
  const savedDraft = state.drafts[draft.id]; assert.equal(savedDraft.title, '저장한 초안'); assert.equal(savedDraft.history.length, 2); assert.ok(savedDraft.review.checks.includes('검토 필요'));
  const proposal = Object.values(state.proposals)[0]; assert.equal(JSON.parse(proposal.content).title, '승인 대기'); assert.equal(proposal.sources[0].quote, '인용 그대로');
  assert.equal(state.chat_messages[messageId].metadata.error_code, 'AI_TIMEOUT'); assert.deepEqual(state.chat_messages[messageId].metadata.options, { scope: 'history' });
  assert.equal(state.chat_messages[userId].request_id, null); assert.equal(state.chat_messages[messageId].request_id, requestId);
  assert.deepEqual(f.engine.db.prepare('SELECT id,bytes FROM local_versions ORDER BY id').all().map(v => [v.id, Buffer.from(v.bytes).toString('hex')]), rawBefore);
  assert.equal(f.store.blob(f.workspaceId, v1.id).data.length, v1.bytes.length);
  assert.ok(!JSON.stringify(state).includes(f.root)); assert.ok(!JSON.stringify(state).includes('relative_path'));
  assert.equal(f.store.pending(f.workspaceId).length, 1); assert.equal(f.store.pending(f.workspaceId)[0].command.type, 'ImportWorkspace');
  f.bridge.project(f.workspaceId); f.bridge.capture(f.workspaceId); assert.equal(f.store.pending(f.workspaceId).length, 1, 'projection must not echo');
  assert.equal(f.engine.getDraft(f.workspaceId, draft.id).revision, next.revision);
});

test('capture creates named deltas and preserves observed-parent branch after a remote head changes', async t => {
  const f = await fixture(t), a = installVersion(f, '원본 A'); f.bridge.capture(f.workspaceId);
  const local = f.store.state(f.workspaceId), remoteVersionId = randomUUID();
  const remoteVersion = { ...local.versions[a.id], id: remoteVersionId, blob: { ...local.versions[a.id].blob, id: remoteVersionId, sha256: 'c'.repeat(64) }, parent_version_ids: [a.id], change_note: '웹 C' };
  const cmd = f.store.command(f.workspaceId, 'AppendDocumentVersion', { version: remoteVersion }, { [`documents:${a.document_id}`]: local.documents[a.document_id].revision });
  f.store.enqueue(f.workspaceId, cmd); f.bridge.project(f.workspaceId);
  const nativeDoc = f.engine.db.prepare('SELECT * FROM local_documents WHERE id=?').get(a.document_id); assert.equal(nativeDoc.file_version_id, a.id, 'metadata projection must not claim pending bytes reached disk');
  const count = f.store.pending(f.workspaceId).length; f.bridge.capture(f.workspaceId); assert.equal(f.store.pending(f.workspaceId).length, count, 'pending remote head must not echo back to A');
  const b = installVersion(f, '외부 편집 B'); f.bridge.capture(f.workspaceId);
  const final = f.store.state(f.workspaceId); assert.deepEqual(final.versions[b.id].parent_version_ids, [a.id]); assert.equal(final.documents[a.document_id].content_head_id, remoteVersionId);
  assert.equal(Object.values(final.conflicts).filter(c => c.status === 'open').length, 1); assert.equal(f.engine.db.prepare('SELECT observed_version_id FROM unified_file_mappings WHERE entry_id=?').get(f.entry.id).observed_version_id, b.id);
  assert.equal(await readFile(path.join(f.root, '문서.txt'), 'utf8'), '첫번째 원본');
});

test('remote logical trash leaves native raw original untouched and is never captured as a restore', async t => {
  const f = await fixture(t), version = installVersion(f, '보존'); f.bridge.capture(f.workspaceId); const state = f.store.state(f.workspaceId), entry = state.entries[f.entry.id];
  f.store.enqueue(f.workspaceId, f.store.command(f.workspaceId, 'TrashEntry', { id: entry.id }, { [`entries:${entry.id}`]: entry.revision, [`documents:${version.document_id}`]: state.documents[version.document_id].revision }));
  f.bridge.project(f.workspaceId); const before = f.store.pending(f.workspaceId).length; f.bridge.capture(f.workspaceId);
  assert.equal(f.store.pending(f.workspaceId).length, before); assert.ok(f.store.state(f.workspaceId).entries[entry.id].deleted_at); assert.equal(await readFile(path.join(f.root, '문서.txt'), 'utf8'), '첫번째 원본');
  assert.equal(f.engine.db.prepare('SELECT status FROM unified_file_mappings WHERE entry_id=?').get(entry.id).status, 'remote_deleted');
});

test('native chat prepare/fail/retry/finish state changes use CAS updates without duplicate messages', async t => {
  const f = await fixture(t); const session = f.engine.createChatSession(f.workspaceId, { requestId: randomUUID(), title: '요청' }), messageId = randomUUID(), requestId = randomUUID();
  f.engine.db.prepare('INSERT INTO local_chat_messages VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(messageId, session.id, requestId, 1, 'assistant', 'RUNNING', '', null, '{}', null, Date.now());
  f.bridge.capture(f.workspaceId); f.engine.db.prepare("UPDATE local_chat_messages SET state='FAILED',error_code='AI_TIMEOUT' WHERE id=?").run(messageId); f.bridge.capture(f.workspaceId);
  f.engine.db.prepare("UPDATE local_chat_messages SET state='RUNNING',error_code=NULL WHERE id=?").run(messageId); f.bridge.capture(f.workspaceId);
  f.engine.db.prepare("UPDATE local_chat_messages SET state='COMPLETED',content='완료',result=? WHERE id=?").run(JSON.stringify({ sources: [], claims: [], insufficient: true }), messageId); f.bridge.capture(f.workspaceId);
  const state = f.store.state(f.workspaceId); assert.equal(Object.keys(state.chat_messages).length, 1); assert.equal(state.chat_messages[messageId].content, '완료'); assert.equal(state.chat_messages[messageId].revision, 4);
  assert.equal(f.store.pending(f.workspaceId).filter(row => row.command.type === 'UpdateChatMessage').length, 3);
  f.bridge.project(f.workspaceId); const count = f.store.pending(f.workspaceId).length; f.bridge.capture(f.workspaceId); assert.equal(f.store.pending(f.workspaceId).length, count);
});

test('remote rename waiting for filesystem application does not echo back, and source/default projections stay canonical', async t => {
  const f = await fixture(t); f.bridge.capture(f.workspaceId); let state = f.store.state(f.workspaceId);
  f.store.enqueue(f.workspaceId, f.store.command(f.workspaceId, 'MoveEntry', { id: f.entry.id, parent_id: state.workspace.root_entry_id, name: '웹 이름.txt' }, { [`entries:${f.entry.id}`]: state.entries[f.entry.id].revision }));
  const noteId = randomUUID(), sourceId = randomUUID(), draftId = randomUUID();
  f.store.enqueue(f.workspaceId, f.store.command(f.workspaceId, 'PutCanvasElement', { element: { id: noteId, workspace_id: f.workspaceId, scope_id: state.workspace.root_entry_id, kind: 'note', x: 4, y: 5, width: 240, height: 180, content: '웹 메모', color: null, sources: [], revision: 0, deleted_at: null } }));
  const source = { id: sourceId, kind: 'note', element_id: noteId, scope_id: state.workspace.root_entry_id, quote: '웹 인용', label: '메모' };
  f.store.enqueue(f.workspaceId, f.store.command(f.workspaceId, 'CreateDraft', { id: draftId, scope_id: state.workspace.root_entry_id, title: '웹 초안', content: '단순 텍스트', sources: [source] }));
  f.bridge.project(f.workspaceId); const count = f.store.pending(f.workspaceId).length; f.bridge.capture(f.workspaceId);
  state = f.store.state(f.workspaceId); assert.equal(f.store.pending(f.workspaceId).length, count, 'remote-only defaults are projection, not edits');
  assert.equal(state.entries[f.entry.id].name, '웹 이름.txt'); assert.equal(state.canvas_elements[noteId].kind, 'note'); assert.equal(state.canvas_elements[noteId].color, null);
  assert.equal(state.drafts[draftId].content, '단순 텍스트'); assert.equal(state.drafts[draftId].sources[0].id, sourceId); assert.equal(state.drafts[draftId].review, null);
  assert.equal(await readFile(path.join(f.root, '문서.txt'), 'utf8'), '첫번째 원본');
});

test('native new draft checks and proposal acceptance survive incremental capture', async t => {
  const f = await fixture(t); f.bridge.capture(f.workspaceId);
  const draft = f.engine.documents.create(f.workspaceId, randomUUID(), { content: content('새 초안'), sources: [], checks: ['생성 검사'] }); f.bridge.capture(f.workspaceId);
  let state = f.store.state(f.workspaceId); assert.deepEqual(state.drafts[draft.id].review, { checks: ['생성 검사'] });
  f.engine.db.prepare('UPDATE local_drafts SET proposal=? WHERE id=?').run(JSON.stringify({ content: content('승인한 제목'), sources: [], checks: ['제안 검사'] }), draft.id); f.bridge.capture(f.workspaceId);
  const proposal = Object.values(f.store.state(f.workspaceId).proposals)[0];
  f.engine.reviewDraft(f.workspaceId, draft.id, draft.revision, 'accept'); f.bridge.capture(f.workspaceId);
  state = f.store.state(f.workspaceId); assert.equal(state.proposals[proposal.id].status, 'accepted'); assert.equal(JSON.parse(state.drafts[draft.id].content).title, '승인한 제목');
  f.bridge.project(f.workspaceId); const count = f.store.pending(f.workspaceId).length; f.bridge.capture(f.workspaceId); assert.equal(f.store.pending(f.workspaceId).length, count);
});

test('25001 native sibling folders import completely without copying BLOBs or manufacturing filesystem state', async t => {
  const f = await fixture(t), insert = f.engine.db.prepare('INSERT INTO entries(id,workspace_id,relative_path,parent_path,name,kind,extension,size,mtime,identity,present,excluded) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  f.engine.db.exec('BEGIN');
  for (let n = 0; n < 25001; n++) { const id = randomUUID(), name = `대량-${String(n).padStart(5, '0')}`; insert.run(id, f.workspaceId, name, '', name, 'directory', '', 0, 0, `synthetic:${id}`, 1, 0); }
  f.engine.db.exec('COMMIT');
  const nativeCount = f.engine.db.prepare('SELECT count(*) AS n FROM entries WHERE workspace_id=?').get(f.workspaceId).n;
  const state = f.bridge.capture(f.workspaceId); assert.equal(Object.keys(state.entries).length, nativeCount + 1);
  assert.ok(Object.values(state.entries).find(e => e.name === '대량-25000')); assert.equal(f.store.pending(f.workspaceId).length, 1);
  assert.equal(f.engine.db.prepare('SELECT count(*) AS n FROM unified_blobs WHERE data IS NOT NULL').get().n, 0);
  assert.equal(await readFile(path.join(f.root, '문서.txt'), 'utf8'), '첫번째 원본');
});

test('corrupt native metadata fails closed without publishing partial import or replacing raw history', async t => {
  const f = await fixture(t), v = installVersion(f, '불변 원본'); const draft = f.engine.createDraft(f.workspaceId, randomUUID());
  f.engine.db.prepare('UPDATE local_drafts SET history=? WHERE id=?').run('{broken', draft.id);
  assert.throws(() => f.bridge.capture(f.workspaceId), error => error.code === 'UNIFIED_IMPORT_INVALID_METADATA');
  assert.equal(f.store.pending(f.workspaceId).length, 0); assert.equal(f.store.row(f.workspaceId).import_complete, 0);
  assert.equal(f.engine.db.prepare('SELECT history FROM local_drafts WHERE id=?').get(draft.id).history, '{broken');
  assert.equal(Buffer.from(f.engine.db.prepare('SELECT bytes FROM local_versions WHERE id=?').get(v.id).bytes).toString(), '불변 원본');
});

test('remote entry and absent raw target remain pending metadata without inventing zero-byte versions', async t => {
  const f = await fixture(t); f.bridge.capture(f.workspaceId); let state = f.store.state(f.workspaceId);
  const entryId = randomUUID(), documentId = randomUUID(), versionId = randomUUID();
  f.store.enqueue(f.workspaceId, f.store.command(f.workspaceId, 'CreateEntry', { id: entryId, document_id: documentId, parent_id: state.workspace.root_entry_id, kind: 'file', name: '웹에서생성.bin' }));
  const version = { id: versionId, workspace_id: f.workspaceId, document_id: documentId, blob: { id: versionId, sha256: 'e'.repeat(64), size: 12, mime_type: 'application/octet-stream' }, parent_version_ids: [], sources: [], created_at: new Date().toISOString(), created_by: f.store.row(f.workspaceId).actor_id, change_note: '' };
  f.store.enqueue(f.workspaceId, f.store.command(f.workspaceId, 'AppendDocumentVersion', { version }, { [`documents:${documentId}`]: 0 }));
  f.bridge.project(f.workspaceId); const pending = f.store.pending(f.workspaceId).length; f.bridge.capture(f.workspaceId);
  assert.equal(f.store.pending(f.workspaceId).length, pending); assert.equal(f.engine.db.prepare('SELECT id FROM local_versions WHERE id=?').get(versionId), undefined);
  const native = f.engine.db.prepare('SELECT * FROM local_documents WHERE id=?').get(documentId); assert.equal(native.file_version_id, null); assert.equal(native.current_version_id, null);
  assert.equal(f.store.state(f.workspaceId).documents[documentId].content_head_id, versionId); assert.equal(f.engine.db.prepare('SELECT present FROM entries WHERE id=?').get(entryId).present, 0);
});

test('unsupported and excluded native rows stay local with quoted references intact', async t => {
  const f = await fixture(t), ids = new Map();
  const insert = f.engine.db.prepare('INSERT INTO entries(id,workspace_id,relative_path,parent_path,name,kind,extension,size,mtime,identity,present,excluded) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const [relative, kind, excluded] of [['링크', 'link', 0], ['소켓', 'other', 0], ['.비공개.txt', 'file', 0], ['node_modules', 'directory', 1], ['node_modules/cache.txt', 'file', 0]]) {
    const id = randomUUID(); ids.set(relative, id); insert.run(id, f.workspaceId, relative, path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative), path.posix.basename(relative), kind, path.extname(relative), 0, 0, `local:${id}`, 1, excluded);
  }
  const hidden = { ...f, entry: { id: ids.get('.비공개.txt') } }, sourceVersion = installVersion(hidden, '기기 전용 원본');
  const source = { id: `version-${sourceVersion.id}-block-0`, kind: 'document', document_id: sourceVersion.document_id, version_id: sourceVersion.id, document_title: '기존 인용', text: '이미 저장한 인용문', locations: [] };
  const draft = f.engine.documents.create(f.workspaceId, randomUUID(), { content: content('인용 보존'), sources: [source], checks: [] });
  const state = f.bridge.capture(f.workspaceId);
  for (const id of ids.values()) assert.equal(state.entries[id], undefined);
  assert.equal(state.versions[sourceVersion.id], undefined); assert.equal(f.engine.db.prepare('SELECT id FROM unified_blobs WHERE id=?').get(sourceVersion.id), undefined);
  assert.equal(state.drafts[draft.id].sources[0].quote, '이미 저장한 인용문'); assert.equal(state.drafts[draft.id].sources[0].version_id, sourceVersion.id);
  assert.equal(Buffer.from(f.engine.db.prepare('SELECT bytes FROM local_versions WHERE id=?').get(sourceVersion.id).bytes).toString(), '기기 전용 원본');
  assert.equal(f.engine.db.prepare('SELECT count(*) AS n FROM entries WHERE workspace_id=? AND id IN (?,?,?,?,?)').get(f.workspaceId, ...ids.values()).n, 5);
});

test('confirmed native file deletion publishes a logical tombstone while keeping immutable raw history', async t => {
  const f = await fixture(t), version = installVersion(f, '보존할 이력'); f.bridge.capture(f.workspaceId);
  await rm(path.join(f.root, '문서.txt')); await f.engine.scan(f.workspaceId); f.bridge.capture(f.workspaceId);
  const state = f.store.state(f.workspaceId); assert.ok(state.entries[f.entry.id].deleted_at); assert.ok(state.documents[version.document_id].deleted_at); assert.ok(state.versions[version.id]);
  assert.equal(Buffer.from(f.engine.db.prepare('SELECT bytes FROM local_versions WHERE id=?').get(version.id).bytes).toString(), '보존할 이력');
  assert.equal(f.store.pending(f.workspaceId).at(-1).command.type, 'TrashEntry');
});

test('unhealthy or truncated scans and device disconnect preferences cannot publish deletion', async t => {
  const f = await fixture(t); installVersion(f, '기록'); f.bridge.capture(f.workspaceId);
  await rm(path.join(f.root, '문서.txt')); await f.engine.scan(f.workspaceId);
  for (const health of [{ status: 'unavailable', warnings: [] }, { status: 'ready', warnings: [], truncated: true }, { status: 'ready', warnings: ['읽을 수 없는 하위 폴더'] }]) {
    f.engine.health.set(f.workspaceId, health); f.bridge.capture(f.workspaceId); assert.equal(f.store.state(f.workspaceId).entries[f.entry.id].deleted_at, null);
  }
  f.engine.health.set(f.workspaceId, { status: 'ready', warnings: [], truncated: false });
  f.engine.db.prepare('INSERT INTO local_settings VALUES(?,?)').run(`disconnected-file:${f.workspaceId}:${f.entry.id}`, 'true'); f.bridge.capture(f.workspaceId);
  assert.equal(f.store.state(f.workspaceId).entries[f.entry.id].deleted_at, null);
});

test('confirmed missing folder supplies every subtree revision and initial-known missing snapshots remain live', async t => {
  const f = await fixture(t), child = f.engine.db.prepare("SELECT * FROM entries WHERE workspace_id=? AND name='아직열지않음.bin'").get(f.workspaceId), folder = f.engine.db.prepare("SELECT * FROM entries WHERE workspace_id=? AND name='안쪽'").get(f.workspaceId);
  const version = installVersion({ ...f, entry: child }, '폴더 안의 원본'); f.bridge.capture(f.workspaceId);
  await rm(path.join(f.root, '안쪽'), { recursive: true }); await f.engine.scan(f.workspaceId); f.bridge.capture(f.workspaceId);
  const state = f.store.state(f.workspaceId); assert.ok(state.entries[folder.id].deleted_at); assert.ok(state.entries[child.id].deleted_at); assert.ok(state.versions[version.id]);
  const trash = f.store.pending(f.workspaceId).find(row => row.command.type === 'TrashEntry'); assert.ok(trash.command.base_revisions[`entries:${child.id}`] !== undefined); assert.ok(trash.command.base_revisions[`documents:${version.document_id}`] !== undefined);
  // Native snapshots already absent when first imported are archival evidence, not a fresh deletion.
  const g = await fixture(t), old = installVersion(g, '오래된 원본'); await rm(path.join(g.root, '문서.txt')); await g.engine.scan(g.workspaceId); g.bridge.capture(g.workspaceId); g.bridge.capture(g.workspaceId);
  assert.equal(g.store.state(g.workspaceId).entries[g.entry.id].deleted_at, null); assert.ok(g.store.state(g.workspaceId).versions[old.id]);
  assert.equal(g.engine.db.prepare('SELECT status FROM unified_file_mappings WHERE entry_id=?').get(g.entry.id).status, 'missing');
});
