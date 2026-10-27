import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export function runProcessor(request, { resourcesPath, signal } = {}) {
  const executable = path.join(resourcesPath || path.resolve(here, '../processor/dist'), 'context-processor', process.platform === 'win32' ? 'context-processor.exe' : 'context-processor');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal });
    let output = [], bytes = 0, done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('문서 처리 시간이 초과되었습니다.')); }, 60000);
    child.on('error', error => { if (error.name === 'AbortError') { const cancelled = new Error('문서 처리를 중단했습니다.'); cancelled.code = 'CANCELLED'; finish(cancelled); } else finish(new Error('문서 처리 프로그램을 실행하지 못했습니다. 앱을 다시 설치하거나 processor:build를 실행해 주세요.')); });
    child.stdout.on('data', data => {
      bytes += data.length;
      if (bytes > 75 * 1024 * 1024) { child.kill(); finish(new Error('문서 처리 결과가 너무 큽니다.')); }
      else output.push(data);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (code !== 0) return finish(new Error('문서 처리 프로그램이 종료되었습니다.'));
      try {
        const result = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (!result.ok) { const error = new Error(result.error); error.code = result.code; finish(error); }
        else finish(null, result.value);
      } catch { finish(new Error('문서 처리 응답을 읽지 못했습니다.')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
