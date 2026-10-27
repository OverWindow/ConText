import { connectedEntrySQL } from './file-connections.mjs';
import { randomUUID } from 'node:crypto';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const finite = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const conflict = () => { throw new Error('다른 창에서 캔버스가 변경되었습니다. 새로고침 후 다시 시도해 주세요.'); };

export class LocalCanvas {
  constructor(engine) { this.engine = engine; this.db = engine.db; }
  scope(workspaceId, directory) {
    this.engine.workspace(workspaceId);
    if (typeof directory !== 'string' || directory.length > 4096 || directory.startsWith('/') || directory.split('/').some(p => p === '..') || directory.includes('\\')) throw new Error('캔버스 위치가 올바르지 않습니다.');
    let row = this.db.prepare('SELECT id FROM local_canvas_scopes WHERE workspace_id=? AND directory=?').get(workspaceId, directory);
    if (!row) { row = { id: randomUUID() }; this.db.prepare('INSERT INTO local_canvas_scopes VALUES(?,?,?)').run(row.id, workspaceId, directory); }
    return row.id;
  }
  snapshot(workspaceId, directory) {
    const scope = this.scope(workspaceId, directory);
    const rows = this.db.prepare('SELECT * FROM local_canvas WHERE workspace_id=? AND scope_id=? AND deleted=0').all(workspaceId, scope);
    const present = new Set(this.db.prepare(`SELECT e.id FROM entries e WHERE e.workspace_id=? AND e.present=1 AND ${connectedEntrySQL()}`).all(workspaceId).map(row => row.id));
    const values = kind => rows.filter(row => row.kind === kind).map(row => ({ ...JSON.parse(row.payload), revision: row.revision }));
    return { elements: values('element'), relations: values('relation').filter(r => present.has(r.source_document_id) && present.has(r.target_document_id)) };
  }
  validate(workspaceId, kind, value) {
    if (!value || !uuid(value.id)) throw new Error('캔버스 식별자가 올바르지 않습니다.');
    if (kind === 'element') {
      if (!['text', 'rectangle', 'ellipse', 'triangle'].includes(value.kind) || typeof value.text !== 'string' || value.text.length > 5000 ||
        !finite(value.x, -100000, 100000) || !finite(value.y, -100000, 100000) || !finite(value.width, 80, 2000) || !finite(value.height, 60, 2000) ||
        !finite(value.font_size, 12, 96) || !['violet', 'blue', 'green', 'amber', 'rose', 'slate'].includes(value.color)) throw new Error('텍스트·도형 값이 올바르지 않습니다.');
      const { id, kind, text, x, y, width, height, color, font_size } = value;
      return { id, kind, text, x, y, width, height, color, font_size };
    }
    if (kind !== 'relation' || !['REFERENCE', 'DERIVED_FROM', 'GENERATED_FROM', 'RELATED_TO'].includes(value.relation_type) || value.source_document_id === value.target_document_id) throw new Error('문서 연결 값이 올바르지 않습니다.');
    const entry = this.db.prepare(`SELECT e.id FROM entries e WHERE e.workspace_id=? AND e.id=? AND e.present=1 AND e.kind='file' AND ${connectedEntrySQL()}`);
    if (!entry.get(workspaceId, value.source_document_id) || !entry.get(workspaceId, value.target_document_id)) throw new Error('같은 작업 공간의 파일끼리 연결해 주세요.');
    const { id, source_document_id, target_document_id, relation_type } = value;
    const source_handle = value.source_handle || 'right', target_handle = value.target_handle || 'left';
    if (![source_handle, target_handle].every(h => ['left', 'right', 'top', 'bottom'].includes(h))) throw new Error('연결점이 올바르지 않습니다.');
    return { id, source_document_id, target_document_id, relation_type, source_handle, target_handle };
  }
  put(workspaceId, directory, kind, value, expectedRevision) {
    const scope = this.scope(workspaceId, directory);
    const payload = this.validate(workspaceId, kind, value);
    const result = this.engine.documents.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM local_canvas WHERE id=?').get(value.id);
      if (existing && (existing.workspace_id !== workspaceId || existing.scope_id !== scope || existing.kind !== kind)) throw new Error('다른 캔버스의 요소는 수정할 수 없습니다.');
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || (existing?.revision || 0) !== expectedRevision) conflict();
      if (existing && !existing.deleted && existing.payload === JSON.stringify(payload)) return { ...payload, revision: existing.revision };
      if (!existing && this.db.prepare('SELECT count(*) AS n FROM local_canvas WHERE scope_id=? AND deleted=0').get(scope).n >= 5000) throw new Error('한 캔버스에는 최대 5,000개 요소를 저장할 수 있습니다.');
      if (kind === 'relation') {
        const duplicate = this.db.prepare("SELECT * FROM local_canvas WHERE scope_id=? AND kind='relation' AND deleted=0 AND id<>?").all(scope, value.id)
          .find(row => { const r = JSON.parse(row.payload); return r.source_document_id === payload.source_document_id && r.target_document_id === payload.target_document_id && r.relation_type === payload.relation_type; });
        if (duplicate) return { ...JSON.parse(duplicate.payload), revision: duplicate.revision };
      }
      const revision = expectedRevision + 1;
      this.db.prepare('INSERT INTO local_canvas VALUES(?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,deleted=0')
        .run(payload.id, workspaceId, scope, kind, JSON.stringify(payload), revision);
      const syncPayload = { scope_id: scope, ...payload };
      if (kind === 'relation') {
        const document = this.db.prepare('SELECT id FROM local_documents WHERE workspace_id=? AND entry_id=?');
        syncPayload.source_document_id = document.get(workspaceId, payload.source_document_id).id;
        syncPayload.target_document_id = document.get(workspaceId, payload.target_document_id).id;
      }
      this.engine.documents.change(workspaceId, payload.id, `canvas.${kind}.save`, revision, syncPayload);
      return { ...payload, revision };
    });
    this.engine.emit('changed', workspaceId); return result;
  }
  remove(workspaceId, directory, id, expectedRevision) {
    const scope = this.scope(workspaceId, directory);
    this.engine.documents.transaction(() => {
      const row = this.db.prepare('SELECT * FROM local_canvas WHERE id=? AND workspace_id=? AND scope_id=? AND deleted=0').get(id, workspaceId, scope);
      if (!row || !Number.isInteger(expectedRevision) || row.revision !== expectedRevision) conflict();
      this.db.prepare('UPDATE local_canvas SET deleted=1,revision=revision+1 WHERE id=?').run(id);
      this.engine.documents.change(workspaceId, id, `canvas.${row.kind}.delete`, expectedRevision + 1, { scope_id: scope, deleted: true });
    });
    this.engine.emit('changed', workspaceId);
  }
}
