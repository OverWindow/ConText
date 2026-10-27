import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function webURL(binding) {
  const url = new URL(binding.web_url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== `/workspaces/${binding.workspace_id}`) throw new Error('웹 작업 공간 주소를 확인하지 못했습니다.');
  return url.toString();
}

/** Credentials stay in main; the worker receives only verified user/server identity. */
export class CloudTransfer extends EventEmitter {
  constructor(connections, call, { uploader = fetch, readBlob = readFile } = {}) {
    super(); this.connections = connections; this.call = call; this.uploader = uploader; this.readBlob = readBlob; this.active = null; this.states = new Map();
  }
  async identity() {
    const config = await this.connections.read();
    if (!config.session?.user?.id) throw new Error('클라우드 동기화를 사용하려면 먼저 로그인해 주세요.');
    return { config, owner: { server: config.serverBaseUrl, user_id: config.session.user.id }, identity: config.session.identity };
  }
  publish(id, value) { this.states.set(id, value); this.emit('changed', id, value); return value; }
  async status(id) {
    if (this.active?.id === id) return this.states.get(id);
    const identity = await this.identity(), { owner } = identity;
    const status = await this.call('cloudStatus', id, owner);
    if (status.binding?.state === 'DELETED') return this.deleted(id, owner);
    if (status.binding) {
      try { await this.request({ ...identity, id, controller: new AbortController() }, `/sync/bindings/${status.binding.id}`, 'GET', undefined, { timeout: 5000, retries: 0 }); }
      catch (error) {
        if (error.status === 410) return this.deleted(id, owner);
        return { ...status, phase: 'offline', message: '클라우드 상태를 확인하지 못했습니다. 네트워크와 계정 연결을 확인해 주세요.' };
      }
    }
    return { ...status, phase: status.pending ? 'paused' : status.linked ? status.changed ? 'changed' : 'complete' : 'local' };
  }
  async deleted(id, owner) {
    const state = await this.call('cloudState', id, owner);
    if (state.pending) await this.call('cloudDiscard', id, owner);
    if (state.binding?.state !== 'DELETED') await this.call('cloudSet', id, owner, { binding: { ...state.binding, state: 'DELETED' } });
    return this.publish(id, { phase: 'deleted', linked: false, message: '클라우드 워크스페이스가 삭제되었습니다. 로컬 폴더와 앱의 작업 내용은 유지됩니다.' });
  }
  async guard(job) {
    if (job.controller.signal.aborted) throw new Error('동기화를 중단했습니다. 다시 눌러 이어서 전송할 수 있습니다.');
    const current = await this.connections.read();
    if (current.session?.identity !== job.identity || current.serverBaseUrl !== job.owner.server || current.session?.user?.id !== job.owner.user_id) {
      this.cancel(); throw new Error('계정 연결이 변경되어 동기화를 중단했습니다.');
    }
    return this.connections.token(job.config);
  }
  async request(job, route, method = 'GET', body, { timeout = 60000, retries = 2 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.guard(job);
      try {
        const value = await this.connections.fetcher(`${job.owner.server}/api${route}`, { method,
          signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(timeout)]),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        await this.guard(job); return value;
      } catch (error) {
        if (error.code === 'WORKSPACE_DELETED') error.message = '클라우드 워크스페이스가 삭제되었습니다. 로컬 원본은 유지됩니다.';
        if (job.controller.signal.aborted || attempt >= retries || error.status && error.status !== 429 && error.status < 500) throw error;
        await delay(500 * 2 ** attempt, undefined, { signal: job.controller.signal });
      }
    }
  }
  start(id) {
    if (this.active) throw new Error('진행 중인 동기화를 먼저 마쳐 주세요.');
    const job = { id, controller: new AbortController() };
    this.active = job;
    const promise = this.run(job).catch(async error => {
      if (error.code === 'WORKSPACE_DELETED' && job.owner) return this.deleted(id, job.owner);
      this.publish(id, { phase: job.controller.signal.aborted ? 'paused' : 'failed', message: job.controller.signal.aborted ? '동기화를 중단했습니다. 다시 눌러 이어서 전송하세요.' : error.message });
      throw error;
    }).finally(() => { job.controller.abort(); if (this.active === job) this.active = null; });
    job.promise = promise; return promise;
  }
  async run(job) {
    Object.assign(job, await this.identity());
    await this.call('cloudStatus', job.id, job.owner); // Refuse another account before sending any folder data.
    this.publish(job.id, { phase: 'preparing', message: '전송할 파일과 수정 이력을 준비하고 있습니다.' });
    const initial = await this.call('cloudState', job.id, job.owner);
    let binding = await this.request(job, '/sync/bindings', 'POST', { device_id: (await this.call('cloudDevice')), local_workspace_id: job.id, name: (await this.call('snapshot', job.id)).workspace.label.slice(0, 120) });
    webURL(binding);
    if (initial.binding && !initial.pending && initial.binding.generation === binding.generation && initial.binding.revision !== binding.revision) throw new Error('클라우드에 더 새로운 작업이 있습니다. 웹에서 내용을 확인한 뒤 연결을 복구해 주세요.');
    await this.call('cloudSet', job.id, job.owner, { binding: initial.binding || binding });
    for (let restart = 0; restart < 2; restart++) {
      let pending = await this.call('cloudPrepare', job.id, job.owner);
      await this.guard(job);
      if (pending.generation !== undefined && pending.generation !== binding.generation) {
        await this.call('cloudDiscard', job.id, job.owner); continue;
      }
      pending = { ...pending, base_revision: pending.base_revision ?? binding.revision, generation: pending.generation ?? binding.generation };
      await this.call('cloudSet', job.id, job.owner, { pending });
      const body = { binding_id: binding.id, generation: pending.generation, request_id: pending.request_id, base_revision: pending.base_revision,
        source_sequence: pending.source_sequence, item_count: pending.items.length, manifest_hash: pending.manifest_hash };
      const session = await this.request(job, `/workspaces/${binding.workspace_id}/sync-sessions`, 'POST', body);
      if (session.state === 'COMMITTED') return this.finish(job, pending, binding, session);
      if (session.state !== 'PREPARING' || new Date(session.expires_at).getTime() <= Date.now()) {
        await this.call('cloudDiscard', job.id, job.owner); continue;
      }
      pending.session_id = session.id;
      await this.call('cloudSet', job.id, job.owner, { pending });
      let prepared = 0;
      for (let offset = 0; offset < pending.items.length;) {
        const page = []; let bytes = 0;
        while (offset < pending.items.length && page.length < 50) {
          const item = pending.items[offset], size = Buffer.byteLength(item.content);
          if (page.length && bytes + size > 1500000) break;
          page.push(item); bytes += size; offset++;
        }
        const result = await this.request(job, `/sync-sessions/${session.id}/items`, 'PUT', { items: page });
        if (result.session.state === 'COMMITTED') return this.finish(job, pending, binding, result.session);
        for (let index = 0; index < result.uploads.length; index += 2) {
          const tickets = result.uploads.slice(index, index + 2);
          await Promise.all(tickets.map(ticket => this.upload(job, pending, ticket)));
          await this.request(job, `/sync-sessions/${session.id}/uploads/complete`, 'POST', { ordinals: tickets.map(ticket => ticket.ordinal) });
        }
        prepared += page.length;
        this.publish(job.id, { phase: 'uploading', completed: prepared, total: pending.items.length, message: `동기화 준비 ${prepared}/${pending.items.length}` });
      }
      this.publish(job.id, { phase: 'committing', message: '웹 작업 공간에 반영하고 있습니다.' });
      const committed = await this.request(job, `/sync-sessions/${session.id}/commit`, 'POST');
      return this.finish(job, pending, binding, committed);
    }
    throw new Error('동기화 세션을 다시 준비하지 못했습니다. 다시 시도해 주세요.');
  }
  async upload(job, pending, ticket) {
    await this.guard(job);
    const item = pending.items[ticket.ordinal];
    if (item?.entity_type !== 'version' || item.entity_id !== ticket.version_id) throw new Error('업로드 응답이 전송 목록과 일치하지 않습니다.');
    const metadata = JSON.parse(item.content), filename = await this.call('cloudBlob', job.id, job.owner, pending.request_id, item.entity_id);
    const data = await this.readBlob(filename);
    if (data.length !== metadata.size || createHash('sha256').update(data).digest('hex') !== metadata.sha256) throw new Error('전송 대기 파일의 내용이 변경되었습니다.');
    const url = new URL(ticket.upload_url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) || url.username || url.password) throw new Error('파일 저장소 주소가 올바르지 않습니다.');
    if (Object.keys(ticket.headers).some(key => ['authorization', 'cookie'].includes(key.toLowerCase()))) throw new Error('파일 저장소 응답이 올바르지 않습니다.');
    await this.guard(job);
    const response = await this.uploader(ticket.upload_url, { method: 'PUT', body: data, headers: ticket.headers, redirect: 'error', signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(120000)]) });
    if (!response.ok && response.status !== 412) throw new Error('파일 업로드를 완료하지 못했습니다. 다시 눌러 이어서 전송해 주세요.');
    await this.guard(job);
  }
  async finish(job, pending, binding, committed) {
    await this.guard(job);
    const state = await this.call('cloudFinish', job.id, job.owner, pending.request_id, binding, committed);
    return this.publish(job.id, { ...state, phase: state.changed ? 'changed' : 'complete', message: state.changed ? '동기화를 완료했습니다. 이후 변경 사항이 남아 있습니다.' : '클라우드 동기화를 완료했습니다.' });
  }
  cancel(id) {
    if (this.active && (!id || this.active.id === id)) { this.active.controller.abort(); void this.call('cloudCancel', this.active.id).catch(() => {}); }
  }
  async detach(id) {
    if (this.active) { this.cancel(id); await this.active.promise.catch(() => {}); }
    const identity = await this.identity(), job = { ...identity, id, controller: new AbortController() };
    const state = await this.call('cloudState', id, job.owner);
    if (state.binding) await this.request(job, `/sync/bindings/${state.binding.id}`, 'DELETE');
    await this.call('cloudDiscard', id, job.owner);
    await this.call('cloudSet', id, job.owner, { binding: null, signature: null, last_synced_at: null });
    return this.publish(id, { phase: 'local', linked: false, changed: true, message: '연결을 해제했습니다. 클라우드 자료는 유지됩니다.' });
  }
  async remove(id) {
    if (this.active) { this.cancel(id); await this.active.promise.catch(() => {}); }
    const identity = await this.identity(), job = { ...identity, id, controller: new AbortController() };
    const state = await this.call('cloudState', id, job.owner);
    if (!state.binding) throw new Error('연결된 클라우드 워크스페이스가 없습니다.');
    await this.request(job, `/workspaces/${state.binding.workspace_id}`, 'DELETE');
    return this.deleted(id, job.owner);
  }
  async restart(id) {
    if (this.active) { this.cancel(id); await this.active.promise.catch(() => {}); }
    const identity = await this.identity(), job = { ...identity, id, controller: new AbortController() };
    const state = await this.call('cloudState', id, job.owner), pending = state.pending;
    if (pending && state.binding && pending.base_revision !== undefined) {
      const session = await this.request(job, `/workspaces/${state.binding.workspace_id}/sync-sessions`, 'POST', {
        binding_id: state.binding.id, generation: pending.generation, request_id: pending.request_id, base_revision: pending.base_revision,
        source_sequence: pending.source_sequence, item_count: pending.items.length, manifest_hash: pending.manifest_hash });
      const result = session.state === 'PREPARING' ? await this.request(job, `/sync-sessions/${session.id}`, 'DELETE') : session;
      if (result.state === 'COMMITTED') await this.call('cloudFinish', id, job.owner, pending.request_id, state.binding, result);
    }
    await this.call('cloudDiscard', id, job.owner);
    return this.start(id);
  }
  async open(id, openExternal) {
    const { owner } = await this.identity(), state = await this.call('cloudState', id, owner);
    if (!state.binding) throw new Error('먼저 클라우드에 동기화해 주세요.');
    await openExternal(webURL(state.binding));
  }
}
