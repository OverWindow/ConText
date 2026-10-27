import { connectedEntrySQL } from './file-connections.mjs';
import { randomUUID } from 'node:crypto';

const encode = JSON.stringify;
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
const invalid = message => { const error = new Error(message); error.code = 'AI_INVALID_RESPONSE'; throw error; };
export function validateClaims(result, sources) {
  const allowed = new Set(sources.map(source => source.id));
  if (!result || !Array.isArray(result.claims) || result.claims.length > 12 || typeof result.insufficient !== 'boolean' || (!result.claims.length && !result.insufficient)) invalid('AI 답변 형식을 검증하지 못했습니다.');
  for (const claim of result.claims) {
    if (typeof claim.text !== 'string' || !claim.text || claim.text.length > 1500 || !Array.isArray(claim.source_ids) || !claim.source_ids.length || claim.source_ids.length > 8 || claim.source_ids.some(id => !allowed.has(id))) invalid('AI 답변의 출처를 검증하지 못했습니다.');
  }
}

export class LocalChat {
  constructor(engine) {
    this.engine = engine; this.db = engine.db;
    this.recoverInterrupted();
  }
  recoverInterrupted() {
    this.db.exec("UPDATE local_chat_messages SET state='FAILED',error_code='WORKER_INTERRUPTED' WHERE role='assistant' AND state IN ('QUEUED','RUNNING')");
  }
  session(workspaceId, sessionId) {
    this.engine.workspace(workspaceId);
    const row = this.db.prepare('SELECT * FROM local_chat_sessions WHERE id=? AND workspace_id=?').get(sessionId, workspaceId);
    if (!row) invalid('대화를 찾을 수 없습니다.');
    return row;
  }
  sessions(workspaceId, offset = 0) {
    this.engine.workspace(workspaceId);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) invalid('대화 목록 범위가 올바르지 않습니다.');
    return this.db.prepare(`SELECT s.id,s.title FROM local_chat_sessions s WHERE s.workspace_id=?
      AND NOT EXISTS (SELECT 1 FROM unified_entities logical WHERE logical.workspace_id=s.workspace_id
        AND logical.layer='view' AND logical.collection='chat_sessions' AND logical.entity_id=s.id
        AND json_extract(logical.value,'$.deleted_at') IS NOT NULL)
      ORDER BY s.updated_at DESC,s.id LIMIT 50 OFFSET ?`).all(workspaceId, offset);
  }
  create(workspaceId, input) {
    this.engine.workspace(workspaceId);
    if (!input || !uuid(input.requestId) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120) invalid('대화 정보가 올바르지 않습니다.');
    const previous = this.db.prepare('SELECT id,title FROM local_chat_sessions WHERE workspace_id=? AND request_id=?').get(workspaceId, input.requestId);
    if (previous) return previous;
    const id = randomUUID(), now = Date.now();
    this.write(workspaceId, () => this.db.prepare('INSERT INTO local_chat_sessions VALUES(?,?,?,?,?,?)').run(id, workspaceId, input.requestId, input.title.trim(), now, now));
    return { id, title: input.title.trim() };
  }
  read(row) {
    return { id: row.id, role: row.role, state: row.state, content: row.content, error_code: row.error_code,
      result: row.result ? JSON.parse(row.result) : null, created_at: new Date(row.created_at).toISOString() };
  }
  write(workspaceId, action) {
    return this.engine.documents.transaction(() => {
      const result = action(); this.engine.unified?.capture(workspaceId); return result;
    });
  }
  messages(workspaceId, sessionId) {
    this.session(workspaceId, sessionId);
    return this.db.prepare('SELECT * FROM local_chat_messages WHERE session_id=? ORDER BY sequence').all(sessionId).map(row => this.read(row));
  }
  validate(input) {
    if (!input || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 2000 || !['auto', 'current', 'history', 'as_of'].includes(input.scope)) invalid('질문 또는 검색 범위가 올바르지 않습니다.');
    if (input.scope === 'as_of' && (!/^\d{4}-\d{2}-\d{2}$/.test(input.as_of || '') || input.as_of > new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()))) invalid('검색 기준 날짜가 올바르지 않습니다.');
  }
  async evidence(workspaceId, input) {
    this.validate(input);
    await this.engine.documents.indexWorkspace(workspaceId);
    const scope = input.scope === 'auto' ? /과거|이전|지난|작년|변경\s*전|\d{4}[-년./]/.test(input.question) ? 'history' : 'current' : input.scope;
    const candidates = this.engine.documents.search(workspaceId, input.question, scope, input.as_of);
    const sources = []; let budget = 24000;
    for (const source of candidates) {
      if (sources.length >= 12 || budget <= 0) break;
      const text = source.text.slice(0, Math.min(4000, budget)); budget -= text.length;
      sources.push({ ...source, text, chunk_id: source.id });
    }
    const indexing = this.engine.documents.indexStatus.get(workspaceId);
    return { scope, as_of: scope === 'as_of' ? input.as_of : null, sources, warnings: indexing && (indexing.failed || indexing.state !== 'complete' || indexing.completed < indexing.total) ? ['INDEX_INCOMPLETE'] : [] };
  }
  indexStatus(workspaceId) {
    this.engine.workspace(workspaceId);
    const current = this.db.prepare(`SELECT count(*) AS n FROM entries e WHERE e.workspace_id=? AND e.present=1 AND ${connectedEntrySQL()} AND e.kind='file' AND e.extension IN ('.txt','.md','.pdf','.docx','.hwpx')`).get(workspaceId).n;
    const complete = this.db.prepare(`SELECT count(*) AS n FROM local_documents d JOIN entries e ON e.id=d.entry_id WHERE d.workspace_id=? AND e.present=1 AND ${connectedEntrySQL()} AND d.current_version_id IS NOT NULL`).get(workspaceId).n;
    const chunks = this.db.prepare(`SELECT count(*) AS n FROM local_search s JOIN local_documents d ON d.id=s.document_id JOIN entries e ON e.id=d.entry_id WHERE s.workspace_id=? AND ${connectedEntrySQL()}`).get(workspaceId).n;
    const versions = this.db.prepare(`SELECT count(*) AS n FROM local_versions v JOIN local_documents d ON d.id=v.document_id JOIN entries e ON e.id=d.entry_id WHERE d.workspace_id=? AND ${connectedEntrySQL()}`).get(workspaceId).n;
    const failed = this.engine.documents.indexStatus.get(workspaceId)?.failed || 0;
    return { current: { versions: current, completed: complete, failed, chunks, indexed_chunks: chunks }, all: { versions, completed: versions, failed, chunks, indexed_chunks: chunks } };
  }
  async prepare(workspaceId, sessionId, input) {
    this.session(workspaceId, sessionId); this.validate(input);
    if (!uuid(input.requestId)) invalid('요청 식별자가 올바르지 않습니다.');
    const previous = this.db.prepare("SELECT * FROM local_chat_messages WHERE session_id=? AND request_id=? AND role='assistant'").get(sessionId, input.requestId);
    if (previous) {
      if (encode(JSON.parse(previous.options)) !== encode(input)) invalid('다른 질문에 사용한 요청 식별자입니다.');
      return { existing: this.read(previous) };
    }
    const evidence = await this.evidence(workspaceId, input);
    const id = randomUUID();
    this.write(workspaceId, () => {
      const sequence = this.db.prepare('SELECT coalesce(max(sequence),0)+1 AS n FROM local_chat_messages WHERE session_id=?').get(sessionId).n;
      const now = Date.now(), insert = this.db.prepare('INSERT INTO local_chat_messages VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      insert.run(randomUUID(), sessionId, input.requestId, sequence, 'user', 'COMPLETED', input.question, null, encode(input), null, now);
      insert.run(id, sessionId, input.requestId, sequence + 1, 'assistant', 'RUNNING', '', null, encode(input), null, now);
      this.db.prepare('UPDATE local_chat_sessions SET updated_at=? WHERE id=?').run(now, sessionId);
    });
    return { messageId: id, request_id: input.requestId, task: 'chat', prompt: input.question, sources: evidence.sources, evidence };
  }
  async retry(workspaceId, sessionId, messageId) {
    this.session(workspaceId, sessionId);
    const row = this.db.prepare("SELECT * FROM local_chat_messages WHERE id=? AND session_id=? AND role='assistant' AND state='FAILED'").get(messageId, sessionId);
    if (!row) invalid('실패한 답변만 다시 요청할 수 있습니다.');
    const last = this.db.prepare('SELECT id FROM local_chat_messages WHERE session_id=? ORDER BY sequence DESC LIMIT 1').get(sessionId);
    if (last.id !== messageId) invalid('가장 최근 답변만 다시 요청할 수 있습니다.');
    const input = JSON.parse(row.options), requestId = randomUUID();
    const evidence = await this.evidence(workspaceId, input);
    this.write(workspaceId, () => this.db.prepare("UPDATE local_chat_messages SET request_id=?,state='RUNNING',error_code=NULL WHERE id=?").run(requestId, messageId));
    return { messageId, request_id: requestId, task: 'chat', prompt: input.question, sources: evidence.sources, evidence };
  }
  finish(workspaceId, sessionId, prepared, result) {
    this.session(workspaceId, sessionId);
    validateClaims(result, prepared.sources);
    const grounded = { ...prepared.evidence, claims: result.claims, insufficient: result.insufficient };
    const content = result.claims.map(claim => claim.text).join('\n\n') || '선택한 문서 범위에서 답변할 근거를 찾지 못했습니다. 검색 범위와 본문 준비 상태를 확인해 주세요.';
    this.write(workspaceId, () => {
      const changed = this.db.prepare("UPDATE local_chat_messages SET state='COMPLETED',content=?,result=?,error_code=NULL WHERE id=? AND session_id=? AND request_id=? AND state='RUNNING'").run(content, encode(grounded), prepared.messageId, sessionId, prepared.request_id);
      if (!changed.changes) invalid('답변 상태가 변경되었습니다. 대화를 다시 열어 주세요.');
    });
    return this.read(this.db.prepare('SELECT * FROM local_chat_messages WHERE id=?').get(prepared.messageId));
  }
  fail(workspaceId, sessionId, prepared, code) {
    this.session(workspaceId, sessionId);
    const publicCode = ['AI_FORBIDDEN', 'AI_RATE_LIMITED', 'AI_TIMEOUT', 'AI_UNSUPPORTED_REQUEST', 'AI_INVALID_RESPONSE', 'AI_REQUEST_ALREADY_SUBMITTED'].includes(code) ? code : 'AI_UNAVAILABLE';
    this.write(workspaceId, () => this.db.prepare("UPDATE local_chat_messages SET state='FAILED',error_code=? WHERE id=? AND session_id=? AND request_id=? AND state='RUNNING'").run(publicCode, prepared.messageId, sessionId, prepared.request_id));
  }
}
