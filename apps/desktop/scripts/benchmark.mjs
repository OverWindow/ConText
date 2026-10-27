import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { WorkspaceEngine } from '../electron/engine.mjs';

const base = await mkdtemp(path.join(os.tmpdir(), 'context-parity-benchmark-'));
const root = path.join(base, '한글 자료'); await mkdir(root);
let engine;
try {
  for (let i = 0; i < 20; i++) {
    const directory = path.join(root, `폴더 ${i}`); await mkdir(directory);
    for (let j = 0; j < 100; j += 25) await Promise.all(Array.from({ length: 25 }, (_, n) => writeFile(path.join(directory, `자료 ${j + n}.dat`), 'metadata only')));
  }
  for (let i = 0; i < 12; i++) await writeFile(path.join(root, `문서 ${i}.md`), `# 문서 ${i}\n\n` + Array.from({ length: 400 }, (_, n) => `프로젝트 ${i}의 한글 예산 자료 ${n}: 비용은 ${n * 10}만원이며 회의에서 검토합니다.`).join('\n\n'));
  engine = await new WorkspaceEngine(path.join(base, 'data')).init({ watchFiles: false });
  let start = performance.now(); const workspace = (await engine.connect(root)).workspace.id;
  const scan_ms = performance.now() - start, inventory = engine.snapshot(workspace);
  const events = []; engine.on('changed', (_id, update) => { if (update?.indexing) events.push(JSON.stringify(update).length); });
  start = performance.now(); await engine.documents.indexWorkspace(workspace);
  const initial_index_ms = performance.now() - start;
  start = performance.now(); const results = engine.searchContent(workspace, '예산 자료 37');
  const search_ms = performance.now() - start;
  await engine.close(); engine = await new WorkspaceEngine(path.join(base, 'data')).init({ watchFiles: false });
  start = performance.now(); await engine.documents.indexWorkspace(workspace);
  const unchanged_index_ms = performance.now() - start;
  const result = { files: inventory.entries.filter(e => e.kind === 'file').length, folders: 20, indexed_versions: engine.db.prepare('SELECT count(*) AS n FROM local_versions').get().n,
    blocks: engine.db.prepare('SELECT count(*) AS n FROM local_search').get().n, search_results: results.length,
    scan_ms: Math.round(scan_ms), initial_index_ms: Math.round(initial_index_ms), search_ms: Math.round(search_ms), unchanged_index_ms: Math.round(unchanged_index_ms),
    progress_events: events.length, largest_progress_bytes: Math.max(...events, 0), metadata_bytes: Buffer.byteLength(JSON.stringify(inventory)) };
  if (result.files !== 2012 || result.indexed_versions !== 12 || !results.length) throw new Error('Benchmark data verification failed');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally { if (engine && !engine.closed) await engine.close(); await rm(base, { recursive: true, force: true }); }
