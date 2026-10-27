import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import asar from '../apps/desktop/node_modules/@electron/asar/lib/asar.js';
import { spawn } from 'node:child_process';
import { unifiedBuildInputs, assertCurrentBuildInputs } from './unified-build-inputs.mjs';
import { processorFingerprint } from '../apps/desktop/processor/fingerprint.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), desktop = path.join(root, 'apps/desktop');
const archive = path.join(desktop, 'release/mac-arm64/ConText Desktop.app/Contents/Resources/app.asar');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const builtInputs = JSON.parse(await readFile(path.join(desktop, 'dist/build-inputs.json'), 'utf8'));
assertCurrentBuildInputs(builtInputs, await unifiedBuildInputs(root));
async function files(directory) {
  const values = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) values.push(...await files(filename)); else if (item.isFile()) values.push(filename);
  }
  return values.sort();
}
const packaged = asar.listPackage(archive);
for (const name of packaged) if (/(?:^|\/)\.env(?:\.|$)|\.sqlite(?:$|-)|(?:^|\/)ai-connection\.enc$|(?:^|\/)\.aws(?:\/|$)/i.test(name)) throw new Error(`Private data in package: ${name}`);
let verified = 0;
for (const folder of ['electron', 'core', 'dist']) for (const filename of await files(path.join(desktop, folder))) {
  if (filename.endsWith('tsconfig.build.json') || filename.endsWith('.d.ts')) continue;
  const relative = path.relative(desktop, filename).split(path.sep).join('/');
  if (hash(await readFile(filename)) !== hash(asar.extractFile(archive, relative))) throw new Error(`Stale packaged runtime: ${relative}`);
  verified++;
}
const processor = JSON.parse(await readFile(path.join(desktop, 'processor/dist/context-processor/manifest.json'), 'utf8'));
if (processor.source_sha256 !== processorFingerprint()) throw new Error('The frozen processor is stale for the current parser sources.');
const processorRoot = path.join(desktop, 'processor/dist/context-processor');
let verifiedProcessor = 0;
for (const filename of await files(processorRoot)) {
  const relative = path.relative(processorRoot, filename), packaged = path.join(path.dirname(archive), 'context-processor', relative);
  if (hash(await readFile(filename)) !== hash(await readFile(packaged))) throw new Error(`Stale packaged processor: ${relative}`);
  verifiedProcessor++;
}
const manifest = { schema_version: 2, verified_at: new Date().toISOString(), platform: process.platform, arch: process.arch, signed: false,
  source_tree_sha256: builtInputs.source_tree_sha256, asar_sha256: hash(await readFile(archive)), verified_runtime_files: verified,
  verified_source_files: builtInputs.files.length, verified_processor_files: verifiedProcessor, processor };
const zip = path.join(desktop, 'release/ConText-Desktop-unified-mac-arm64.zip');
if (process.argv.includes('--zip')) {
  const zipDigest = await new Promise((resolve, reject) => {
    const checksum = createHash('sha256'), child = spawn('unzip', ['-p', zip, 'ConText Desktop.app/Contents/Resources/app.asar']);
    child.stdout.on('data', bytes => checksum.update(bytes)); child.stderr.resume(); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(checksum.digest('hex')) : reject(new Error('Cannot inspect the ZIP app.asar.')));
  });
  if (zipDigest !== manifest.asar_sha256) throw new Error('The ZIP contains a different app.asar. Recreate the ZIP from the verified app.');
  manifest.zip = { filename: path.basename(zip), size: (await stat(zip)).size, sha256: hash(await readFile(zip)) };
}
await writeFile(path.join(desktop, 'release/unified-build.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(JSON.stringify(manifest) + '\n');
