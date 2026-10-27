import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink, link, chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkspaceEngine } from '../electron/engine.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-derivatives-'));
  const root = path.join(base, '자료'), data = path.join(base, 'data'); await mkdir(root);
  await writeFile(path.join(root, '보고서.md'), '# 한글 보고서\n\n예산 100만원\n\n| 항목 | 금액 |\n| --- | --- |\n| 개발 | 100만원 |');
  const f = { base, root, data, engine: await new WorkspaceEngine(data).init({ watchFiles: false }) };
  f.workspace = (await f.engine.connect(root)).workspace.id;
  f.entry = f.engine.snapshot(f.workspace).entries.find(entry => entry.name === '보고서.md');
  t.after(async () => { await f.engine.close(); await rm(base, { recursive: true, force: true }); });
  return f;
}
async function completed(f, version, format) {
  for (let n = 0; n < 500; n++) {
    const job = f.engine.listConversions(f.workspace, version.document_id).find(job => job.version_id === version.version_id && job.format === format);
    if (job?.state === 'FAILED') throw new Error(job.error_message);
    if (job?.state === 'COMPLETED') return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('conversion did not complete');
}

test('five real local conversions persist, deduplicate and save without replacing source bytes', async t => {
  const f = await fixture(t), version = await f.engine.openDocument(f.workspace, f.entry.id);
  const original = await readFile(path.join(f.root, f.entry.name));
  assert.equal(f.engine.db.prepare('PRAGMA user_version').get().user_version, 10);
  for (const format of ['pdf', 'docx', 'hwpx', 'txt', 'md']) {
    f.engine.requestConversion(f.workspace, version.version_id, format);
    f.engine.requestConversion(f.workspace, version.version_id, format);
    const job = await completed(f, version, format); assert.equal(job.attempts, 1); assert.ok(job.size);
    const output = f.engine.conversionOutput(f.workspace, version.version_id, format);
    await f.engine.writeConversion(f.workspace, version.version_id, format, path.join(f.base, `저장.${format}`), null);
    assert.equal((await readFile(path.join(f.base, `저장.${format}`))).toString('base64'), output.data);
  }
  assert.deepEqual(await readFile(path.join(f.root, f.entry.name)), original);
  await assert.rejects(f.engine.writeConversion(f.workspace, version.version_id, 'md', path.join(f.root, f.entry.name), null), /원본/);
  const alias = path.join(f.root, '원본 별칭.md'); await link(path.join(f.root, f.entry.name), alias);
  await assert.rejects(f.engine.writeConversion(f.workspace, version.version_id, 'md', alias, null), /원본/);
  await f.engine.close(); f.engine = await new WorkspaceEngine(f.data).init({ watchFiles: false });
  assert.equal(f.engine.listConversions(f.workspace, version.document_id).length, 5);
  f.engine.requestConversion(f.workspace, version.version_id, 'pdf'); assert.equal((await completed(f, version, 'pdf')).attempts, 1);
});

test('document copies keep selected immutable bytes and independent identity while binary copies stream unchanged', async t => {
  const f = await fixture(t), first = await f.engine.openDocument(f.workspace, f.entry.id);
  await writeFile(path.join(f.root, f.entry.name), '# 새 내용'); await f.engine.scan(f.workspace);
  await f.engine.openDocument(f.workspace, f.entry.id);
  let metadata = f.engine.getDocument(f.workspace, f.entry.id);
  f.engine.setCurrentVersion(f.workspace, metadata.id, first.version_id, metadata.revision);
  const request = randomUUID();
  const copies = await Promise.all([f.engine.copyFile(f.workspace, f.entry.id, request), f.engine.copyFile(f.workspace, f.entry.id, request)]);
  assert.equal(copies[0].id, copies[1].id); assert.equal(copies[0].name, '보고서 copy.md');
  assert.match(await readFile(path.join(f.root, copies[0].name), 'utf8'), /예산 100만원/);
  const copied = f.engine.getDocument(f.workspace, copies[0].id);
  assert.notEqual(copied.id, metadata.id); assert.notEqual(copied.current_version_id, first.version_id);
  assert.equal(copied.versions[0].source_version_id, first.version_id);
  await writeFile(path.join(f.root, copies[0].name), '# 복사본만 수정');
  assert.equal(await readFile(path.join(f.root, f.entry.name), 'utf8'), '# 새 내용');
  const next = await f.engine.copyFile(f.workspace, f.entry.id, randomUUID()); assert.equal(next.name, '보고서 copy 2.md');
  const bytes = Buffer.alloc(3 * 1024 * 1024, 173); await writeFile(path.join(f.root, '이미지.png'), bytes); await writeFile(path.join(f.root, '빈 파일.bin'), ''); await f.engine.scan(f.workspace);
  for (const name of ['이미지.png', '빈 파일.bin']) {
    const entry = f.engine.snapshot(f.workspace).entries.find(entry => entry.name === name);
    const copy = await f.engine.copyFile(f.workspace, entry.id, randomUUID());
    assert.deepEqual(await readFile(path.join(f.root, copy.name)), await readFile(path.join(f.root, name)));
    assert.notEqual((await stat(path.join(f.root, copy.name))).ino, (await stat(path.join(f.root, name))).ino);
  }
});

test('published copies recover after interruption without creating another file', async t => {
  const f = await fixture(t), request = randomUUID(), scan = f.engine.scan.bind(f.engine);
  f.engine.scan = async () => { throw new Error('synthetic interrupted metadata registration'); };
  await assert.rejects(f.engine.copyFile(f.workspace, f.entry.id, request), /interrupted/);
  assert.equal(f.engine.db.prepare('SELECT state FROM local_copy_requests').get().state, 'PUBLISHED');
  f.engine.scan = scan;
  await f.engine.close(); f.engine = await new WorkspaceEngine(f.data).init({ watchFiles: false });
  const copy = await f.engine.copyFile(f.workspace, f.entry.id, request);
  assert.equal(copy.name, '보고서 copy.md');
  assert.deepEqual((await readdir(f.root)).filter(name => name.includes('copy')), ['보고서 copy.md']);
  assert.equal(f.engine.db.prepare('SELECT state FROM local_copy_requests').get().state, 'COMPLETED');
});

test('unsafe copy sources, wrong versions and reused request IDs are rejected', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, '폴더')); await writeFile(path.join(f.root, '다른 파일.md'), '# 별도 문서');
  await symlink(path.join(f.root, f.entry.name), path.join(f.root, '링크.md')); await f.engine.scan(f.workspace);
  const entries = f.engine.snapshot(f.workspace).entries;
  for (const name of ['폴더', '링크.md']) await assert.rejects(f.engine.copyFile(f.workspace, entries.find(e => e.name === name).id, randomUUID()));
  const other = entries.find(e => e.name === '다른 파일.md'), otherVersion = await f.engine.openDocument(f.workspace, other.id);
  await assert.rejects(f.engine.copyFile(f.workspace, f.entry.id, randomUUID(), otherVersion.version_id), /선택한 파일/);
  const request = randomUUID(); await f.engine.copyFile(f.workspace, f.entry.id, request);
  await assert.rejects(f.engine.copyFile(f.workspace, other.id, request), /다른 작업/);
  await f.engine.disconnectFile(f.workspace, f.entry.id);
  await assert.rejects(f.engine.copyFile(f.workspace, f.entry.id, randomUUID()), /연결 해제/);
});

test('source changes during binary copying fail before publication and temporary files stay out of inventory', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, '원본.bin'), 'original binary'); await f.engine.scan(f.workspace);
  const entry = f.engine.snapshot(f.workspace).entries.find(e => e.name === '원본.bin');
  const resolve = f.engine.resolveEntry.bind(f.engine); let reads = 0;
  f.engine.resolveEntry = async (id, file) => { if (file === entry.id && ++reads === 2) await writeFile(path.join(f.root, entry.name), 'external change'); return resolve(id, file); };
  await assert.rejects(f.engine.copyFile(f.workspace, entry.id, randomUUID()), /원본이 변경/);
  assert.equal((await readdir(f.root)).some(name => name.includes(' copy')), false);
  await writeFile(path.join(f.root, '.context-copy-interrupted.tmp'), 'interrupted');
  await f.engine.settings(f.workspace, { showHidden: true, includeGenerated: false });
  assert.equal(f.engine.snapshot(f.workspace).entries.some(e => e.name.includes('.context-copy-')), false);
});

test('failed jobs retry explicitly, interrupted jobs resume and disconnected workspaces reject late results', async t => {
  const f = await fixture(t), version = await f.engine.openDocument(f.workspace, f.entry.id);
  const processor = f.engine.derivatives.processor;
  f.engine.derivatives.processor = async () => { throw new Error('synthetic converter failure'); };
  f.engine.requestConversion(f.workspace, version.version_id, 'pdf');
  await assert.rejects(completed(f, version, 'pdf'), /converter failure/);
  f.engine.derivatives.processor = processor; f.engine.requestConversion(f.workspace, version.version_id, 'pdf');
  assert.equal((await completed(f, version, 'pdf')).attempts, 2);
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.engine.derivatives.processor = async (_request, { signal }) => { entered(); await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }); }); return { data: Buffer.from('late output').toString('base64'), warnings: [] }; };
  f.engine.requestConversion(f.workspace, version.version_id, 'txt'); await waiting;
  await f.engine.close(); f.engine = await new WorkspaceEngine(f.data).init({ watchFiles: false });
  assert.equal((await completed(f, version, 'txt')).attempts, 2);
  const after = new Promise(resolve => { entered = resolve; });
  f.engine.derivatives.processor = async (_request, { signal }) => { entered(); await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }); }); return { data: Buffer.from('late output').toString('base64'), warnings: [] }; };
  f.engine.requestConversion(f.workspace, version.version_id, 'docx'); await after;
  await f.engine.disconnect(f.workspace); release();
  assert.equal(f.engine.db.prepare('SELECT count(*) AS n FROM local_conversions').get().n, 0);
  assert.equal(await readFile(path.join(f.root, f.entry.name), 'utf8').then(Boolean), true);
});

test('version 7 upgrades with a consistent backup and preserves workspace data and coordinates', async t => {
  const f = await fixture(t); await f.engine.openDocument(f.workspace, f.entry.id);
  f.engine.savePositions(f.workspace, [{ id: f.entry.id, x: 123, y: -456 }]);
  f.engine.db.exec('DROP TABLE local_conversions; DROP TABLE local_copy_requests; PRAGMA user_version=7;');
  await f.engine.close(); f.engine = await new WorkspaceEngine(f.data).init({ watchFiles: false });
  const filename = (await readdir(path.join(f.data, 'backups'))).find(name => name.startsWith('workspace-v7-'));
  assert.ok(filename);
  const backup = new DatabaseSync(path.join(f.data, 'backups', filename), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 7); backup.close();
  const restored = f.engine.snapshot(f.workspace).entries.find(e => e.id === f.entry.id);
  assert.equal(restored.x, 123); assert.equal(restored.y, -456);
  assert.equal(f.engine.getDocument(f.workspace, f.entry.id).versions.length, 1);
});

test('historical conversions keep the current head, detect damaged cache and can retry', async t => {
  const f = await fixture(t), first = await f.engine.openDocument(f.workspace, f.entry.id);
  await writeFile(path.join(f.root, f.entry.name), '# 최신 본문'); await f.engine.scan(f.workspace);
  const latest = await f.engine.openDocument(f.workspace, f.entry.id);
  f.engine.requestConversion(f.workspace, first.version_id, 'txt'); await completed(f, first, 'txt');
  assert.match(Buffer.from(f.engine.conversionOutput(f.workspace, first.version_id, 'txt').data, 'base64').toString(), /100만원/);
  assert.equal(f.engine.getDocument(f.workspace, f.entry.id).current_version_id, latest.version_id);
  f.engine.db.prepare('UPDATE local_conversions SET bytes=? WHERE version_id=?').run(Buffer.from('damaged'), first.version_id);
  assert.throws(() => f.engine.conversionOutput(f.workspace, first.version_id, 'txt'), /다시 변환/);
  f.engine.requestConversion(f.workspace, first.version_id, 'txt'); assert.equal((await completed(f, first, 'txt')).attempts, 2);
  assert.throws(() => f.engine.requestConversion(f.workspace, first.version_id, 'exe'), /출력 형식/);
  assert.throws(() => f.engine.requestConversion(f.workspace, randomUUID(), 'pdf'), /문서 이력/);
});

test('long Korean names, simultaneous copy requests and read-only folders preserve original files', async t => {
  const f = await fixture(t), name = '한글이름'.repeat(20) + '.bin';
  await writeFile(path.join(f.root, name), 'independent bytes'); await f.engine.scan(f.workspace);
  const entry = f.engine.snapshot(f.workspace).entries.find(e => e.name === name);
  const copies = await Promise.all([f.engine.copyFile(f.workspace, entry.id, randomUUID()), f.engine.copyFile(f.workspace, entry.id, randomUUID())]);
  assert.notEqual(copies[0].name, copies[1].name);
  for (const copy of copies) { assert.ok(Buffer.byteLength(copy.name) <= 240); assert.match(copy.name, / copy( 2)?\.bin$/); }
  await chmod(f.root, 0o500);
  try { await assert.rejects(f.engine.copyFile(f.workspace, entry.id, randomUUID()), error => ['EACCES', 'EPERM'].includes(error.code)); }
  finally { await chmod(f.root, 0o700); }
  assert.equal(await readFile(path.join(f.root, name), 'utf8'), 'independent bytes');
});

test('a pinned version copies its saved bytes even after the disk file becomes unparseable', async t => {
  const f = await fixture(t), first = await f.engine.openDocument(f.workspace, f.entry.id);
  const original = await readFile(path.join(f.root, f.entry.name));
  const doc = f.engine.getDocument(f.workspace, f.entry.id);
  f.engine.setCurrentVersion(f.workspace, doc.id, first.version_id, doc.revision);
  const invalid = Buffer.from([0xff, 0xfe, 0x00]); await writeFile(path.join(f.root, f.entry.name), invalid);
  const copy = await f.engine.copyFile(f.workspace, f.entry.id, randomUUID());
  assert.deepEqual(await readFile(path.join(f.root, copy.name)), original);
  assert.deepEqual(await readFile(path.join(f.root, f.entry.name)), invalid);
  assert.equal(f.engine.getDocument(f.workspace, copy.id).versions[0].source_version_id, first.version_id);
});
