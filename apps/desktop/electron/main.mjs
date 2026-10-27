import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, shell, session, powerMonitor, safeStorage } from 'electron';
import { Worker } from 'node:worker_threads';
import { open, readFile, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIConnections } from './ai-connections.mjs';
import { DesktopAccount } from './account.mjs';
import { UnifiedTransfer } from './unified-transfer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, '../dist');
const inside = (root, file) => { const r = path.relative(root, file); return !r || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)); };
protocol.registerSchemesAsPrivileged([{ scheme: 'context', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (!app.isPackaged && process.env.CONTEXT_DESKTOP_DATA_DIR) app.setPath('userData', path.resolve(process.env.CONTEXT_DESKTOP_DATA_DIR));
if (!app.requestSingleInstanceLock()) { app.quit(); } else { start().catch(error => { dialog.showErrorBox('ConText 시작 오류', error.message); app.quit(); }); }

async function start() {
  await app.whenReady();
  const ai = new AIConnections(app.getPath('userData'), {
    secureStorage: {
      available: async () => ['darwin', 'win32'].includes(process.platform) && await safeStorage.isAsyncEncryptionAvailable(),
      encrypt: value => safeStorage.encryptStringAsync(value),
      decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
    },
    openExternal: url => shell.openExternal(url),
  });
  const account = new DesktopAccount(ai, { defaultServerBaseUrl: process.env.CONTEXT_SERVER_URL || 'http://127.0.0.1:8000' });
  let window, sequence = 0, stopping = false, failure;
  const requests = new Map();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { dataDirectory: app.getPath('userData'), resourcesPath: app.isPackaged ? process.resourcesPath : undefined } });
  const failed = error => { failure = error; rejectReady(error); for (const request of requests.values()) request.reject(error); requests.clear(); };
  worker.on('error', failed);
  worker.on('exit', code => { if (!stopping) failed(new Error(`로컬 저장소가 종료되었습니다 (${code}). 앱을 다시 실행해 주세요.`)); });
  worker.on('message', message => {
    if (message.ready) resolveReady();
    else if (message.event === 'changed') { if (window && !window.isDestroyed()) window.webContents.send('context:changed', message.workspaceId, message.update); }
    else { const request = requests.get(message.id); requests.delete(message.id); if (request) { if (message.error) { const error = new Error(message.error); error.code = message.code; request.reject(error); } else request.resolve(message.result); } }
  });
  ready.catch(() => {});
  async function call(method, ...args) {
    await ready; if (failure) throw failure;
    return new Promise((resolve, reject) => { const id = ++sequence; requests.set(id, { resolve, reject }); worker.postMessage({ id, method, args }); });
  }
  const cloud = new UnifiedTransfer(ai, call);
  let automaticSyncRunning = false;
  async function automaticSync() {
    if (stopping || automaticSyncRunning || cloud.active) return;
    automaticSyncRunning = true;
    try {
      const state = await account.status(); if (state.status !== 'signed_in') return;
      const spaces = await call('unifiedList');
      for (const space of spaces) {
        if (stopping || cloud.active) break;
        if (!space.paused && !space.deleted) { cloud.watch(space.id, () => { void automaticSync().catch(() => {}); }); await cloud.start(space.id).catch(() => {}); }
        else cloud.stopWatching(space.id);
      }
    } finally { automaticSyncRunning = false; }
  }
  cloud.on('changed', (id, state) => {
    if (state.phase === 'complete') cloud.watch(id, () => { void automaticSync().catch(() => {}); });
    if (state.deleted || state.paused) cloud.stopWatching(id);
    if (window && !window.isDestroyed()) window.webContents.send('context:sync-changed', id, state);
  });
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
      } catch (error) { return { ok: false, error: error.message || '작업을 완료하지 못했습니다.', code: error.code }; }
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
    cloud.cancel(id);
    if (cloud.active?.id === id) await cloud.active.promise.catch(() => {});
    const { workspace } = await call('snapshot', id);
    const recovery = await call('recoveryItems', id);
    const detail = '현재 앱 저장소의 배치·메모·초안·대화·문서 이력·검색 자료를 지웁니다. 원본 폴더·내보낸 파일·마이그레이션 백업은 그대로 남습니다. 이미 동기화한 클라우드 공간은 유지됩니다. 클라우드 공간도 지우려면 동기화 메뉴 또는 웹의 워크스페이스 목록에서 따로 삭제해 주세요.' + (recovery.length ? ` 확인이 필요한 저장 ${recovery.length}개의 복구 자료도 원래 폴더에 남습니다. 연결을 해제하기 전에 복구 화면에서 확인해 주세요.` : '');
    const { response } = await dialog.showMessageBox(window, { type: 'question', title: '폴더 연결 해제', message: `${workspace.label} 연결을 해제할까요?`, detail, buttons: ['취소', '연결 해제'], defaultId: 0, cancelId: 0 });
    if (response !== 1) return false;
    cloud.stopWatching(id); await call('disconnect', id); return true;
  });
  handle('refresh', async id => { await call('scan', id); return call('snapshot', id); });
  for (const method of ['disconnectFile', 'reconnectFile']) handle(method, (...args) => call(method, ...args));
  handle('settings', (id, settings) => call('settings', id, settings));
  handle('savePositions', (id, positions) => call('savePositions', id, positions));
  handle('saveView', (id, directory, viewport) => call('saveView', id, directory, viewport));
  for (const method of ['listDrafts', 'getDraft', 'createDraft', 'saveDraft', 'reviewDraft', 'deleteDraft', 'openDocument', 'importDraft', 'searchContent', 'getDocument', 'getDocumentVersion', 'compareDocumentVersions', 'chatSessions', 'createChatSession', 'chatMessages', 'chatSearch', 'chatIndexStatus', 'indexDocuments']) handle(method, (...args) => call(method, ...args));
  account.on('changed', state => { if (state.status !== 'signed_in') cloud.cancel(); if (window && !window.isDestroyed()) window.webContents.send('context:account-changed', state); });
  handle('syncStatus', id => cloud.status(id));
  handle('syncStart', async id => {
    const state = await account.refresh();
    if (state.status !== 'signed_in') throw new Error('로그인을 확인한 뒤 다시 동기화해 주세요.');
    const status = await cloud.status(id);
    if (!status.linked) {
      const snapshot = await call('snapshot', id);
      const choice = await dialog.showMessageBox(window, { type: 'question', buttons: ['취소', '클라우드 동기화'], defaultId: 0, cancelId: 0,
        message: `${snapshot.workspace.label} 폴더를 클라우드에 연결할까요?`,
        detail: `${state.user.email}\n${state.serverBaseUrl}\n\n연결된 일반 파일과 수정 이력, 하위 폴더, 배치·메모·연결선, 작성 초안과 대화를 동기화합니다. 웹과 다른 기기에서 수정한 내용도 이 폴더로 받습니다. 충돌이 생기면 양쪽 이력을 보존합니다.` });
      if (choice.response !== 1) return status;
    }
    return cloud.start(id);
  });
  handle('syncCancel', id => cloud.cancel(id));
  handle('syncRestart', id => cloud.restart(id));
  handle('syncOpenWeb', id => cloud.open(id, url => shell.openExternal(url)));
  handle('cloudList', () => cloud.listCloud());
  handle('cloudAttach', async id => {
    const choice = await dialog.showOpenDialog(window, { title: '클라우드 작업 공간을 받을 빈 폴더', properties: ['openDirectory', 'createDirectory'] });
    return choice.canceled ? null : cloud.attach(choice.filePaths[0], id);
  });
  handle('cloudConflicts', id => call('unifiedConflicts', id));
  handle('cloudRecoveryOriginal', async (id, recordId) => { const output = await call('unifiedRecoveryOriginal', id, recordId); await saveOutput(output, 'bin', (filename, _data, expectedHash) => call('unifiedWriteRecoveryOriginal', id, recordId, filename, expectedHash)); });
  handle('cloudRecovery', id => call('unifiedRecovery', id));
  handle('cloudExportRecovery', async (id, recordId) => {
    const output = await call('unifiedRecoveryOutput', id, recordId);
    await saveOutput(output, 'json', (filename, _data, expectedHash) => call('unifiedWriteRecovery', id, recordId, filename, expectedHash));
  });
  handle('cloudResolve', async (id, type, payload, bases) => {
    await call('unifiedResolve', id, type, payload, bases);
    try { return await cloud.start(id); } catch { return cloud.status(id); }
  });
  handle('syncDetach', async id => {
    const choice = await dialog.showMessageBox(window, { type: 'question', buttons: ['취소', '동기화 연결 해제'], defaultId: 0, cancelId: 0,
      message: '클라우드 동기화 연결을 해제할까요?', detail: '이후 변경 사항은 전송하지 않습니다. 로컬 원본과 이미 동기화한 클라우드 자료는 유지됩니다.' });
    return choice.response === 1 ? cloud.detach(id) : cloud.status(id);
  });
  handle('syncDelete', async id => {
    const { workspace } = await call('snapshot', id);
    const choice = await dialog.showMessageBox(window, { type: 'warning', buttons: ['취소', '클라우드 워크스페이스 삭제'], defaultId: 0, cancelId: 0,
      message: `${workspace.label} 클라우드 워크스페이스를 삭제할까요?`,
      detail: '모든 팀원의 웹 접근과 이후 동기화를 차단합니다. 이 앱에서 삭제를 되돌리거나 같은 연결로 다시 동기화할 수 없습니다. 로컬 원본 폴더와 앱의 작업 내용은 유지됩니다. 서버 자료는 삭제 상태로 보관되며 즉시 영구 파기되지는 않습니다.' });
    return choice.response === 1 ? cloud.remove(id) : cloud.status(id);
  });
  handle('accountStatus', () => account.status());
  handle('accountRefresh', () => account.refresh());
  handle('accountConfigure', base => account.configure(base));
  handle('accountLogin', async base => {
    const state = await account.login(base);
    if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.focus(); }
    return state;
  });
  handle('accountLogout', () => account.logout());
  handle('accountCancelLogin', () => account.cancel());
  handle('aiConnection', () => ai.summary());
  handle('saveAIConnection', async value => { const state = await ai.update(value); await account.publish(); return state; });
  handle('removePersonalAI', () => ai.removePersonal());
  handle('aiModels', () => ai.models());
  handle('aiLogin', async () => { await account.login(); return ai.summary(); });
  handle('aiLogout', async () => { await account.logout(); return ai.summary(); });
  handle('aiCancelLogin', () => account.cancel());
  handle('generateDraft', async (id, input) => {
    await ai.ensureReady();
    const request = await call('prepareGeneration', id, input);
    if (request.existing) return request.existing;
    const result = await ai.generate(request);
    // Bind citations to exactly the local excerpts sent to the model, never returned source objects.
    result.sources = request.sources;
    return call('finishGeneration', id, input, result);
  });
  handle('summarizeSelection', async (id, input) => {
    if (!await call('summaryStatus', id, input)) await ai.ensureReady();
    const request = await call('prepareSummary', id, input);
    if (request.completed) return request.existing;
    const result = request.resume ? undefined : await ai.generate(request);
    return call('finishSummary', id, input, result);
  });
  handle('getChangeSummary', (...args) => call('getChangeSummary', ...args));
  handle('summarizeChanges', async (id, documentId, left, right, requestId) => {
    const cached = await call('getChangeSummary', id, documentId, left, right);
    if (cached?.state === 'complete') return cached.result;
    await ai.ensureReady();
    const request = await call('prepareChangeSummary', id, documentId, left, right, requestId);
    if (request.existing) return request.existing;
    const result = request.sources.length ? await ai.generate(request) : { claims: [], insufficient: true };
    return call('finishChangeSummary', id, documentId, left, right, requestId, result, (await ai.summary()).model);
  });
  async function answerChat(id, sessionId, prepare, ...args) {
    const request = await call(prepare, id, sessionId, ...args);
    if (request.existing) return request.existing;
    try {
      let result = { claims: [], insufficient: true };
      if (request.sources.length) { await ai.ensureReady(); result = await ai.generate(request); }
      return await call('finishChat', id, sessionId, request, result);
    } catch (error) { await call('failChat', id, sessionId, request, error.code).catch(() => {}); throw error; }
  }
  handle('askChat', (id, sessionId, input) => answerChat(id, sessionId, 'prepareChat', input));
  handle('retryChat', (id, sessionId, messageId) => answerChat(id, sessionId, 'prepareChatRetry', messageId));
  handle('readTextFile', (id, entryId) => call('readTextFile', id, entryId));
  handle('recoveryItems', id => call('recoveryItems', id));
  handle('cancelIndex', id => call('cancelIndex', id));
  for (const method of ['canvasSnapshot', 'putCanvasItem', 'removeCanvasItem']) handle(method, (...args) => call(method, ...args));
  for (const method of ['setCurrentVersion', 'linkDocumentVersion', 'versionSources', 'versionCandidates', 'documentEntries']) handle(method, (...args) => call(method, ...args));
  handle('acknowledgeRecovery', (id, journalId) => call('acknowledgeRecovery', id, journalId));
  handle('exportRecovery', async (id, journalId, original = false) => {
    const output = await call('renderRecovery', id, journalId, original === true);
    await saveOutput(output, output.extension, (filename, _data, expectedHash) => call('writeRecovery', id, journalId, original === true, filename, expectedHash));
  });
  handle('saveTextFile', (id, entryId, revision, text) => call('saveTextFile', id, entryId, revision, text));
  handle('createTextFile', (id, name, directoryId) => call('createTextFile', id, name, directoryId));
  handle('renameFile', (id, entryId, name) => call('renameFile', id, entryId, name));
  handle('moveFileToFolder', (id, entryId, directoryId, options) => call('moveFileToFolder', id, entryId, directoryId, options));
  handle('moveFile', async (id, entryId) => {
    const entry = await call('resolveEntry', id, entryId);
    const choice = await dialog.showOpenDialog(window, { title: '파일을 이동할 폴더', defaultPath: path.dirname(entry.filename), properties: ['openDirectory'] });
    if (!choice.canceled) await call('renameFile', id, entryId, entry.name, choice.filePaths[0]);
  });
  handle('trashFile', async (id, entryId) => {
    const entry = await call('resolveEntry', id, entryId);
    if (entry.kind !== 'file') throw new Error('일반 파일만 휴지통으로 이동할 수 있습니다.');
    const choice = await dialog.showMessageBox(window, { type: 'question', title: '파일 휴지통 이동', message: `${entry.name} 파일을 휴지통으로 이동할까요?`, detail: '원본 파일이 휴지통으로 이동합니다. 앱에 보관된 문서 이력은 남습니다.', buttons: ['취소', '휴지통으로 이동'], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return false;
    const checked = await call('resolveEntry', id, entryId);
    if (checked.inode !== entry.inode || checked.device !== entry.device || checked.mtime !== entry.mtime || checked.size !== entry.size) throw new Error('확인하는 동안 파일이 변경되었습니다. 다시 확인해 주세요.');
    await shell.trashItem(checked.filename); await call('scan', id); return true;
  });
  async function saveOutput(output, format, save) {
    const choice = await dialog.showSaveDialog(window, { title: '문서 저장', defaultPath: `${output.title.replace(/[\\/:*?"<>|]/g, '_')}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (choice.canceled || !choice.filePath) return;
    let expectedHash = null;
    try {
      const stats = await lstat(choice.filePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 50 * 1024 * 1024) throw new Error('50MB 이하의 일반 파일로만 저장할 수 있습니다.');
      expectedHash = createHash('sha256').update(await readFile(choice.filePath)).digest('hex');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await save(choice.filePath, output.data, expectedHash);
  }
  handle('exportDraft', async (id, draftId, revision, format) => {
    const output = await call('renderDraft', id, draftId, revision, format);
    await saveOutput(output, format, (filename, data, expectedHash) => call('writeDraftExport', id, draftId, revision, filename, data, expectedHash));
  });
  handle('listConversions', (id, documentId) => call('listConversions', id, documentId));
  handle('requestConversion', (id, versionId, format) => call('requestConversion', id, versionId, format));
  handle('copyFile', (id, entryId, requestId, versionId) => call('copyFile', id, entryId, requestId, versionId));
  handle('saveConversion', async (id, versionId, format) => {
    const output = await call('conversionOutput', id, versionId, format);
    await saveOutput(output, format, (filename, _data, expectedHash) => call('writeConversion', id, versionId, format, filename, expectedHash));
  });
  handle('exportDocumentVersion', async (id, documentId, versionId, format) => {
    const output = await call('renderDocumentVersion', id, documentId, versionId, format);
    await saveOutput(output, output.extension, (filename, data, expectedHash) => call('writeVersionExport', id, documentId, versionId, filename, data, expectedHash));
  });
  handle('saveTextAs', async (id, entryId, text) => {
    const output = await call('renderTextExport', id, entryId, text);
    await saveOutput(output, output.extension, (filename, data, expectedHash) => call('writeTextExport', id, entryId, filename, data, expectedHash));
  });
  handle('restoreDocumentVersion', async (id, documentId, versionId) => {
    const version = await call('getDocumentVersion', id, documentId, versionId);
    const current = await call('openDocument', id, version.entry_id);
    const choice = await dialog.showMessageBox(window, { type: 'question', title: '이전 수정 이력 복원', message: `원본을 수정 이력 ${version.version_number} 내용으로 복원할까요?`, detail: '현재 원본 내용은 앱의 수정 이력에 보존됩니다. 외부 변경이 감지되면 복원을 중단합니다.', buttons: ['취소', '원본 복원'], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    return call('restoreDocumentVersion', id, documentId, versionId, current.sha256);
  });
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
    event.preventDefault(); stopping = true; cloud.cancel(); account.cancel(); clearInterval(accountTimer); clearInterval(syncTimer);
    call('close').catch(() => {}).finally(async () => { await worker.terminate(); app.quit(); });
  });
  const accountTimer = setInterval(() => { void account.refresh().catch(() => {}); }, 5 * 60 * 1000);
  accountTimer.unref();
  const syncTimer = setInterval(() => { void automaticSync().catch(() => {}); }, 60000);
  syncTimer.unref();
  powerMonitor.on('resume', () => { void account.refresh().catch(() => {}); });
  powerMonitor.on('resume', () => call('list').then(list => Promise.all(list.map(item => call('scan', item.id)))).catch(() => {}));
  powerMonitor.on('resume', () => { void automaticSync().catch(() => {}); });
  createWindow();
  void account.refresh().then(() => automaticSync()).catch(() => {});
}
