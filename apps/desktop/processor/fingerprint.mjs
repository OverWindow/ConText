import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function processorFingerprint() {
  const files = ['main.py', 'build.mjs', 'notices.py', 'requirements.lock', 'assets/NanumGothic.ttf', 'assets/NanumGothic-LICENSE.txt', '../../../backend/app/processing/parsers.py', '../../../backend/app/conversion/renderers.py', '../../../backend/app/intelligence/diff.py', '../../../backend/app/writing_format.py', '../../../backend/app/writing_export.py'];
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update(readFileSync(fileURLToPath(new URL(file, import.meta.url)))); }
  return hash.digest('hex');
}
