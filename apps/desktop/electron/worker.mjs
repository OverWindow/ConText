import { parentPort, workerData } from 'node:worker_threads';
import { WorkspaceEngine } from './engine.mjs';
const engine = new WorkspaceEngine(workerData.dataDirectory);
engine.on('changed', workspaceId => parentPort.postMessage({ event: 'changed', workspaceId }));
await engine.init();
parentPort.postMessage({ ready: true });
let queue = Promise.resolve();
const methods = new Set(['list', 'connect', 'relink', 'snapshot', 'scan', 'settings', 'savePositions', 'saveView', 'resolveEntry', 'disconnect', 'close']);
parentPort.on('message', ({ id, method, args }) => {
  queue = queue.then(async () => {
    try {
      if (!methods.has(method)) throw new Error('지원하지 않는 작업입니다.');
      const result = await engine[method](...args);
      parentPort.postMessage({ id, result });
    } catch (error) { parentPort.postMessage({ id, error: error.message }); }
  });
});
