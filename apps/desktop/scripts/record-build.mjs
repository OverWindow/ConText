import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('..', import.meta.url)), root = path.resolve(desktop, '../..');
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(filename)); else if (entry.isFile()) result.push(filename);
  }
  return result.sort();
}
async function digest(paths) {
  const hash = createHash('sha256');
  for (const filename of [...paths].sort()) { hash.update(path.relative(root, filename)); hash.update(await readFile(filename)); }
  return hash.digest('hex');
}
const source = [path.join(desktop, 'package.json'), ...await files(path.join(desktop, 'electron')), ...await files(path.join(desktop, 'src')), ...await files(path.join(root, 'frontend/shared')), ...await files(path.join(root, 'frontend/design'))];
const processor = JSON.parse(await readFile(path.join(desktop, 'processor/dist/context-processor/manifest.json'), 'utf8'));
const packageFile = process.argv[2];
if (!packageFile || !path.isAbsolute(packageFile)) throw new Error('패키징한 app.asar의 절대 경로를 지정해 주세요.');
const packageHash = createHash('sha256').update(await readFile(packageFile)).digest('hex');
const value = { verified_at: new Date().toISOString(), platform: process.platform, arch: process.arch,
  source_tree_sha256: await digest(source), renderer_sha256: await digest(await files(path.join(desktop, 'dist'))), app_asar_sha256: packageHash,
  processor, source_files: source.map(filename => path.relative(root, filename)).sort(), note: 'Unsigned development build; validation commands and external setup limits are documented in docs/desktop-web-parity-verification.md.' };
await mkdir(path.join(desktop, 'release'), { recursive: true });
await writeFile(path.join(desktop, 'release/parity-build.json'), JSON.stringify(value, null, 2) + '\n');
process.stdout.write(JSON.stringify({ source_tree_sha256: value.source_tree_sha256, app_asar_sha256: value.app_asar_sha256 }) + '\n');
