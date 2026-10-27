import { validateClaims } from './local-chat.mjs';

export class LocalInsights {
  constructor(engine) { this.engine = engine; this.db = engine.db; }
  key(workspaceId, documentId, left, right) {
    this.engine.documents.version(workspaceId, documentId, left);
    this.engine.documents.version(workspaceId, documentId, right);
    if (left === right) throw new Error('서로 다른 수정 이력을 선택해 주세요.');
    return `change-summary:${workspaceId}:${documentId}:${left}:${right}`;
  }
  get(workspaceId, documentId, left, right) {
    const key = this.key(workspaceId, documentId, left, right), row = this.db.prepare('SELECT value FROM local_settings WHERE key=?').get(key);
    if (!row) return null;
    const value = JSON.parse(row.value);
    return { state: value.state, result: value.result || null };
  }
  async prepare(workspaceId, documentId, left, right, requestId) {
    const key = this.key(workspaceId, documentId, left, right);
    if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('요약 요청 식별자가 올바르지 않습니다.');
    const row = this.db.prepare('SELECT value FROM local_settings WHERE key=?').get(key), previous = row ? JSON.parse(row.value) : null;
    if (previous?.state === 'complete') return { existing: previous.result };
    if (previous?.requestId === requestId) throw new Error('이미 접수한 요약 요청입니다. 처리 여부가 불명확하므로 자동 재전송하지 않습니다.');
    const diff = await this.engine.documents.compare(workspaceId, documentId, left, right);
    const before = this.engine.documents.version(workspaceId, documentId, left), after = this.engine.documents.version(workspaceId, documentId, right);
    const sources = []; let budget = 24000;
    for (const change of diff.changes.slice(0, 8)) {
      const text = `유형: ${change.kind}\n이전: ${change.before?.text || '(없음)'}\n이후: ${change.after?.text || '(없음)'}`.slice(0, Math.min(budget, 4000)); budget -= text.length;
      sources.push({ id: change.id, kind: 'change', document_title: `${before.filename} → ${after.filename}`.slice(0, 300), text });
    }
    const partial = diff.truncated || sources.length < diff.total_changes;
    this.db.prepare('INSERT INTO local_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify({ state: 'pending', requestId, sources, partial }));
    return { request_id: requestId, task: 'summary', prompt: '두 수정 이력의 추가·삭제·수정 사항을 한국어로 요약해 주세요. 제공된 변경 근거만 사용하고 모든 주장에 change 출처 id를 연결해 주세요. 수치가 변했으면 전후 값을 명시하세요.', sources, current: null };
  }
  finish(workspaceId, documentId, left, right, requestId, result, model) {
    const key = this.key(workspaceId, documentId, left, right), row = this.db.prepare('SELECT value FROM local_settings WHERE key=?').get(key);
    const state = row ? JSON.parse(row.value) : null;
    if (!state || state.state !== 'pending' || state.requestId !== requestId) throw new Error('변경 요약 요청 상태가 변경되었습니다.');
    validateClaims(result, state.sources);
    const value = { claims: result.claims, insufficient: result.insufficient, partial: state.partial, model: typeof model === 'string' ? model.slice(0, 200) : '', finished_at: new Date().toISOString() };
    this.db.prepare('UPDATE local_settings SET value=? WHERE key=?').run(JSON.stringify({ ...state, state: 'complete', result: value }), key);
    return value;
  }
}
