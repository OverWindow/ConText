import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceEngine } from '../electron/engine.mjs';

test('a real 25001-folder scan and production initial import retain every sibling', { timeout: 180000 }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-real-scale-')), root = path.join(base, '원본'), data = path.join(base, 'app-data');
  await mkdir(root); let engine;
  t.after(async () => { if (engine) await engine.close(); await rm(base, { recursive: true, force: true }); });
  let next = 0;
  await Promise.all(Array.from({ length: 256 }, async () => {
    for (;;) { const n = next++; if (n >= 25001) break; await mkdir(path.join(root, `폴더-${String(n).padStart(5, '0')}`)); }
  }));
  // Default production hooks are deliberate: this exercises the actual scan and automatic migration path.
  engine = await new WorkspaceEngine(data).init({ watchFiles: false }); const snapshot = await engine.connect(root), id = snapshot.workspace.id;
  assert.equal(snapshot.status, 'ready'); assert.equal(snapshot.truncated, false); assert.deepEqual(snapshot.warnings, []); assert.equal(snapshot.entries.length, 25001);
  assert.ok(snapshot.entries.find(entry => entry.name === '폴더-25000'));
  const state = engine.unified.store.state(id); assert.equal(Object.keys(state.entries).length, 25002); assert.equal(Object.values(state.entries).filter(entry => entry.parent_id === state.workspace.root_entry_id).length, 25001);
  assert.equal(engine.db.prepare('SELECT count(*) AS n FROM entries WHERE workspace_id=? AND present=1').get(id).n, 25001);
  const outbox = engine.unified.store.pending(id); assert.equal(outbox.length, 1); assert.equal(outbox[0].command.type, 'ImportWorkspace');
  const last = Object.values(state.entries).find(entry => entry.name === '폴더-25000'); assert.ok(last); assert.ok(last.x !== null && last.y !== null, 'scanner must persist the final entry position as well');
  assert.equal(engine.db.prepare('SELECT count(*) AS n FROM unified_blobs WHERE workspace_id=?').get(id).n, 0, 'empty folders do not fabricate file blobs');
});
