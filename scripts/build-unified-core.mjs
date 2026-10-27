import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'apps/desktop/core');
mkdirSync(output, { recursive: true });
const config = {
  compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    skipLibCheck: true, rewriteRelativeImportExtensions: true, declaration: true,
    rootDir: path.join(root, 'packages'), outDir: output, noEmitOnError: true,
  },
  files: ['contracts', 'domain', 'sync-client'].map(name => path.join(root, 'packages', name, 'src/index.ts')).filter(existsSync),
};
const configFile = path.join(output, 'tsconfig.build.json');
writeFileSync(configFile, JSON.stringify(config, null, 2));
const compiler = [path.join(root, 'node_modules/typescript/bin/tsc'), path.join(root, 'apps/desktop/node_modules/typescript/bin/tsc')].find(existsSync);
if (!compiler) throw new Error('TypeScript build dependencies must be installed.');
execFileSync(process.execPath, [compiler, '-p', configFile], { cwd: root, stdio: 'inherit' });
