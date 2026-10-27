import { backup } from 'node:sqlite';
import { mkdir, open, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { connectedEntrySQL } from './file-connections.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cancelled = () => { throw new Error('동기화를 취소했습니다.'); };
export async function migrateCloud(db, directory) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= 9) return;
  if (db.prepare('SELECT count(*) AS n FROM workspaces').get().n) {
    await mkdir(path.join(directory, 'backups'), { recursive: true, mode: 0o700 });
    await backup(db, path.join(directory, 'backups', `workspace-v${version}-${Date.now()}.sqlite`));
  }
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS local_cloud_states (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      server TEXT NOT NULL, user_id TEXT NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY(workspace_id,server,user_id)
    );
    PRAGMA user_version=9; COMMIT;`);
}

export class CloudSnapshots {
  constructor(engine) { this.engine = engine; this.db = engine.db; this.cancellations = new Map(); }
  owner(workspaceId, owner) {
    this.engine.workspace(workspaceId);
    if (!owner || typeof owner.server !== 'string' || typeof owner.user_id !== 'string') throw new Error('로그인 계정을 확인해 주세요.');
    const other = this.db.prepare('SELECT server,user_id FROM local_cloud_states WHERE workspace_id=?').all(workspaceId)
      .find(row => row.server !== owner.server || row.user_id !== owner.user_id);
    if (other) throw new Error('이 폴더는 다른 서버 또는 계정에 연결돼 있습니다. 기존 계정으로 로그인해 주세요.');
  }
  get(workspaceId, owner) {
    this.owner(workspaceId, owner);
    const row = this.db.prepare('SELECT state FROM local_cloud_states WHERE workspace_id=? AND server=? AND user_id=?').get(workspaceId, owner.server, owner.user_id);
    return row ? JSON.parse(row.state) : {};
  }
  set(workspaceId, owner, patch) {
    const previous = this.get(workspaceId, owner), state = { ...previous, ...patch };
    this.db.prepare('INSERT INTO local_cloud_states VALUES(?,?,?,?) ON CONFLICT(workspace_id,server,user_id) DO UPDATE SET state=excluded.state')
      .run(workspaceId, owner.server, owner.user_id, JSON.stringify(state));
    return state;
  }
  signature(workspaceId) {
    const rows = this.db.prepare(`SELECT e.id,e.relative_path,e.parent_path,e.name,e.size,e.mtime,e.present,e.excluded,p.x,p.y
      FROM entries e LEFT JOIN positions p ON p.entry_id=e.id WHERE e.workspace_id=? ORDER BY e.id`).all(workspaceId);
    const sequence = this.db.prepare('SELECT coalesce(max(device_sequence),0) AS n FROM local_changes WHERE workspace_id=?').get(workspaceId).n;
    const disconnected = this.db.prepare("SELECT key,value FROM local_settings WHERE key LIKE ? ORDER BY key").all(`disconnected-file:${workspaceId}:%`);
    return hash(JSON.stringify({ rows, sequence, disconnected }));
  }
  status(workspaceId, owner) {
    const state = this.get(workspaceId, owner);
    return { linked: !!state.binding, pending: !!state.pending, changed: !state.signature || state.signature !== this.signature(workspaceId),
      last_synced_at: state.last_synced_at || null, binding: state.binding || null };
  }
  cancel(workspaceId) { this.cancellations.set(workspaceId, (this.cancellations.get(workspaceId) || 0) + 1); }
  async read(workspaceId, entryId) {
    const entry = await this.engine.resolveEntry(workspaceId, entryId);
    const file = await open(entry.filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 50 * 1024**2 || before.dev !== entry.device || before.ino !== entry.inode) throw new Error('50MB 이하의 일반 파일만 동기화할 수 있습니다.');
      const data = await file.readFile();
      const after = await file.stat(), check = await this.engine.resolveEntry(workspaceId, entryId);
      if (data.length > 50 * 1024**2 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || check.device !== before.dev || check.inode !== before.ino) throw new Error('파일이 변경되었습니다. 저장을 마친 뒤 다시 동기화해 주세요.');
      return { entry, data, sha256: hash(data) };
    } finally { await file.close(); }
  }
  async prepare(workspaceId, owner) {
    const state = this.get(workspaceId, owner);
    if (state.pending) return state.pending;
    const workspace = this.engine.workspace(workspaceId);
    const cancellation = this.cancellations.get(workspaceId) || 0;
    const check = () => { this.engine.workspace(workspaceId); if ((this.cancellations.get(workspaceId) || 0) !== cancellation) cancelled(); };
    await this.engine.scan(workspaceId); check();
    if (this.engine.snapshot(workspaceId).status === 'unavailable') throw new Error('원본 폴더를 읽을 수 없습니다. 다시 연결한 뒤 동기화해 주세요.');
    const candidates = this.db.prepare(`SELECT e.*,d.id AS document_id FROM entries e LEFT JOIN local_documents d ON d.entry_id=e.id
      WHERE e.workspace_id=? AND e.kind='file' AND ${connectedEntrySQL()} ORDER BY e.id`).all(workspaceId);
    for (const candidate of candidates) {
      check();
      if (!candidate.present) {
        if (!this.db.prepare('SELECT id FROM local_versions WHERE document_id=? LIMIT 1').get(candidate.document_id)) throw new Error(`원본을 찾을 수 없습니다: ${candidate.name}. 파일을 다시 연결해 주세요.`);
        continue;
      }
      const { entry, data, sha256 } = await this.read(workspaceId, candidate.id); check();
      this.engine.documents.transaction(() => {
        this.engine.requireFileConnection(workspaceId, candidate.id);
        const doc = this.db.prepare('SELECT * FROM local_documents WHERE workspace_id=? AND entry_id=?').get(workspaceId, candidate.id);
        const previous = doc.file_version_id ? this.db.prepare('SELECT * FROM local_versions WHERE id=?').get(doc.file_version_id) : null;
        if (previous?.sha256 === sha256) return;
        const number = this.db.prepare('SELECT coalesce(max(version_number),0)+1 AS n FROM local_versions WHERE document_id=?').get(doc.id).n;
        const versionId = randomUUID();
        const normalized = { schema_version: 1, sync_only: true, title: entry.name, source_filename: entry.name, source_sha256: sha256, blocks: [], warnings: [], page_count: null };
        this.db.prepare('INSERT INTO local_versions(id,document_id,version_number,filename,sha256,bytes,normalized,created_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(versionId, doc.id, number, entry.name, sha256, data, JSON.stringify(normalized), Date.now());
        this.engine.documents.change(workspaceId, versionId, 'document.version.create', 1, { document_id: doc.id, version_number: number, sha256 });
        this.engine.documents.observeVersion(workspaceId, doc.id, versionId);
      });
    }
    check();
    const pending = this.engine.documents.transaction(() => this.manifest(workspaceId));
    const directory = path.join(this.engine.dataDirectory, 'sync-cache', workspaceId, pending.request_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      for (const item of pending.items.filter(item => item.entity_type === 'version')) {
        check();
        const version = this.db.prepare('SELECT bytes,sha256 FROM local_versions WHERE id=?').get(item.entity_id);
        if (!version || hash(version.bytes) !== version.sha256) throw new Error('보관된 수정 이력을 검증하지 못했습니다.');
        await writeFile(path.join(directory, item.entity_id), version.bytes, { mode: 0o600, flag: 'wx' });
      }
      check();
      // Paths and tokens never enter the portable manifest.
      return this.set(workspaceId, owner, { pending }).pending;
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  manifest(workspaceId) {
    const workspace = this.engine.workspace(workspaceId), records = [], entryToDocument = new Map();
    const add = (entity_type, entity_id, payload) => records.push({ entity_type, entity_id, content: JSON.stringify(payload) });
    const entries = this.db.prepare(`SELECT e.*,p.x,p.y,d.id AS document_id FROM entries e LEFT JOIN positions p ON p.entry_id=e.id
      LEFT JOIN local_documents d ON d.entry_id=e.id WHERE e.workspace_id=? AND e.kind IN ('file','directory') AND ${connectedEntrySQL()} ORDER BY e.relative_path`).all(workspaceId);
    const directories = new Map([['', this.engine.canvas.scope(workspaceId, '')]]);
    for (const entry of entries.filter(e => e.kind === 'directory')) directories.set(entry.relative_path, this.engine.canvas.scope(workspaceId, entry.relative_path));
    const root = directories.get('');
    add('entry', root, { parent_id: null, kind: 'directory', name: workspace.label });
    add('scope', root, { folder_entry_id: root });
    for (const entry of entries) {
      const parent = directories.get(entry.parent_path);
      if (!parent) throw new Error('폴더 구조를 다시 확인해 주세요.');
      const key = entry.kind === 'directory' ? directories.get(entry.relative_path) : entry.document_id;
      const payload = { parent_id: parent, kind: entry.kind, name: entry.name, x: entry.x ?? 0, y: entry.y ?? 0, available: !!entry.present };
      if (entry.kind === 'directory') { payload.area_positioned = this.db.prepare('SELECT value FROM local_settings WHERE key=?').get(`folder-area:${workspaceId}:${entry.id}`)?.value === '1'; add('entry', key, payload); add('scope', key, { folder_entry_id: key }); continue; }
      if (!entry.document_id) throw new Error('문서 식별자를 확인하지 못했습니다.');
      entryToDocument.set(entry.id, entry.document_id);
      add('entry', key, { ...payload, document_id: entry.document_id });
      const doc = this.db.prepare('SELECT * FROM local_documents WHERE id=?').get(entry.document_id);
      if (!doc.file_version_id || !doc.current_version_id) throw new Error(`수정 이력이 없습니다: ${entry.name}`);
      add('document', doc.id, { title: entry.name.slice(0, 200), current_version_id: doc.current_version_id, file_version_id: doc.file_version_id,
        current_is_pinned: !!doc.current_is_pinned, revision: doc.revision });
      for (const v of this.db.prepare('SELECT id,document_id,version_number,filename,sha256,length(bytes) AS size,created_at,source_version_id,change_note FROM local_versions WHERE document_id=? ORDER BY version_number').all(doc.id)) {
        add('version', v.id, { document_id: v.document_id, version_number: v.version_number, filename: v.filename, size: v.size, sha256: v.sha256,
          created_at: v.created_at, source_version_id: v.source_version_id, change_note: v.change_note });
      }
    }
    const versionIds = new Set(records.filter(r => r.entity_type === 'version').map(r => r.entity_id));
    for (const record of records.filter(r => r.entity_type === 'version')) {
      const p = JSON.parse(record.content);
      if (p.source_version_id && !versionIds.has(p.source_version_id)) throw new Error('수정 이력의 출처 파일이 연결 해제돼 있습니다. 출처를 다시 연결한 뒤 동기화해 주세요.');
    }
    for (const row of this.db.prepare('SELECT * FROM local_canvas WHERE workspace_id=? AND deleted=0 ORDER BY id').all(workspaceId)) {
      if (![...directories.values()].includes(row.scope_id)) continue;
      const p = JSON.parse(row.payload);
      if (row.kind === 'element') add('element', row.id, { ...p, scope_id: row.scope_id, revision: row.revision });
      else if (entryToDocument.has(p.source_document_id) && entryToDocument.has(p.target_document_id)) {
        const { id: _id, ...relation } = p;
        add('relation', row.id, { ...relation, source_document_id: entryToDocument.get(p.source_document_id), target_document_id: entryToDocument.get(p.target_document_id), scope_id: row.scope_id, revision: row.revision });
      }
    }
    const source = s => ({ id: s.id, chunk_id: s.chunk_id || s.id, document_id: s.document_id, document_title: s.document_title, version_id: s.version_id,
      version_number: s.version_number, is_current: !!s.is_current, text: s.text, locations: s.locations.map(l => ({ block_id: l.block_id, ...(l.page === undefined ? {} : { page: l.page }), ...(l.line === undefined ? {} : { line: l.line }) })) });
    const history = p => ({ content: p.content, sources: (p.sources || []).map(source), checks: p.checks || [] });
    for (const row of this.db.prepare('SELECT * FROM local_drafts WHERE workspace_id=? AND deleted=0 ORDER BY id').all(workspaceId)) {
      add('draft', row.id, { ...history({ content: JSON.parse(row.content), sources: JSON.parse(row.sources), checks: JSON.parse(row.checks) }), revision: row.revision,
        history: JSON.parse(row.history).map(history) });
    }
    const digest = createHash('sha256');
    const items = records.map((record, ordinal) => { digest.update(`${record.entity_type}:${record.entity_id}:${hash(record.content)}\n`); return { ...record, ordinal }; });
    return { request_id: randomUUID(), items, manifest_hash: digest.digest('hex'), source_sequence: this.db.prepare('SELECT coalesce(max(device_sequence),0) AS n FROM local_changes WHERE workspace_id=?').get(workspaceId).n,
      signature: this.signature(workspaceId), device_id: this.engine.documents.deviceId, name: workspace.label.slice(0, 120) };
  }
  blob(workspaceId, owner, requestId, versionId) {
    const state = this.get(workspaceId, owner), pending = state.pending;
    if (pending?.request_id !== requestId || !pending.items.some(item => item.entity_type === 'version' && item.entity_id === versionId)) throw new Error('동기화 파일을 찾을 수 없습니다.');
    return path.join(this.engine.dataDirectory, 'sync-cache', workspaceId, requestId, versionId);
  }
  async finish(workspaceId, owner, requestId, binding, committed) {
    const state = this.get(workspaceId, owner), pending = state.pending;
    if (pending?.request_id !== requestId || committed.state !== 'COMMITTED' || committed.source_sequence !== pending.source_sequence) throw new Error('동기화 완료 응답이 일치하지 않습니다.');
    this.set(workspaceId, owner, { binding: { ...binding, revision: committed.revision }, signature: pending.signature, last_synced_at: Date.now(), pending: null });
    await rm(path.join(this.engine.dataDirectory, 'sync-cache', workspaceId, requestId), { recursive: true, force: true });
    return this.status(workspaceId, owner);
  }
  async discard(workspaceId, owner) {
    const state = this.get(workspaceId, owner);
    this.set(workspaceId, owner, { pending: null });
    if (state.pending) await rm(path.join(this.engine.dataDirectory, 'sync-cache', workspaceId, state.pending.request_id), { recursive: true, force: true });
  }
}
