import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const modules = new Map();
for (const name of await readdir(path.join(root, 'packages'))) {
  const directory = path.join(root, 'packages', name);
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  modules.set(manifest.name, { directory, manifest });
}
async function files(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...await files(filename));
    else if (/\.(?:mjs|cjs|tsx?|css)$/.test(filename)) result.push(filename);
  }
  return result;
}
let checked = 0;
for (const consumer of ['apps/desktop', 'apps/server', 'frontend']) {
  const base = path.join(root, consumer), manifest = JSON.parse(await readFile(path.join(base, 'package.json'), 'utf8'));
  const sourceFolders = consumer === 'frontend' ? ['app', 'features', 'lib', 'shared', 'design'] : consumer === 'apps/server' ? ['src'] : ['src', 'electron'];
  for (const folder of sourceFolders) for (const filename of await files(path.join(base, folder))) {
    const source = await readFile(filename, 'utf8'); checked++;
    const imports = source.matchAll(/\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g);
    for (const [, specifier] of imports) {
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(filename), specifier);
        if (!target.startsWith(base + path.sep)) throw new Error(`Cross-boundary relative import in ${path.relative(root, filename)}: ${specifier}`);
      } else if (specifier.startsWith('@context/')) {
        const name = specifier.split('/').slice(0, 2).join('/'), library = modules.get(name);
        const declared = manifest.dependencies?.[name] || (consumer === 'apps/desktop' && manifest.devDependencies?.[name]);
        if (!library || !declared) throw new Error(`Undeclared workspace dependency in ${consumer}: ${name}`);
        const subpath = specifier.slice(name.length), exports = library.manifest.exports;
        const target = typeof exports === 'string' ? subpath ? undefined : exports : exports[subpath ? '.' + subpath : '.'];
        if (!target) throw new Error(`Private package import in ${path.relative(root, filename)}: ${specifier}`);
        await readFile(path.join(library.directory, target));
      }
    }
  }
}
process.stdout.write(`Workspace boundaries verified across ${checked} source files and ${modules.size} packages.\n`);
