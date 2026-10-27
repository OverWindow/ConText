import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runProcessor } from '../electron/processor.mjs';
import { WorkspaceEngine } from '../electron/engine.mjs';

const available = existsSync(new URL('../processor/dist/context-processor/context-processor', import.meta.url));
const content = { title: '한글 보고서', blocks: [
  { id: 'p', type: 'paragraph', text: '경희대학교의 로컬 문서입니다.', level: 2 },
  { id: 'l', type: 'list', items: ['자료 확인', '초안 작성'] },
  { id: 't', type: 'table', rows: [['항목', '예산'], ['개발', '100만원']] },
] };

test('frozen processor exports and reparses Korean PDF/DOCX/HWPX/TXT/MD without system Python', { skip: !available }, async () => {
  for (const format of ['pdf', 'docx', 'hwpx', 'txt', 'md']) {
    const output = await runProcessor({ operation: 'export', content, format });
    const parsed = await runProcessor({ operation: 'parse', filename: `문서.${format}`, data: output.data });
    const text = parsed.blocks.map(block => block.text).join('\n');
    assert.match(text, /한글 보고서/); assert.match(text, /경희대학교/); assert.match(text, /100만원/);
  }
});

test('local indexing snapshots versions, invalidates changed content and preserves original citations', { skip: !available }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-index-'));
  const root = path.join(base, '자료'); await mkdir(root);
  const filename = path.join(root, '정책.md'); await writeFile(filename, '# 가격 정책\n초기 예산은 100만원');
  const engine = await new WorkspaceEngine(path.join(base, 'data')).init({ watchFiles: false });
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  const initial = await engine.connect(root), wid = initial.workspace.id, file = initial.entries[0].id;
  const first = await engine.openDocument(wid, file);
  assert.equal(first.version_number, 1);
  const draft = await engine.importDraft(wid, file, randomUUID());
  assert.equal(draft.sources[0].version_id, first.version_id);
  await writeFile(filename, '# 가격 정책\n변경 예산은 200만원'); await engine.scan(wid);
  assert.equal(engine.searchContent(wid, '100만원').length, 0);
  const second = await engine.openDocument(wid, file);
  assert.equal(second.document_id, first.document_id); assert.equal(second.version_number, 2);
  assert.equal(engine.searchContent(wid, '200만원')[0].version_id, second.version_id);
  assert.equal(engine.searchContent(wid, '100만원', 'history')[0].version_id, first.version_id);
  assert.equal(engine.getDraft(wid, draft.id).sources[0].version_id, first.version_id);
  const difference = await engine.compareDocumentVersions(wid, first.document_id, first.version_id, second.version_id);
  assert.equal(difference.counts.modified, 1);
  const restored = await engine.restoreDocumentVersion(wid, first.document_id, first.version_id, second.sha256);
  assert.equal(restored.version_number, 3);
  assert.match((await engine.documents.readEntry(wid, file)).data.toString(), /100만원/);
  assert.equal(engine.getDocument(wid, file).versions.length, 3);
});

test('paused indexing survives restart, resumes incrementally and FTS safely handles Korean short terms', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-index-pause-'));
  const root = path.join(base, '자료'); await mkdir(root);
  const data = path.join(base, 'data');
  let engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  await writeFile(path.join(root, '문서.md'), '# 한글 제목\n예산 100만원 회의 자료');
  const workspace = (await engine.connect(root)).workspace.id;
  engine.cancelIndex(workspace); await engine.documents.indexWorkspace(workspace);
  assert.equal(engine.documents.indexStatus.get(workspace).state, 'cancelled');
  assert.equal(engine.db.prepare('SELECT count(*) AS n FROM local_versions').get().n, 0);
  await engine.close(); engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  assert.equal(engine.snapshot(workspace).indexing.state, 'cancelled');
  await engine.documents.indexWorkspace(workspace, { resume: true });
  assert.ok(engine.searchContent(workspace, '100만원').length);
  assert.ok(engine.searchContent(workspace, '예산').length);
  assert.deepEqual(engine.searchContent(workspace, '" OR *'), []);
  const versions = engine.db.prepare('SELECT count(*) AS n FROM local_versions').get().n;
  await engine.close(); engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  // An unchanged, already indexed document needs no new processor or version.
  await engine.documents.indexWorkspace(workspace);
  assert.equal(engine.db.prepare('SELECT count(*) AS n FROM local_versions').get().n, versions);
  assert.equal(engine.snapshot(workspace).indexing.completed, 1);
});

test('selected-file summaries bind citations, create one local file and source edges, and resume export without another AI call', { skip: !available }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-summary-'));
  const root = path.join(base, '자료'); await mkdir(root);
  const data = path.join(base, 'data'); let engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'A.md'), '# 첫 근거\n예산 100만원'); await writeFile(path.join(root, 'B.md'), '# 둘째 근거\n일정은 10월');
  const workspace = (await engine.connect(root)).workspace.id;
  const ids = engine.snapshot(workspace).entries.filter(e => e.kind === 'file').map(e => e.id);
  const input = { request_id: randomUUID(), entry_ids: ids, directory: '', x: 600, y: 200 };
  const request = await engine.prepareSummary(workspace, input);
  await assert.rejects(engine.prepareSummary(workspace, input), /접수된/);
  const response = { content: { title: '자료 요약', blocks: [{ id: 'p', type: 'paragraph', text: '두 근거를 요약했습니다.', source_ids: [request.sources[0].id] }] }, checks: [] };
  const collision = path.join(root, `요약-${input.request_id.slice(0, 8)}.md`);
  await writeFile(collision, '기존 파일은 보존');
  await assert.rejects(engine.finishSummary(workspace, input, response));
  assert.equal(await (await import('node:fs/promises')).readFile(collision, 'utf8'), '기존 파일은 보존');
  assert.equal(engine.listDrafts(workspace).length, 1);
  await engine.close(); engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  assert.equal((await engine.prepareSummary(workspace, input)).resume, true);
  await rm(collision);
  const entry = await engine.finishSummary(workspace, input);
  assert.equal(entry.x, 600);
  assert.equal(engine.canvasSnapshot(workspace, '').relations.length, 2);
  assert.equal((await engine.prepareSummary(workspace, input)).existing.id, entry.id);
  assert.equal(engine.listDrafts(workspace).length, 1);
  assert.equal(await (await import('node:fs/promises')).readFile(path.join(root, 'A.md'), 'utf8'), '# 첫 근거\n예산 100만원');
});

test('aborting an active index stops the processor and leaves no partial version', { skip: !available }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-index-abort-'));
  const root = path.join(base, '자료'); await mkdir(root); await writeFile(path.join(root, 'A.md'), '# 취소할 자료\n본문');
  const engine = await new WorkspaceEngine(path.join(base, 'data')).init({ watchFiles: false });
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  const workspace = (await engine.connect(root)).workspace.id;
  const job = engine.documents.indexWorkspace(workspace); engine.cancelIndex(workspace); await job;
  assert.equal(engine.db.prepare('SELECT count(*) AS n FROM local_versions').get().n, 0);
  assert.equal(engine.snapshot(workspace).indexing.state, 'cancelled');
});

test('manual version links preserve both files and citations, current choice stays pinned through indexing', { skip: !available }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-version-link-'));
  const root = path.join(base, '자료'); await mkdir(root);
  const data = path.join(base, 'data'); let engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  const filename = path.join(root, '가격 정책.md');
  await writeFile(filename, '# 가격 정책\n서비스 가격 정책의 기본 원칙은 같은 조건의 고객에게 같은 기준을 적용하는 것입니다. 예산은 100만원입니다.');
  await writeFile(path.join(root, '가격 정책_수정.md'), '# 가격 정책\n서비스 가격 정책의 기본 원칙은 같은 조건의 고객에게 같은 기준을 적용하는 것입니다. 예산은 200만원입니다.');
  const workspace = (await engine.connect(root)).workspace.id;
  await engine.documents.indexWorkspace(workspace);
  const entries = engine.snapshot(workspace).entries;
  const a = entries.find(e => e.name === '가격 정책.md'), b = entries.find(e => e.name === '가격 정책_수정.md');
  let target = engine.getDocument(workspace, a.id); const source = engine.getDocument(workspace, b.id);
  const originalId = source.versions[0].id, request = randomUUID();
  const candidates = await engine.versionCandidates(workspace, source.id, originalId);
  assert.equal(candidates.items[0].document_id, target.id);
  assert.equal(candidates.items[0].embedding_similarity, null);
  engine.linkDocumentVersion(workspace, target.id, originalId, request, target.revision, '가격 수정본');
  engine.linkDocumentVersion(workspace, target.id, originalId, request, target.revision, '가격 수정본');
  target = engine.getDocument(workspace, a.id);
  assert.equal(target.versions.length, 2); assert.equal(target.versions[1].source_version_id, originalId);
  const linked = target.versions[1].id;
  engine.setCurrentVersion(workspace, target.id, linked, target.revision);
  await engine.openDocument(workspace, a.id);
  assert.equal(engine.getDocument(workspace, a.id).versions.length, 2);
  assert.ok(engine.searchContent(workspace, '200만원').some(s => s.document_id === target.id));
  await writeFile(filename, '# 외부 수정\n300만원'); await engine.scan(workspace); await engine.openDocument(workspace, a.id);
  target = engine.getDocument(workspace, a.id);
  assert.equal(target.current_version_id, linked); assert.notEqual(target.file_version_id, linked); assert.equal(target.versions.length, 3);
  assert.throws(() => engine.setCurrentVersion(workspace, target.id, null, target.revision - 1), { code: 'CONFLICT' });
  engine.setCurrentVersion(workspace, target.id, null, target.revision);
  assert.ok(engine.searchContent(workspace, '300만원').some(s => s.document_id === target.id));
  await engine.close(); engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  assert.equal(engine.getDocumentVersion(workspace, source.id, originalId).version_id, originalId);
  assert.equal(engine.getDocumentVersion(workspace, target.id, linked).normalized.blocks.at(-1).text.includes('200만원'), true);
});

test('local AI change summaries validate only bounded diff evidence and persist without retrying pending calls', { skip: !available }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-insight-'));
  const root = path.join(base, '자료'); await mkdir(root);
  const data = path.join(base, 'data'); let engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  const filename = path.join(root, '예산.md'); await writeFile(filename, '# 예산\n100만원');
  const workspace = (await engine.connect(root)).workspace.id, entry = engine.snapshot(workspace).entries[0];
  const before = await engine.openDocument(workspace, entry.id);
  await writeFile(filename, '# 예산\n200만원'); await engine.scan(workspace);
  const after = await engine.openDocument(workspace, entry.id), requestId = randomUUID();
  const request = await engine.prepareChangeSummary(workspace, before.document_id, before.version_id, after.version_id, requestId);
  assert.ok(request.sources.some(source => source.text.includes('100만원') && source.text.includes('200만원')));
  await assert.rejects(engine.prepareChangeSummary(workspace, before.document_id, before.version_id, after.version_id, requestId), /이미 접수/);
  assert.throws(() => engine.finishChangeSummary(workspace, before.document_id, before.version_id, after.version_id, requestId, { claims: [{ text: '근거 없는 답', source_ids: ['unknown'] }], insufficient: false }, 'test-model'));
  engine.finishChangeSummary(workspace, before.document_id, before.version_id, after.version_id, requestId, { claims: [{ text: '예산이 100만원에서 200만원으로 변경됐습니다.', source_ids: [request.sources[0].id] }], insufficient: false }, 'test-model');
  await engine.close(); engine = await new WorkspaceEngine(data).init({ watchFiles: false });
  const cached = engine.getChangeSummary(workspace, before.document_id, before.version_id, after.version_id);
  assert.equal(cached.state, 'complete'); assert.equal(cached.result.model, 'test-model');
  assert.equal((await engine.prepareChangeSummary(workspace, before.document_id, before.version_id, after.version_id, requestId)).existing.claims[0].text.includes('200만원'), true);
});

test('empty and large documents import as editable bounded drafts while preserving the full snapshot', { skip: !available }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-import-size-'));
  const root = path.join(base, '자료'); await mkdir(root);
  const engine = await new WorkspaceEngine(path.join(base, 'data')).init({ watchFiles: false });
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  await writeFile(path.join(root, '빈 파일.md'), '');
  const text = '# 긴 문서\n\n' + Array.from({ length: 130 }, (_, n) => `${n}: ` + '한글 본문을 보존합니다. '.repeat(100)).join('\n\n');
  await writeFile(path.join(root, '긴 문서.md'), text);
  const workspace = (await engine.connect(root)).workspace.id, entries = engine.snapshot(workspace).entries;
  const blank = await engine.importDraft(workspace, entries.find(e => e.name === '빈 파일.md').id, randomUUID());
  assert.equal(blank.content.blocks.length, 1); assert.equal(blank.content.blocks[0].text, '');
  const entry = entries.find(e => e.name === '긴 문서.md'), draft = await engine.importDraft(workspace, entry.id, randomUUID());
  assert.ok(JSON.stringify(draft.content).length < 150000);
  assert.ok(draft.checks.some(check => check.includes('일부 본문')));
  const document = engine.getDocument(workspace, entry.id);
  assert.equal(Buffer.from(engine.documents.version(workspace, document.id, document.file_version_id).bytes).toString(), text);
});

test('as-of search respects the Korean midnight boundary and rejects normalized invalid dates', { skip: !available }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-asof-'));
  const root = path.join(base, '자료'); await mkdir(root);
  const engine = await new WorkspaceEngine(path.join(base, 'data')).init({ watchFiles: false });
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  const filename = path.join(root, '기준.md'); await writeFile(filename, '예전 예산은 100만원');
  const workspace = (await engine.connect(root)).workspace.id, entry = engine.snapshot(workspace).entries[0];
  const before = await engine.openDocument(workspace, entry.id);
  await writeFile(filename, '다음 예산은 200만원'); await engine.scan(workspace);
  const after = await engine.openDocument(workspace, entry.id);
  engine.db.prepare('UPDATE local_versions SET created_at=? WHERE id=?').run(Date.parse('2025-10-22T23:59:59+09:00'), before.version_id);
  engine.db.prepare('UPDATE local_versions SET created_at=? WHERE id=?').run(Date.parse('2025-10-23T00:00:00+09:00'), after.version_id);
  assert.equal(engine.searchContent(workspace, '예산', 'as_of', '2025-10-22')[0].version_id, before.version_id);
  assert.equal(engine.searchContent(workspace, '예산', 'as_of', '2025-10-23')[0].version_id, after.version_id);
  assert.throws(() => engine.searchContent(workspace, '예산', 'as_of', '2025-02-31'));
  assert.throws(() => engine.searchContent(workspace, '예산', 'as_of', '2999-01-01'));
});
