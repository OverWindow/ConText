import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

async function files(directory, optional = false) {
  let children;
  try { children = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (optional && error.code === 'ENOENT') return []; throw error; }
  const values = [];
  for (const item of children) {
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) values.push(...await files(filename)); else if (item.isFile()) values.push(filename);
  }
  return values;
}

/** Record source inputs when the compiler runs, not when the artifact is inspected. */
export async function unifiedBuildInputs(root) {
  const inputs = ['package.json', 'package-lock.json', 'apps/desktop/package.json', 'apps/desktop/package-lock.json', 'apps/desktop/tsconfig.json', 'apps/desktop/vite.config.ts', 'apps/desktop/scripts/build.mjs', 'scripts/unified-build-inputs.mjs', 'scripts/build-unified-core.mjs', 'scripts/check-workspace-boundaries.mjs', 'scripts/generate-worker-contracts.mjs'].map(file => path.join(root, file));
  for (const folder of ['electron', 'src']) inputs.push(...await files(path.join(root, 'apps/desktop', folder)));
  for (const name of ['contracts', 'domain', 'sync-client', 'workspace-client', 'workspace-ui']) {
    const directory = path.join(root, 'packages', name); inputs.push(path.join(directory, 'package.json'));
    for (const folder of ['src', 'shared', 'assets', 'schema']) inputs.push(...await files(path.join(directory, folder), folder !== 'src'));
  }
  const digest = createHash('sha256'), records = [];
  for (const filename of inputs.sort()) {
    const relative = path.relative(root, filename).split(path.sep).join('/'), bytes = await readFile(filename);
    digest.update(relative); digest.update(bytes);
    records.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { schema_version: 1, source_tree_sha256: digest.digest('hex'), files: records };
}

export function assertCurrentBuildInputs(built, current) {
  if (built.schema_version !== 1 || built.source_tree_sha256 !== current.source_tree_sha256) throw new Error('Desktop build inputs changed. Rebuild and package the current sources.');
}
