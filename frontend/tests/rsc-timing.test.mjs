import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { clients, patchTimingSource } from '../scripts/patch-next-rsc-timing.mjs';
const require = createRequire(import.meta.url), nextRoot = path.dirname(require.resolve('next/package.json'));
function runProfile(source, status, start, end) {
  const begin = source.indexOf('    function flushComponentPerformance('), finish = source.indexOf('    function flushInitialRenderPerformance(', begin);
  assert.ok(begin >= 0 && finish > begin);
  const measures = [], reason = new Error('NEXT_REDIRECT');
  const context = {
    isArrayImpl: Array.isArray, supportsUserTiming: true, trackNames: Array.from({ length: 10 }, (_, i) => `track-${i}`),
    performance: { measure(name, options) { if (!Number.isFinite(options.end) || options.end < 0) throw new TypeError(`${name} cannot have a negative time stamp`); measures.push({ name, options }); }, clearMeasures() {} },
    console: { timeStamp() {} },
  };
  const flush = vm.runInNewContext(`${source.slice(begin, finish)}; flushComponentPerformance;`, context);
  const root = { _children: [], _debugInfo: status === 'rejected' ? [{ time: start }, { name: 'Login', env: 'Server' }, { time: end }] : [{ time: end }, { name: 'Login', env: 'Server' }], status, reason };
  flush({ _rootEnvironmentName: 'Server', _closedReason: null }, root, 0, -Infinity, -Infinity);
  assert.equal(root.status, status); assert.equal(root.reason, reason);
  return measures;
}
for (const client of clients) {
  const filename = path.join(nextRoot, 'dist/compiled', client, 'cjs', `${client.replace('-experimental', '')}-client.browser.development.js`);
  const source = await readFile(filename, 'utf8');
  for (const status of ['rejected', 'pending']) for (const end of [-Infinity, -10]) {
    test(`${client}: ${status} Login skips invalid end ${end}`, () => { assert.deepEqual(runProfile(source, status, -20, end), []); });
  }
  for (const status of ['rejected', 'pending']) test(`${client}: valid ${status} timings and redirect reason remain intact`, () => {
    const measures = runProfile(source, status, 1, 10); assert.equal(measures.length, 1); assert.equal(measures[0].name, '\u200bLogin'); assert.equal(measures[0].options.end, 10);
  });
  test(`${client}: patch is idempotent and rejects unexpected bundle changes`, () => {
    const patched = patchTimingSource(source, client); assert.equal(patchTimingSource(patched, client), patched);
    assert.throws(() => patchTimingSource('unexpected bundle'), /expected one timing guard/);
  });
}
