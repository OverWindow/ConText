import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { processorFingerprint } from './fingerprint.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.CONTEXT_PROCESSOR_PYTHON || path.join(here, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const args = ['-m', 'PyInstaller', '--noconfirm', '--clean', '--name', 'context-processor', '--onedir',
  '--distpath', path.join(here, 'dist'), '--workpath', path.join(here, 'build'), '--specpath', path.join(here, 'build'),
  '--paths', path.resolve(here, '../../../backend'), '--collect-data', 'docx', '--collect-all', 'hwpx', '--collect-data', 'reportlab'];
const font = path.join(here, 'assets', 'NanumGothic.ttf');
if (existsSync(font)) args.push('--add-data', `${font}${path.delimiter}.`);
args.push(path.join(here, 'main.py'));
const result = spawnSync(python, args, { stdio: 'inherit', env: { ...process.env, PYINSTALLER_CONFIG_DIR: path.join(here, 'build', 'cache') } });
if (result.error) throw new Error('문서 처리 빌드용 Python 환경이 필요합니다. processor/requirements.txt를 설치하고 CONTEXT_PROCESSOR_PYTHON을 지정해 주세요.');
if (result.status === 0) {
  const output = path.join(here, 'dist/context-processor');
  writeFileSync(path.join(output, 'NanumGothic-LICENSE.txt'), readFileSync(path.join(here, 'assets/NanumGothic-LICENSE.txt')));
  const notices = spawnSync(python, [path.join(here, 'notices.py'), path.join(output, 'THIRD_PARTY_NOTICES.txt')], { stdio: 'inherit' });
  if (notices.status !== 0) throw new Error('문서 파서의 라이선스 고지를 준비하지 못했습니다.');
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ platform: process.platform, arch: process.arch, source_sha256: processorFingerprint(), built_at: new Date().toISOString() }, null, 2));
}
process.exit(result.status ?? 1);
