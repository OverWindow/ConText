import { connectedEntrySQL } from './file-connections.mjs';
import { backup } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, open, rename, realpath, lstat, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { runProcessor } from './processor.mjs';
import { writingContext } from './local-context.mjs';

const encode = JSON.stringify;
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
const fail = (message, code = 'INVALID_INPUT') => { const error = new Error(message); error.code = code; throw error; };
const hash = data => createHash('sha256').update(data).digest('hex');
const conflict = () => fail('다른 곳에서 문서가 변경됐습니다. 저장된 문서를 다시 열어 주세요.', 'CONFLICT');
const snapshot = draft => ({ content: draft.content, sources: draft.sources, checks: draft.checks });

export function validateContent(value, sources = []) {
  if (!value || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200 ||
    !Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > 200 || encode(value).length > 150000) fail('문서 제목 또는 크기가 올바르지 않습니다.');
  const ids = new Set(), allowed = new Set(sources.map(source => source.id));
  const bounded = (values, size, length) => Array.isArray(values) && values.length <= size && values.every(item => typeof item === 'string' && item.length <= length);
  const blocks = value.blocks.map(block => {
    if (!block || typeof block.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(block.id) || ids.has(block.id) || !['paragraph', 'heading', 'list', 'table'].includes(block.type)) fail('문단 구조가 올바르지 않습니다.');
    ids.add(block.id);
    const text = block.text ?? '', level = block.level ?? 2, items = block.items ?? [], rows = block.rows ?? [], refs = block.source_ids ?? [];
    if (typeof text !== 'string' || text.length > 12000 || !Number.isInteger(level) || level < 1 || level > 6 ||
      !bounded(items, 100, 2000) || !Array.isArray(rows) || rows.length > 100 || rows.some(row => !bounded(row, 12, 2000)) ||
      !bounded(refs, 20, 200) || refs.some(ref => !allowed.has(ref)) ||
      (block.type === 'list' && !items.length) || (block.type === 'table' && (!rows.length || rows.some(row => !row.length)))) fail('문단 내용 또는 연결된 출처가 올바르지 않습니다.');
    return { id: block.id, type: block.type, text, level, items, rows, source_ids: refs };
  });
  return { title: value.title.trim(), blocks };
}

export async function migrateDocuments(db, directory) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 10) fail('더 새로운 앱에서 만든 저장소입니다. 앱을 업데이트해 주세요.', 'NEWER_DATABASE');
  if (version >= 7) return;
  if (db.prepare('SELECT count(*) AS count FROM workspaces').get().count) {
    await mkdir(path.join(directory, 'backups'), { recursive: true, mode: 0o700 });
    await backup(db, path.join(directory, 'backups', `workspace-v${version}-${Date.now()}.sqlite`));
  }
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS local_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS local_drafts (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, content TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]', checks TEXT NOT NULL DEFAULT '[]',
      history TEXT NOT NULL DEFAULT '[]', proposal TEXT, revision INTEGER NOT NULL DEFAULT 1,
      deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(workspace_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS drafts_workspace ON local_drafts(workspace_id,deleted,updated_at);
    CREATE TABLE IF NOT EXISTS local_changes (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL,
      base_revision INTEGER, revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS save_journal (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, draft_id TEXT NOT NULL, revision INTEGER NOT NULL,
      destination TEXT NOT NULL, temporary TEXT NOT NULL, expected_hash TEXT, content_hash TEXT NOT NULL,
      state TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_documents (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id) ON DELETE CASCADE, current_version_id TEXT
    );
    CREATE TABLE IF NOT EXISTS local_versions (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES local_documents(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL,
      bytes BLOB NOT NULL, normalized TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(document_id,version_number)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS local_search USING fts5(workspace_id UNINDEXED, document_id UNINDEXED, version_id UNINDEXED, block_id UNINDEXED, title, text, tokenize='trigram');
    CREATE TABLE IF NOT EXISTS local_chat_sessions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(workspace_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS local_chat_messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES local_chat_sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, sequence INTEGER NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL,
      content TEXT NOT NULL, result TEXT, options TEXT NOT NULL, error_code TEXT, created_at INTEGER NOT NULL,
      UNIQUE(session_id,request_id,role)
    );
    CREATE TABLE IF NOT EXISTS local_canvas_scopes (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      directory TEXT NOT NULL, UNIQUE(workspace_id,directory)
    );
    CREATE TABLE IF NOT EXISTS local_canvas (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      scope_id TEXT NOT NULL REFERENCES local_canvas_scopes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, payload TEXT NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS canvas_scope ON local_canvas(workspace_id,scope_id,deleted);
    PRAGMA user_version=5;
    COMMIT;`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(local_changes)').all().map(column => column.name));
    if (!columns.has('device_id')) db.exec('ALTER TABLE local_changes ADD COLUMN device_id TEXT');
    if (!columns.has('device_sequence')) db.exec('ALTER TABLE local_changes ADD COLUMN device_sequence INTEGER');
    if (!columns.has('schema_version')) db.exec('ALTER TABLE local_changes ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1');
    db.prepare('INSERT OR IGNORE INTO local_settings VALUES(?,?)').run('device-id', randomUUID());
    const deviceId = db.prepare('SELECT value FROM local_settings WHERE key=?').get('device-id').value;
    let sequence = db.prepare('SELECT coalesce(max(device_sequence),0) AS n FROM local_changes WHERE device_id=?').get(deviceId).n;
    for (const row of db.prepare('SELECT id FROM local_changes WHERE device_id IS NULL ORDER BY rowid').all()) {
      db.prepare('UPDATE local_changes SET device_id=?,device_sequence=? WHERE id=?').run(deviceId, ++sequence, row.id);
    }
    db.prepare('INSERT INTO local_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('change-sequence', String(sequence));
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS changes_device_sequence ON local_changes(device_id,device_sequence)');
    const insert = db.prepare('INSERT OR IGNORE INTO local_documents(id,workspace_id,entry_id) VALUES(?,?,?)');
    for (const entry of db.prepare("SELECT id,workspace_id FROM entries WHERE kind='file'").all()) insert.run(randomUUID(), entry.workspace_id, entry.id);
    for (const row of db.prepare("SELECT id,payload FROM local_changes WHERE operation='document.version'").all()) {
      const payload = JSON.parse(row.payload);
      if (payload.versionId) db.prepare("UPDATE local_changes SET entity_id=?,operation='document.version.create',base_revision=NULL,revision=1,payload=? WHERE id=?")
        .run(payload.versionId, encode({ document_id: db.prepare('SELECT document_id FROM local_versions WHERE id=?').get(payload.versionId)?.document_id, sha256: payload.sha256 }), row.id);
    }
    const documentColumns = new Set(db.prepare('PRAGMA table_info(local_documents)').all().map(c => c.name));
    if (!documentColumns.has('file_version_id')) {
      db.exec('ALTER TABLE local_documents ADD COLUMN file_version_id TEXT');
      db.exec('UPDATE local_documents SET file_version_id=current_version_id');
    }
    if (!documentColumns.has('revision')) db.exec('ALTER TABLE local_documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    if (!documentColumns.has('current_is_pinned')) db.exec('ALTER TABLE local_documents ADD COLUMN current_is_pinned INTEGER NOT NULL DEFAULT 0');
    const versionColumns = new Set(db.prepare('PRAGMA table_info(local_versions)').all().map(c => c.name));
    for (const column of ['source_version_id', 'request_id', 'change_note']) if (!versionColumns.has(column)) db.exec(`ALTER TABLE local_versions ADD COLUMN ${column} TEXT`);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS versions_request ON local_versions(document_id,request_id)');
    db.exec('PRAGMA user_version=7; COMMIT;');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export class LocalDocuments {
  constructor(engine) {
    this.engine = engine; this.db = engine.db; this.jobs = new Map(); this.indexJobs = new Map(); this.indexStatus = new Map(); this.signatures = new Map(); this.indexPublished = new Map();
    this.deviceId = this.db.prepare('SELECT value FROM local_settings WHERE key=?').get('device-id').value;
    for (const row of this.db.prepare("SELECT key,value FROM local_settings WHERE key LIKE 'index-paused:%'").all()) {
      const value = JSON.parse(row.value);
      this.indexStatus.set(row.key.slice('index-paused:'.length), { total: 0, completed: 0, failed: 0, ...(typeof value === 'object' ? value : {}), state: 'cancelled' });
    }
  }
  list(workspaceId) {
    this.engine.workspace(workspaceId);
    return this.db.prepare('SELECT id,content FROM local_drafts WHERE workspace_id=? AND deleted=0 ORDER BY updated_at DESC').all(workspaceId)
      .map(row => ({ id: row.id, title: JSON.parse(row.content).title }));
  }
  row(workspaceId, id, revision) {
    this.engine.workspace(workspaceId);
    if (!uuid(id)) fail('문서 식별자가 올바르지 않습니다.');
    const row = this.db.prepare('SELECT * FROM local_drafts WHERE id=? AND workspace_id=? AND deleted=0').get(id, workspaceId);
    if (!row) fail('문서를 찾을 수 없습니다.', 'NOT_FOUND');
    if (revision !== undefined && (!Number.isInteger(revision) || row.revision !== revision)) conflict();
    return { ...row, content: JSON.parse(row.content), sources: JSON.parse(row.sources), checks: JSON.parse(row.checks), history: JSON.parse(row.history), proposal: row.proposal ? JSON.parse(row.proposal) : null };
  }
  get(workspaceId, id, revision) {
    const row = this.row(workspaceId, id, revision);
    return { id: row.id, title: row.content.title, revision: row.revision, content: row.content, sources: row.sources, checks: row.checks, can_undo: !!row.history.length, proposal: row.proposal };
  }
  transaction(action) {
    if (this.db.isTransaction) return action();
    const before = Number(this.db.prepare('SELECT value FROM local_settings WHERE key=?').get('change-sequence')?.value || 0);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      // The presentation write and its common-domain outbox commit together.
      // A process exit can never leave a committed draft/chat edit without its command.
      for (const row of this.db.prepare('SELECT DISTINCT workspace_id FROM local_changes WHERE device_id=? AND device_sequence>?').all(this.deviceId, before)) this.engine.unified?.capture(row.workspace_id);
      this.db.exec('COMMIT'); return result;
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  change(workspaceId, id, operation, revision, payload) {
    const sequence = Number(this.db.prepare('SELECT value FROM local_settings WHERE key=?').get('change-sequence').value) + 1;
    this.db.prepare('UPDATE local_settings SET value=? WHERE key=?').run(String(sequence), 'change-sequence');
    this.db.prepare('INSERT INTO local_changes(id,workspace_id,entity_id,operation,base_revision,revision,payload,created_at,device_id,device_sequence,schema_version) VALUES(?,?,?,?,?,?,?,?,?,?,1)')
      .run(randomUUID(), workspaceId, id, operation, revision > 1 ? revision - 1 : null, revision, encode(payload), Date.now(), this.deviceId, sequence);
  }
  create(workspaceId, requestId, initial) {
    this.engine.workspace(workspaceId);
    if (!uuid(requestId)) fail('요청 식별자가 올바르지 않습니다.');
    const previous = this.db.prepare('SELECT id,deleted FROM local_drafts WHERE workspace_id=? AND request_id=?').get(workspaceId, requestId);
    if (previous) { if (previous.deleted) fail('삭제된 문서 생성 요청입니다. 새 요청으로 다시 시도해 주세요.'); return this.get(workspaceId, previous.id); }
    const sources = initial?.sources || [];
    const content = validateContent(initial?.content || { title: '새 문서', blocks: [{ id: randomUUID(), type: 'paragraph', text: '' }] }, sources);
    const id = randomUUID(), now = Date.now();
    this.transaction(() => {
      this.db.prepare('INSERT INTO local_drafts(id,workspace_id,request_id,content,sources,checks,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, workspaceId, requestId, encode(content), encode(sources), encode(initial?.checks || []), now, now);
      this.change(workspaceId, id, 'draft.create', 1, { content, sources });
    });
    this.engine.emit('changed', workspaceId);
    return this.get(workspaceId, id);
  }
  update(workspaceId, id, revision, mutate, operation) {
    const result = this.transaction(() => {
      const row = this.row(workspaceId, id, revision);
      mutate(row);
      const next = revision + 1;
      this.db.prepare('UPDATE local_drafts SET content=?,sources=?,checks=?,history=?,proposal=?,revision=?,updated_at=? WHERE id=?')
        .run(encode(row.content), encode(row.sources), encode(row.checks), encode(row.history), row.proposal ? encode(row.proposal) : null, next, Date.now(), id);
      this.change(workspaceId, id, operation, next, snapshot(row));
      return this.get(workspaceId, id);
    });
    this.engine.emit('changed', workspaceId);
    return result;
  }
  save(workspaceId, id, revision, content) {
    return this.update(workspaceId, id, revision, row => {
      const next = validateContent(content, row.sources);
      row.history = [...row.history, snapshot(row)].slice(-20);
      row.content = next; row.proposal = null;
      row.checks = [...new Set([...row.checks, '직접 수정한 내용은 연결된 출처와 다시 대조해 주세요.'])];
    }, 'draft.save');
  }
  review(workspaceId, id, revision, action) {
    if (!['accept', 'reject', 'undo'].includes(action)) fail('지원하지 않는 문서 작업입니다.');
    return this.update(workspaceId, id, revision, row => {
      if (action === 'undo') {
        if (!row.history.length) fail('되돌릴 저장 이력이 없습니다.');
        Object.assign(row, row.history.pop());
      } else if (action === 'accept') {
        if (!row.proposal) fail('적용할 수정안이 없습니다.');
        row.history = [...row.history, snapshot(row)].slice(-20);
        Object.assign(row, snapshot(row.proposal));
      }
      row.proposal = null;
    }, `draft.${action}`);
  }
  remove(workspaceId, id, revision) {
    this.transaction(() => {
      this.row(workspaceId, id, revision);
      this.db.prepare('UPDATE local_drafts SET deleted=1,revision=revision+1,updated_at=? WHERE id=?').run(Date.now(), id);
      this.change(workspaceId, id, 'draft.delete', revision + 1, { deleted: true });
    });
    this.engine.emit('changed', workspaceId);
  }
  async readEntry(workspaceId, entryId) {
    const entry = await this.engine.resolveEntry(workspaceId, entryId);
    if (entry.kind !== 'file' || !['.txt', '.md', '.pdf', '.docx', '.hwpx'].includes(entry.extension)) fail('이 형식은 원본 앱에서 확인해 주세요.', 'UNSUPPORTED_FORMAT');
    const file = await open(entry.filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 50 * 1024 * 1024) fail('50MB 이하 문서만 읽을 수 있습니다.');
      const checked = await this.engine.resolveEntry(workspaceId, entryId);
      if (checked.device !== before.dev || checked.inode !== before.ino) conflict();
      const data = await file.readFile();
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length > 50 * 1024 * 1024) conflict();
      return { entry, data, sha256: hash(data) };
    } finally { await file.close(); }
  }
  open(workspaceId, entryId, signal) {
    const key = `${workspaceId}:${entryId}`;
    if (this.jobs.has(key)) return this.jobs.get(key);
    const job = this.openOnce(workspaceId, entryId, signal).finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
    return job;
  }
  observeVersion(workspaceId, documentId, versionId) {
    const row = this.db.prepare('SELECT * FROM local_documents WHERE id=? AND workspace_id=?').get(documentId, workspaceId);
    const current = row.current_is_pinned ? row.current_version_id : versionId;
    if (row.file_version_id === versionId && row.current_version_id === current) return;
    this.db.prepare('UPDATE local_documents SET file_version_id=?,current_version_id=?,revision=revision+1 WHERE id=?').run(versionId, current, documentId);
    this.change(workspaceId, documentId, 'document.head', row.revision + 1, { current_version_id: current, pinned: !!row.current_is_pinned });
  }
  copyOrigin(workspaceId, entry, sha256) {
    for (const row of this.db.prepare("SELECT payload,result_entry_id FROM local_copy_requests WHERE workspace_id=? AND state IN ('PREPARED','PUBLISHED','COMPLETED')").all(workspaceId)) {
      const origin = JSON.parse(row.payload);
      if (!origin.version || origin.hash !== sha256 || !origin.destination) continue;
      if ((origin.parent ? `${origin.parent}/` : '') + origin.destination !== entry.relative_path) continue;
      if (row.result_entry_id && row.result_entry_id !== entry.id) continue;
      if (!row.result_entry_id && (origin.inode !== entry.inode || origin.device !== entry.device)) continue;
      return { source_version_id: origin.version, change_note: '복사본 생성' };
    }
    return { source_version_id: null, change_note: null };
  }
  async openOnce(workspaceId, entryId, signal) {
    const { entry, data, sha256 } = await this.readEntry(workspaceId, entryId);
    let document = this.db.prepare('SELECT * FROM local_documents WHERE entry_id=? AND workspace_id=?').get(entryId, workspaceId);
    let version = document?.file_version_id ? this.db.prepare('SELECT * FROM local_versions WHERE document_id=? AND id=?').get(document.id, document.file_version_id) : null;
    if (!version || version.sha256 !== sha256 || JSON.parse(version.normalized).sync_only) {
      let normalized;
      try { normalized = await runProcessor({ operation: 'parse', filename: entry.name, data: data.toString('base64') }, { ...this.engine.processorOptions, signal }); }
      catch (error) {
        if (error.code !== 'EMPTY_DOCUMENT') throw error;
        normalized = { schema_version: 1, title: path.parse(entry.name).name, source_filename: entry.name, source_sha256: sha256, blocks: [], warnings: ['내용이 없는 문서입니다.'], page_count: null };
      }
      this.transaction(() => {
        // A file or workspace may have been disconnected while the processor was running.
        this.engine.workspace(workspaceId);
        this.engine.requireFileConnection(workspaceId, entryId);
        if (!document) {
          document = { id: randomUUID(), workspace_id: workspaceId, entry_id: entryId };
          this.db.prepare('INSERT INTO local_documents(id,workspace_id,entry_id) VALUES(?,?,?)').run(document.id, workspaceId, entryId);
        }
        const observed = this.db.prepare('SELECT v.* FROM local_documents d JOIN local_versions v ON v.id=d.file_version_id WHERE d.id=?').get(document.id);
        const materialize = observed?.sha256 === sha256 && JSON.parse(observed.normalized).sync_only;
        if (materialize) {
          // A raw sync snapshot can finish while the parser is running. Fill only
          // its derived index; preserve the original bytes, version UUID and head.
          version = { ...observed, normalized: encode(normalized) };
          this.db.prepare('UPDATE local_versions SET normalized=? WHERE id=?').run(version.normalized, version.id);
          this.db.prepare('DELETE FROM local_search WHERE version_id=?').run(version.id);
        } else {
          const number = this.db.prepare('SELECT coalesce(max(version_number),0)+1 AS n FROM local_versions WHERE document_id=?').get(document.id).n;
          version = { id: randomUUID(), document_id: document.id, version_number: number, filename: entry.name, sha256, normalized: encode(normalized), created_at: Date.now() };
          const origin = number === 1 ? this.copyOrigin(workspaceId, entry, sha256) : { source_version_id: null, change_note: null };
          this.db.prepare('INSERT INTO local_versions(id,document_id,version_number,filename,sha256,bytes,normalized,created_at,source_version_id,change_note) VALUES(?,?,?,?,?,?,?,?,?,?)').run(version.id, document.id, number, entry.name, sha256, data, version.normalized, version.created_at, origin.source_version_id, origin.change_note);
          this.change(workspaceId, version.id, 'document.version.create', 1, { document_id: document.id, version_number: number, sha256 });
        }
        const insert = this.db.prepare('INSERT INTO local_search VALUES(?,?,?,?,?,?)');
        for (const block of normalized.blocks) insert.run(workspaceId, document.id, version.id, block.id, entry.name, block.text);
        this.observeVersion(workspaceId, document.id, version.id);
      });
    } else this.transaction(() => { this.engine.requireFileConnection(workspaceId, entryId); this.observeVersion(workspaceId, document.id, version.id); });
    this.signatures.set(`${workspaceId}:${entryId}`, `${entry.mtime}:${entry.size}`);
    this.db.prepare('INSERT INTO local_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`index-signature:${workspaceId}:${entryId}`, encode({ mtime: entry.mtime, size: entry.size, extension: entry.extension, versionId: version.id }));
    return { document_id: document.id, entry_id: entryId, version_id: version.id, version_number: version.version_number,
      filename: entry.name, sha256, created_at: version.created_at, normalized: JSON.parse(version.normalized) };
  }
  cancelIndex(workspaceId) {
    this.engine.workspace(workspaceId);
    const status = { ...(this.indexStatus.get(workspaceId) || { total: 0, completed: 0, failed: 0 }), state: 'cancelled' };
    this.db.prepare('INSERT INTO local_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`index-paused:${workspaceId}`, encode(status));
    const job = this.indexJobs.get(workspaceId);
    if (job) { job.cancelled = true; job.again = false; job.controller.abort(); }
    this.indexStatus.set(workspaceId, status);
    this.publishIndex(workspaceId, status, true);
  }
  publishIndex(workspaceId, status, force = false) {
    const now = Date.now();
    if (!force && now - (this.indexPublished.get(workspaceId) || 0) < 100) return;
    this.indexPublished.set(workspaceId, now);
    this.engine.emit('changed', workspaceId, { indexing: { ...status } });
  }
  indexWorkspace(workspaceId, { resume = false } = {}) {
    this.engine.workspace(workspaceId);
    if (resume) this.db.prepare('DELETE FROM local_settings WHERE key=?').run(`index-paused:${workspaceId}`);
    else if (this.db.prepare('SELECT key FROM local_settings WHERE key=?').get(`index-paused:${workspaceId}`)) return Promise.resolve();
    if (this.indexJobs.has(workspaceId)) {
      const job = this.indexJobs.get(workspaceId);
      if (job.cancelled && resume) return job.promise.then(() => this.indexWorkspace(workspaceId, { resume: true }));
      job.again = true; return job.promise;
    }
    const state = { again: false, promise: null, cancelled: false, controller: new AbortController() };
    state.promise = (async () => {
      do {
        state.again = false;
        if (this.engine.closed) break;
        const entries = this.engine.snapshot(workspaceId).entries.filter(entry => entry.kind === 'file' && ['.txt', '.md', '.pdf', '.docx', '.hwpx'].includes(entry.extension));
        const status = { state: 'running', total: entries.length, completed: 0, failed: 0 };
        this.indexStatus.set(workspaceId, status); this.publishIndex(workspaceId, status, true);
        for (const entry of entries) {
          if (this.engine.closed || state.cancelled || !this.db.prepare('SELECT id FROM workspaces WHERE id=?').get(workspaceId)) break;
          try {
            this.engine.requireFileConnection(workspaceId, entry.id);
            const saved = this.db.prepare('SELECT value FROM local_settings WHERE key=?').get(`index-signature:${workspaceId}:${entry.id}`);
            const signature = saved ? JSON.parse(saved.value) : null;
            const current = this.db.prepare('SELECT file_version_id FROM local_documents WHERE workspace_id=? AND entry_id=?').get(workspaceId, entry.id);
            if (!signature || signature.mtime !== entry.mtime || signature.size !== entry.size || signature.extension !== entry.extension || signature.versionId !== current?.file_version_id) await this.open(workspaceId, entry.id, state.controller.signal);
            status.completed++;
          } catch (error) { if (error.code === 'FILE_DISCONNECTED') status.total--; else if (error.code !== 'CANCELLED') status.failed++; }
          this.publishIndex(workspaceId, status);
        }
        status.state = state.cancelled ? 'cancelled' : 'complete'; this.indexStatus.set(workspaceId, status); this.publishIndex(workspaceId, status, true);
      } while (state.again && !state.cancelled);
    })().finally(() => this.indexJobs.delete(workspaceId));
    this.indexJobs.set(workspaceId, state);
    return state.promise;
  }
  async importDraft(workspaceId, entryId, requestId, versionId) {
    const metadata = versionId ? this.document(workspaceId, entryId) : null;
    const document = versionId ? this.getVersion(workspaceId, metadata.id, versionId) : await this.open(workspaceId, entryId);
    const sources = [], blocks = []; let budget = 80000, truncated = document.normalized.blocks.length > 200;
    const bounded = (text, maximum) => { const value = text.slice(0, Math.min(maximum, budget)); budget -= value.length; if (value.length < text.length) truncated = true; return value; };
    for (const block of document.normalized.blocks.slice(0, 200)) {
      if (!budget) { truncated = true; break; }
      const sourceId = `version-${document.version_id}-block-${block.id}`;
      sources.push({ id: sourceId, kind: 'document', document_title: document.filename, text: block.text.slice(0, 4000), version_number: document.version_number,
        version_id: document.version_id, document_id: document.document_id, locations: [{ block_id: block.id, ...block.source }] });
      const common = { id: `block-${block.id}`, source_ids: [sourceId] };
      if (block.type === 'table') {
        const rows = [];
        if (block.rows.length > 100 || block.rows.some(row => row.length > 12)) truncated = true;
        for (const row of block.rows.slice(0, 100)) { if (!budget) { truncated = true; break; } rows.push(row.slice(0, 12).map(cell => bounded(cell, 2000))); }
        if (rows.length) blocks.push({ ...common, type: 'table', rows });
      } else if (block.type === 'list_item') blocks.push({ ...common, type: 'list', items: [bounded(block.text, 2000)] });
      else blocks.push({ ...common, type: block.type === 'heading' ? 'heading' : 'paragraph', text: bounded(block.text, 12000), level: block.level || 2 });
    }
    if (!blocks.length) blocks.push({ id: 'empty', type: 'paragraph', text: '' });
    return this.create(workspaceId, requestId, { content: { title: document.normalized.title, blocks }, sources,
      checks: ['원본을 보존한 새 초안입니다. 이미지와 원본 배치를 재현하지 않습니다.', ...(truncated ? ['초안 크기 제한으로 일부 본문·표를 줄였습니다. 전체 내용은 원본과 저장된 스냅샷에서 확인해 주세요.'] : [])] });
  }
  document(workspaceId, entryId) {
    this.engine.workspace(workspaceId);
    const document = this.db.prepare('SELECT d.*,e.name FROM local_documents d JOIN entries e ON e.id=d.entry_id WHERE d.workspace_id=? AND d.entry_id=?').get(workspaceId, entryId);
    if (!document) fail('문서 본문을 먼저 열어 주세요.', 'NOT_FOUND');
    const versions = this.db.prepare('SELECT id,version_number,filename,sha256,length(bytes) AS size,created_at,source_version_id,change_note FROM local_versions WHERE document_id=? ORDER BY version_number').all(document.id)
      .map(version => ({ ...version, original_filename: version.filename, created_at: new Date(version.created_at).toISOString(), status: 'READY', author_name: '이 기기', uploaded_at: new Date(version.created_at).toISOString() }));
    return { id: document.id, entry_id: entryId, title: document.name, current_version_id: document.current_version_id, file_version_id: document.file_version_id, revision: document.revision, current_is_pinned: !!document.current_is_pinned, versions };
  }
  setCurrent(workspaceId, documentId, versionId, revision) {
    this.engine.workspace(workspaceId);
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM local_documents WHERE workspace_id=? AND id=?').get(workspaceId, documentId);
      if (!row) fail('문서를 찾을 수 없습니다.');
      if (row.revision !== revision) conflict();
      const current = versionId || row.file_version_id;
      if (!current) fail('원본 본문을 먼저 읽어 주세요.');
      this.version(workspaceId, documentId, current);
      this.db.prepare('UPDATE local_documents SET current_version_id=?,current_is_pinned=?,revision=revision+1 WHERE id=?').run(current, versionId ? 1 : 0, documentId);
      this.change(workspaceId, documentId, 'document.head', revision + 1, { current_version_id: current, pinned: !!versionId });
    });
    this.engine.emit('changed', workspaceId);
  }
  linkVersion(workspaceId, documentId, sourceId, requestId, revision, note = '') {
    this.engine.workspace(workspaceId);
    if (!uuid(requestId) || typeof note !== 'string' || note.length > 500) fail('수정 이력 연결 정보가 올바르지 않습니다.');
    this.transaction(() => {
      const document = this.db.prepare('SELECT * FROM local_documents WHERE id=? AND workspace_id=?').get(documentId, workspaceId);
      const source = this.db.prepare('SELECT v.* FROM local_versions v JOIN local_documents d ON d.id=v.document_id WHERE v.id=? AND d.workspace_id=?').get(sourceId, workspaceId);
      if (!document?.file_version_id || !source || source.document_id === documentId) fail('같은 작업 공간에서 본문 처리가 끝난 다른 문서 이력을 선택해 주세요.');
      const previous = this.db.prepare('SELECT * FROM local_versions WHERE document_id=? AND request_id=?').get(documentId, requestId);
      if (previous) { if (previous.source_version_id !== sourceId || previous.change_note !== note) conflict(); return; }
      if (document.revision !== revision) conflict();
      const id = randomUUID(), number = this.db.prepare('SELECT coalesce(max(version_number),0)+1 AS n FROM local_versions WHERE document_id=?').get(documentId).n;
      this.db.prepare('INSERT INTO local_versions(id,document_id,version_number,filename,sha256,bytes,normalized,created_at,source_version_id,request_id,change_note) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, documentId, number, source.filename, source.sha256, source.bytes, source.normalized, Date.now(), sourceId, requestId, note);
      const insert = this.db.prepare('INSERT INTO local_search VALUES(?,?,?,?,?,?)');
      for (const block of JSON.parse(source.normalized).blocks) insert.run(workspaceId, documentId, id, block.id, source.filename, block.text);
      this.db.prepare('UPDATE local_documents SET revision=revision+1 WHERE id=?').run(documentId);
      this.change(workspaceId, id, 'document.version.create', 1, { document_id: documentId, version_number: number, sha256: source.sha256, source_version_id: sourceId, change_note: note });
      this.change(workspaceId, documentId, 'document.version.link', revision + 1, { version_id: id });
    });
    this.engine.emit('changed', workspaceId);
  }
  versionSources(workspaceId) {
    this.engine.workspace(workspaceId);
    return this.db.prepare(`SELECT d.entry_id FROM local_documents d JOIN entries e ON e.id=d.entry_id WHERE d.workspace_id=? AND e.present=1 AND ${connectedEntrySQL()} AND EXISTS(SELECT 1 FROM local_versions v WHERE v.document_id=d.id) ORDER BY e.mtime DESC LIMIT 500`).all(workspaceId)
      .map(row => this.document(workspaceId, row.entry_id));
  }
  async candidates(workspaceId, documentId, versionId) {
    const source = this.version(workspaceId, documentId, versionId);
    const total = this.db.prepare(`SELECT count(*) AS n FROM local_documents d JOIN entries e ON e.id=d.entry_id WHERE d.workspace_id=? AND d.id<>? AND e.present=1 AND ${connectedEntrySQL()} AND d.current_version_id IS NOT NULL`).get(workspaceId, documentId).n;
    const rows = this.db.prepare(`SELECT v.id,v.document_id,v.version_number,v.filename,v.sha256,d.revision AS document_revision,e.name AS title FROM local_versions v JOIN local_documents d ON d.current_version_id=v.id JOIN entries e ON e.id=d.entry_id WHERE d.workspace_id=? AND d.id<>? AND e.present=1 AND ${connectedEntrySQL()} ORDER BY e.mtime DESC LIMIT 500`).all(workspaceId, documentId);
    const excerpt = row => this.db.prepare('SELECT substr(text,1,12000) AS text FROM local_search WHERE version_id=? ORDER BY cast(block_id AS INTEGER) LIMIT 40').all(row.id).map(block => block.text).join('\n').slice(0, 12000);
    const items = await runProcessor({ operation: 'candidates', source: { filename: source.filename, sha256: source.sha256, text: excerpt(source) }, candidates: rows.map(row => ({ document_id: row.document_id, document_title: row.title, version_id: row.id, version_number: row.version_number, document_revision: row.document_revision, filename: row.filename, sha256: row.sha256, text: excerpt(row) })) }, this.engine.processorOptions);
    return { items, scanned: rows.length, total, pending: 0, limited: total > rows.length };
  }
  version(workspaceId, documentId, versionId) {
    this.engine.workspace(workspaceId);
    const row = this.db.prepare('SELECT v.*,d.entry_id FROM local_versions v JOIN local_documents d ON d.id=v.document_id WHERE v.id=? AND d.id=? AND d.workspace_id=?').get(versionId, documentId, workspaceId);
    if (!row) fail('이 작업 공간의 문서 이력만 열 수 있습니다.', 'NOT_FOUND');
    return row;
  }
  getVersion(workspaceId, documentId, versionId) {
    const row = this.version(workspaceId, documentId, versionId);
    return { document_id: documentId, entry_id: row.entry_id, version_id: row.id, version_number: row.version_number,
      filename: row.filename, sha256: row.sha256, created_at: row.created_at, normalized: JSON.parse(row.normalized) };
  }
  async compare(workspaceId, documentId, left, right) {
    if (left === right) fail('서로 다른 두 수정 이력을 선택해 주세요.');
    const before = this.getVersion(workspaceId, documentId, left), after = this.getVersion(workspaceId, documentId, right);
    return runProcessor({ operation: 'compare', before: before.normalized, after: after.normalized }, this.engine.processorOptions);
  }
  async restore(workspaceId, documentId, versionId, expectedHash) {
    const version = this.version(workspaceId, documentId, versionId);
    const current = await this.open(workspaceId, version.entry_id);
    if (current.sha256 !== expectedHash) conflict();
    const entry = await this.engine.resolveEntry(workspaceId, version.entry_id);
    if (path.extname(version.filename).toLowerCase() !== entry.extension) fail('현재 파일과 형식이 다른 이력입니다. 원본 저장으로 별도 파일을 만들어 주세요.');
    await this.writeFile(workspaceId, documentId, current.version_number, entry.filename, Buffer.from(version.bytes), expectedHash,
      () => this.version(workspaceId, documentId, versionId));
    await this.engine.scan(workspaceId);
    return this.open(workspaceId, version.entry_id);
  }
  async renderVersion(workspaceId, documentId, versionId, format) {
    const version = this.version(workspaceId, documentId, versionId);
    if (format === 'original') return { title: path.parse(version.filename).name, extension: path.extname(version.filename).slice(1), data: Buffer.from(version.bytes).toString('base64') };
    if (!['docx', 'hwpx', 'pdf', 'txt', 'md'].includes(format)) fail('지원하지 않는 출력 형식입니다.');
    const output = await runProcessor({ operation: 'export', document: JSON.parse(version.normalized), format }, this.engine.processorOptions);
    return { ...output, title: path.parse(version.filename).name, extension: format };
  }
  writeVersionExport(workspaceId, documentId, versionId, filename, data, expectedHash) {
    const version = this.version(workspaceId, documentId, versionId);
    return this.writeFile(workspaceId, documentId, version.version_number, filename, Buffer.from(data, 'base64'), expectedHash,
      () => this.version(workspaceId, documentId, versionId));
  }
  search(workspaceId, query, scope = 'current', asOf) {
    this.engine.workspace(workspaceId);
    if (typeof query !== 'string' || !query.trim() || query.length > 2000 || !['current', 'history', 'as_of'].includes(scope)) fail('검색어 또는 범위가 올바르지 않습니다.');
    let cutoff = Number.MAX_SAFE_INTEGER;
    if (scope === 'as_of') {
      if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) fail('기준 날짜가 필요합니다.');
      const start = Date.parse(`${asOf}T00:00:00+09:00`);
      const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
      if (!Number.isFinite(start) || new Date(start + 9 * 3600000).toISOString().slice(0, 10) !== asOf || asOf > today) fail('기준 날짜가 올바르지 않습니다.');
      cutoff = start + 86400000;
    }
    // Quote generated MATCH expressions; one/two-character terms retain Korean substring fallback.
    const terms = [...new Set(query.trim().toLocaleLowerCase().split(/\s+/))].slice(0, 12);
    const long = terms.filter(term => [...term].length >= 3), short = terms.filter(term => [...term].length < 3);
    const conditions = [long.length ? 's.rowid IN (SELECT rowid FROM local_search WHERE local_search MATCH ?)' : '', ...short.map(() => '(instr(lower(s.text),?)>0 OR instr(lower(s.title),?)>0)')].filter(Boolean).join(' OR ');
    const parameters = [...(long.length ? [long.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')] : []), ...short.flatMap(term => [term, term])];
    const rows = this.db.prepare(`SELECT s.*,v.version_number,v.created_at,d.current_version_id,
      e.present,e.relative_path FROM local_search s JOIN local_versions v ON v.id=s.version_id
      JOIN local_documents d ON d.id=s.document_id JOIN entries e ON e.id=d.entry_id
      WHERE s.workspace_id=? AND (${conditions}) AND ${connectedEntrySQL()}
      AND (?!='current' OR (d.current_version_id=s.version_id AND e.present=1))
      AND (?!='as_of' OR (v.created_at<? AND v.version_number=(SELECT max(v2.version_number) FROM local_versions v2 WHERE v2.document_id=d.id AND v2.created_at<?)))
      ORDER BY v.created_at DESC LIMIT 60`).all(workspaceId, ...parameters, scope, scope, cutoff, cutoff);
    return rows.map(row => ({ id: `version-${row.version_id}-block-${row.block_id}`, kind: 'document',
      document_id: row.document_id, version_id: row.version_id, version_number: row.version_number,
      document_title: row.title, text: row.text.slice(0, 4000), locations: [{ block_id: Number(row.block_id) }],
      is_current: row.current_version_id === row.version_id, available: !!row.present, relative_path: row.relative_path }));
  }
  async prepareGeneration(workspaceId, input) {
    this.engine.workspace(workspaceId);
    if (!input || !uuid(input.requestId) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000) fail('AI 작성 요청이 올바르지 않습니다.');
    const key = `ai-request:${workspaceId}:${input.requestId}`;
    const fingerprint = hash(encode(input));
    const prior = this.db.prepare('SELECT value FROM local_settings WHERE key=?').get(key);
    if (prior) {
      const saved = JSON.parse(prior.value);
      if (saved.fingerprint !== fingerprint) fail('다른 내용에 사용된 요청 식별자입니다.');
      if (saved.draftId) return { existing: this.get(workspaceId, saved.draftId) };
      fail('이미 접수한 요청입니다. 처리 여부를 확인한 뒤 새 요청으로 시도해 주세요.', 'AI_PENDING');
    }
    const draft = input.draftId ? this.row(workspaceId, input.draftId, input.revision) : null;
    await this.indexWorkspace(workspaceId);
    const sources = writingContext(this, workspaceId, input.prompt, draft);
    this.db.prepare('INSERT INTO local_settings(key,value) VALUES(?,?)').run(key, encode({ fingerprint, state: 'pending' }));
    return { task: 'write', request_id: input.requestId, prompt: input.prompt, sources, current: draft?.content || null };
  }
  finishGeneration(workspaceId, input, result) {
    const key = `ai-request:${workspaceId}:${input.requestId}`;
    const state = this.db.prepare('SELECT value FROM local_settings WHERE key=?').get(key);
    if (!state || JSON.parse(state.value).fingerprint !== hash(encode(input))) fail('AI 요청 상태가 올바르지 않습니다.');
    if (!result || !Array.isArray(result.sources) || result.sources.length > 20 || !Array.isArray(result.checks) || result.checks.length > 30 || result.checks.some(check => typeof check !== 'string' || check.length > 1000)) fail('AI 응답 형식을 검증하지 못했습니다.');
    const content = validateContent(result.content, result.sources);
    let draft;
    if (input.draftId) {
      draft = this.update(workspaceId, input.draftId, input.revision, row => {
        row.proposal = { content, sources: result.sources, checks: result.checks };
      }, 'draft.propose');
    } else draft = this.create(workspaceId, input.requestId, { ...result, content });
    this.db.prepare('UPDATE local_settings SET value=? WHERE key=?').run(encode({ ...JSON.parse(state.value), state: 'complete', draftId: draft.id }), key);
    return draft;
  }
  async recover() {
    for (const item of this.db.prepare("SELECT * FROM save_journal WHERE state='prepared'").all()) {
      try {
        const actual = hash(await readFile(item.destination));
        if (actual === item.content_hash) this.db.prepare("UPDATE save_journal SET state='complete' WHERE id=?").run(item.id);
        else this.db.prepare("UPDATE save_journal SET state='needs_review' WHERE id=?").run(item.id);
      } catch (error) {
        if (error.code === 'ENOENT') {
          // A crash between preserving the old file and publishing the new file must not hide the original.
          await link(`${item.temporary}.original`, item.destination).catch(() => {});
        }
        this.db.prepare("UPDATE save_journal SET state='needs_review' WHERE id=?").run(item.id);
      }
    }
  }
  recoveryItems(workspaceId) {
    this.engine.workspace(workspaceId);
    return this.db.prepare("SELECT id,destination,created_at FROM save_journal WHERE workspace_id=? AND state IN ('prepared','needs_review') ORDER BY created_at DESC").all(workspaceId)
      .map(item => ({ id: item.id, filename: path.basename(item.destination), created_at: item.created_at }));
  }
  recoveryItem(workspaceId, id) {
    this.engine.workspace(workspaceId);
    if (!uuid(id)) fail('복구 항목을 찾을 수 없습니다.');
    const item = this.db.prepare("SELECT * FROM save_journal WHERE workspace_id=? AND id=? AND state IN ('prepared','needs_review')").get(workspaceId, id);
    if (!item) fail('복구 항목을 찾을 수 없습니다.');
    return item;
  }
  async renderRecovery(workspaceId, id, original) {
    const item = this.recoveryItem(workspaceId, id);
    const filename = original ? `${item.temporary}.original` : item.temporary;
    const expected = original ? item.expected_hash : item.content_hash;
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50 * 1024 * 1024) fail('복구 자료를 읽을 수 없습니다.');
    const data = await readFile(filename);
    if (!expected || hash(data) !== expected) fail('복구 자료가 변경되었습니다. 원본 위치를 직접 확인해 주세요.');
    return { title: path.parse(item.destination).name + (original ? '-저장전' : '-복구'), extension: path.extname(item.destination).slice(1) || 'bin', data: data.toString('base64') };
  }
  async writeRecovery(workspaceId, id, original, filename, expectedHash) {
    const output = await this.renderRecovery(workspaceId, id, original);
    return this.writeFile(workspaceId, id, 0, filename, Buffer.from(output.data, 'base64'), expectedHash, () => this.recoveryItem(workspaceId, id));
  }
  acknowledgeRecovery(workspaceId, id) {
    this.recoveryItem(workspaceId, id);
    // Acknowledgement never deletes the preserved temporary/original files.
    this.db.prepare("UPDATE save_journal SET state='reviewed' WHERE id=?").run(id);
    this.engine.emit('changed', workspaceId);
  }
  async writeFile(workspaceId, draftId, revision, filename, data, expectedHash, validateRevision = () => this.row(workspaceId, draftId, revision)) {
    await validateRevision();
    if (!Buffer.isBuffer(data) || data.length > 50 * 1024 * 1024 || !path.isAbsolute(filename)) fail('저장할 파일이 올바르지 않습니다.');
    const parent = await realpath(path.dirname(filename));
    const parentIdentity = await lstat(parent);
    const destination = path.join(parent, path.basename(filename));
    const relative = path.relative(this.engine.dataDirectory, destination);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) fail('앱 내부 폴더에는 내보낼 수 없습니다.');
    const check = async () => {
      await validateRevision();
      const currentParent = await lstat(parent);
      if (await realpath(path.dirname(filename)) !== parent || currentParent.isSymbolicLink() || !currentParent.isDirectory() || currentParent.ino !== parentIdentity.ino || currentParent.dev !== parentIdentity.dev) fail('저장하는 동안 대상 폴더가 변경되었습니다. 원본을 보존했습니다.');
      try {
        const stats = await lstat(destination);
        if (!stats.isFile() || stats.isSymbolicLink()) fail('일반 파일로만 저장할 수 있습니다.');
        if (expectedHash === null || hash(await readFile(destination)) !== expectedHash) conflict();
        return stats.mode;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (expectedHash !== null) conflict();
        return 0o600;
      }
    };
    const mode = await check(), id = randomUUID(), temporary = path.join(parent, `.context-save-${id}.tmp`);
    this.db.prepare('INSERT INTO save_journal VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, workspaceId, draftId, revision, destination, temporary, expectedHash, hash(data), 'prepared', Date.now());
    // File data is durable before replacement; an interrupted save remains recoverable in the journal.
    const file = await open(temporary, 'wx', mode);
    try {
      await file.writeFile(data); await file.sync(); await file.close();
      await validateRevision();
      await check();
      if (expectedHash === null) {
        // Exclusive publication cannot overwrite a file created after the dialog/check.
        await link(temporary, destination);
        await unlink(temporary);
      } else {
        const original = `${temporary}.original`;
        await rename(destination, original);
        try {
          if (hash(await readFile(original)) !== expectedHash) conflict();
          await link(temporary, destination);
          await unlink(temporary);
        } catch (error) {
          // Never overwrite a competing writer. Both the original and draft remain recoverable.
          await link(original, destination).catch(() => {});
          throw error;
        }
        await unlink(original);
      }
      this.db.prepare("UPDATE save_journal SET state='complete' WHERE id=?").run(id);
    } catch (error) {
      await file.close().catch(() => {});
      this.db.prepare("UPDATE save_journal SET state='needs_review' WHERE id=?").run(id);
      // Preserve the temporary output when replacement failed; the original is never deleted.
      throw error;
    }
    return { saved: true };
  }
}
