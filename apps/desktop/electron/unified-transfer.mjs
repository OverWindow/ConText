import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceSynchronizer, subscribeWorkspaceChanges } from '../core/sync-client/src/index.js';

const MAX_JSON = 128 * 1024 * 1024;
const MAX_BLOB = 50 * 1024 * 1024;
const loopback = host => ['127.0.0.1', 'localhost', '[::1]'].includes(host);
function error(message, code, status) { return Object.assign(new Error(message), { code, ...(status ? { status } : {}) }); }
function secureURL(value, label) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname)))) throw error(`${label} 주소가 올바르지 않습니다.`, 'INVALID_URL');
  return url;
}
export function unifiedURL(config, override = process.env.CONTEXT_UNIFIED_API_URL) {
  const explicit = override || config.unifiedApiUrl || config.auth?.unified_api_url;
  const url = secureURL(explicit || config.serverBaseUrl, '워크스페이스 서버');
  if (url.search) throw error('워크스페이스 서버 주소에는 검색 조건을 넣을 수 없습니다.', 'INVALID_URL');
  if (!explicit && loopback(url.hostname) && url.port === '8000') url.port = '8001';
  url.pathname = url.pathname.replace(/\/v2\/?$/, '').replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}
export function unifiedWebURL(config, workspaceId, apiBase, override = process.env.CONTEXT_WEB_URL) {
  const configured = override || config.webBaseUrl || config.auth?.web_base_url;
  const base = secureURL(configured || apiBase, '웹 워크스페이스');
  if (base.search) throw error('웹 주소를 확인하지 못했습니다.', 'INVALID_URL');
  if (!configured && loopback(base.hostname)) base.port = '3000';
  base.pathname = `/workspaces/${workspaceId}`;
  return base.toString();
}
async function boundedBytes(response, maximum) {
  if (Number(response.headers?.get('Content-Length')) > maximum) { await response.body?.cancel(); throw error('서버 응답 크기가 한도를 초과했습니다.', 'RESPONSE_TOO_LARGE'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), parts = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw error('서버 응답 크기가 한도를 초과했습니다.', 'RESPONSE_TOO_LARGE'); }
      parts.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts, length);
}

/** Main owns JWTs; the worker receives account identity and verified portable bytes only. */
export class UnifiedTransfer extends EventEmitter {
  constructor(connections, call, { fetcher = fetch, uploader = fetch, apiUrl, webUrl } = {}) {
    super(); this.connections = connections; this.call = call; this.fetcher = fetcher; this.uploader = uploader;
    this.apiUrl = apiUrl; this.webUrl = webUrl; this.active = null; this.states = new Map(); this.watches = new Map();
  }
  publish(id, state) { this.states.set(id, state); this.emit('changed', id, state); return state; }
  async identity(job = { controller: new AbortController() }) {
    const config = await this.connections.read();
    if (!config.session?.user?.id) throw error('클라우드 동기화를 사용하려면 먼저 로그인해 주세요.', 'AUTHENTICATION_REQUIRED');
    Object.assign(job, { config, server: unifiedURL(config, this.apiUrl), sourceServer: config.serverBaseUrl, accountUser: config.session.user.id, identity: config.session.identity });
    const me = await this.request(job, '/v2/me', 'GET', undefined, { timeout: 10000 });
    if (!me?.id) throw error('서버에서 계정을 확인하지 못했습니다.', 'INVALID_IDENTITY');
    job.owner = { server: job.server, user_id: me.id };
    return job;
  }
  async guard(job, token = false) {
    if (job.controller.signal.aborted) throw error('동기화를 중단했습니다. 대기 중인 변경은 보존됩니다.', 'SYNC_CANCELLED');
    const current = await this.connections.read();
    if (current.session?.identity !== job.identity || current.serverBaseUrl !== job.sourceServer || current.session?.user?.id !== job.accountUser || unifiedURL(current, this.apiUrl) !== job.server) {
      job.controller.abort(); throw error('계정 연결이 변경되어 동기화를 중단했습니다.', 'ACCOUNT_CHANGED');
    }
    return token ? this.connections.token(job.config) : undefined;
  }
  async request(job, path, method = 'GET', body, { timeout = 60000, retries = 2 } = {}) {
    if (!path.startsWith('/v2/') || path.startsWith('//')) throw error('워크스페이스 API 경로가 올바르지 않습니다.', 'INVALID_ROUTE');
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized) > MAX_JSON) throw error('동기화 데이터가 128 MiB를 초과했습니다.', 'REQUEST_TOO_LARGE');
    for (let attempt = 0; ; attempt++) {
      const token = await this.guard(job, true);
      try {
        const response = await this.fetcher(`${job.server}${path}`, { method, redirect: 'error', signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(timeout)]),
          headers: { Authorization: `Bearer ${token}`, ...(serialized === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(serialized === undefined ? {} : { body: serialized }) });
        const bytes = await boundedBytes(response, MAX_JSON);
        let result; try { result = bytes.length ? JSON.parse(bytes.toString('utf8')) : null; } catch { throw error('워크스페이스 서버 응답을 읽지 못했습니다.', 'INVALID_RESPONSE'); }
        await this.guard(job);
        if (!response.ok) {
          const detail = result?.error || result;
          throw error(detail?.message || (response.status === 410 ? '클라우드 워크스페이스가 삭제되었습니다. 로컬 원본은 유지됩니다.' : '워크스페이스 서버 요청을 완료하지 못했습니다.'), detail?.code || 'SERVER_ERROR', response.status);
        }
        return result;
      } catch (reason) {
        if (job.controller.signal.aborted || attempt >= retries || reason.status && reason.status !== 429 && reason.status < 500 || ['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'].includes(reason.code)) throw reason;
        await delay(300 * 2 ** attempt, undefined, { signal: job.controller.signal });
      }
    }
  }
  async local(job, method, ...args) { await this.guard(job); const result = await this.call(method, job.id, ...args); await this.guard(job); return result; }
  adapters(job) {
    return {
      local: {
        prepare: () => this.local(job, 'unifiedPrepare'), identity: () => this.local(job, 'unifiedIdentity'), pending: () => this.local(job, 'unifiedPending'),
        blob: async id => {
          const record = await this.local(job, 'unifiedBlob', id), data = Buffer.from(record.data ?? record);
          if (data.length > MAX_BLOB || record.sha256 && createHash('sha256').update(data).digest('hex') !== record.sha256 || record.size !== undefined && Number(record.size) !== data.length) throw error('보관된 원본이 기록과 다릅니다.', 'INVALID_LOCAL_BLOB');
          return data;
        },
        uploaded: id => this.local(job, 'unifiedUploaded', id), acknowledge: receipts => this.local(job, 'unifiedAcknowledge', receipts),
        bootstrap: (state, cursor) => this.local(job, 'unifiedBootstrap', state, cursor), receive: (events, cursor) => this.local(job, 'unifiedReceive', events, cursor),
        state: () => this.local(job, 'unifiedState'), missing: () => this.local(job, 'unifiedMissing'), receiveBlob: (blob, bytes) => this.local(job, 'unifiedReceiveBlob', blob, bytes),
        applyFiles: () => this.local(job, 'unifiedApply'),
      },
      remote: {
        request: (method, path, body) => this.request(job, path, method, body), upload: (url, headers, bytes) => this.upload(job, url, headers, bytes), download: (url, blob) => this.download(job, url, blob),
      },
    };
  }
  async upload(job, value, headers, input) {
    const url = secureURL(value, '파일 저장소'), bytes = Buffer.from(input);
    if (bytes.length > MAX_BLOB || Object.keys(headers).some(key => ['authorization', 'cookie', 'proxy-authorization'].includes(key.toLowerCase()))) throw error('파일 저장소 응답이 올바르지 않습니다.', 'INVALID_UPLOAD');
    const checksum = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-amz-checksum-sha256')?.[1];
    if (!checksum || createHash('sha256').update(bytes).digest('base64') !== checksum) throw error('전송할 원본의 체크섬이 기록과 다릅니다.', 'INVALID_LOCAL_BLOB');
    await this.guard(job);
    const response = await this.uploader(url.toString(), { method: 'PUT', redirect: 'error', body: bytes, headers, signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(120000)]) });
    await response.body?.cancel(); await this.guard(job);
    if (!response.ok && response.status !== 412) throw error('원본 업로드를 완료하지 못했습니다. 다시 동기화해 주세요.', 'UPLOAD_FAILED', response.status);
  }
  async download(job, value, expected) {
    const url = secureURL(value, '파일 저장소');
    if (!Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > MAX_BLOB || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw error('받을 원본의 정보가 올바르지 않습니다.', 'INVALID_DOWNLOAD');
    await this.guard(job);
    const response = await this.uploader(url.toString(), { method: 'GET', redirect: 'error', signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(120000)]) });
    if (!response.ok) { await response.body?.cancel(); throw error('원본을 내려받지 못했습니다.', 'DOWNLOAD_FAILED', response.status); }
    const bytes = await boundedBytes(response, expected.size); await this.guard(job);
    if (bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw error('내려받은 원본의 체크섬이 기록과 다릅니다.', 'INVALID_DOWNLOAD');
    return bytes;
  }
  start(id) {
    if (this.active?.id === id) return this.active.promise;
    if (this.active) throw error('진행 중인 동기화를 먼저 마쳐 주세요.', 'SYNC_ACTIVE');
    const job = { id, controller: new AbortController() }; this.active = job;
    this.publish(id, { ...this.states.get(id), phase: 'preparing', message: '동기화를 준비하고 있습니다.' });
    job.promise = this.run(job).catch(reason => {
      this.publish(id, { phase: reason.status === 410 || reason.code === 'WORKSPACE_DELETED' ? 'deleted' : job.controller.signal.aborted ? 'paused' : 'failed', message: reason.message }); throw reason;
    }).finally(() => { job.controller.abort(); if (this.active === job) this.active = null; });
    return job.promise;
  }
  async run(job) {
    await this.identity(job); const previous = await this.local(job, 'unifiedStatus'); await this.local(job, 'unifiedBind', job.owner);
    if (previous.paused && previous.linked) {
      const identity = await this.local(job, 'unifiedIdentity');
      await this.request(job, `/v2/workspaces/${job.id}/devices`, 'POST', { device_id: identity.device_id, name: 'ConText Desktop', platform: 'desktop' });
    }
    const { local, remote } = this.adapters(job);
    const sync = new WorkspaceSynchronizer(local, remote, progress => this.publish(job.id, { ...this.states.get(job.id), ...progress }));
    const result = await sync.run(), state = await this.local(job, 'unifiedStatus');
    return this.publish(job.id, this.presentation(job, state, result));
  }
  presentation(job, state, result) {
    const failures = result?.failures || [], conflicts = result?.conflicts ?? state.conflicts;
    const deleted = result?.deleted || state.deleted;
    return { ...state, binding: state.linked ? { workspace_id: job.id, web_url: unifiedWebURL(job.config, job.id, job.server, this.webUrl) } : null,
      phase: deleted ? 'deleted' : state.paused ? 'paused' : conflicts ? 'conflict' : failures.length || state.applying || state.blocked_count ? 'failed' : state.pending ? 'changed' : state.linked ? 'complete' : 'local', conflicts,
      ...(failures.length ? { failures, message: `서버 변경은 받았지만 파일 ${failures.length}개는 적용 확인이 필요합니다. ${failures[0].message}` } : state.paused ? { message: '이 기기의 자동 동기화를 중지했습니다. 다시 시작하면 같은 클라우드 공간에 연결합니다.' } : state.blocked_count ? { message: `서버에서 거절한 변경 ${state.blocked_count}개를 전송 기록에 보존했습니다. 다른 변경은 계속 동기화합니다.` } : conflicts ? { message: `동시에 수정한 내용 ${conflicts}개가 보존되어 있습니다. 충돌 목록에서 비교해 주세요.` } : deleted ? { message: '클라우드 공간이 삭제되었습니다. 로컬 원본과 작업 내용은 보존됩니다.' } : state.pending ? { message: '전송할 로컬 변경이 남아 있습니다.' } : { message: '웹과 데스크톱의 변경을 확인했습니다.' }) };
  }
  async status(id) {
    if (this.active?.id === id) return this.states.get(id) || { phase: 'preparing' };
    const state = await this.call('unifiedStatus', id);
    const config = await this.connections.read();
    if (!config.session?.user?.id) return { ...state, phase: state.linked ? 'offline' : 'local', message: '로그인하면 클라우드 변경을 확인할 수 있습니다.' };
    const job = { id, controller: new AbortController() };
    try {
      await this.identity(job);
      const result = this.presentation(job, state);
      if (state.linked) {
        const page = await this.request(job, `/v2/workspaces/${id}/changes?after=${state.cursor || 0}&limit=1`, 'GET', undefined, { timeout: 5000, retries: 0 });
        if (page.deleted_at) return this.publish(id, { ...result, phase: 'deleted', deleted: true, message: '클라우드 공간이 삭제되었습니다. 로컬 자료는 보존됩니다.' });
        if (page.changes?.length) return { ...result, phase: 'changed', changed: true, message: '웹 또는 다른 기기의 변경을 받을 수 있습니다.' };
      }
      return result;
    } catch (reason) { return { ...state, phase: 'offline', message: reason.message || '클라우드 상태를 확인하지 못했습니다.' }; }
    finally { job.controller.abort(); }
  }
  watch(id, onHint) {
    if (this.watches.has(id)) return;
    const job = { id, controller: new AbortController() }, handle = { stop: () => job.controller.abort() };
    this.watches.set(id, handle);
    void this.identity(job).then(() => {
      if (job.controller.signal.aborted) return;
      const stop = subscribeWorkspaceChanges(async signal => {
        const token = await this.guard(job, true);
        const response = await this.fetcher(`${job.server}/v2/workspaces/${id}/events`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.any([signal, job.controller.signal]) });
        try { await this.guard(job); } catch (error) { await response.body?.cancel(); throw error; }
        return response;
      }, hint => { void this.local(job, 'unifiedIdentity').then(local => { if (hint.cursor > local.cursor || hint.epoch > local.workspace.epoch) onHint(); }).catch(() => this.stopWatching(id)); }, { onError: error => { if (job.controller.signal.aborted || [401,403,404,410].includes(error.status)) this.stopWatching(id); } });
      handle.stop = () => { job.controller.abort(); stop(); };
    }).catch(() => { if (this.watches.get(id) === handle) this.watches.delete(id); job.controller.abort(); });
  }
  stopWatching(id) { for (const [key, watch] of this.watches) if (!id || key === id) { watch.stop(); this.watches.delete(key); } }
  cancel(id) { if (!id) this.stopWatching(); if (this.active && (!id || this.active.id === id)) { this.active.controller.abort(); void this.call('cloudCancel', this.active.id).catch(() => {}); } }
  async stop(id) { if (this.active) { this.cancel(id); if (this.active.id === id) await this.active.promise.catch(() => {}); else throw error('다른 폴더의 동기화를 먼저 마쳐 주세요.', 'SYNC_ACTIVE'); } }
  async restart(id) { await this.stop(id); return this.start(id); }
  async detach(id) {
    this.stopWatching(id);
    await this.stop(id); const job = await this.identity({ id, controller: new AbortController() });
    try {
      await this.local(job, 'unifiedBind', job.owner); const identity = await this.local(job, 'unifiedIdentity');
      if (identity.linked) await this.request(job, `/v2/workspaces/${id}/devices/${identity.device_id}`, 'DELETE');
      const state = await this.local(job, 'unifiedDetach'); return this.publish(id, this.presentation(job, state));
    } finally { job.controller.abort(); }
  }
  async remove(id) {
    this.stopWatching(id);
    await this.stop(id); const job = await this.identity({ id, controller: new AbortController() });
    try {
      await this.local(job, 'unifiedBind', job.owner); const identity = await this.local(job, 'unifiedIdentity');
      await this.request(job, `/v2/workspaces/${id}/devices`, 'POST', { device_id: identity.device_id, name: 'ConText Desktop', platform: 'desktop' });
      const bootstrap = await this.request(job, `/v2/workspaces/${id}/bootstrap`);
      if (!bootstrap.state.workspace.deleted_at) {
        const workspace = bootstrap.state.workspace;
        const command = { schema_version: 2, operation_id: randomUUID(), workspace_id: id, device_id: identity.device_id, workspace_epoch: workspace.epoch, type: 'DeleteWorkspace', payload: {}, base_revisions: { [`workspace:${id}`]: workspace.revision } };
        const result = await this.request(job, `/v2/workspaces/${id}/commands`, 'POST', { commands: [command] });
        if (result.results[0]?.status !== 'applied') throw error(result.results[0]?.error?.message || '클라우드 공간을 삭제하지 못했습니다.', 'DELETE_REJECTED');
        const latest = await this.request(job, `/v2/workspaces/${id}/bootstrap`); await this.local(job, 'unifiedBootstrap', latest.state, latest.cursor);
      } else await this.local(job, 'unifiedBootstrap', bootstrap.state, bootstrap.cursor);
      return this.publish(id, { phase: 'deleted', deleted: true, linked: false, message: '클라우드 공간을 삭제했습니다. 로컬 원본과 작업 내용은 유지됩니다.' });
    } finally { job.controller.abort(); }
  }
  async open(id, openExternal) {
    const job = await this.identity({ id, controller: new AbortController() });
    try { const identity = await this.local(job, 'unifiedIdentity'); if (!identity.linked) throw error('먼저 클라우드에 연결해 주세요.', 'NOT_LINKED'); await openExternal(unifiedWebURL(job.config, id, job.server, this.webUrl)); }
    finally { job.controller.abort(); }
  }
  async listCloud() { const job = await this.identity(); try { return (await this.request(job, '/v2/workspaces')).workspaces; } finally { job.controller.abort(); } }
  async attach(root, workspaceId) {
    if (this.active) throw error('진행 중인 동기화를 먼저 마쳐 주세요.', 'SYNC_ACTIVE');
    const job = await this.identity({ id: workspaceId, controller: new AbortController() });
    try {
      const bootstrap = await this.request(job, `/v2/workspaces/${workspaceId}/bootstrap`);
      if (bootstrap.state.workspace.deleted_at) throw error('삭제된 워크스페이스에는 연결할 수 없습니다.', 'WORKSPACE_DELETED', 410);
      await this.guard(job); const snapshot = await this.call('unifiedAttach', root, bootstrap.state, bootstrap.cursor, job.owner); await this.guard(job);
      const identity = await this.local(job, 'unifiedIdentity'); await this.request(job, `/v2/workspaces/${workspaceId}/devices`, 'POST', { device_id: identity.device_id, name: 'ConText Desktop', platform: 'desktop' });
      await this.start(workspaceId); return await this.local(job, 'snapshot') || snapshot;
    } finally { job.controller.abort(); }
  }
}
