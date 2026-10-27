import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { folderFrame, spatialEntries, spatialLayout, storedPosition, referenceScene } from '../src/spatial-layout.ts';
import { WorkspaceEngine } from '../electron/engine.mjs';

const entry = (id, name, parent = '', kind = 'file', x = 0, y = 0) => ({ id, name, parent_path: parent, relative_path: parent ? `${parent}/${name}` : name, kind, x, y });

test('folder regions nest saved local positions without rewriting files and avoid legacy card overlaps', () => {
  const entries = [entry('root', 'root.md'), entry('folder', '자료', '', 'directory'), entry('a', 'A.md', '자료', 'file', -80, 35), entry('nested', '이전', '자료', 'directory', 255), entry('b', 'B.md', '자료/이전', 'file', 60, 90)];
  const before = JSON.stringify(entries), layout = spatialLayout(entries, new Map());
  assert.equal(JSON.stringify(entries), before);
  const folder = layout.placements.get('folder'), a = layout.placements.get('a'), b = layout.placements.get('b');
  assert.ok(folder.world.x >= 200 || folder.world.y >= 290, 'folder packing avoids the existing root file in either direction');
  assert.equal(a.parentId, 'folder'); assert.equal(b.parentId, 'nested');
  assert.deepEqual(storedPosition(layout, a.entry, a.position), { id: 'a', x: -80, y: 35 });
  assert.deepEqual(storedPosition(layout, b.entry, b.position), { id: 'b', x: 60, y: 90 });
  assert.ok(a.world.x >= folder.world.x && a.world.y >= folder.world.y);
  assert.ok(a.world.x + a.width <= folder.world.x + folder.width);
  const moved = spatialLayout(entries.map(e => e.id === 'folder' ? { ...e, x: 800, y: 900, area_positioned: true } : e), new Map());
  assert.equal(storedPosition(moved, moved.placements.get('folder').entry, moved.placements.get('folder').position).x, 800);
  assert.equal(moved.placements.get('b').world.x - b.world.x, (800 - folder.anchor.x) * layout.scopes.get('').scale);
  assert.deepEqual(storedPosition(moved, moved.placements.get('b').entry, moved.placements.get('b').position), { id: 'b', x: 60, y: 90 });
  const fixed = entries.map(e => e.id === 'folder' ? { ...e, x: 800, y: 900, area_positioned: true } : e.id === 'nested' ? { ...e, area_positioned: true } : e);
  const negative = spatialLayout(fixed.map(e => e.id === 'a' ? { ...e, x: -250 } : e), new Map());
  assert.deepEqual(storedPosition(negative, negative.placements.get('a').entry, negative.placements.get('a').position), { id: 'a', x: -250, y: 35 });
  assert.deepEqual(storedPosition(negative, negative.placements.get('b').entry, negative.placements.get('b').position), { id: 'b', x: 60, y: 90 });
});

test('automatic regions form compact rows while manual areas and file coordinates stay fixed', () => {
  const entries = Array.from({ length: 9 }, (_, i) => entry(`folder-${i}`, `자료 ${i}`, '', 'directory', i * 3000, i * 1200));
  const original = JSON.stringify(entries), layout = spatialLayout(entries, new Map());
  assert.equal(JSON.stringify(entries), original);
  assert.ok(layout.bounds.width < 1500 && layout.bounds.height < 1700, 'nine regions should fit into a nearby grid');
  const regions = [...layout.placements.values()];
  assert.ok(new Set(regions.map(region => region.world.y)).size > 1, 'folders wrap to another row');
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const a = regions[i], b = regions[j];
    assert.ok(a.world.x + a.width + 48 <= b.world.x || b.world.x + b.width + 48 <= a.world.x || a.world.y + a.height + 48 <= b.world.y || b.world.y + b.height + 48 <= a.world.y);
  }
  const manual = { ...entry('manual', '직접 배치', '', 'directory', 4200, 2400), area_positioned: true };
  const child = entry('child', 'A.md', '직접 배치', 'file', 90, 35);
  const mixed = [...entries, manual, child], kept = spatialLayout(mixed, new Map());
  assert.deepEqual(kept.placements.get('manual').anchor, { x: 4200, y: 2400 });
  const compact = spatialLayout(mixed, new Map(), '');
  assert.ok(compact.placements.get('manual').anchor.x < 2000);
  const nested = compact.placements.get('child');
  assert.deepEqual(storedPosition(compact, child, nested.position), { id: 'child', x: 90, y: 35 });
});

test('mixed siblings share representative dimensions and scale geometry without changing canonical coordinates', () => {
  const name = '매우긴이름의프로젝트자료와회의기록'.repeat(5);
  const entries = [entry('folder', name, '', 'directory'), entry('a', 'A.md', '', 'file', 255, -35), entry('b', 'B.md', '', 'file', 510, 0), entry('inside', '기록.md', name, 'file', 50, 20)];
  const note = { id: 'note', kind: 'text', text: '원본 메모', x: -20, y: 350, width: 320, height: 140 };
  const original = JSON.stringify({ entries, note }), layout = spatialLayout(entries, new Map([['', [note]]]));
  const scope = layout.scopes.get(''), frame = folderFrame([name]);
  assert.ok(frame.width > 400, 'long names reserve enough label space');
  assert.equal(scope.scale, frame.width / 200);
  const a = layout.placements.get('a'), b = layout.placements.get('b');
  assert.equal(a.width, frame.width); assert.equal(a.height, frame.height);
  assert.ok(a.world.x + a.width < b.world.x);
  assert.deepEqual(storedPosition(layout, a.entry, a.position), { id: 'a', x: 255, y: -35 });
  assert.equal(layout.scopes.get(name).scale, 1, 'file-only folders retain the normal card size');
  assert.deepEqual(storedPosition(layout, entries[3], layout.placements.get('inside').position), { id: 'inside', x: 50, y: 20 });
  assert.equal(JSON.stringify({ entries, note }), original);
});

test('bounded inventory includes ancestors first and scoped notes remain inside the right region', () => {
  const entries = [entry('child', 'A.md', '자료'), entry('folder', '자료', '', 'directory'), entry('root', 'B.md')];
  assert.deepEqual(spatialEntries(entries, 2).map(e => e.id), ['folder', 'root']);
  assert.deepEqual(spatialEntries(entries, 3).map(e => e.id), ['folder', 'root', 'child']);
  const layout = spatialLayout(entries, new Map([['자료', [{ x: -200, y: -300, width: 900, height: 600 }]]]));
  const folder = layout.placements.get('folder'), scope = layout.scopes.get('자료');
  assert.ok(scope.origin.x - 200 > folder.world.x);
  assert.ok(scope.origin.y - 300 > folder.world.y);
  assert.ok(scope.origin.x + 700 <= folder.world.x + folder.width);
  const crowded = [...Array.from({ length: 250 }, (_, i) => entry(`root-${i}`, `${i}.md`)), ...entries];
  const focused = spatialEntries(crowded, 200, '자료');
  assert.equal(focused.length, 200); assert.ok(focused.some(e => e.id === 'folder')); assert.ok(focused.some(e => e.id === 'child'));
  assert.ok(focused.findIndex(e => e.id === 'folder') < focused.findIndex(e => e.id === 'child'));
});

test('moving a folder retains its full content size and its hidden child coordinates', () => {
  const entries = [entry('folder', '폴더', '', 'directory'), ...Array.from({ length: 20 }, (_, i) => entry(`file-${i}`, `${i}.md`, '폴더', 'file', i % 4 * 255, Math.floor(i / 4) * 335))];
  const original = spatialLayout(entries, new Map());
  const moved = spatialLayout(entries.map(e => e.id === 'folder' ? { ...e, x: 720, y: 500, area_positioned: true } : e), new Map());
  const folder = moved.placements.get('folder'), before = original.placements.get('folder');
  assert.equal(folder.width, before.width); assert.equal(folder.height, before.height);
  assert.equal(folder.width, 1093); assert.equal(folder.height, 793);
  assert.ok(moved.scopes.get('폴더').scale < 1, 'fit contents inside the eight-item frame');
  const last = entries.at(-1), placement = moved.placements.get(last.id);
  assert.deepEqual(storedPosition(moved, last, placement.position), { id: last.id, x: last.x, y: last.y });
  assert.equal(placement.world.x - original.placements.get(last.id).world.x, 720 - before.anchor.x);
  assert.equal(placement.world.y - original.placements.get(last.id).world.y, 500 - before.anchor.y);
});

test('explicit region placement survives restart and disconnect cleans only its device metadata', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-spatial-engine-'));
  let engine;
  try {
    const root = path.join(base, '원본'); await mkdir(path.join(root, '자료'), { recursive: true });
    await writeFile(path.join(root, '자료', 'A.md'), '보존할 원본');
    const data = path.join(base, 'data'); engine = await new WorkspaceEngine(data).init({ watchFiles: false });
    const snapshot = await engine.connect(root), id = snapshot.workspace.id;
    const folder = snapshot.entries.find(e => e.kind === 'directory'), file = snapshot.entries.find(e => e.kind === 'file');
    assert.equal(folder.area_positioned, 0);
    engine.savePositions(id, [{ id: folder.id, x: 720, y: 600 }]);
    engine.saveView(id, ':spatial:', { x: -300, y: -200, zoom: .6, focus_directory: '자료' });
    assert.throws(() => engine.saveView(id, ':spatial:', { x: 0, y: 0, zoom: .6, focus_directory: '../다른 폴더' }));
    engine.saveView(id, ':spatial:compact', { x: -120, y: -80, zoom: .7, focus_directory: '자료' });
    engine.saveView(id, ':spatial:readable', { x: -20_000_000_000, y: -400, zoom: 16, focus_directory: '자료', editing: true });
    assert.equal(engine.snapshot(id).views.find(view => view.directory === ':spatial:readable')?.zoom, 16);
    engine.saveView(id, ':spatial:readable', { x: -1_500_000, y: -40, zoom: .8, focus_directory: '자료', editing: true });
    assert.throws(() => engine.saveView(id, ':spatial:readable', { x: 2_000_000_000_000, y: 0, zoom: 16 }));
    assert.throws(() => engine.saveView(id, ':spatial:readable', { x: Infinity, y: 0, zoom: .8 }));
    await engine.close(); engine = await new WorkspaceEngine(data).init({ watchFiles: false });
    const after = engine.snapshot(id), stored = after.entries.find(e => e.id === folder.id);
    assert.equal(stored.area_positioned, 1); assert.equal(stored.x, 720); assert.equal(stored.y, 600);
    assert.equal(after.spatial_focus, '자료');
    assert.equal(after.spatial_editing, true);
    assert.equal(after.views.find(view => view.directory === ':spatial:compact')?.zoom, .7);
    assert.equal(after.views.find(view => view.directory === ':spatial:readable')?.zoom, .8);
    assert.equal(after.views.find(view => view.directory === ':spatial:readable')?.x, -1_500_000);
    assert.equal(after.entries.find(e => e.id === file.id).x, file.x);
    await rename(path.join(root, '자료'), path.join(root, '바뀐 자료')); await engine.scan(id);
    assert.equal(engine.snapshot(id).spatial_focus, '바뀐 자료');
    await engine.disconnect(id);
    assert.equal(engine.db.prepare("SELECT count(*) AS n FROM local_settings WHERE key LIKE 'folder-area:%'").get().n, 0);
    assert.equal(engine.db.prepare("SELECT count(*) AS n FROM local_settings WHERE key LIKE 'spatial-focus:%'").get().n, 0);
    assert.equal(engine.db.prepare("SELECT count(*) AS n FROM local_settings WHERE key LIKE 'spatial-editing:%'").get().n, 0);
  } finally { if (engine && !engine.closed) await engine.close(); await rm(base, { recursive: true, force: true }); }
});


test('reference scenes preserve all existing geometry and add only missing cited files and their ancestors', () => {
  const inventory = [...Array.from({ length: 210 }, (_, i) => entry(`root-${i}`, `${i}.md`, '', 'file', i % 4 * 255, Math.floor(i / 4) * 335)),
    entry('folder', '멀리 있는 폴더', '', 'directory', 600, 1200), entry('nested', '안쪽', '멀리 있는 폴더', 'directory'), entry('target', '인용.md', '멀리 있는 폴더/안쪽', 'file', 60, 35)];
  const visible = spatialEntries(inventory, 200), elements = new Map(), base = spatialLayout(visible, elements), original = JSON.stringify(inventory);
  const scene = referenceScene(visible, base, inventory, ['target', 'root-205'], elements);
  assert.equal(scene.entries.length, 204);
  assert.equal(scene.entries.filter(row => visible.some(old => old.id === row.id)).length, 200);
  for (const [id, before] of base.placements) assert.deepEqual(scene.layout.placements.get(id), before);
  assert.deepEqual(scene.entries.slice(-4).map(row => row.id), ['root-205', 'folder', 'nested', 'target']);
  const target = scene.layout.placements.get('target'), parent = scene.layout.scopes.get('멀리 있는 폴더/안쪽');
  assert.equal(target.parentId, 'nested');
  assert.equal(target.width, 200); assert.equal(target.height, 290); assert.equal(parent.scale, 1);
  assert.equal(scene.layout.placements.get('root-205').height, 290);
  assert.equal(target.world.x, parent.origin.x + 60 * parent.scale);
  assert.equal(target.world.y, parent.origin.y + 35 * parent.scale);
  assert.equal(JSON.stringify(inventory), original);
  assert.equal(referenceScene(visible, base, inventory, ['root-0'], elements).layout, base);
});

test('adding a reference to an existing folder keeps its box, sibling file size and scoped notes in place', () => {
  const inventory = [entry('folder', '자료', '', 'directory'), entry('neighbor', '주변.md', '', 'file', 255, 0), entry('target', '인용.md', '자료', 'file', -20, 100)];
  const elements = new Map([['자료', [{ kind: 'text', x: -50, y: 350, width: 320, height: 100 }]]]);
  const base = spatialLayout(inventory.slice(0, 2), elements), scene = referenceScene(inventory.slice(0, 2), base, inventory, ['target'], elements);
  for (const [id, before] of base.placements) assert.deepEqual(scene.layout.placements.get(id), before);
  assert.deepEqual(scene.layout.scopes.get('자료'), base.scopes.get('자료'));
  const target = scene.layout.placements.get('target'), scope = base.scopes.get('자료');
  assert.equal(target.world.x, scope.origin.x - 20 * scope.scale);
  assert.equal(target.position.y, scope.inset.y + 100 * scope.scale);
});


test('eight direct children cap the frame, shrink descendants and preserve coordinate round trips', () => {
  for (const count of [0, 7, 8, 9, 32]) {
    const children = Array.from({ length: count }, (_, i) => entry(`file-${i}`, `${i}.md`, '묶음', 'file', i % 4 * 255, Math.floor(i / 4) * 335));
    const inventory = [entry('folder', '묶음', '', 'directory'), ...children];
    const result = spatialLayout(inventory, new Map());
    const box = result.placements.get('folder');
    assert.ok(box.width <= 1093 && box.height <= 793);
    if (count >= 8) { assert.equal(box.width, 1093); assert.equal(box.height, 793); }
    for (const child of children) {
      const p = result.placements.get(child.id);
      assert.ok(p.world.x >= box.world.x && p.world.y >= box.world.y);
      assert.ok(p.world.x + p.width <= box.world.x + box.width + .001);
      assert.ok(p.world.y + p.height <= box.world.y + box.height + .001);
      assert.deepEqual(storedPosition(result, child, p.position), { id: child.id, x: child.x, y: child.y });
      const moved = storedPosition(result, child, { x: p.position.x + 25, y: p.position.y + 10 });
      assert.ok(Math.abs((moved.x - child.x) * result.scopes.get('묶음').scale - 25) < 1e-8);
    }
    if (count >= 8) {
      const partial = spatialLayout(inventory.slice(0, 3), new Map(), undefined, inventory);
      assert.equal(partial.placements.get('folder').width, 1093);
      assert.equal(partial.placements.get('folder').height, 793);
    }
  }
});

test('nested folders count as direct children and inherit cumulative scaling', () => {
  const inventory = [entry('parent', '부모', '', 'directory'),
    ...Array.from({ length: 8 }, (_, i) => entry(`dir-${i}`, `하위${i}`, '부모', 'directory')),
    ...Array.from({ length: 32 }, (_, i) => entry(`file-${i}`, `${i}.md`, '부모/하위0', 'file', i % 4 * 255, Math.floor(i / 4) * 335))];
  const result = spatialLayout(inventory, new Map());
  assert.equal(result.placements.get('parent').width, 1093);
  for (const item of inventory) {
    const p = result.placements.get(item.id);
    const point = storedPosition(result, item, p.position);
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    if (item.kind === 'file') { assert.equal(point.x, item.x); assert.equal(point.y, item.y); }
    if (p.parentId) {
      const parent = result.placements.get(p.parentId);
      assert.ok(p.world.x >= parent.world.x - .001 && p.world.y >= parent.world.y - .001);
      assert.ok(p.world.x + p.width <= parent.world.x + parent.width + .001);
      assert.ok(p.world.y + p.height <= parent.world.y + parent.height + .001);
    }
  }
});
