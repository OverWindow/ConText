import { randomUUID } from 'node:crypto';
import { backup } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { applyChanges, applyCommand, createWorkspaceState } from '../core/domain/src/index.js';

export const COLLECTIONS = ['entries', 'documents', 'versions', 'canvas_elements', 'relations', 'drafts', 'proposals', 'chat_sessions', 'chat_messages', 'artifacts', 'conflicts'];
export async function migrateUnified(db, directory) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 10) throw new Error('더 새로운 앱에서 만든 저장소입니다. 앱을 업데이트해 주세요.');
  if (version === 10) { db.exec('CREATE INDEX IF NOT EXISTS unified_file_paths ON unified_file_mappings(workspace_id,relative_path)'); return; }
  if (db.prepare('SELECT count(*) AS n FROM workspaces').get().n) {
    await mkdir(path.join(directory, 'backups'), { recursive: true, mode: 0o700 });
    await backup(db, path.join(directory, 'backups', `workspace-v${version}-before-unified-${Date.now()}.sqlite`));
  }
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS unified_spaces (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      workspace TEXT NOT NULL, confirmed_workspace TEXT NOT NULL,
      actor_id TEXT NOT NULL, server TEXT, user_id TEXT, cursor INTEGER NOT NULL DEFAULT 0,
      device_id TEXT NOT NULL, linked INTEGER NOT NULL DEFAULT 0, last_synced_at INTEGER,
      import_complete INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS unified_entities (
      workspace_id TEXT NOT NULL REFERENCES unified_spaces(workspace_id) ON DELETE CASCADE,
      layer TEXT NOT NULL CHECK(layer IN ('base','view')), collection TEXT NOT NULL,
      entity_id TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(workspace_id,layer,collection,entity_id)
    );
    CREATE TABLE IF NOT EXISTS unified_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL REFERENCES unified_spaces(workspace_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL UNIQUE, command TEXT NOT NULL, created_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', result TEXT
    );
    CREATE INDEX IF NOT EXISTS unified_outbox_pending ON unified_outbox(workspace_id,state,sequence);
    CREATE TABLE IF NOT EXISTS unified_blobs (
      workspace_id TEXT NOT NULL REFERENCES unified_spaces(workspace_id) ON DELETE CASCADE,
      id TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime_type TEXT NOT NULL,
      local_version_id TEXT, data BLOB, uploaded INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(workspace_id,id)
    );
    CREATE TABLE IF NOT EXISTS unified_file_mappings (
      workspace_id TEXT NOT NULL REFERENCES unified_spaces(workspace_id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL, relative_path TEXT NOT NULL, observed_version_id TEXT,
      observed_hash TEXT, status TEXT NOT NULL DEFAULT 'ready',
      PRIMARY KEY(workspace_id,entry_id)
    );
    CREATE TABLE IF NOT EXISTS unified_apply_journal (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES unified_spaces(workspace_id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL, version_id TEXT, action TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'prepared', error TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS unified_file_paths ON unified_file_mappings(workspace_id,relative_path);
    PRAGMA user_version=10; COMMIT;`);
}

export class UnifiedStore {
  constructor(engine) { this.engine = engine; this.db = engine.db; this.applying = new Set(); }
  transaction(action) {
    const nested = this.db.isTransaction;
    if (!nested) this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); if (!nested) this.db.exec('COMMIT'); return value; }
    catch (error) { if (!nested) this.db.exec('ROLLBACK'); throw error; }
  }
  row(id) { this.engine.workspace(id); return this.db.prepare('SELECT * FROM unified_spaces WHERE workspace_id=?').get(id); }
  ensure(id) {
    let row = this.row(id); if (row) return row;
    const local = this.engine.workspace(id), now = new Date().toISOString();
    const workspace = { id, name: local.label.normalize('NFC'), root_entry_id: this.engine.canvas.scope(id, ''), epoch: 1, revision: 0, created_at: now, updated_at: now, deleted_at: null };
    const state = createWorkspaceState(workspace);
    this.transaction(() => {
      this.db.prepare('INSERT INTO unified_spaces(workspace_id,workspace,confirmed_workspace,actor_id,device_id) VALUES(?,?,?,?,?)')
        .run(id, JSON.stringify(workspace), JSON.stringify(workspace), this.engine.documents.deviceId, this.engine.documents.deviceId);
      this.persist(id, state, 'base'); this.persist(id, state, 'view');
    });
    return this.row(id);
  }
  state(id, layer = 'view') {
    const row = this.ensure(id), workspace = JSON.parse(layer === 'base' ? row.confirmed_workspace : row.workspace);
    const state = createWorkspaceState(workspace);
    for (const record of this.db.prepare('SELECT collection,entity_id,value FROM unified_entities WHERE workspace_id=? AND layer=?').all(id, layer)) {
      state[record.collection][record.entity_id] = JSON.parse(record.value);
    }
    return state;
  }
  persist(id, state, layer = 'view') {
    this.db.prepare(`UPDATE unified_spaces SET ${layer === 'base' ? 'confirmed_workspace' : 'workspace'}=? WHERE workspace_id=?`).run(JSON.stringify(state.workspace), id);
    const put = this.db.prepare('INSERT INTO unified_entities VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,layer,collection,entity_id) DO UPDATE SET value=excluded.value');
    const prior = new Map(this.db.prepare('SELECT collection,entity_id,value FROM unified_entities WHERE workspace_id=? AND layer=?').all(id, layer).map(row => [`${row.collection}:${row.entity_id}`, row.value]));
    for (const collection of COLLECTIONS) for (const [entityId, value] of Object.entries(state[collection])) {
      const key = `${collection}:${entityId}`, encoded = JSON.stringify(value);
      if (prior.get(key) !== encoded) put.run(id, layer, collection, entityId, encoded);
      prior.delete(key);
    }
    for (const key of prior.keys()) {
      const split = key.indexOf(':');
      this.db.prepare('DELETE FROM unified_entities WHERE workspace_id=? AND layer=? AND collection=? AND entity_id=?').run(id, layer, key.slice(0, split), key.slice(split + 1));
    }
  }
  command(id, type, payload, base_revisions = {}) {
    const row = this.ensure(id), state = this.state(id);
    return { schema_version: 2, operation_id: randomUUID(), workspace_id: id, device_id: row.device_id, workspace_epoch: state.workspace.epoch, type, payload, base_revisions };
  }
  enqueue(id, input, { now = new Date().toISOString(), allowConflict = true } = {}) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT result FROM unified_outbox WHERE operation_id=?').get(input.operation_id);
      if (existing?.result) return JSON.parse(existing.result);
      const row = this.ensure(id), result = applyCommand(this.state(id), input, { actor_id: row.actor_id, role: 'OWNER', now });
      if (result.status === 'rejected' || !allowConflict && result.status === 'conflict') {
        const error = new Error(result.error?.message || '공통 편집 규칙을 적용하지 못했습니다.'); error.code = result.error?.code; throw error;
      }
      this.persist(id, result.state);
      this.db.prepare('INSERT INTO unified_outbox(workspace_id,operation_id,command,created_at,result) VALUES(?,?,?,?,?)')
        .run(id, input.operation_id, JSON.stringify(input), now, JSON.stringify({ status: result.status, conflict_ids: result.conflict_ids, error: result.error }));
      return result;
    });
  }
  pending(id, limit = 100) { this.ensure(id); return this.db.prepare("SELECT * FROM unified_outbox WHERE workspace_id=? AND state='pending' ORDER BY sequence LIMIT ?").all(id, limit).map(row => ({ ...row, command: JSON.parse(row.command) })); }
  bind(id, owner) {
    const row = this.ensure(id);
    if (row.server && (row.server !== owner.server || row.user_id !== owner.user_id)) throw new Error('다른 서버 또는 계정에 연결된 폴더입니다. 기존 계정으로 연결해 주세요.');
    this.transaction(() => {
      this.db.prepare('UPDATE unified_spaces SET server=?,user_id=?,actor_id=? WHERE workspace_id=?').run(owner.server, owner.user_id, owner.user_id, id);
      // Before the first authenticated transmission, local edits are authored by this device.
      // Historical imported authors remain unchanged. A bound account cannot be replaced above.
      if (!row.server && row.actor_id !== owner.user_id) {
        const pending = this.pending(id, 1000000);
        const freshMessages = new Set(pending.filter(item => item.command.type === 'AppendChatMessage' && item.command.payload.message.created_by === row.actor_id).map(item => item.command.payload.message.id));
        for (const item of pending) {
          const command = item.command;
          if (command.type === 'AppendDocumentVersion' && command.payload.version.created_by === row.actor_id) command.payload.version.created_by = owner.user_id;
          if (command.type === 'AppendChatMessage' && command.payload.message.created_by === row.actor_id) command.payload.message.created_by = owner.user_id;
          if (command.type === 'UpdateChatMessage' && freshMessages.has(command.payload.message.id) && command.payload.message.created_by === row.actor_id) command.payload.message.created_by = owner.user_id;
          this.db.prepare('UPDATE unified_outbox SET command=? WHERE operation_id=?').run(JSON.stringify(command), command.operation_id);
        }
        this.rebuild(id);
      }
    });
    return this.row(id);
  }
  acknowledge(id, receipts) {
    this.transaction(() => {
      for (const receipt of receipts) {
        this.db.prepare('UPDATE unified_outbox SET state=?,result=? WHERE workspace_id=? AND operation_id=?')
          .run(receipt.status === 'rejected' ? 'blocked' : 'acknowledged', JSON.stringify(receipt), id, receipt.operation_id);
      }
    });
  }
  bootstrap(id, remote, cursor) {
    this.transaction(() => {
      this.ensure(id); this.persist(id, remote, 'base');
      this.db.prepare('UPDATE unified_spaces SET cursor=?,linked=1 WHERE workspace_id=?').run(cursor, id);
      this.rebuild(id);
    });
  }
  receive(id, events, cursor) {
    this.transaction(() => {
      let state = this.state(id, 'base');
      for (const event of events) {
        if (event.sequence <= this.row(id).cursor) continue;
        state = applyChanges(state, event.changes);
        if (event.operation_id) this.db.prepare("UPDATE unified_outbox SET state='acknowledged' WHERE workspace_id=? AND operation_id=?").run(id, event.operation_id);
      }
      this.persist(id, state, 'base');
      this.db.prepare('UPDATE unified_spaces SET cursor=?,linked=1,last_synced_at=? WHERE workspace_id=?').run(cursor, Date.now(), id);
      this.rebuild(id);
    });
  }
  rebuild(id) {
    const row = this.row(id); let state = this.state(id, 'base');
    for (const item of this.pending(id, 1000000)) {
      const result = applyCommand(state, item.command, { actor_id: row.actor_id, role: 'OWNER', now: item.created_at });
      if (result.status !== 'rejected') state = result.state;
      // Rejected operations remain in outbox for recovery; never silently discard edits.
    }
    this.persist(id, state); return state;
  }
  blob(id, blobId) {
    this.ensure(id);
    const row = this.db.prepare('SELECT * FROM unified_blobs WHERE workspace_id=? AND id=?').get(id, blobId);
    if (!row) throw new Error('원본 데이터를 찾지 못했습니다.');
    const bytes = row.data ?? this.db.prepare('SELECT bytes FROM local_versions WHERE id=?').get(row.local_version_id)?.bytes;
    if (!bytes) throw new Error('원본 데이터를 찾지 못했습니다.');
    return { ...row, data: bytes };
  }
  status(id) {
    const row = this.ensure(id), state = this.state(id);
    const pending = this.db.prepare("SELECT count(*) AS n FROM unified_outbox WHERE workspace_id=? AND state='pending'").get(id).n;
    const blocked = this.db.prepare("SELECT count(*) AS n FROM unified_outbox WHERE workspace_id=? AND state='blocked'").get(id).n;
    const conflicts = Object.values(state.conflicts).filter(conflict => conflict.status === 'open').length;
    const applying = this.db.prepare("SELECT count(*) AS n FROM unified_apply_journal WHERE workspace_id=? AND state!='complete'").get(id).n;
    return { linked: !!row.linked, pending: !!pending, pending_count: pending, blocked_count: blocked, changed: !!pending, conflicts, applying,
      cursor: row.cursor, last_synced_at: row.last_synced_at, deleted: !!state.workspace.deleted_at,
      binding: row.linked ? { workspace_id: id, web_url: `${row.server}/workspaces/${id}` } : null };
  }
}
