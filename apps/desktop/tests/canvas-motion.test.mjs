import test from 'node:test';
import assert from 'node:assert/strict';
import { planInsertion } from '../../../frontend/shared/canvas/local-placement.ts';
import { folderVisibility } from '../../../frontend/shared/canvas/folder-visibility.ts';
import { spatialLayout } from '../src/spatial-layout.ts';

const box = (id, x, y = 0, width = 200, height = 290) => ({ id, x, y, width, height });
const overlap = (a, b) => a.x < b.x + b.width + 23.999 && a.x + a.width + 23.999 > b.x && a.y < b.y + b.height + 23.999 && a.y + a.height + 23.999 > b.y;
test('insertion opens a horizontal gap with bounded motion and keeps distant rows fixed', () => {
  const siblings = [box('left', 0), box('right', 400), box('far', 900), box('below', 200, 500)];
  const original = JSON.stringify(siblings), incoming = box('new', 200), plan = planInsertion(incoming, siblings);
  assert.equal(plan.fallback, false); assert.ok(plan.shifts.length > 0);
  for (const shift of plan.shifts) {
    assert.equal(shift.after.y, shift.before.y);
    assert.ok(Math.abs(shift.after.x - shift.before.x) <= 160);
    assert.ok(['left', 'right'].includes(shift.id));
  }
  const placed = siblings.map(item => ({ ...item, ...plan.shifts.find(s => s.id === item.id)?.after }));
  assert.ok(placed.every(item => !overlap({ ...incoming, ...plan.position }, item)));
  assert.equal(JSON.stringify(siblings), original);
  assert.deepEqual(planInsertion(incoming, siblings), plan);
});
test('crowded insertion moves only the incoming box and never propagates beyond eight neighbors', () => {
  const siblings = Array.from({ length: 20 }, (_, i) => box(String(i), i * 224));
  const incoming = box('new', 2200, 0, 320, 240), plan = planInsertion(incoming, siblings);
  assert.equal(plan.fallback, true); assert.deepEqual(plan.shifts, []);
  assert.ok(siblings.every(item => !overlap({ ...incoming, ...plan.position }, item)));
  const undo = planInsertion(incoming, siblings, false);
  assert.deepEqual(undo.shifts, []);
});
test('insertion preserves unrelated pre-existing overlaps and avoids pushing into a different row', () => {
  const siblings = [box('a', 0), box('b', 0), box('target', 1000), box('adjacent-row', 1230, 290)];
  const plan = planInsertion(box('new', 1000, -20), siblings);
  assert.ok(plan.shifts.every(shift => !['a', 'b', 'adjacent-row'].includes(shift.id)));
});
test('folders reveal independently with hysteresis, inherited scale and reachable deep zoom', () => {
  const folders = [{ id: 'outer', scale: 1 }, { id: 'inner', parentId: 'outer', scale: .2 }, { id: 'deep', parentId: 'inner', scale: .04 }];
  const far = folderVisibility(folders, .3);
  assert.equal(far.hidden('outer'), true); assert.equal(far.hidden('inner'), true);
  const outer = folderVisibility(folders, .55);
  assert.equal(outer.hidden('outer'), false); assert.equal(outer.hidden('inner'), true);
  assert.ok(outer.maxZoom >= 10);
  assert.equal(folderVisibility(folders, .38, outer.opened).opened.has('outer'), true);
  assert.equal(folderVisibility(folders, .34, outer.opened).opened.has('outer'), false);
  const inner = folderVisibility(folders, 2.75);
  assert.equal(inner.hidden('inner'), false); assert.equal(inner.hidden('deep'), true);
  assert.ok(inner.maxZoom >= 50);
  assert.equal(folderVisibility(folders, 13.75).hidden('deep'), false);
  assert.equal(folderVisibility(folders, .1, new Set(), new Set(['outer', 'inner', 'deep'])).hidden('deep'), false);
});
test('text overlays do not resize or repack physical folders', () => {
  const entries = [{ id: 'folder', name: '자료', relative_path: '자료', parent_path: '', kind: 'directory', x: 0, y: 0 }, { id: 'file', name: 'A.md', relative_path: '자료/A.md', parent_path: '자료', kind: 'file', x: 40, y: 40 }];
  const before = spatialLayout(entries, new Map());
  const after = spatialLayout(entries, new Map([['', [{ kind: 'text', x: -1000, y: -1000, width: 2000, height: 140 }]], ['자료', [{ kind: 'text', x: -200, y: -300, width: 2000, height: 140 }]]]));
  assert.deepEqual(after.placements, before.placements);
  assert.deepEqual(after.bounds, before.bounds);
});

test('bounded insertion keeps displaced children inside their parent area', () => {
  const siblings = [box('left', 440), box('right', 840)];
  const bounds = { x: 424, y: 0, width: 1952, height: 1952 };
  const plan = planInsertion(box('new', 600), siblings, true, bounds);
  for (const shift of plan.shifts) assert.ok(shift.after.x >= bounds.x);
  assert.ok(plan.position.x >= bounds.x);
});

test('zoom remains available after opening a deep folder with heavily fitted contents', () => {
  const result = folderVisibility([{ id: 'folder', scale: .1, contentScale: .02 }], 5.5);
  assert.equal(result.maxZoom, 100);
  assert.ok(result.opened.has('folder'));
});
