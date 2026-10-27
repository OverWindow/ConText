import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unifiedBuildInputs, assertCurrentBuildInputs } from '../../../scripts/unified-build-inputs.mjs';

const desktop = fileURLToPath(new URL('..', import.meta.url)), root = path.resolve(desktop, '../..');
const before = await unifiedBuildInputs(root);
const run = (script, args = [], cwd = root) => execFileSync(process.execPath, [path.join(root, script), ...args], { cwd, stdio: 'inherit' });
run('scripts/check-workspace-boundaries.mjs');
run('scripts/generate-worker-contracts.mjs', ['--check']);
run('scripts/build-unified-core.mjs');
run('apps/desktop/node_modules/typescript/bin/tsc', ['--noEmit'], desktop);
run('apps/desktop/node_modules/vite/bin/vite.js', ['build'], desktop);
assertCurrentBuildInputs(before, await unifiedBuildInputs(root));
await writeFile(path.join(desktop, 'dist/build-inputs.json'), JSON.stringify(before, null, 2) + '\n');
