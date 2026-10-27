import { parentPort, workerData } from 'node:worker_threads';
import { WorkspaceEngine } from './engine.mjs';
const engine = new WorkspaceEngine(workerData.dataDirectory, { resourcesPath: workerData.resourcesPath, indexDocuments: true });
engine.on('changed', (workspaceId, update) => parentPort.postMessage({ event: 'changed', workspaceId, update }));
await engine.init();
parentPort.postMessage({ ready: true });
let queue = Promise.resolve();
const methods = new Set([
  'unifiedBind', 'unifiedPrepare', 'unifiedIdentity', 'unifiedPending', 'unifiedBlob', 'unifiedUploaded',
  'unifiedAcknowledge', 'unifiedBootstrap', 'unifiedReceive', 'unifiedState', 'unifiedMissing',
  'unifiedReceiveBlob', 'unifiedApply', 'unifiedStatus', 'unifiedList', 'unifiedAttach', 'unifiedDetach',
  'unifiedConflicts', 'unifiedResolve',
  'unifiedRecoveryOriginal', 'unifiedWriteRecoveryOriginal', 'unifiedRecovery', 'unifiedRecoveryOutput', 'unifiedWriteRecovery',
  'cloudDevice', 'cloudState', 'cloudStatus', 'cloudSet', 'cloudPrepare', 'cloudBlob', 'cloudFinish', 'cloudDiscard',
  'listConversions', 'requestConversion', 'conversionOutput', 'writeConversion', 'copyFile',
  'list', 'connect', 'relink', 'snapshot', 'scan', 'settings', 'savePositions', 'saveView', 'resolveEntry', 'disconnect', 'disconnectFile', 'reconnectFile', 'close',
  'listDrafts', 'getDraft', 'createDraft', 'saveDraft', 'reviewDraft', 'deleteDraft', 'renderDraft', 'writeDraftExport',
  'openDocument', 'importDraft', 'searchContent', 'prepareGeneration', 'finishGeneration', 'getDocument', 'getDocumentVersion',
  'compareDocumentVersions', 'restoreDocumentVersion', 'renderDocumentVersion', 'writeVersionExport',
  'chatSessions', 'createChatSession', 'chatMessages', 'chatSearch', 'chatIndexStatus', 'prepareChat', 'prepareChatRetry', 'finishChat', 'failChat', 'indexDocuments',
  'readTextFile', 'saveTextFile', 'createTextFile', 'renameFile', 'moveFileToFolder', 'renderTextExport', 'writeTextExport',
  'recoveryItems', 'renderRecovery', 'writeRecovery', 'acknowledgeRecovery',
  'canvasSnapshot', 'putCanvasItem', 'removeCanvasItem',
  'summaryStatus', 'prepareSummary', 'finishSummary',
  'setCurrentVersion', 'linkDocumentVersion', 'versionSources', 'versionCandidates', 'documentEntries',
  'getChangeSummary', 'prepareChangeSummary', 'finishChangeSummary',
]);
parentPort.on('message', ({ id, method, args }) => {
  // Cancellation must reach a running parser rather than wait behind its queued request.
  if (method === 'cancelIndex' || method === 'cloudCancel') {
    try { parentPort.postMessage({ id, result: engine[method](...args) }); }
    catch (error) { parentPort.postMessage({ id, error: error.message, code: error.code }); }
    return;
  }
  queue = queue.then(async () => {
    try {
      if (!methods.has(method)) throw new Error('지원하지 않는 작업입니다.');
      const result = await engine[method](...args);
      parentPort.postMessage({ id, result });
    } catch (error) { parentPort.postMessage({ id, error: error.message, code: error.code }); }
  });
});
