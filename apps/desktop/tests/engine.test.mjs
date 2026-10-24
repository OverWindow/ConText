import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, link, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceEngine } from '../electron/engine.mjs';
async function fixture(t, watchFiles = false) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-engine-'));
  const root = path.join(base, 'files'); await mkdir(root);
  const data = path.join(base, 'data'); let engine = await new WorkspaceEngine(data).init({ watchFiles });
  t.after(async () => { if (!engine.closed) await engine.close(); await rm(base, { recursive: true, force: true }); });
  return { base, root, data, get engine() { return engine; }, restart: async () => { await engine.close(); engine = await new WorkspaceEngine(data).init({ watchFiles }); return engine; } };
}
const entry = (snapshot, name) => snapshot.entries.find(item => item.relative_path === name);
async function until(fn) { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); } assert.fail('change did not arrive'); }
test('recursive inventory, empty files, generated and hidden folder settings', async t => {
  const f = await fixture(t); await mkdir(path.join(f.root, 'child')); await mkdir(path.join(f.root, 'node_modules'));
  await Promise.all(['zero.txt', '.secret', 'child/photo.png', 'node_modules/cache.js'].map(name => writeFile(path.join(f.root, name), '')));
  let value = await f.engine.connect(f.root); assert.equal(value.status, 'ready');
  assert.equal(entry(value, 'zero.txt').size, 0); assert.ok(entry(value, 'child/photo.png'));
  assert.equal(entry(value, 'node_modules').excluded, 1); assert.equal(entry(value, '.secret'), undefined); assert.equal(entry(value, 'node_modules/cache.js'), undefined);
  value = await f.engine.settings(value.workspace.id, { showHidden: true, includeGenerated: true });
  assert.ok(entry(value, '.secret')); assert.ok(entry(value, 'node_modules/cache.js'));
});
test('rename, path swaps, atomic replacement and restart preserve intended layout', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'a.txt'), 'a'); await writeFile(path.join(f.root, 'b.txt'), 'b');
  let value = await f.engine.connect(f.root); const id = value.workspace.id, a = entry(value, 'a.txt').id, b = entry(value, 'b.txt').id;
  f.engine.savePositions(id, [{ id: a, x: 123, y: -40 }]); f.engine.saveView(id, '', { x: -10, y: 60, zoom: .6 });
  await rename(path.join(f.root, 'a.txt'), path.join(f.root, 'tmp')); await rename(path.join(f.root, 'b.txt'), path.join(f.root, 'a.txt')); await rename(path.join(f.root, 'tmp'), path.join(f.root, 'b.txt'));
  await f.engine.scan(id); value = f.engine.snapshot(id); assert.equal(value.status, 'ready');
  assert.equal(entry(value, 'b.txt').id, a); assert.equal(entry(value, 'a.txt').id, b); assert.equal(entry(value, 'b.txt').x, 123);
  await writeFile(path.join(f.root, 'new.tmp'), 'replaced'); await rename(path.join(f.root, 'new.tmp'), path.join(f.root, 'b.txt')); await f.engine.scan(id);
  assert.equal(entry(f.engine.snapshot(id), 'b.txt').id, a);
  await f.restart(); value = f.engine.snapshot(id); assert.equal(entry(value, 'b.txt').x, 123); assert.equal(value.views[0].zoom, .6);
});
test('folder rename preserves descendant ids and distinct hard links stay distinct', async t => {
  const f = await fixture(t); await mkdir(path.join(f.root, 'before')); await writeFile(path.join(f.root, 'before/doc.txt'), 'content');
  await link(path.join(f.root, 'before/doc.txt'), path.join(f.root, 'copy.txt'));
  let value = await f.engine.connect(f.root); const id = value.workspace.id, folderId = entry(value, 'before').id;
  assert.notEqual(entry(value, 'before/doc.txt').id, entry(value, 'copy.txt').id);
  await rename(path.join(f.root, 'before'), path.join(f.root, 'after')); await f.engine.scan(id); value = f.engine.snapshot(id);
  assert.equal(value.status, 'ready'); assert.equal(entry(value, 'after').id, folderId); assert.ok(entry(value, 'after/doc.txt'));
});
test('watcher reconciles add, rename, modification and deletion without manual refresh', async t => {
  const f = await fixture(t, true); const initial = await f.engine.connect(f.root); const id = initial.workspace.id;
  await writeFile(path.join(f.root, 'live.txt'), 'a'); await until(() => entry(f.engine.snapshot(id), 'live.txt'));
  const fileId = entry(f.engine.snapshot(id), 'live.txt').id;
  await rename(path.join(f.root, 'live.txt'), path.join(f.root, 'renamed.txt')); await until(() => entry(f.engine.snapshot(id), 'renamed.txt'));
  assert.equal(entry(f.engine.snapshot(id), 'renamed.txt').id, fileId);
  await writeFile(path.join(f.root, 'renamed.txt'), 'more content'); await until(() => entry(f.engine.snapshot(id), 'renamed.txt')?.size === 12);
  await rm(path.join(f.root, 'renamed.txt')); await until(() => !entry(f.engine.snapshot(id), 'renamed.txt'));
});
test('offline cache, relinking and disconnect never delete originals', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'keep.txt'), 'keep'); const value = await f.engine.connect(f.root), id = value.workspace.id;
  const moved = path.join(f.base, 'moved'); await rename(f.root, moved); await f.engine.scan(id);
  assert.equal(f.engine.snapshot(id).status, 'unavailable'); assert.ok(entry(f.engine.snapshot(id), 'keep.txt'));
  const relinked = await f.engine.relink(id, moved); assert.equal(relinked.status, 'ready'); assert.equal(entry(relinked, 'keep.txt').id, entry(value, 'keep.txt').id);
  await f.engine.disconnect(id); assert.equal(f.engine.list().length, 0); assert.ok((await stat(path.join(moved, 'keep.txt'))).isFile());
});
test('cross-workspace IDs, invalid coordinates, symlinks and replaced parent escapes rejected', async t => {
  const f = await fixture(t); const outside = path.join(f.base, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'private.txt'), 'private');
  await symlink(outside, path.join(f.root, 'shortcut')); await mkdir(path.join(f.root, 'sub')); await writeFile(path.join(f.root, 'sub/private.txt'), 'local');
  const value = await f.engine.connect(f.root), id = value.workspace.id;
  assert.equal(entry(value, 'shortcut').kind, 'link'); assert.equal(entry(value, 'shortcut/private.txt'), undefined);
  await assert.rejects(f.engine.resolveEntry(id, entry(value, 'shortcut').id));
  const other = await f.engine.connect(outside);
  await assert.rejects(f.engine.resolveEntry(id, other.entries[0].id));
  assert.throws(() => f.engine.savePositions(id, [{ id: other.entries[0].id, x: 0, y: 0 }]));
  assert.throws(() => f.engine.savePositions(id, [{ id: value.entries[0].id, x: Infinity, y: 0 }]));
  assert.throws(() => f.engine.saveView(id, '', { x: 0, y: 0, zoom: 0 }));
  await rm(path.join(f.root, 'sub'), { recursive: true }); await symlink(outside, path.join(f.root, 'sub'));
  await assert.rejects(f.engine.resolveEntry(id, entry(value, 'sub/private.txt').id));
});
test('new files receive free positions without shifting already indexed cards', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'z.txt'), 'z');
  const value = await f.engine.connect(f.root), id = value.workspace.id, original = entry(value, 'z.txt');
  assert.equal(original.x, 0); assert.equal(original.y, 0);
  await writeFile(path.join(f.root, 'a.txt'), 'a'); await f.engine.scan(id);
  const updated = f.engine.snapshot(id); assert.equal(entry(updated, 'z.txt').x, original.x);
  assert.notEqual(entry(updated, 'a.txt').x, original.x);
});
