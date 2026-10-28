import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { sampleData } from '../../../packages/workspace-ui/assets/harulab-sample.ts';
import { generateSample, sampleExportContent } from '../electron/sample-ai.mjs';
import { createSampleStore } from '../../../packages/workspace-ui/src/sample-store.ts';

const moduleURL = new URL('../../../packages/workspace-ui/src/sample-ai.ts', import.meta.url);
const source = (await readFile(moduleURL, 'utf8')).replace("'../shared/core/writing'", JSON.stringify(new URL('../../../packages/workspace-ui/shared/core/writing.ts', import.meta.url).href));
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { createSampleRepositories, sampleSources } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) }; };
const search = { question: '모아오더 제품 요구사항', scope: 'current', as_of: null };
const block = (text, source) => ({ id: 'body', type: 'paragraph', text, source_ids: source ? [source.id] : [] });
const generated = request => ({ content: { title: '하루랩 소개서', blocks: [block(request.current ? '수정된 소개' : '처음 소개', request.sources[0])] }, sources: [{ id: 'untrusted' }], checks: ['가상 회사 자료입니다.'] });

test('sample retrieval stays grounded in bundled documents, respects budgets, and never invents historical versions', () => {
  const evidence = sampleSources(sampleData, search);
  assert.ok(evidence.sources.length > 0);
  assert.ok(evidence.sources.some(source => source.document_title.includes('제품요구사항')));
  assert.ok(evidence.sources.length <= 12);
  assert.ok(evidence.sources.reduce((n, source) => n + source.text.length, 0) <= 24000);
  for (const source of evidence.sources) assert.ok(sampleData.documents.some(document => document.entry_id === source.document_id));
  const historical = sampleSources(sampleData, { ...search, scope: 'as_of', as_of: '2026-01-01' });
  assert.equal(historical.sources.length, 0); assert.equal(historical.warnings.length, 1);
});

test('draft generation, persistence, idempotency, proposal review, undo and revision conflicts preserve sample originals', async () => {
  const original = JSON.stringify(sampleData), saved = storage(); let calls = 0;
  const adapter = { generate: async request => { calls++; return generated(request); } };
  const repo = createSampleRepositories(sampleData, adapter, saved).drafts;
  const input = { prompt: search.question, requestId: crypto.randomUUID() };
  const first = await repo.generate(input);
  assert.equal(calls, 1); assert.equal((await repo.generate(input)).id, first.id); assert.equal(calls, 1);
  assert.notEqual(first.sources[0].id, 'untrusted');
  const reopened = createSampleRepositories(sampleData, adapter, saved).drafts;
  assert.deepEqual(await reopened.get(first.id), first);
  const proposed = await reopened.generate({ draftId: first.id, revision: first.revision, prompt: '고객 전략을 추가해줘', requestId: crypto.randomUUID() });
  assert.equal(proposed.content.blocks[0].text, '처음 소개'); assert.equal(proposed.proposal.content.blocks[0].text, '수정된 소개');
  const accepted = await reopened.review(first.id, proposed.revision, 'accept');
  assert.equal(accepted.content.blocks[0].text, '수정된 소개'); assert.equal(accepted.can_undo, true);
  const undone = await reopened.review(first.id, accepted.revision, 'undo');
  assert.equal(undone.content.blocks[0].text, '처음 소개');
  await assert.rejects(reopened.save(first.id, first.revision, first.content), /변경/);
  assert.equal(JSON.stringify(sampleData), original);
});

test('invalid model citations are rejected and an uncertain generation is never automatically submitted twice', async () => {
  let calls = 0;
  const repo = createSampleRepositories(sampleData, { generate: async () => { calls++; return { content: { title: '위조', blocks: [block('위조 근거', { id: 'not-sent' })] }, checks: [] }; } }, storage()).drafts;
  const input = { prompt: search.question, requestId: crypto.randomUUID() };
  await assert.rejects(repo.generate(input), /검증/);
  await assert.rejects(repo.generate(input), /이미 접수/); assert.equal(calls, 1);
  assert.deepEqual(await repo.list(), []);
});

test('chat persists grounded answers, records failures, retries, and avoids AI calls when there is no evidence', async () => {
  const saved = storage(); let fail = true, calls = 0;
  const adapter = { generate: async request => { calls++; if (fail) throw new Error('연결 실패'); return { claims: [{ text: '샘플에 근거한 답변', source_ids: [request.sources[0].id] }], insufficient: false }; } };
  const repo = createSampleRepositories(sampleData, adapter, saved).chat;
  const session = await repo.createSession({ title: '질문', requestId: crypto.randomUUID() });
  await assert.rejects(repo.ask(session.id, { ...search, requestId: crypto.randomUUID() }), /연결 실패/);
  const failed = (await repo.messages(session.id)).at(-1); assert.equal(failed.state, 'FAILED');
  fail = false; const answer = await repo.retry(session.id, failed.id); assert.equal(answer.state, 'COMPLETED');
  assert.equal(answer.id, failed.id); assert.equal((await repo.messages(session.id)).length, 2);
  const reopened = createSampleRepositories(sampleData, adapter, saved).chat;
  assert.equal((await reopened.messages(session.id)).at(-1).content, '샘플에 근거한 답변');
  const before = calls;
  const empty = await reopened.ask(session.id, { question: 'zxqv999999999', scope: 'current', as_of: null, requestId: crypto.randomUUID() });
  assert.equal(empty.result.insufficient, true); assert.equal(calls, before);
});

test('desktop bridge enforces input limits and replaces provider source objects with the exact request excerpts', async () => {
  const sources = sampleSources(sampleData, search).sources;
  const request = { request_id: crypto.randomUUID(), task: 'write', prompt: search.question, sources, current: null };
  let calls = 0;
  const ai = { ensureReady: async () => {}, generate: async input => { calls++; return generated(input); } };
  const result = await generateSample(ai, request); assert.deepEqual(result.sources, sources);
  await assert.rejects(generateSample(ai, { ...request, sources: [...sources, sources[0]] }), /근거/);
  await assert.rejects(generateSample(ai, { ...request, prompt: 'x'.repeat(4001) }), /요청/);
  assert.equal(calls, 1);
  assert.equal(sampleExportContent(result.content, 'docx').title, result.content.title);
  assert.throws(() => sampleExportContent(result.content, 'exe'), /형식/);
});

test('sample working copy persists document revisions and AI searches the edited content while old citations stay readable', async () => {
  const saved = storage(), original = JSON.stringify(sampleData), store = createSampleStore(sampleData, saved);
  const repositories = createSampleRepositories(store.data, {}, saved), repo = repositories.chat;
  const aiDraft = await repositories.drafts.create(crypto.randomUUID());
  const document = store.data.documents.find(document => document.path.endsWith('제품요구사항_v1.2.md'));
  const before = structuredClone(document.content);
  const content = { ...before, blocks: [{ id: 1, type: 'paragraph', text: '시연수정표식 신규 출시 목표는 2030년입니다.', source: {} }] };
  await store.saveDocument(document.entry_id, 1, content);
  assert.equal((await repo.search({ ...search, question: '시연수정표식' })).sources[0].version_number, 2);
  assert.equal((await repo.search({ ...search, question: '시연수정표식' })).sources[0].text, content.blocks[0].text);
  assert.deepEqual(store.document(document.entry_id, 1).content, before);
  const reopened = createSampleStore(sampleData, saved); reopened.load();
  assert.deepEqual(reopened.document(document.entry_id).content, content);
  await assert.rejects(reopened.saveDocument(document.entry_id, 1, before), /변경/);
  await reopened.reset();
  assert.equal((await repositories.drafts.get(aiDraft.id)).title, '새 문서');
  assert.deepEqual(reopened.document(document.entry_id).content, before);
  assert.deepEqual(reopened.document(document.entry_id, 2).content, content);
  assert.equal(JSON.stringify(sampleData), original);
});

test('sample canvas supports persistence, revision conflicts and undo recreation after deletion', async () => {
  const saved = storage(), store = createSampleStore(sampleData, saved), id = sampleData.workspace_id;
  const value = { id: crypto.randomUUID(), kind: 'text', text: '시연 메모', x: 50, y: 70, width: 300, height: 160, color: 'rose', font_size: 20 };
  const first = await store.api.putCanvasItem(id, '02_제품기획', 'element', value, 0);
  await assert.rejects(store.api.putCanvasItem(id, '02_제품기획', 'element', value, 0), /변경/);
  await store.api.removeCanvasItem(id, '02_제품기획', first.id, first.revision);
  const restored = await store.api.putCanvasItem(id, '02_제품기획', 'element', value, 2);
  assert.equal(restored.revision, 3);
  const file = store.data.entries.find(entry => entry.kind === 'file');
  await store.api.savePositions(id, [{ id: file.id, x: 111, y: 222 }]);
  await store.api.saveView(id, ':spatial:readable', { x: 40, y: 60, zoom: 1, editing: true });
  const reopened = createSampleStore(sampleData, saved); reopened.load();
  assert.equal((await reopened.api.canvasSnapshot(id, '02_제품기획')).elements.find(item => item.id === value.id).text, '시연 메모');
  assert.equal(reopened.snapshot().entries.find(entry => entry.id === file.id).x, 111);
  assert.equal(reopened.snapshot().spatial_editing, true);
});

test('sample file creation, copying, moving and folder rename stay inside the working copy and reset restores inventory', async () => {
  const store = createSampleStore(sampleData, storage()), id = sampleData.workspace_id;
  const item = await store.createFile('시연.md', '02_제품기획');
  await assert.rejects(store.createFile('시연.md', '02_제품기획'), /같은 이름/);
  await assert.rejects(store.createFile('../이탈.md', '02_제품기획'), /이름/);
  const requestId = crypto.randomUUID(), copied = await store.api.copyFile(id, item.id, requestId);
  assert.equal((await store.api.copyFile(id, item.id, requestId)).id, copied.id);
  const folder = store.data.entries.find(entry => entry.relative_path === '01_회사소개');
  await store.api.moveFileToFolder(id, copied.id, folder.id, { expected_parent: item.parent_path });
  await store.rename(folder.id, '회사 자료');
  assert.equal(store.data.entries.find(entry => entry.id === copied.id).relative_path, '회사 자료/시연 copy.md');
  await store.reset();
  assert.equal(store.data.documents.length, sampleData.documents.length);
  assert.equal(store.data.entries.some(entry => entry.id === item.id), false);
});
