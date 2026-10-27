import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceEngine } from '../electron/engine.mjs';
import { writingContext } from '../electron/local-context.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-documents-'));
  const root = path.join(base, '한글 자료'); await mkdir(root);
  const data = path.join(base, 'data');
  let engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  const workspace = (await engine.connect(root)).workspace.id;
  t.after(async () => { if (!engine.closed) await engine.close(); await rm(base, { recursive: true, force: true }); });
  return { base, root, data, workspace, get engine() { return engine; }, restart: async () => {
    await engine.close(); engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  } };
}
const content = text => ({ title: '한글 문서', blocks: [
  { id: 'body', type: 'paragraph', text },
  { id: 'list', type: 'list', items: ['첫 항목', '둘째 항목'] },
  { id: 'table', type: 'table', rows: [['항목', '값'], ['예산', '100']] },
] });

test('draft persistence, idempotent creation, revision conflicts, undo and tombstones', async t => {
  const f = await fixture(t), request = randomUUID();
  let draft = f.engine.createDraft(f.workspace, request);
  assert.equal(f.engine.createDraft(f.workspace, request).id, draft.id);
  draft = f.engine.saveDraft(f.workspace, draft.id, 1, content('저장한 본문'));
  assert.equal(draft.revision, 2);
  assert.throws(() => f.engine.saveDraft(f.workspace, draft.id, 1, content('오래된 수정')), { code: 'CONFLICT' });
  assert.equal(f.engine.getDraft(f.workspace, draft.id).content.blocks[0].text, '저장한 본문');
  await f.restart();
  assert.deepEqual(f.engine.getDraft(f.workspace, draft.id), draft);
  const restored = f.engine.reviewDraft(f.workspace, draft.id, 2, 'undo');
  assert.equal(restored.content.title, '새 문서');
  assert.equal(restored.can_undo, false);
  f.engine.deleteDraft(f.workspace, draft.id, 3);
  assert.deepEqual(f.engine.listDrafts(f.workspace), []);
  assert.throws(() => f.engine.getDraft(f.workspace, draft.id), { code: 'NOT_FOUND' });
  const changes = f.engine.db.prepare('SELECT operation,revision FROM local_changes ORDER BY rowid').all();
  assert.deepEqual(changes.map(c => [c.operation, c.revision]), [['draft.create', 1], ['draft.save', 2], ['draft.undo', 3], ['draft.delete', 4]]);
});

test('cross-workspace access and invented citations are rejected without partial changes', async t => {
  const f = await fixture(t);
  const another = path.join(f.base, 'other'); await mkdir(another);
  const other = (await f.engine.connect(another)).workspace.id;
  const draft = f.engine.createDraft(f.workspace, randomUUID());
  assert.throws(() => f.engine.getDraft(other, draft.id), { code: 'NOT_FOUND' });
  const forged = content('근거 없는 주장'); forged.blocks[0].source_ids = ['invented'];
  assert.throws(() => f.engine.saveDraft(f.workspace, draft.id, 1, forged));
  assert.equal(f.engine.getDraft(f.workspace, draft.id).revision, 1);
  assert.equal(f.engine.db.prepare('SELECT count(*) AS n FROM local_changes').get().n, 1);
});

test('legacy migration preserves workspace IDs, positions and a consistent backup', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '원본.txt'), '원본'); await f.engine.scan(f.workspace);
  const entry = f.engine.snapshot(f.workspace).entries[0];
  f.engine.savePositions(f.workspace, [{ id: entry.id, x: 120, y: 30 }]);
  f.engine.db.exec('DROP TABLE local_drafts; DROP TABLE local_changes; DROP TABLE save_journal; DROP TABLE local_settings; PRAGMA user_version=1;');
  await f.restart();
  assert.equal(f.engine.snapshot(f.workspace).entries[0].id, entry.id);
  assert.equal(f.engine.snapshot(f.workspace).entries[0].x, 120);
  const backups = await readdir(path.join(f.data, 'backups'));
  const legacy = new DatabaseSync(path.join(f.data, 'backups', backups[0]), { readOnly: true });
  assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(legacy.prepare('SELECT x FROM positions WHERE entry_id=?').get(entry.id).x, 120);
  legacy.close();
});

test('file export checks disk conflicts, refuses links and survives a restart', async t => {
  const f = await fixture(t), draft = f.engine.createDraft(f.workspace, randomUUID());
  const filename = path.join(f.root, '저장.txt');
  await f.engine.documents.writeFile(f.workspace, draft.id, 1, filename, Buffer.from('첫 저장'), null);
  assert.equal(await readFile(filename, 'utf8'), '첫 저장');
  const expected = createHash('sha256').update('첫 저장').digest('hex');
  await writeFile(filename, '외부 수정');
  await assert.rejects(f.engine.documents.writeFile(f.workspace, draft.id, 1, filename, Buffer.from('덮어쓰기'), expected), { code: 'CONFLICT' });
  assert.equal(await readFile(filename, 'utf8'), '외부 수정');
  const link = path.join(f.root, '링크.txt'); await symlink(filename, link);
  await assert.rejects(f.engine.documents.writeFile(f.workspace, draft.id, 1, link, Buffer.from('금지'), null));
  await f.restart();
  assert.equal(f.engine.db.prepare("SELECT count(*) AS n FROM save_journal WHERE state='complete'").get().n, 1);
});

test('UTF-8 direct editing preserves BOM and CRLF, snapshots originals and refuses stale writes', async t => {
  const f = await fixture(t), filename = path.join(f.root, '원본.md');
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 제목\r\n기존 한글\r\n')]);
  await writeFile(filename, original); await f.engine.scan(f.workspace);
  const entry = f.engine.snapshot(f.workspace).entries[0];
  const first = await f.engine.readTextFile(f.workspace, entry.id);
  assert.equal(first.text, '# 제목\n기존 한글\n');
  const saved = await f.engine.saveTextFile(f.workspace, entry.id, first.revision, '# 제목\n새 한글\n');
  const bytes = await readFile(filename);
  assert.deepEqual(bytes.subarray(0, 3), original.subarray(0, 3));
  assert.equal(bytes.subarray(3).toString(), '# 제목\r\n새 한글\r\n');
  assert.equal(saved.text, '# 제목\n새 한글\n');
  const doc = await f.engine.getDocument(f.workspace, entry.id);
  assert.equal(doc.versions.length, 2);
  assert.deepEqual(Buffer.from(f.engine.documents.version(f.workspace, doc.id, doc.versions[0].id).bytes), original);
  await writeFile(filename, '외부 변경');
  await assert.rejects(f.engine.saveTextFile(f.workspace, entry.id, saved.revision, '덮어쓰기'), /외부에서/);
  assert.equal(await readFile(filename, 'utf8'), '외부 변경');
  const fresh = await f.engine.createTextFile(f.workspace, '빈 문서.txt');
  const blank = await f.engine.readTextFile(f.workspace, fresh.id);
  await f.engine.saveTextFile(f.workspace, fresh.id, blank.revision, '첫 문장');
  assert.equal(await readFile(path.join(f.root, '빈 문서.txt'), 'utf8'), '첫 문장');
});

test('native file rename and move preserve identities and never overwrite another file', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '원본.txt'), '자료');
  await writeFile(path.join(f.root, '기존.txt'), '기존');
  const folder = path.join(f.root, '하위'); await mkdir(folder); await f.engine.scan(f.workspace);
  const entry = f.engine.snapshot(f.workspace).entries.find(e => e.name === '원본.txt');
  f.engine.savePositions(f.workspace, [{ id: entry.id, x: 12, y: 48 }]);
  await assert.rejects(f.engine.renameFile(f.workspace, entry.id, '기존.txt'));
  assert.equal(await readFile(path.join(f.root, '기존.txt'), 'utf8'), '기존');
  await f.engine.renameFile(f.workspace, entry.id, '새 이름.txt');
  await f.engine.renameFile(f.workspace, entry.id, '새 이름.txt', folder);
  const moved = f.engine.snapshot(f.workspace).entries.find(e => e.id === entry.id);
  assert.equal(moved.relative_path, '하위/새 이름.txt'); assert.equal(moved.x, 12);
  await assert.rejects(f.engine.renameFile(f.workspace, entry.id, '../탈출.txt'));
  await assert.rejects(f.engine.renameFile(f.workspace, entry.id, '탈출.txt', f.base));
  await assert.rejects(f.engine.createTextFile(f.workspace, '../탈출.md'));
  await assert.rejects(f.engine.createTextFile(f.workspace, '.숨김.md'));
  await assert.rejects(f.engine.createTextFile(f.workspace, '.md'));
  await assert.rejects(f.engine.createTextFile(f.workspace, '기존.txt'));
});

test('canvas drops move the real file by folder ID, keep history, find a free cell and reject stale or unsafe destinations', async t => {
  const f = await fixture(t), folder = path.join(f.root, '이동 대상');
  await mkdir(folder);
  await writeFile(path.join(f.root, ' 원본.txt'), '보존할 원문');
  await writeFile(path.join(folder, '기존.txt'), '기존 자료');
  await f.engine.scan(f.workspace);
  const snapshot = f.engine.snapshot(f.workspace), source = snapshot.entries.find(e => e.name === ' 원본.txt'), target = snapshot.entries.find(e => e.kind === 'directory');
  f.engine.putCanvasItem(f.workspace, target.relative_path, 'element', { id: randomUUID(), kind: 'text', text: '기존 메모', x: 255, y: 0, width: 320, height: 140, color: 'blue', font_size: 24 }, 0);
  const document = await f.engine.getDocument(f.workspace, source.id);
  const moved = await f.engine.moveFileToFolder(f.workspace, source.id, target.id, { expected_parent: '' });
  assert.equal(moved.id, source.id); assert.equal(moved.document_id, source.document_id);
  assert.equal(moved.relative_path, '이동 대상/ 원본.txt');
  assert.equal(await readFile(path.join(folder, ' 원본.txt'), 'utf8'), '보존할 원문');
  await assert.rejects(readFile(path.join(f.root, ' 원본.txt')), { code: 'ENOENT' });
  const existing = f.engine.snapshot(f.workspace).entries.find(e => e.name === '기존.txt');
  assert.ok(moved.x !== existing.x || moved.y !== existing.y);
  assert.equal(moved.x, 765, 'the new file also avoids the existing note');
  assert.equal((await f.engine.getDocument(f.workspace, source.id)).id, document.id);
  await assert.rejects(f.engine.moveFileToFolder(f.workspace, source.id, null, { expected_parent: '' }), /파일 위치가 바뀌었/);
  await f.engine.moveFileToFolder(f.workspace, source.id, null, { expected_parent: '이동 대상', position: { x: source.x, y: source.y } });
  assert.equal(f.engine.snapshot(f.workspace).entries.find(e => e.id === source.id).x, source.x);
  await writeFile(path.join(folder, ' 원본.txt'), '덮어쓰면 안 되는 자료');
  await assert.rejects(f.engine.moveFileToFolder(f.workspace, source.id, target.id), /같은 이름/);
  assert.equal(await readFile(path.join(folder, ' 원본.txt'), 'utf8'), '덮어쓰면 안 되는 자료');
  assert.equal(await readFile(path.join(f.root, ' 원본.txt'), 'utf8'), '보존할 원문');
  await assert.rejects(f.engine.moveFileToFolder(f.workspace, source.id, source.id), /일반 파일을 폴더/);
  await symlink(f.base, path.join(f.root, '바깥 링크')); await f.engine.scan(f.workspace);
  const link = f.engine.snapshot(f.workspace).entries.find(e => e.name === '바깥 링크');
  await assert.rejects(f.engine.moveFileToFolder(f.workspace, source.id, link.id));
  const otherRoot = path.join(f.base, '별도 작업'); await mkdir(otherRoot); await mkdir(path.join(otherRoot, '별도 폴더'));
  const other = await f.engine.connect(otherRoot);
  await assert.rejects(f.engine.moveFileToFolder(f.workspace, source.id, other.entries[0].id));
  await mkdir(path.join(f.root, 'node_modules')); await f.engine.scan(f.workspace);
  const excluded = f.engine.snapshot(f.workspace).entries.find(e => e.name === 'node_modules');
  await assert.rejects(f.engine.moveFileToFolder(f.workspace, source.id, excluded.id), /숨김·제외/);
  await assert.rejects(f.engine.moveFileToFolder(f.workspace, source.id, target.id, { position: { x: Infinity, y: 0 } }));
  await f.restart();
  assert.equal(f.engine.snapshot(f.workspace).entries.find(e => e.id === source.id).relative_path, ' 원본.txt');
});

test('interrupted replacement restores the original and exposes both recovery outputs after restart', async t => {
  const f = await fixture(t), destination = path.join(f.root, '복구.txt'), id = randomUUID();
  const temporary = path.join(f.root, `.context-save-${id}.tmp`);
  const old = Buffer.from('저장 전 원본'), next = Buffer.from('작성한 수정');
  await writeFile(`${temporary}.original`, old); await writeFile(temporary, next);
  const sha = data => createHash('sha256').update(data).digest('hex');
  f.engine.db.prepare('INSERT INTO save_journal VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, f.workspace, randomUUID(), 1, destination, temporary, sha(old), sha(next), 'prepared', Date.now());
  await f.restart();
  assert.equal(await readFile(destination, 'utf8'), old.toString());
  assert.equal(f.engine.recoveryItems(f.workspace)[0].filename, '복구.txt');
  const exported = path.join(f.root, '별도 복구.txt');
  await f.engine.writeRecovery(f.workspace, id, false, exported, null);
  assert.equal(await readFile(exported, 'utf8'), next.toString());
  assert.equal(Buffer.from((await f.engine.renderRecovery(f.workspace, id, true)).data, 'base64').toString(), old.toString());
  await writeFile(temporary, '외부 변경');
  await assert.rejects(f.engine.renderRecovery(f.workspace, id, false), /변경/);
  f.engine.acknowledgeRecovery(f.workspace, id);
  assert.deepEqual(f.engine.recoveryItems(f.workspace), []);
  assert.equal(await readFile(`${temporary}.original`, 'utf8'), old.toString());
});

test('canvas shapes, logical scopes, relations, revisions and tombstones survive restart with atomic changes', async t => {
  const f = await fixture(t);
  const first = await f.engine.createTextFile(f.workspace, 'A.txt'), second = await f.engine.createTextFile(f.workspace, 'B.txt');
  const value = { id: randomUUID(), kind: 'rectangle', text: '자료 묶음', x: 20, y: 30, width: 640, height: 420, font_size: 24, color: 'blue' };
  const saved = f.engine.putCanvasItem(f.workspace, '', 'element', value, 0);
  assert.equal(saved.revision, 1);
  assert.throws(() => f.engine.putCanvasItem(f.workspace, '', 'element', { ...value, text: '오래된 수정' }, 0), /다른 창/);
  assert.throws(() => f.engine.putCanvasItem(f.workspace, '', 'element', { ...value, width: 9000 }, 1), /값이/);
  const relation = { id: randomUUID(), source_document_id: first.id, target_document_id: second.id, relation_type: 'REFERENCE' };
  f.engine.putCanvasItem(f.workspace, '', 'relation', relation, 0);
  const otherRoot = path.join(f.base, 'other-canvas'); await mkdir(otherRoot);
  const otherWorkspace = (await f.engine.connect(otherRoot)).workspace.id;
  assert.throws(() => f.engine.putCanvasItem(otherWorkspace, '', 'element', value, 1), /다른 캔버스/);
  assert.throws(() => f.engine.putCanvasItem(otherWorkspace, '', 'relation', { ...relation, id: randomUUID() }, 0), /같은 작업/);
  await f.restart();
  const snapshot = f.engine.canvasSnapshot(f.workspace, '');
  assert.equal(snapshot.elements[0].text, '자료 묶음'); assert.equal(snapshot.relations[0].source_document_id, first.id);
  assert.equal(f.engine.canvasSnapshot(f.workspace, 'different').elements.length, 0);
  const changes = f.engine.db.prepare("SELECT * FROM local_changes WHERE operation LIKE 'canvas.%'").all();
  assert.equal(changes.length, 2);
  assert.ok(changes.every(row => !row.payload.includes(f.root) && JSON.parse(row.payload).scope_id));
  f.engine.removeCanvasItem(f.workspace, '', value.id, 1);
  assert.equal(f.engine.canvasSnapshot(f.workspace, '').elements.length, 0);
  assert.equal(f.engine.putCanvasItem(f.workspace, '', 'element', value, 2).revision, 3);
});

test('sync envelopes use persistent device sequences and logical IDs and rollback with metadata', async t => {
  const f = await fixture(t), device = f.engine.documents.deviceId;
  const first = await f.engine.createTextFile(f.workspace, 'A.txt'), second = await f.engine.createTextFile(f.workspace, 'B.txt');
  const relation = { id: randomUUID(), source_document_id: first.id, target_document_id: second.id, relation_type: 'REFERENCE' };
  f.engine.putCanvasItem(f.workspace, '', 'relation', relation, 0);
  f.engine.savePositions(f.workspace, [{ id: first.id, x: 24, y: 80 }]);
  let changes = f.engine.db.prepare('SELECT * FROM local_changes ORDER BY device_sequence').all();
  assert.equal(new Set(changes.map(c => c.device_sequence)).size, changes.length);
  assert.ok(changes.every(c => c.device_id === device && c.schema_version === 1));
  const edge = JSON.parse(changes.find(c => c.operation === 'canvas.relation.save').payload);
  assert.notEqual(edge.source_document_id, first.id);
  assert.equal(edge.source_document_id, f.engine.db.prepare('SELECT id FROM local_documents WHERE entry_id=?').get(first.id).id);
  const length = changes.length;
  f.engine.db.exec("CREATE TEMP TRIGGER reject_change BEFORE INSERT ON local_changes BEGIN SELECT RAISE(ABORT,'test abort'); END");
  assert.throws(() => f.engine.savePositions(f.workspace, [{ id: first.id, x: 999, y: 999 }]), /test abort/);
  assert.equal(f.engine.snapshot(f.workspace).entries.find(e => e.id === first.id).x, 24);
  f.engine.db.exec('DROP TRIGGER reject_change');
  await f.restart();
  assert.equal(f.engine.documents.deviceId, device);
  const draft = f.engine.createDraft(f.workspace, randomUUID());
  changes = f.engine.db.prepare('SELECT * FROM local_changes ORDER BY device_sequence').all();
  assert.equal(changes.length, length + 1);
  assert.equal(changes.at(-1).entity_id, draft.id);
  assert.equal(changes.at(-1).device_sequence, changes.at(-2).device_sequence + 1);
});

test('an externally renamed directory keeps the same logical canvas scope', async t => {
  const f = await fixture(t), old = path.join(f.root, '옛 폴더'), next = path.join(f.root, '새 폴더');
  await mkdir(old); await f.engine.scan(f.workspace);
  const element = { id: randomUUID(), kind: 'text', text: '폴더에 둔 메모', x: 10, y: 20, width: 320, height: 140, font_size: 24, color: 'blue' };
  f.engine.putCanvasItem(f.workspace, '옛 폴더', 'element', element, 0);
  const scope = f.engine.canvas.scope(f.workspace, '옛 폴더');
  f.engine.saveView(f.workspace, '옛 폴더', { x: 60, y: 70, zoom: .7 });
  await rename(old, next); await f.engine.scan(f.workspace);
  assert.equal(f.engine.canvas.scope(f.workspace, '새 폴더'), scope);
  assert.equal(f.engine.snapshot(f.workspace).views.find(view => view.directory === '새 폴더').zoom, .7);
  assert.equal(f.engine.canvasSnapshot(f.workspace, '새 폴더').elements[0].text, element.text);
});

test('writing gathers only this workspace documents, notes, recent chats and saved drafts within the source budget', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '계획.md'), '# 프로젝트\n프로젝트 근거입니다.'); await f.engine.scan(f.workspace);
  const draft = f.engine.createDraft(f.workspace, randomUUID());
  f.engine.saveDraft(f.workspace, draft.id, 1, content('프로젝트의 기존 초안입니다.'));
  f.engine.putCanvasItem(f.workspace, '', 'element', { id: randomUUID(), kind: 'text', text: '프로젝트의 캔버스 메모입니다.', x: 10, y: 20, width: 320, height: 140, font_size: 24, color: 'blue' }, 0);
  const session = f.engine.createChatSession(f.workspace, { requestId: randomUUID(), title: '프로젝트 대화' });
  f.engine.db.prepare('INSERT INTO local_chat_messages VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), session.id, randomUUID(), 1, 'assistant', 'COMPLETED', '프로젝트의 최근 대화입니다.', null, '{}', null, Date.now());
  const otherRoot = path.join(f.base, 'private'); await mkdir(otherRoot);
  const other = (await f.engine.connect(otherRoot)).workspace.id;
  f.engine.putCanvasItem(other, '', 'element', { id: randomUUID(), kind: 'text', text: '다른 작업 공간의 비공개 메모', x: 10, y: 20, width: 320, height: 140, font_size: 24, color: 'blue' }, 0);
  const request = await f.engine.prepareGeneration(f.workspace, { prompt: '프로젝트 정리', requestId: randomUUID() });
  assert.deepEqual(new Set(request.sources.map(source => source.kind)), new Set(['document', 'note', 'chat', 'draft']));
  assert.ok(request.sources.length <= 20); assert.ok(request.sources.reduce((n, source) => n + source.text.length, 0) <= 24000);
  assert.equal(JSON.stringify(request.sources).includes('비공개'), false);
  assert.equal(JSON.stringify(request.sources).includes(f.root), false);
});

test('disconnect clears workspace request excerpts and local records while keeping originals and device identity', async t => {
  const f = await fixture(t), device = f.engine.documents.deviceId;
  const filename = path.join(f.root, '원본.txt'); await writeFile(filename, '보존할 원본'); await f.engine.scan(f.workspace);
  const entry = f.engine.snapshot(f.workspace).entries[0];
  f.engine.savePositions(f.workspace, [{ id: entry.id, x: 24, y: 80 }]);
  f.engine.createDraft(f.workspace, randomUUID());
  for (const prefix of ['ai-request', 'summary-request', 'change-summary', 'index-signature']) f.engine.db.prepare('INSERT INTO local_settings VALUES(?,?)').run(`${prefix}:${f.workspace}:synthetic`, JSON.stringify({ text: '지울 로컬 발췌문' }));
  await f.engine.disconnect(f.workspace);
  assert.equal(await readFile(filename, 'utf8'), '보존할 원본');
  assert.equal(f.engine.db.prepare('SELECT count(*) AS n FROM local_settings WHERE key LIKE ?').get(`%${f.workspace}%`).n, 0);
  assert.equal(f.engine.db.prepare('SELECT count(*) AS n FROM local_drafts').get().n, 0);
  assert.equal(f.engine.db.prepare('SELECT value FROM local_settings WHERE key=?').get('device-id').value, device);
});


test('file disconnection survives scans, renames and restart, filters retrieval and restores identities without deleting originals', async t => {
  const f = await fixture(t), name = '해제할 문서.md', original = '# 자료\n개별연결테스트의 원본입니다.';
  await writeFile(path.join(f.root, name), original);
  await writeFile(path.join(f.root, '유지.txt'), '연결을 유지할 자료입니다.');
  await mkdir(path.join(f.root, '폴더')); await f.engine.scan(f.workspace);
  const snapshot = f.engine.snapshot(f.workspace), entry = snapshot.entries.find(row => row.name === name), other = snapshot.entries.find(row => row.name === '유지.txt');
  const version = await f.engine.openDocument(f.workspace, entry.id); await f.engine.openDocument(f.workspace, other.id);
  f.engine.savePositions(f.workspace, [{ id: entry.id, x: 123, y: 456 }]);
  f.engine.putCanvasItem(f.workspace, '', 'relation', { id: randomUUID(), source_document_id: entry.id, target_document_id: other.id, relation_type: 'REFERENCE' }, 0);
  assert.throws(() => f.engine.disconnectFile(f.workspace, snapshot.entries.find(row => row.kind === 'directory').id), /일반 파일/);
  const otherRoot = path.join(f.base, '별도 폴더'); await mkdir(otherRoot);
  const another = (await f.engine.connect(otherRoot)).workspace.id;
  assert.throws(() => f.engine.disconnectFile(another, entry.id));
  await assert.rejects(f.engine.reconnectFile(another, entry.id));
  f.engine.disconnectFile(f.workspace, entry.id);
  assert.equal(await readFile(path.join(f.root, name), 'utf8'), original);
  const renamed = path.join(f.root, '이름이 바뀐 문서.md'); await rename(path.join(f.root, name), renamed);
  await writeFile(renamed, original + '\n연결 해제 중 변경'); await f.engine.scan(f.workspace); await f.restart();
  const disconnected = f.engine.snapshot(f.workspace);
  assert.equal(disconnected.entries.some(row => row.id === entry.id), false);
  assert.equal(disconnected.entries.some(row => row.id === other.id), true);
  assert.deepEqual(disconnected.disconnected_files.map(row => [row.id, row.name, row.available]), [[entry.id, '이름이 바뀐 문서.md', true]]);
  await assert.rejects(f.engine.resolveEntry(f.workspace, entry.id), { code: 'FILE_DISCONNECTED' });
  await assert.rejects(f.engine.openDocument(f.workspace, entry.id), { code: 'FILE_DISCONNECTED' });
  for (const scope of ['current', 'history', 'as_of']) assert.deepEqual(f.engine.searchContent(f.workspace, '개별연결테스트', scope, new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date())), []);
  assert.deepEqual(f.engine.documentEntries(f.workspace, [version.document_id]), []);
  assert.equal(f.engine.canvasSnapshot(f.workspace, '').relations.length, 0);
  assert.equal(f.engine.versionSources(f.workspace).some(row => row.id === version.document_id), false);
  assert.equal(writingContext(f.engine.documents, f.workspace, '아무것도일치하지않는질문').some(source => source.document_id === version.document_id), false);
  assert.equal(f.engine.chatIndexStatus(f.workspace).current.versions, 1);
  assert.equal(f.engine.chatIndexStatus(f.workspace).all.versions, 1);
  assert.equal(f.engine.getDocumentVersion(f.workspace, version.document_id, version.version_id).normalized.blocks.at(-1).text, '개별연결테스트의 원본입니다.');
  await f.engine.reconnectFile(f.workspace, entry.id);
  const restored = f.engine.snapshot(f.workspace).entries.find(row => row.id === entry.id);
  assert.equal(restored.x, 123); assert.equal(restored.y, 456); assert.equal(restored.document_id, version.document_id);
  assert.equal(f.engine.canvasSnapshot(f.workspace, '').relations.length, 1);
  await f.engine.openDocument(f.workspace, entry.id);
  assert.equal(f.engine.getDocument(f.workspace, entry.id).versions.length, 2);
  assert.ok(f.engine.searchContent(f.workspace, '개별연결테스트').length);
  assert.equal(await readFile(renamed, 'utf8'), original + '\n연결 해제 중 변경');
  f.engine.disconnectFile(f.workspace, entry.id); await f.engine.disconnect(f.workspace);
  assert.equal(f.engine.db.prepare("SELECT count(*) AS n FROM local_settings WHERE key LIKE 'disconnected-file:%'").get().n, 0);
});

test('disconnecting while an index read is running prevents late parsed versions from entering the index', async t => {
  const f = await fixture(t), filename = path.join(f.root, '진행 중.md');
  await writeFile(filename, '# 진행 중\n늦게 완료될 본문'); await f.engine.scan(f.workspace);
  const entry = f.engine.snapshot(f.workspace).entries[0], read = f.engine.documents.readEntry.bind(f.engine.documents);
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  f.engine.documents.readEntry = async (...args) => { const result = await read(...args); entered(); await blocked; return result; };
  const job = f.engine.documents.indexWorkspace(f.workspace);
  try { await started; f.engine.disconnectFile(f.workspace, entry.id); } finally { release(); }
  await job;
  assert.equal(f.engine.getDocument(f.workspace, entry.id).versions.length, 0);
  assert.deepEqual(f.engine.searchContent(f.workspace, '본문', 'history'), []);
  assert.equal(f.engine.documents.indexStatus.get(f.workspace).failed, 0);
  assert.equal(f.engine.documents.indexStatus.get(f.workspace).total, 0);
  assert.equal(await readFile(filename, 'utf8'), '# 진행 중\n늦게 완료될 본문');
  await f.engine.reconnectFile(f.workspace, entry.id); await f.engine.openDocument(f.workspace, entry.id);
  assert.equal(f.engine.getDocument(f.workspace, entry.id).versions.length, 1);
});
