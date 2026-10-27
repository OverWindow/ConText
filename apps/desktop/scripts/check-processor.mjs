import { readFile } from 'node:fs/promises';
import { processorFingerprint } from '../processor/fingerprint.mjs';
import { runProcessor } from '../electron/processor.mjs';

const expected = process.argv[2] || process.platform;
if (expected !== process.platform) throw new Error(`${expected}용 파서는 해당 OS에서 빌드해야 합니다. 현재 OS: ${process.platform}`);
let manifest;
try { manifest = JSON.parse(await readFile(new URL('../processor/dist/context-processor/manifest.json', import.meta.url), 'utf8')); }
catch { throw new Error('문서 파서를 먼저 빌드해 주세요: npm run processor:build'); }
if (manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.source_sha256 !== processorFingerprint()) throw new Error('현재 OS·아키텍처·소스와 맞는 문서 파서가 필요합니다. npm run processor:build를 다시 실행해 주세요.');
for (const filename of ['NanumGothic-LICENSE.txt', 'THIRD_PARTY_NOTICES.txt']) if (!(await readFile(new URL('../processor/dist/context-processor/' + filename, import.meta.url), 'utf8')).trim()) throw new Error('문서 파서의 라이선스 고지가 없습니다.');
const info = await runProcessor({ operation: 'info' });
if (info.schema_version !== 1 || !['txt', 'md', 'pdf', 'docx', 'hwpx'].every(format => info.parse.includes(format) && info.export.includes(format))) throw new Error('문서 파서의 계약을 확인하지 못했습니다.');
process.stdout.write(`Document processor verified: ${manifest.platform}/${manifest.arch}\n`);
