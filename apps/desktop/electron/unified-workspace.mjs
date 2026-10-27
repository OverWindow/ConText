import { randomUUID, createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { UnifiedStore } from './unified-store.mjs';
import { UnifiedLegacyBridge } from './unified-import.mjs';
import { UnifiedFileApplier } from './unified-files.mjs';
import { connectedEntrySQL } from './file-connections.mjs';
import { conflictResolutionBases } from '../core/domain/src/index.js';

// The old SQLite tables are a presentation projection during the v9 transition.
// Portable writes always become named commands executed by the common domain.
const MUTATIONS = [
  'settings', 'savePositions', 'copyFile', 'createDraft', 'saveDraft', 'reviewDraft', 'deleteDraft',
  'importDraft', 'finishGeneration', 'openDocument', 'restoreDocumentVersion', 'setCurrentVersion',
  'linkDocumentVersion', 'createChatSession', 'prepareChat', 'prepareChatRetry', 'finishChat', 'failChat',
  'saveTextFile', 'createTextFile', 'renameFile', 'moveFileToFolder', 'putCanvasItem', 'removeCanvasItem',
  'finishSummary',
];
export class UnifiedWorkspace {
  constructor(engine) {
    this.engine = engine; this.db = engine.db;
    this.store = new UnifiedStore(engine); this.bridge = new UnifiedLegacyBridge(engine, this.store);
    this.files = new UnifiedFileApplier(engine, this.store); this.suppressed = new Set();
  }
  installHooks() {
    for (const name of MUTATIONS) {
      const original = this.engine[name].bind(this.engine), sync = this;
      this.engine[name] = function(id, ...args) {
        const result = original(id, ...args);
        const capture = value => { sync.capture(id); return value; };
        return result && typeof result.then === 'function' ? result.then(capture) : capture(result);
      };
    }
  }
  capture(id, { readOnlyReconcile = false } = {}) {
    if (this.engine.processorOptions.unifiedCommands === false) return;
    const row = this.store.row(id);
    if (readOnlyReconcile && row && JSON.parse(row.workspace).deleted_at) return;
    if (!this.suppressed.has(id) && !this.store.applying.has(id) && row?.import_complete) return this.bridge.capture(id);
  }
  async prepare(id) {
    this.engine.workspace(id); this.suppressed.add(id);
    const cancelled = this.engine.cloud.cancellations.get(id) || 0;
    const check = () => {
      this.engine.workspace(id);
      if ((this.engine.cloud.cancellations.get(id) || 0) !== cancelled) throw Object.assign(new Error('동기화를 중단했습니다.'), { code: 'SYNC_CANCELLED' });
    };
    try {
      if (this.store.row(id) && this.store.state(id).workspace.deleted_at) return this.store.state(id);
      await this.engine.scan(id); check();
      const health = this.engine.health.get(id);
      if (health?.status !== 'ready' || health.truncated || health.warnings?.length) throw new Error('폴더 전체를 읽지 못했습니다. 폴더 상태와 접근 권한을 확인해 주세요.');
      this.store.ensure(id);
      const candidates = this.db.prepare(`SELECT e.*,d.id AS document_id,m.status AS mapping_status
        FROM entries e LEFT JOIN local_documents d ON d.entry_id=e.id
        LEFT JOIN unified_file_mappings m ON m.workspace_id=e.workspace_id AND m.entry_id=e.id
        WHERE e.workspace_id=? AND e.kind='file' AND e.present=1 AND e.excluded=0 AND ${connectedEntrySQL()} ORDER BY e.id`).all(id);
      for (const candidate of candidates) {
        check(); if (candidate.mapping_status === 'remote_deleted') continue;
        if (this.engine.excluded(this.engine.workspace(id).root, path.join(this.engine.workspace(id).root, candidate.relative_path), this.engine.workspace(id))) continue;
        const { entry, data, sha256 } = await this.engine.cloud.read(id, candidate.id); check();
        this.store.transaction(() => {
          const document = this.db.prepare('SELECT * FROM local_documents WHERE workspace_id=? AND entry_id=?').get(id, entry.id);
          if (!document) throw new Error('문서 식별자가 없어 원본 수집을 중단했습니다.');
          const previous = document.file_version_id ? this.db.prepare('SELECT sha256 FROM local_versions WHERE id=?').get(document.file_version_id) : null;
          if (previous?.sha256 === sha256) return;
          const number = this.db.prepare('SELECT coalesce(max(version_number),0)+1 AS n FROM local_versions WHERE document_id=?').get(document.id).n;
          const versionId = randomUUID();
          const origin = number === 1 ? this.engine.documents.copyOrigin(id, entry, sha256) : { source_version_id: null, change_note: null };
          const normalized = { schema_version: 1, sync_only: true, title: entry.name, source_filename: entry.name, source_sha256: sha256, blocks: [], warnings: [], page_count: null };
          this.db.prepare('INSERT INTO local_versions(id,document_id,version_number,filename,sha256,bytes,normalized,created_at,source_version_id,change_note) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(versionId, document.id, number, entry.name, sha256, data, JSON.stringify(normalized), Date.now(), origin.source_version_id, origin.change_note);
          this.engine.documents.change(id, versionId, 'document.version.create', 1, { document_id: document.id, version_number: number, sha256 });
          this.engine.documents.observeVersion(id, document.id, versionId);
        });
      }
      check(); return this.bridge.capture(id);
    } finally { this.suppressed.delete(id); }
  }
  identity(id) {
    const row = this.store.ensure(id);
    return { workspace: JSON.parse(row.workspace), device_id: row.device_id, cursor: row.cursor, linked: !!row.linked };
  }
  allowRestoration(id, before, state) {
    for (const conflict of Object.values(state.conflicts)) if (conflict.status === 'resolved' && before.conflicts[conflict.id]?.status !== 'resolved' && conflict.resolution?.choice === 'keep_current' && conflict.candidate?.type === 'TrashEntry') {
      const pending = [conflict.candidate.payload.id];
      for (let i = 0; i < pending.length; i++) { const entry = state.entries[pending[i]]; if (!entry || entry.deleted_at) continue; this.db.prepare("UPDATE unified_file_mappings SET status='restore' WHERE workspace_id=? AND entry_id=?").run(id, entry.id); for (const child of Object.values(state.entries)) if (child.parent_id === entry.id && !child.deleted_at) pending.push(child.id); }
    }
  }
  async bootstrap(id, state, cursor) { this.store.transaction(() => { const before = this.store.state(id); this.store.bootstrap(id, state, cursor); this.allowRestoration(id, before, this.store.state(id)); this.bridge.project(id); }); if (state.workspace.deleted_at) await this.apply(id); }
  async receive(id, changes, cursor) { this.store.transaction(() => { const before = this.store.state(id); this.store.receive(id, changes, cursor); this.allowRestoration(id, before, this.store.state(id)); this.bridge.project(id); }); if (this.store.state(id).workspace.deleted_at) await this.apply(id); }
  async apply(id) {
    this.suppressed.add(id); this.engine.mutating.add(id);
    try {
      // An in-flight parser must not observe the temporary rename namespace or
      // publish a second UUID while a verified remote original reaches disk.
      const indexing = this.engine.documents.indexJobs.get(id);
      if (indexing) { indexing.cancelled = true; indexing.controller.abort(); await indexing.promise.catch(() => {}); }
      this.bridge.project(id);
      const result = await this.files.apply(id);
      this.bridge.project(id);
      return result;
    } finally {
      this.engine.mutating.delete(id);
      try { await this.engine.scan(id); } finally { this.suppressed.delete(id); }
      this.engine.emit('changed', id);
    }
  }
  async attach(root, state, cursor, owner) {
    root = await this.engine.checkedRoot(root);
    if ((await readdir(root)).length) throw new Error('클라우드 작업 공간을 받을 빈 폴더를 선택해 주세요.');
    if (this.db.prepare('SELECT id FROM workspaces WHERE id=? OR root=?').get(state.workspace.id, root)) throw new Error('이미 연결된 작업 공간 또는 폴더입니다. 기존 연결을 열어 주세요.');
    this.store.transaction(() => {
      this.db.prepare('INSERT INTO workspaces(id,root,label,last_opened) VALUES(?,?,?,?)').run(state.workspace.id, root, state.workspace.name, Date.now());
      this.db.prepare('INSERT INTO local_canvas_scopes(id,workspace_id,directory) VALUES(?,?,?)').run(state.workspace.root_entry_id, state.workspace.id, '');
      this.store.ensure(state.workspace.id); this.store.bind(state.workspace.id, owner);
      this.store.bootstrap(state.workspace.id, state, cursor);
      this.db.prepare('UPDATE unified_spaces SET import_complete=1 WHERE workspace_id=?').run(state.workspace.id);
      this.bridge.project(state.workspace.id);
    });
    if (this.engine.watchFiles) await this.engine.startWatcher(state.workspace.id);
    return this.engine.snapshot(state.workspace.id);
  }
  conflicts(id) {
    const state = this.store.state(id);
    return Object.values(state.conflicts).filter(conflict => conflict.status === 'open').map(conflict => ({
      ...conflict, current: state[conflict.entity_collection]?.[conflict.entity_id] || null,
      base_revisions: conflictResolutionBases(state, conflict),
    }));
  }
  recovery(id) {
    this.store.ensure(id);
    const blocked = this.db.prepare("SELECT operation_id,command,result,created_at FROM unified_outbox WHERE workspace_id=? AND state='blocked' ORDER BY sequence").all(id).map(row => ({ id: row.operation_id, title: JSON.parse(row.command).type, has_original: JSON.parse(row.command).type === 'AppendDocumentVersion', reason: JSON.parse(row.result || '{}').error?.message || '서버가 변경을 거절했습니다.', created_at: Date.parse(row.created_at), candidate: { command: JSON.parse(row.command), receipt: JSON.parse(row.result || '{}') } }));
    const files = this.db.prepare("SELECT * FROM unified_apply_journal WHERE workspace_id=? AND state!='complete' ORDER BY created_at").all(id).map(row => ({ id: row.id, title: `파일 적용: ${row.action}`, reason: row.error || '다음 동기화에서 파일 상태를 다시 확인합니다.', created_at: Date.parse(row.created_at), candidate: { entry_id: row.entry_id, version_id: row.version_id, state: row.state, ...JSON.parse(row.payload) } }));
    return [...blocked, ...files];
  }
  recoveryOutput(id, recordId) {
    const item = this.recovery(id).find(row => row.id === recordId);
    if (!item) throw new Error('복구 기록을 찾지 못했습니다.');
    return { title: `context-recovery-${recordId}`, data: Buffer.from(JSON.stringify({ schema_version: 2, workspace_id: id, ...item }, null, 2)).toString('base64') };
  }
  recoveryOriginal(id, recordId) {
    const row = this.db.prepare("SELECT command FROM unified_outbox WHERE workspace_id=? AND operation_id=? AND state='blocked'").get(id, recordId);
    const command = row && JSON.parse(row.command);
    if (command?.type !== 'AppendDocumentVersion') throw new Error('이 기록에는 원본 파일이 없습니다.');
    const expected = command.payload.version.blob, bytes = Buffer.from(this.store.blob(id, expected.id).data);
    if (bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error('복구 원본의 무결성 정보가 다릅니다.');
    return { title: `context-recovered-${recordId}`, data: bytes.toString('base64') };
  }
  async resolve(id, type, payload, bases) {
    if (type !== 'ResolveConflict') throw new Error('지원하지 않는 충돌 해결 명령입니다.');
    this.store.transaction(() => { const before = this.store.state(id); this.store.enqueue(id, this.store.command(id, type, payload, bases)); this.allowRestoration(id, before, this.store.state(id)); });
    await this.apply(id); return this.store.status(id);
  }
  status(id) {
    const status = this.store.status(id);
    return { ...status, paused: this.db.prepare('SELECT value FROM local_settings WHERE key=?').get(`unified-paused:${id}`)?.value === '1' };
  }
  bind(id, owner) { this.db.prepare('DELETE FROM local_settings WHERE key=?').run(`unified-paused:${id}`); return this.store.bind(id, owner); }
  detach(id) { this.engine.cloudCancel(id); this.db.prepare('INSERT INTO local_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`unified-paused:${id}`, '1'); return this.status(id); }
  list() { return this.db.prepare('SELECT workspace_id FROM unified_spaces WHERE linked=1 AND server IS NOT NULL').all().map(row => ({ id: row.workspace_id, ...this.status(row.workspace_id) })); }
  async recover() {
    for (const row of this.db.prepare("SELECT DISTINCT workspace_id FROM unified_apply_journal WHERE state!='complete'").all()) {
      try { await this.apply(row.workspace_id); } catch { /* Journal and original bytes remain available for the recovery UI. */ }
    }
  }
}
