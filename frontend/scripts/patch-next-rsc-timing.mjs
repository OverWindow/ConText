/**
 * Next 16.4.3 bundles React's unguarded errored/aborted RSC timing paths.
 * https://github.com/react/react/issues/37561
 * Apply the same nonnegative-end check used by the normal rendering path.
 * This affects development profiling only; authentication/errors stay intact.
 */
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
export const clients = ['react-server-dom-turbopack', 'react-server-dom-turbopack-experimental', 'react-server-dom-webpack', 'react-server-dom-webpack-experimental'];
export function patchTimingSource(source, filename = 'RSC client') {
  const sites = [
    { pattern: /(error = root\.reason;\s+if \()(supportsUserTiming(?: && 0 <= childrenEndTime\$jscomp\$1)?)(\) \{)/g, end: 'childrenEndTime$jscomp$1' },
    { pattern: /(childrenEndTime\$jscomp\$3 = childrenEndTime;\s+if \()(supportsUserTiming(?: && 0 <= childrenEndTime\$jscomp\$3)?)(\) \{)/g, end: 'childrenEndTime$jscomp$3' },
  ];
  for (const { pattern, end } of sites) {
    let found = 0;
    source = source.replace(pattern, (_match, before, _condition, after) => { found++; return `${before}supportsUserTiming && 0 <= ${end}${after}`; });
    if (found !== 1) throw new Error(`${filename}: expected one timing guard for ${end}, found ${found}. Review the workaround against the installed Next.js source.`);
  }
  return source;
}
export async function patchNextTiming() {
  const nextRoot = path.dirname(require.resolve('next/package.json'));
  const { version } = JSON.parse(await readFile(path.join(nextRoot, 'package.json'), 'utf8'));
  if (version !== '16.4.3') throw new Error(`Next.js ${version}: review/remove the RSC timing workaround before upgrading from 16.4.3.`);
  // Validate every target before writing any of them.
  const changes = [];
  for (const client of clients) {
    const name = client.replace('-experimental', '');
    const filename = path.join(nextRoot, 'dist/compiled', client, 'cjs', `${name}-client.browser.development.js`);
    const source = await readFile(filename, 'utf8'), patched = patchTimingSource(source, client);
    if (source !== patched) changes.push({ filename, patched });
  }
  for (const { filename, patched } of changes) await writeFile(filename, patched);
  if (changes.length) await rm(path.join(root, '.next/dev/cache'), { recursive: true, force: true });
  return changes.length;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`RSC development timing guards verified (${await patchNextTiming()} clients updated).`);
}
