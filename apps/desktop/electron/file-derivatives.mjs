import { backup } from 'node:sqlite';
import { mkdir, open, realpath, lstat, link, unlink } from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { runProcessor } from './processor.mjs';

const formats = ['pdf', 'docx', 'hwpx', 'txt', 'md'];
const supported = new Set(formats.map(format => `.${format}`));
const uuid = value => typeof value === 'string' && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const hash = data => createHash('sha256').update(data).digest('hex');
// Bump when the frozen export implementation changes; do not reuse stale outputs.
const renderer = 'normalized-export-v1';
const publicJob = row => ({ version_id: row.version_id, format: row.format, state: row.state, attempts: row.attempts, error_message: row.error_message, size: row.size, warnings: JSON.parse(row.warnings || '[]') });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

export async function migrateDerivatives(db, directory) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= 8) return;
  if (db.prepare('SELECT count(*) AS n FROM workspaces').get().n) {
    await mkdir(path.join(directory, 'backups'), { recursive: true, mode: 0o700 });
    await backup(db, path.join(directory, 'backups', `workspace-v${version}-${Date.now()}.sqlite`));
  }
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS local_conversions (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      version_id TEXT NOT NULL REFERENCES local_versions(id) ON DELETE CASCADE, format TEXT NOT NULL,
      renderer TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      error_message TEXT, warnings TEXT NOT NULL DEFAULT '[]', size INTEGER, sha256 TEXT, bytes BLOB,
      PRIMARY KEY(version_id,format)
    );
    CREATE TABLE IF NOT EXISTS local_copy_requests (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, entry_id TEXT NOT NULL, version_id TEXT,
      state TEXT NOT NULL, payload TEXT NOT NULL, result_entry_id TEXT,
      PRIMARY KEY(workspace_id,request_id)
    );
    PRAGMA user_version=8; COMMIT;`);
}

export class FileDerivatives {
  constructor(engine, { processor = runProcessor } = {}) {
    this.engine = engine; this.db = engine.db; this.processor = processor;
    const resources = engine.processorOptions.resourcesPath || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../processor/dist');
    this.renderer = renderer;
    try { this.renderer += ':' + JSON.parse(readFileSync(path.join(resources, 'context-processor/manifest.json'), 'utf8')).source_sha256; } catch { /* Missing processors produce explicit failed jobs on request. */ }
    this.active = null; this.stopped = false; this.blocked = new Set(); this.copyQueue = Promise.resolve();
    this.db.prepare("UPDATE local_conversions SET state='QUEUED' WHERE state='RUNNING'").run();
    this.db.prepare("UPDATE local_conversions SET state='QUEUED',bytes=NULL,size=NULL,sha256=NULL,renderer=? WHERE renderer<>?").run(this.renderer, this.renderer);
  }
  source(workspaceId, versionId) {
    this.engine.workspace(workspaceId);
    const row = this.db.prepare('SELECT v.*,d.entry_id FROM local_versions v JOIN local_documents d ON d.id=v.document_id WHERE v.id=? AND d.workspace_id=?').get(versionId, workspaceId);
    if (!row) throw new Error('이 작업 공간의 문서 이력을 선택해 주세요.');
    return row;
  }
  list(workspaceId, documentId) {
    this.engine.workspace(workspaceId);
    return this.db.prepare(`SELECT c.* FROM local_conversions c JOIN local_versions v ON v.id=c.version_id
      WHERE c.workspace_id=? AND v.document_id=? ORDER BY v.version_number,c.format`).all(workspaceId, documentId).map(publicJob);
  }
  request(workspaceId, versionId, format) {
    this.source(workspaceId, versionId);
    if (!formats.includes(format)) throw new Error('지원하지 않는 출력 형식입니다.');
    const existing = this.db.prepare('SELECT * FROM local_conversions WHERE version_id=? AND format=?').get(versionId, format);
    if (!existing || existing.state === 'FAILED') {
      this.db.prepare(`INSERT INTO local_conversions(workspace_id,version_id,format,renderer,state) VALUES(?,?,?,?,'QUEUED')
        ON CONFLICT(version_id,format) DO UPDATE SET state='QUEUED',error_message=NULL`).run(workspaceId, versionId, format, this.renderer);
      this.changed(workspaceId);
    }
    this.storageFailed = false; this.kick();
    return publicJob(this.db.prepare('SELECT * FROM local_conversions WHERE version_id=? AND format=?').get(versionId, format));
  }
  changed(workspaceId) { if (!this.stopped && !this.blocked.has(workspaceId)) this.engine.emit('changed', workspaceId, { conversions: true }); }
  kick() {
    if (this.active || this.stopped || this.storageFailed) return;
    const row = this.db.prepare("SELECT * FROM local_conversions WHERE state='QUEUED' ORDER BY rowid LIMIT 1").get();
    if (!row || this.blocked.has(row.workspace_id)) return;
    const controller = new AbortController();
    const promise = this.convert(row, controller.signal).catch(() => { this.storageFailed = true; this.changed(row.workspace_id); }).finally(() => { this.active = null; this.kick(); });
    this.active = { workspaceId: row.workspace_id, controller, promise };
  }
  async convert(row, signal) {
    this.db.prepare("UPDATE local_conversions SET state='RUNNING',attempts=attempts+1,error_message=NULL WHERE version_id=? AND format=?").run(row.version_id, row.format);
    this.changed(row.workspace_id);
    try {
      const source = this.source(row.workspace_id, row.version_id);
      const output = await this.processor({ operation: 'export', document: JSON.parse(source.normalized), format: row.format }, { ...this.engine.processorOptions, signal });
      if (signal.aborted || this.stopped || this.blocked.has(row.workspace_id)) return;
      this.source(row.workspace_id, row.version_id);
      const data = Buffer.from(output.data, 'base64');
      if (!data.length || data.length > 50 * 1024 * 1024) throw new Error('변환 파일은 50MB 이하만 보관할 수 있습니다.');
      this.db.prepare("UPDATE local_conversions SET state='COMPLETED',warnings=?,bytes=?,size=?,sha256=? WHERE version_id=? AND format=?")
        .run(JSON.stringify(output.warnings || []), data, data.length, hash(data), row.version_id, row.format);
    } catch (error) {
      if (signal.aborted || this.stopped || this.blocked.has(row.workspace_id)) return;
      this.db.prepare("UPDATE local_conversions SET state='FAILED',error_message=? WHERE version_id=? AND format=?")
        .run(error.message || '변환에 실패했습니다. 다시 시도해 주세요.', row.version_id, row.format);
    }
    this.changed(row.workspace_id);
  }
  output(workspaceId, versionId, format) {
    const source = this.source(workspaceId, versionId);
    const row = this.db.prepare("SELECT * FROM local_conversions WHERE workspace_id=? AND version_id=? AND format=? AND state='COMPLETED'").get(workspaceId, versionId, format);
    if (!row) throw new Error('변환이 완료된 파일을 선택해 주세요.');
    if (hash(row.bytes) !== row.sha256) {
      this.db.prepare("UPDATE local_conversions SET state='FAILED',error_message='보관된 변환 파일을 확인하지 못했습니다. 다시 변환해 주세요.' WHERE version_id=? AND format=?").run(versionId, format);
      this.changed(workspaceId); throw new Error('보관된 변환 파일을 확인하지 못했습니다. 다시 변환해 주세요.');
    }
    return { title: `${path.parse(source.filename).name}-v${source.version_number}`, extension: format, data: Buffer.from(row.bytes).toString('base64') };
  }
  async save(workspaceId, versionId, format, filename, expectedHash) {
    const source = this.source(workspaceId, versionId), output = this.output(workspaceId, versionId, format);
    const entry = this.db.prepare('SELECT relative_path FROM entries WHERE id=?').get(source.entry_id);
    const parent = await realpath(path.dirname(filename));
    const destination = path.join(parent, path.basename(filename));
    const target = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (entry && target) {
      const original = await lstat(path.join(this.engine.workspace(workspaceId).root, entry.relative_path)).catch(() => null);
      if (original && same(target, original)) throw new Error('원본 파일과 다른 이름이나 위치에 저장해 주세요.');
    }
    if (entry && destination === path.join(this.engine.workspace(workspaceId).root, entry.relative_path)) throw new Error('원본 파일과 다른 이름이나 위치에 저장해 주세요.');
    await this.engine.documents.writeFile(workspaceId, source.document_id, source.version_number, destination, Buffer.from(output.data, 'base64'), expectedHash, () => this.source(workspaceId, versionId));
    await this.engine.scan(workspaceId);
  }
  async pause(workspaceId) {
    this.blocked.add(workspaceId);
    if (this.active?.workspaceId === workspaceId) { this.active.controller.abort(); await this.active.promise; }
  }
  async close() {
    this.stopped = true;
    if (this.active) { this.active.controller.abort(); await this.active.promise; }
    await this.copyQueue;
  }
  copy(workspaceId, entryId, requestId, versionId = null) {
    const job = this.copyQueue.then(() => this.copyOnce(workspaceId, entryId, requestId, versionId));
    this.copyQueue = job.catch(() => {}); return job;
  }
  copyEntry(workspaceId, entryId) {
    const entry = this.db.prepare('SELECT e.*,p.x,p.y FROM entries e LEFT JOIN positions p ON p.entry_id=e.id WHERE e.id=? AND e.workspace_id=? AND e.present=1').get(entryId, workspaceId);
    if (!entry) throw new Error('복사본이 이동되거나 삭제됐습니다. 폴더를 새로고침해 주세요.');
    return entry;
  }
  async copyParent(workspaceId, payload) {
    const workspace = this.engine.workspace(workspaceId);
    if (workspace.root !== payload.root || await realpath(workspace.root) !== workspace.root) throw new Error('연결 폴더의 위치가 변경되었습니다. 다시 확인해 주세요.');
    const directory = path.join(workspace.root, payload.parent);
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw new Error('원본 폴더의 위치가 변경되었습니다.');
    return directory;
  }
  async copyOnce(workspaceId, entryId, requestId, versionId) {
    this.engine.workspace(workspaceId);
    if (!uuid(entryId) || !uuid(requestId) || versionId !== null && !uuid(versionId)) throw new Error('복사 요청이 올바르지 않습니다.');
    let row = this.db.prepare('SELECT * FROM local_copy_requests WHERE workspace_id=? AND request_id=?').get(workspaceId, requestId);
    if (row && (row.entry_id !== entryId || row.version_id !== versionId)) throw new Error('다른 작업에 사용한 복사 요청입니다.');
    if (row?.state === 'COMPLETED') { await this.engine.resolveEntry(workspaceId, row.result_entry_id); return this.copyEntry(workspaceId, row.result_entry_id); }
    const entry = await this.engine.resolveEntry(workspaceId, entryId);
    if (entry.kind !== 'file' || entry.filename !== path.join(this.engine.workspace(workspaceId).root, entry.relative_path) || (await lstat(entry.filename)).isSymbolicLink()) throw new Error('일반 파일만 복사할 수 있습니다.');
    if (row && ['PREPARED', 'PUBLISHED'].includes(row.state)) return this.publishCopy(workspaceId, requestId, JSON.parse(row.payload));
    let version;
    if (versionId) {
      version = this.source(workspaceId, versionId);
      if (version.entry_id !== entryId) throw new Error('선택한 파일의 수정 이력만 복사할 수 있습니다.');
    } else if (supported.has(entry.extension)) {
      const doc = this.engine.documents.document(workspaceId, entryId);
      // A pinned snapshot remains authoritative even when the disk file is now unparseable.
      if (doc.current_is_pinned && doc.current_version_id) version = this.source(workspaceId, doc.current_version_id);
      else {
        // Parse failure must not stop an otherwise valid binary file copy.
        try {
          await this.engine.documents.open(workspaceId, entryId);
          const current = this.engine.documents.document(workspaceId, entryId);
          version = this.source(workspaceId, current.current_version_id);
        } catch { /* Unsupported/corrupt/large files are still ordinary files. */ }
      }
    }
    const sourceName = version?.filename || entry.name;
    const payload = { root: this.engine.workspace(workspaceId).root, parent: entry.parent_path, name: path.basename(sourceName), temporary: `.context-copy-${randomUUID()}.tmp`, hash: null, version: version?.id || null };
    const directory = await this.copyParent(workspaceId, payload), temporary = path.join(directory, payload.temporary);
    this.db.prepare(`INSERT INTO local_copy_requests VALUES(?,?,?,?,'PREPARING',?,NULL)
      ON CONFLICT(workspace_id,request_id) DO UPDATE SET state='PREPARING',payload=excluded.payload`).run(workspaceId, requestId, entryId, versionId, JSON.stringify(payload));
    let file, source;
    try {
      file = await open(temporary, 'wx', 0o600);
      const staged = await file.stat(); payload.inode = staged.ino; payload.device = staged.dev;
      this.db.prepare('UPDATE local_copy_requests SET payload=? WHERE workspace_id=? AND request_id=?').run(JSON.stringify(payload), workspaceId, requestId);
      const fingerprint = createHash('sha256');
      if (version) { const bytes = Buffer.from(version.bytes); await file.writeFile(bytes); fingerprint.update(bytes); }
      else {
        source = await open(entry.filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const before = await source.stat();
        if (!before.isFile() || before.ino !== entry.inode || before.dev !== entry.device) throw new Error('복사할 원본 파일이 변경됐습니다.');
        const buffer = Buffer.alloc(1024 * 1024);
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
          const bytes = buffer.subarray(0, bytesRead); fingerprint.update(bytes); await file.writeFile(bytes);
        }
        const after = await source.stat(), checked = await this.engine.resolveEntry(workspaceId, entryId);
        if (!same(before, after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || checked.mtime !== after.mtimeMs || checked.size !== after.size || checked.filename !== entry.filename || checked.inode !== before.ino || checked.device !== before.dev) throw new Error('복사 중 원본이 변경됐습니다. 다시 시도해 주세요.');
      }
      await file.sync(); const stats = await file.stat(); await file.close(); file = null;
      payload.hash = fingerprint.digest('hex'); payload.inode = stats.ino; payload.device = stats.dev;
      this.db.prepare("UPDATE local_copy_requests SET state='PREPARED',payload=? WHERE workspace_id=? AND request_id=?").run(JSON.stringify(payload), workspaceId, requestId);
    } catch (error) {
      const owned = file ? await file.stat().catch(() => null) : null;
      if (file) await file.close().catch(() => {});
      const current = await lstat(temporary).catch(() => null);
      if (owned && current && same(owned, current)) await unlink(temporary).catch(() => {});
      this.db.prepare("UPDATE local_copy_requests SET state='FAILED' WHERE workspace_id=? AND request_id=?").run(workspaceId, requestId);
      throw error;
    } finally { if (source) await source.close(); }
    return this.publishCopy(workspaceId, requestId, payload);
  }
  async publishCopy(workspaceId, requestId, payload) {
    const request = this.db.prepare('SELECT entry_id FROM local_copy_requests WHERE workspace_id=? AND request_id=?').get(workspaceId, requestId);
    if (!request) throw new Error('복사 요청을 찾을 수 없습니다.');
    this.engine.requireFileConnection(workspaceId, request.entry_id);
    const directory = await this.copyParent(workspaceId, payload), temporary = path.join(directory, payload.temporary);
    const stats = await lstat(temporary);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.ino !== payload.inode || stats.dev !== payload.device) throw new Error('복사 중간 파일이 변경됐습니다. 원본은 유지했습니다.');
    // Hash streaming output again only during publication/recovery, without loading a large file into memory.
    const reader = await open(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const fingerprint = createHash('sha256');
    try { for await (const bytes of reader.createReadStream()) fingerprint.update(bytes); } finally { await reader.close(); }
    if (fingerprint.digest('hex') !== payload.hash) throw new Error('복사 중간 파일을 검증하지 못했습니다.');
    const extension = path.extname(payload.name), suffix = Buffer.byteLength(extension) > 200 ? '' : extension, stem = path.basename(payload.name, suffix);
    let destination = payload.destination ? path.join(directory, payload.destination) : null;
    if (destination) {
      const existing = await lstat(destination).catch(() => null);
      if (!existing || !same(existing, stats)) destination = null;
    }
    if (!destination) {
      for (let number = 1; number <= 100000; number++) {
        const label = number === 1 ? ' copy' : ` copy ${number}`;
        const name = `${Array.from(stem).slice(0, Math.max(1, 220 - Buffer.byteLength(suffix + label))).join('')}${label}${suffix}`;
        // Bound the actual UTF-8 filename, including Korean and emoji.
        let base = path.basename(name, suffix);
        while (Buffer.byteLength(base + suffix) > 240) base = Array.from(base).slice(1).join('');
        payload.destination = base + suffix;
        this.db.prepare("UPDATE local_copy_requests SET payload=? WHERE workspace_id=? AND request_id=?").run(JSON.stringify(payload), workspaceId, requestId);
        destination = path.join(directory, payload.destination);
        try { await link(temporary, destination); break; }
        catch (error) { destination = null; if (error.code !== 'EEXIST') throw error; }
      }
      if (!destination) throw new Error('복사본 이름을 만들 수 없습니다.');
    }
    this.db.prepare("UPDATE local_copy_requests SET state='PUBLISHED' WHERE workspace_id=? AND request_id=?").run(workspaceId, requestId);
    await this.engine.scan(workspaceId);
    const relative = path.relative(payload.root, destination).split(path.sep).join('/');
    const result = this.db.prepare('SELECT id FROM entries WHERE workspace_id=? AND relative_path=? AND present=1').get(workspaceId, relative);
    if (!result) throw new Error('복사본은 생성됐지만 목록에 반영되지 않았습니다. 다시 확인해 주세요.');
    if (payload.version) {
      try {
        const version = await this.engine.documents.open(workspaceId, result.id);
        // copyOrigin reads the durable copy request before the first immutable
        // version is published, including recovery and background parser races.
        if (version.sha256 !== payload.hash) throw new Error('복사본의 원본 해시가 변경되었습니다.');
      } catch { /* Keep the physical copy even if background content processing is unavailable. */ }
    }
    this.db.prepare("UPDATE local_copy_requests SET state='COMPLETED',result_entry_id=? WHERE workspace_id=? AND request_id=?").run(result.id, workspaceId, requestId);
    await unlink(temporary).catch(() => {});
    this.changed(workspaceId);
    return this.copyEntry(workspaceId, result.id);
  }
  async cleanupCopy(workspaceId, payload) {
    if (!payload.inode || !payload.device) return;
    try {
      const directory = await this.copyParent(workspaceId, payload), filename = path.join(directory, payload.temporary);
      const stats = await lstat(filename);
      if (stats.isFile() && !stats.isSymbolicLink() && stats.ino === payload.inode && stats.dev === payload.device) await unlink(filename);
    } catch { /* A disconnected drive or replaced file is never removed. */ }
  }
  async recoverCopies() {
    for (const row of this.db.prepare("SELECT * FROM local_copy_requests WHERE state IN ('PREPARED','PUBLISHED')").all()) {
      try { await this.publishCopy(row.workspace_id, row.request_id, JSON.parse(row.payload)); } catch { /* Retry the same request; never publish another copy blindly. */ }
    }
    for (const row of this.db.prepare("SELECT * FROM local_copy_requests WHERE state='COMPLETED'").all()) await this.cleanupCopy(row.workspace_id, JSON.parse(row.payload));
    for (const row of this.db.prepare("SELECT * FROM local_copy_requests WHERE state='PREPARING'").all()) {
      // No publication can have happened before PREPARED. Only remove our own partial temp inode.
      await this.cleanupCopy(row.workspace_id, JSON.parse(row.payload));
      this.db.prepare("UPDATE local_copy_requests SET state='FAILED' WHERE workspace_id=? AND request_id=?").run(row.workspace_id, row.request_id);
    }
  }
}
