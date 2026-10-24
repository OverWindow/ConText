import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, shell, session, powerMonitor } from 'electron';
import { Worker } from 'node:worker_threads';
import { open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, '../dist');
const inside = (root, file) => { const r = path.relative(root, file); return !r || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)); };
protocol.registerSchemesAsPrivileged([{ scheme: 'context', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (!app.isPackaged && process.env.CONTEXT_DESKTOP_DATA_DIR) app.setPath('userData', path.resolve(process.env.CONTEXT_DESKTOP_DATA_DIR));
if (!app.requestSingleInstanceLock()) { app.quit(); } else { start().catch(error => { dialog.showErrorBox('ConText 시작 오류', error.message); app.quit(); }); }

async function start() {
  await app.whenReady();
  let window, sequence = 0, stopping = false, failure;
  const requests = new Map();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { dataDirectory: app.getPath('userData') } });
  const failed = error => { failure = error; rejectReady(error); for (const request of requests.values()) request.reject(error); requests.clear(); };
  worker.on('error', failed);
  worker.on('exit', code => { if (!stopping) failed(new Error(`로컬 저장소가 종료되었습니다 (${code}). 앱을 다시 실행해 주세요.`)); });
  worker.on('message', message => {
    if (message.ready) resolveReady();
    else if (message.event === 'changed') { if (window && !window.isDestroyed()) window.webContents.send('context:changed', message.workspaceId); }
    else { const request = requests.get(message.id); requests.delete(message.id); if (request) message.error ? request.reject(new Error(message.error)) : request.resolve(message.result); }
  });
  ready.catch(() => {});
  async function call(method, ...args) {
    await ready; if (failure) throw failure;
    return new Promise((resolve, reject) => { const id = ++sequence; requests.set(id, { resolve, reject }); worker.postMessage({ id, method, args }); });
  }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  protocol.handle('context', async request => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'app' || request.method !== 'GET') return new Response('', { status: 403 });
      const filename = await realpath(path.join(assets, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
      if (!inside(assets, filename)) return new Response('', { status: 403 });
      return new Response(await readFile(filename), { headers: {
        'Content-Type': mime[path.extname(filename)] || 'application/octet-stream',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'",
        'X-Content-Type-Options': 'nosniff',
      } });
    } catch { return new Response('', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  function handle(name, fn) {
    ipcMain.handle(`context:${name}`, async (event, ...args) => {
      try {
        if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith('context://app/')) throw new Error('허용되지 않은 요청입니다.');
        return { ok: true, value: await fn(...args) };
      } catch (error) { return { ok: false, error: error.message || '작업을 완료하지 못했습니다.' }; }
    });
  }
  handle('list', () => call('list'));
  handle('snapshot', id => call('snapshot', id));
  handle('connect', async () => {
    const choice = await dialog.showOpenDialog(window, { title: 'ConText에 연결할 폴더', properties: ['openDirectory'] });
    return choice.canceled ? null : call('connect', choice.filePaths[0]);
  });
  handle('relink', async id => {
    await call('snapshot', id);
    const choice = await dialog.showOpenDialog(window, { title: '폴더의 새 위치', properties: ['openDirectory'] });
    return choice.canceled ? null : call('relink', id, choice.filePaths[0]);
  });
  handle('disconnect', async id => {
    const { workspace } = await call('snapshot', id);
    const { response } = await dialog.showMessageBox(window, { type: 'question', title: '폴더 연결 해제', message: `${workspace.label} 연결을 해제할까요?`, detail: '이 앱에 저장된 배치만 지웁니다. 원본 폴더와 파일은 그대로 남습니다.', buttons: ['취소', '연결 해제'], defaultId: 0, cancelId: 0 });
    if (response !== 1) return false;
    await call('disconnect', id); return true;
  });
  handle('refresh', async id => { await call('scan', id); return call('snapshot', id); });
  handle('settings', (id, settings) => call('settings', id, settings));
  handle('savePositions', (id, positions) => call('savePositions', id, positions));
  handle('saveView', (id, directory, viewport) => call('saveView', id, directory, viewport));
  const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
  const textExtensions = new Set(['.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.log', '.xml', '.html', '.css', '.js', '.ts', '.tsx', '.py', '.sql']);
  const openExtensions = new Set([...imageExtensions, '.pdf', '.doc', '.docx', '.hwp', '.hwpx', '.odt', '.rtf', '.txt', '.md', '.csv', '.xlsx', '.xls', '.ppt', '.pptx', '.mp3', '.wav', '.mp4', '.mov']);
  const thumbnails = new Map();
  let thumbnailQueue = Promise.resolve();
  handle('preview', async (id, entryId, small = false) => {
    if (typeof small !== 'boolean') throw new Error('미리보기 설정이 올바르지 않습니다.');
    const entry = await call('resolveEntry', id, entryId);
    if (entry.kind !== 'file') return { kind: 'unsupported' };
    if (imageExtensions.has(entry.extension) && entry.size <= 20 * 1024 * 1024) {
      const key = `${id}:${entry.id}:${entry.mtime}:${entry.size}:${small}`;
      if (thumbnails.has(key)) return thumbnails.get(key);
      const job = thumbnailQueue.then(async () => {
        const checked = await call('resolveEntry', id, entryId);
        const picture = await nativeImage.createThumbnailFromPath(checked.filename, { width: small ? 256 : 1000, height: small ? 256 : 1000 });
        const result = { kind: 'image', url: picture.toDataURL() };
        thumbnails.set(key, result); if (thumbnails.size > 150) thumbnails.delete(thumbnails.keys().next().value);
        return result;
      });
      thumbnailQueue = job.catch(() => {}); return job;
    }
    if (!small && textExtensions.has(entry.extension)) {
      const file = await open(entry.filename, 'r');
      try { const buffer = Buffer.alloc(65536); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); return { kind: 'text', text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: entry.size > buffer.length }; }
      finally { await file.close(); }
    }
    return { kind: 'unsupported' };
  });
  handle('open', async (id, entryId) => {
    const entry = await call('resolveEntry', id, entryId);
    if (entry.kind !== 'file' || !openExtensions.has(entry.extension)) throw new Error('이 파일 형식은 탐색기에서 확인해 주세요.');
    const error = await shell.openPath(entry.filename); if (error) throw new Error('기본 앱으로 열지 못했습니다. 탐색기에서 확인해 주세요.');
  });
  handle('reveal', async (id, entryId) => { const entry = await call('resolveEntry', id, entryId); shell.showItemInFolder(entry.filename); });
  function createWindow() {
    window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1000, minHeight: 680, backgroundColor: '#F7F9FC', title: 'ConText Desktop',
      webPreferences: { preload: path.join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.loadURL('context://app/index.html');
    window.on('closed', () => { window = null; });
  }
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('activate', () => { if (!window) createWindow(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (stopping) return;
    event.preventDefault(); stopping = true;
    call('close').catch(() => {}).finally(async () => { await worker.terminate(); app.quit(); });
  });
  powerMonitor.on('resume', () => call('list').then(list => Promise.all(list.map(item => call('scan', item.id)))).catch(() => {}));
  createWindow();
}
