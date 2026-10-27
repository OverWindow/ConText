import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const encode = JSON.stringify;
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);

export class LocalSummaries {
  constructor(engine) { this.engine = engine; this.db = engine.db; }
  state(workspaceId, input) {
    this.engine.workspace(workspaceId);
    if (!input || !uuid(input.request_id) || !Array.isArray(input.entry_ids) || !input.entry_ids.length || input.entry_ids.length > 8 || new Set(input.entry_ids).size !== input.entry_ids.length || !input.entry_ids.every(uuid) ||
      ![input.x, input.y].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 99500)) throw new Error('요약할 파일과 위치를 확인해 주세요.');
    this.engine.canvas.scope(workspaceId, input.directory);
    const key = `summary-request:${workspaceId}:${input.request_id}`, fingerprint = hash(encode(input));
    const row = this.db.prepare('SELECT value FROM local_settings WHERE key=?').get(key);
    const state = row ? JSON.parse(row.value) : null;
    if (state && state.fingerprint !== fingerprint) throw new Error('다른 요약에 사용한 요청 식별자입니다.');
    return { key, fingerprint, state };
  }
  store(key, value) { this.db.prepare('INSERT INTO local_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, encode(value)); }
  async prepare(workspaceId, input) {
    const { key, fingerprint, state } = this.state(workspaceId, input);
    if (state?.status === 'complete') return { existing: this.engine.snapshot(workspaceId).entries.find(entry => entry.id === state.entryId) || null, completed: true };
    if (state?.status === 'generated') return { resume: true };
    if (state) throw new Error('접수된 요약 요청입니다. 처리 여부가 불명확하므로 자동으로 재전송하지 않습니다. 문서 작성 목록에서 결과를 확인해 주세요.');
    if (this.db.prepare('SELECT id FROM local_drafts WHERE workspace_id=? AND request_id=?').get(workspaceId, input.request_id)) throw new Error('이미 사용한 요청 식별자입니다.');
    const folder = input.directory ? this.db.prepare("SELECT id FROM entries WHERE workspace_id=? AND relative_path=? AND kind='directory' AND present=1").get(workspaceId, input.directory) : null;
    if (input.directory && !folder) throw new Error('요약 파일을 만들 폴더를 찾을 수 없습니다.');
    const sources = [], maxBlocks = Math.floor(20 / input.entry_ids.length), perDocument = Math.floor(24000 / input.entry_ids.length);
    for (const entryId of input.entry_ids) {
      const document = await this.engine.documents.open(workspaceId, entryId);
      let budget = perDocument, count = 0;
      for (const block of document.normalized.blocks) {
        if (budget <= 0 || count >= maxBlocks) break;
        if (!block.text.trim()) continue;
        const text = block.text.slice(0, Math.min(budget, 4000)); budget -= text.length; count++;
        sources.push({ id: `version-${document.version_id}-block-${block.id}`, kind: 'document', document_id: document.document_id, version_id: document.version_id,
          version_number: document.version_number, document_title: document.filename, text, locations: [{ block_id: block.id, ...block.source }] });
      }
      if (!count) throw new Error(`${document.filename}: 요약할 본문이 없습니다.`);
    }
    this.store(key, { fingerprint, status: 'pending', sources, directoryId: folder?.id || null });
    return { request_id: input.request_id, task: 'write', prompt: '선택한 파일들의 핵심 내용과 공통점, 차이점을 한국어 문서로 요약해 주세요. 사실과 수치는 제공된 근거에만 기반하고 각 문단에 출처를 연결해 주세요.', sources, current: null };
  }
  async finish(workspaceId, input, result) {
    const { key, state } = this.state(workspaceId, input);
    if (!state) throw new Error('요약 요청을 찾을 수 없습니다.');
    if (state.status === 'complete') return this.engine.snapshot(workspaceId).entries.find(entry => entry.id === state.entryId) || null;
    if (state.status !== 'generated') {
      if (!result || !Array.isArray(result.checks) || result.checks.length > 30 || result.checks.some(c => typeof c !== 'string' || c.length > 1000)) throw new Error('요약 응답을 검증하지 못했습니다.');
      const draft = this.engine.documents.create(workspaceId, input.request_id, { content: result.content, sources: state.sources, checks: result.checks });
      state.status = 'generated'; state.draftId = draft.id; state.revision = draft.revision; this.store(key, state);
    }
    const workspace = this.engine.workspace(workspaceId);
    const folder = state.directoryId ? await this.engine.resolveEntry(workspaceId, state.directoryId) : null;
    const parent = folder?.filename || await realpath(workspace.root);
    if (parent !== (folder?.filename || workspace.root)) throw new Error('폴더 위치가 변경되었습니다. 다시 연결해 주세요.');
    const filename = path.join(parent, `요약-${input.request_id.slice(0, 8)}.md`);
    const output = await this.engine.renderDraft(workspaceId, state.draftId, state.revision, 'md'), bytes = Buffer.from(output.data, 'base64');
    let alreadySaved = false;
    try {
      const stat = await lstat(filename);
      alreadySaved = stat.isFile() && !stat.isSymbolicLink() && stat.size <= 50 * 1024 * 1024 && hash(await readFile(filename)) === hash(bytes) &&
        !!this.db.prepare("SELECT id FROM save_journal WHERE workspace_id=? AND draft_id=? AND destination=? AND state='complete'").get(workspaceId, state.draftId, filename);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!alreadySaved) await this.engine.documents.writeFile(workspaceId, state.draftId, state.revision, filename, bytes, null);
    await this.engine.scan(workspaceId);
    const relative = path.relative(workspace.root, filename).split(path.sep).join('/');
    const entry = this.engine.snapshot(workspaceId).entries.find(e => e.relative_path === relative);
    if (!entry) throw new Error('생성한 요약 파일은 저장됐습니다. 폴더를 새로고침해 주세요.');
    await this.engine.documents.open(workspaceId, entry.id);
    this.engine.savePositions(workspaceId, [{ id: entry.id, x: input.x, y: input.y }]);
    for (const source of input.entry_ids) {
      if (!this.db.prepare('SELECT id FROM entries WHERE workspace_id=? AND id=? AND present=1').get(workspaceId, source)) continue;
      const relation = { id: hash(`${input.request_id}:${source}`).slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'), source_document_id: entry.id, target_document_id: source, relation_type: 'GENERATED_FROM' };
      const previous = this.db.prepare('SELECT revision FROM local_canvas WHERE id=?').get(relation.id);
      if (!previous) this.engine.canvas.put(workspaceId, folder?.relative_path || '', 'relation', relation, 0);
    }
    state.status = 'complete'; state.entryId = entry.id; this.store(key, state); this.engine.emit('changed', workspaceId);
    return { ...entry, x: input.x, y: input.y };
  }
}
