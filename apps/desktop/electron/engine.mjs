import { EventEmitter } from 'node:events';
import { mkdir, readdir, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { watch } from 'chokidar';
import { LocalDocuments, migrateDocuments } from './local-documents.mjs';
import { runProcessor } from './processor.mjs';
import { LocalChat } from './local-chat.mjs';
import { FileDerivatives, migrateDerivatives } from './file-derivatives.mjs';
import { LocalFiles } from './local-files.mjs';
import { LocalCanvas } from './local-canvas.mjs';
import { LocalSummaries } from './local-summaries.mjs';
import { LocalInsights } from './local-insights.mjs';
import { CloudSnapshots, migrateCloud } from './cloud-snapshot.mjs';
import { connectedEntrySQL, deviceConnectedEntrySQL, fileConnectionKey } from './file-connections.mjs';
import { migrateUnified } from './unified-store.mjs';
import { UnifiedWorkspace } from './unified-workspace.mjs';

const GENERATED = new Set(['node_modules', '.git', '.next', '.venv', '__pycache__']);
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MAX_ENTRIES = 250000;
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function requireId(id) { if (!uuid(id)) throw new Error('작업 공간 또는 파일 식별자가 올바르지 않습니다.'); }
function coordinates(value) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000; }

/** Runs in a worker thread. The renderer never supplies an unrestricted filesystem path. */
export class WorkspaceEngine extends EventEmitter {
  constructor(dataDirectory, options = {}) {
    super();
    this.dataDirectory = path.resolve(dataDirectory);
    this.watchers = new Map(); this.scans = new Map(); this.timers = new Map(); this.health = new Map();
    this.closed = false; this.watcherWarnings = new Map();
    this.processorOptions = options;
    this.mutating = new Set();
  }
  async init({ watchFiles = true } = {}) {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(this.dataDirectory, 'workspace.sqlite'));
    if (this.db.prepare('PRAGMA user_version').get().user_version > 10) throw new Error('더 새로운 앱에서 만든 저장소입니다. 앱을 업데이트해 주세요.');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
        show_hidden INTEGER NOT NULL DEFAULT 0, include_generated INTEGER NOT NULL DEFAULT 0,
        last_opened INTEGER NOT NULL, scanned_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL, parent_path TEXT NOT NULL, name TEXT NOT NULL,
        kind TEXT NOT NULL, extension TEXT NOT NULL, size REAL NOT NULL, mtime REAL NOT NULL,
        identity TEXT NOT NULL, present INTEGER NOT NULL DEFAULT 1, excluded INTEGER NOT NULL DEFAULT 0,
        UNIQUE(workspace_id, relative_path)
      );
      CREATE INDEX IF NOT EXISTS entries_parent ON entries(workspace_id, parent_path, present);
      CREATE TABLE IF NOT EXISTS positions (
        entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, x REAL NOT NULL, y REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS views (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        directory TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, zoom REAL NOT NULL,
        PRIMARY KEY(workspace_id, directory)
      );`);
    await migrateDocuments(this.db, this.dataDirectory);
    await migrateDerivatives(this.db, this.dataDirectory);
    await migrateCloud(this.db, this.dataDirectory);
    await migrateUnified(this.db, this.dataDirectory);
    this.documents = new LocalDocuments(this);
    this.chat = new LocalChat(this);
    this.files = new LocalFiles(this);
    this.canvas = new LocalCanvas(this);
    this.summaries = new LocalSummaries(this);
    this.insights = new LocalInsights(this);
    this.derivatives = new FileDerivatives(this);
    this.cloud = new CloudSnapshots(this);
    this.unified = new UnifiedWorkspace(this);
    await this.documents.recover();
    this.watchFiles = watchFiles;
    await this.unified.recover();
    // Physical staging is recovered before the first watcher/catch-up capture.
    // Restore interrupted chat status after canonical metadata projection too.
    this.chat.recoverInterrupted();
    for (const workspace of this.list()) this.unified.capture(workspace.id, { readOnlyReconcile: true });
    // Reconcile cached folders on launch, even if their OS watcher missed changes while closed.
    for (const workspace of this.list()) {
      await this.scan(workspace.id);
      if (this.processorOptions.unifiedCommands !== false && !this.unified.store.row(workspace.id)?.import_complete && this.health.get(workspace.id)?.status === 'ready') this.unified.bridge.capture(workspace.id);
      if (watchFiles) await this.startWatcher(workspace.id);
    }
    if (watchFiles) {
      this.reconcile = setInterval(() => {
        for (const item of this.list()) this.scan(item.id).catch(() => {});
      }, 60000);
      this.reconcile.unref();
    }
    await this.derivatives.recoverCopies();
    this.derivatives.kick();
    if (this.processorOptions.unifiedCommands !== false) this.unified.installHooks();
    return this;
  }
  workspace(id) {
    requireId(id);
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
    if (!row) throw new Error('연결된 작업 공간을 찾을 수 없습니다.');
    return row;
  }
  list() { return this.db.prepare('SELECT * FROM workspaces ORDER BY last_opened DESC').all(); }
  async checkedRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('폴더를 선택해 주세요.');
    const resolved = await realpath(root);
    if (!(await lstat(resolved)).isDirectory()) throw new Error('폴더만 연결할 수 있습니다.');
    if (inside(this.dataDirectory, resolved)) throw new Error('앱의 내부 저장 폴더는 연결할 수 없습니다.');
    return resolved;
  }
  async connect(root) {
    root = await this.checkedRoot(root);
    let row = this.db.prepare('SELECT * FROM workspaces WHERE root=?').get(root);
    if (!row) {
      const id = randomUUID();
      this.db.prepare('INSERT INTO workspaces(id,root,label,last_opened) VALUES(?,?,?,?)')
        .run(id, root, path.basename(root) || root, Date.now());
      row = this.workspace(id);
    }
    this.db.prepare('UPDATE workspaces SET last_opened=? WHERE id=?').run(Date.now(), row.id);
    await this.scan(row.id);
    if (this.processorOptions.unifiedCommands !== false && !this.unified.store.row(row.id)?.import_complete && this.health.get(row.id)?.status === 'ready') this.unified.bridge.capture(row.id);
    if (this.watchFiles) await this.startWatcher(row.id);
    return this.snapshot(row.id);
  }
  async relink(id, root) {
    this.workspace(id); root = await this.checkedRoot(root);
    const duplicate = this.db.prepare('SELECT id FROM workspaces WHERE root=? AND id<>?').get(root, id);
    if (duplicate) throw new Error('이미 연결된 폴더입니다. 해당 작업 공간을 열어 주세요.');
    await this.stopWatcher(id);
    this.db.prepare('UPDATE workspaces SET root=?,label=? WHERE id=?').run(root, path.basename(root) || root, id);
    await this.scan(id);
    if (this.watchFiles) await this.startWatcher(id);
    return this.snapshot(id);
  }
  snapshot(id) {
    const workspace = this.workspace(id);
    const entries = this.db.prepare(`SELECT e.*,p.x,p.y,d.id AS document_id,v.version_number, COALESCE(area.value,'0')='1' AS area_positioned,
      (SELECT count(*) FROM local_versions history WHERE history.document_id=d.id) AS version_count
      FROM entries e LEFT JOIN positions p ON p.entry_id=e.id LEFT JOIN local_documents d ON d.entry_id=e.id LEFT JOIN local_versions v ON v.id=d.current_version_id
      LEFT JOIN local_settings area ON area.key='folder-area:' || e.workspace_id || ':' || e.id
      WHERE e.workspace_id=? AND e.present=1 AND ${connectedEntrySQL()} ORDER BY e.relative_path LIMIT ?`).all(id, MAX_ENTRIES);
    const disconnected_files = this.db.prepare(`SELECT e.id,e.name,e.relative_path,e.present AS available FROM entries e
      WHERE e.workspace_id=? AND e.kind='file' AND NOT (${deviceConnectedEntrySQL()}) ORDER BY e.relative_path`).all(id)
      .map(entry => ({ ...entry, available: !!entry.available }));
    const views = this.db.prepare('SELECT directory,x,y,zoom FROM views WHERE workspace_id=?').all(id);
    const health = this.health.get(id) || { status: 'ready', warnings: [] };
    const focus = this.db.prepare('SELECT value FROM local_settings WHERE key=?').get(`spatial-focus:${id}`)?.value || '';
    const spatial_focus = entries.some(entry => entry.kind === 'directory' && entry.relative_path === focus) ? focus : '';
    const spatial_editing = this.db.prepare('SELECT value FROM local_settings WHERE key=?').get(`spatial-editing:${id}`)?.value === 'true';
    return { workspace, entries, disconnected_files, views, spatial_focus, spatial_editing, ...health, indexing: this.documents?.indexStatus.get(id), warnings: [...health.warnings, ...(this.watcherWarnings.get(id) || [])] };
  }
  excluded(root, filename, workspace) {
    if (path.relative(root, filename).split(path.sep).some(part => /^\.context-(copy|save)-/.test(part))) return true;
    if (inside(this.dataDirectory, filename)) return true;
    const parts = path.relative(root, filename).split(path.sep);
    return parts.some(part => (!workspace.show_hidden && part.startsWith('.')) || (!workspace.include_generated && GENERATED.has(part)));
  }
  async scan(id) {
    if (this.closed || this.mutating.has(id)) return;
    if (this.scans.has(id)) { this.scans.get(id).again = true; return this.scans.get(id).promise; }
    const state = { again: false, promise: null };
    state.promise = (async () => {
      do { state.again = false; await this.scanOnce(id); } while (state.again && !this.closed);
    })().finally(() => this.scans.delete(id));
    this.scans.set(id, state);
    return state.promise;
  }
  async scanOnce(id) {
    const workspace = this.workspace(id);
    this.health.set(id, { status: 'scanning', warnings: [] }); this.emit('changed', id);
    const records = [], warnings = [], unreadable = [];
    let truncated = false;
    try {
      if (await realpath(workspace.root) !== workspace.root || !(await lstat(workspace.root)).isDirectory()) throw new Error('root changed');
      const pending = [''];
      while (pending.length && !this.closed) {
        const directory = pending.shift();
        let names;
        try {
          const folder = path.join(workspace.root, directory);
          // A directory may have been replaced by a link since it entered the scan queue.
          if (await realpath(folder) !== folder || !(await lstat(folder)).isDirectory()) throw new Error('directory changed');
          names = await readdir(folder, { withFileTypes: true });
        }
        catch { unreadable.push(directory); warnings.push(`읽을 수 없는 폴더: ${directory || workspace.label}`); continue; }
        names.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of names) {
          if (records.length >= MAX_ENTRIES) { truncated = true; break; }
          const relative = directory ? `${directory}/${entry.name}` : entry.name;
          const full = path.join(workspace.root, relative);
          if (inside(this.dataDirectory, full) || /^\.context-(copy|save)-/.test(entry.name)) continue;
          if (!workspace.show_hidden && entry.name.startsWith('.')) continue;
          let stats;
          try { stats = await lstat(full); } catch { unreadable.push(relative); continue; }
          const kind = stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
          const excluded = kind === 'directory' && !workspace.include_generated && GENERATED.has(entry.name);
          records.push({ relative, parent: directory, name: entry.name, kind, excluded: Number(excluded),
            extension: path.extname(entry.name).toLowerCase(), size: stats.size, mtime: stats.mtimeMs,
            identity: stats.ino ? `${stats.dev}:${stats.ino}:${kind}` : '' });
          if (kind === 'directory' && !excluded) pending.push(relative);
        }
        if (truncated) break;
      }
      if (this.closed) return;
      if (unreadable.includes('')) throw new Error('unreadable root');
      if (truncated) warnings.push(`파일 수가 ${MAX_ENTRIES.toLocaleString('ko-KR')}개를 넘었습니다. 더 작은 폴더를 연결해 주세요.`);
      const old = this.db.prepare('SELECT * FROM entries WHERE workspace_id=?').all(id);
      const byPath = new Map(old.map(row => [row.relative_path, row]));
      const byIdentity = new Map();
      for (const row of old.filter(row => row.present && row.identity)) {
        const group = byIdentity.get(row.identity) || []; group.push(row); byIdentity.set(row.identity, group);
      }
      const identityCounts = new Map();
      for (const row of records) identityCounts.set(row.identity, (identityCounts.get(row.identity) || 0) + 1);
      const reserved = new Set();
      for (const record of records) {
        const match = byIdentity.get(record.identity);
        if (record.identity && match?.length === 1 && identityCounts.get(record.identity) === 1) { record.id = match[0].id; reserved.add(record.id); }
      }
      const oldIds = new Map(old.map(row => [row.id, row]));
      const folderMoves = records.filter(record => record.id && record.kind === 'directory' && oldIds.get(record.id)?.relative_path !== record.relative)
        .map(record => ({ before: oldIds.get(record.id).relative_path, after: record.relative })).sort((a, b) => b.before.length - a.before.length);
      const movedPaths = new Map();
      for (const row of old) {
        const move = folderMoves.find(item => row.relative_path.startsWith(item.before + '/'));
        if (move) movedPaths.set(move.after + row.relative_path.slice(move.before.length), row);
      }
      for (const record of records) {
        if (record.id) continue;
        const previous = byPath.get(record.relative) || movedPaths.get(record.relative);
        record.id = previous && !reserved.has(previous.id) ? previous.id : randomUUID();
        reserved.add(record.id);
      }
      this.db.exec('BEGIN');
      try {
        // Temporary paths permit two files to swap names without UNIQUE violations.
        const moveAside = this.db.prepare('UPDATE entries SET relative_path=? WHERE id=?');
        for (const record of records) {
          const occupying = byPath.get(record.relative);
          if (occupying && occupying.id !== record.id) moveAside.run(`:stale:${occupying.id}`, occupying.id);
        }
        if (!truncated) this.db.prepare('UPDATE entries SET present=0 WHERE workspace_id=?').run(id);
        for (const prefix of unreadable) {
          for (const row of old) if (row.present && (row.relative_path === prefix || row.relative_path.startsWith(`${prefix}/`))) {
            this.db.prepare('UPDATE entries SET present=1 WHERE id=?').run(row.id);
          }
        }
        const put = this.db.prepare(`INSERT INTO entries(id,workspace_id,relative_path,parent_path,name,kind,extension,size,mtime,identity,present,excluded)
          VALUES(?,?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET relative_path=excluded.relative_path,parent_path=excluded.parent_path,
          name=excluded.name,kind=excluded.kind,extension=excluded.extension,size=excluded.size,mtime=excluded.mtime,identity=excluded.identity,present=1,excluded=excluded.excluded`);
        const oldById = new Map(old.map(entry => [entry.id, entry]));
        const invalidate = this.db.prepare('UPDATE local_documents SET current_version_id=CASE WHEN current_is_pinned=1 THEN current_version_id ELSE NULL END WHERE entry_id=?');
        const documentFor = this.db.prepare('SELECT id FROM local_documents WHERE entry_id=?');
        for (const r of records) {
          put.run(r.id, id, r.relative, r.parent, r.name, r.kind, r.extension, r.size, r.mtime, r.identity, r.excluded);
          const previous = oldById.get(r.id);
          if (previous && (previous.mtime !== r.mtime || previous.size !== r.size)) invalidate.run(r.id);
          if (r.kind === 'file' && !documentFor.get(r.id)) {
            const documentId = randomUUID();
            this.db.prepare('INSERT INTO local_documents(id,workspace_id,entry_id) VALUES(?,?,?)').run(documentId, id, r.id);
            this.documents.change(id, documentId, 'document.discovered', 1, { filename: r.name });
          }
        }
        // Directory identity carries its logical canvas through an external rename.
        const renames = records.filter(r => r.kind === 'directory' && oldById.get(r.id)?.kind === 'directory' && oldById.get(r.id).relative_path !== r.relative)
          .map(r => ({ before: oldById.get(r.id).relative_path, after: r.relative })).sort((a, b) => b.before.length - a.before.length);
        const remap = directory => { const found = renames.find(r => directory === r.before || directory.startsWith(`${r.before}/`)); return found ? found.after + directory.slice(found.before.length) : directory; };
        const scopes = this.db.prepare('SELECT id,directory FROM local_canvas_scopes WHERE workspace_id=?').all(id);
        const scopeMoves = scopes.map(scope => ({ ...scope, next: remap(scope.directory) })).filter(scope => scope.next !== scope.directory);
        const moving = new Set(scopeMoves.map(scope => scope.id));
        const safeMoves = scopeMoves.filter(scope => { const clash = scopes.find(s => s.directory === scope.next && !moving.has(s.id)); if (clash) warnings.push(`기존 캔버스가 있어 폴더 배치를 옮기지 못했습니다: ${scope.directory}`); return !clash; });
        for (const scope of safeMoves) this.db.prepare('UPDATE local_canvas_scopes SET directory=? WHERE id=?').run(`:moving:${scope.id}`, scope.id);
        for (const scope of safeMoves) this.db.prepare('UPDATE local_canvas_scopes SET directory=? WHERE id=?').run(scope.next, scope.id);
        const views = this.db.prepare('SELECT directory FROM views WHERE workspace_id=?').all(id);
        const viewMoves = views.map(view => ({ before: view.directory, after: remap(view.directory), temporary: `:moving:${randomUUID()}` })).filter(view => view.before !== view.after);
        const oldDirectories = new Set(viewMoves.map(view => view.before));
        const safeViews = viewMoves.filter(view => !views.some(v => v.directory === view.after && !oldDirectories.has(v.directory)));
        for (const view of safeViews) this.db.prepare('UPDATE views SET directory=? WHERE workspace_id=? AND directory=?').run(view.temporary, id, view.before);
        for (const view of safeViews) this.db.prepare('UPDATE views SET directory=? WHERE workspace_id=? AND directory=?').run(view.after, id, view.temporary);
        const spatialFocus = this.db.prepare('SELECT value FROM local_settings WHERE key=?').get(`spatial-focus:${id}`);
        if (spatialFocus && remap(spatialFocus.value) !== spatialFocus.value) this.db.prepare('UPDATE local_settings SET value=? WHERE key=?').run(remap(spatialFocus.value), `spatial-focus:${id}`);
        // Give every newly discovered item a persistent free grid cell. New files must not shift existing cards.
        const current = this.db.prepare('SELECT e.id,e.parent_path,p.x,p.y FROM entries e LEFT JOIN positions p ON p.entry_id=e.id WHERE e.workspace_id=? AND e.present=1 ORDER BY e.relative_path').all(id);
        const occupied = new Map(), next = new Map();
        for (const row of current) {
          if (!occupied.has(row.parent_path)) occupied.set(row.parent_path, new Set());
          if (row.x === null) continue;
          const cells = occupied.get(row.parent_path);
          for (let x = Math.floor(row.x / 255); x <= Math.floor((row.x + 200) / 255); x++)
            for (let y = Math.floor(row.y / 335); y <= Math.floor((row.y + 290) / 335); y++) cells.add(`${x}:${y}`);
        }
        const place = this.db.prepare('INSERT INTO positions(entry_id,x,y) VALUES(?,?,?)');
        for (const row of current) {
          if (row.x !== null) continue;
          const cells = occupied.get(row.parent_path); let index = next.get(row.parent_path) || 0;
          while (cells.has(`${index % 4}:${Math.floor(index / 4)}`)) index++;
          const x = index % 4, y = Math.floor(index / 4);
          place.run(row.id, x * 255, y * 335); cells.add(`${x}:${y}`); next.set(row.parent_path, index + 1);
        }
        this.db.prepare('UPDATE workspaces SET scanned_at=? WHERE id=?').run(Date.now(), id);
        this.health.set(id, { status: 'ready', warnings: warnings.slice(0, 10), truncated });
        this.unified?.capture(id, { readOnlyReconcile: true });
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.health.set(id, { status: 'ready', warnings: warnings.slice(0, 10), truncated });
    } catch {
      this.health.set(id, { status: 'unavailable', warnings: ['폴더에 접근하지 못했습니다. 드라이브 연결과 접근 권한을 확인하거나 위치를 다시 지정해 주세요.'] });
    }
    this.emit('changed', id);
    if (this.processorOptions.indexDocuments && this.health.get(id)?.status === 'ready' && !this.closed) {
      this.documents.indexWorkspace(id).catch(() => {});
    }
  }
  async startWatcher(id, polling = false) {
    if (this.watchers.has(id) || this.closed) return;
    const workspace = this.workspace(id);
    const watcher = watch(workspace.root, {
      ignoreInitial: true, followSymlinks: false, usePolling: polling, interval: 2000, binaryInterval: 3000,
      ignored: filename => this.excluded(workspace.root, filename, workspace),
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    });
    this.watchers.set(id, watcher);
    const schedule = () => {
      clearTimeout(this.timers.get(id));
      this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.scan(id).catch(() => {}); }, 250));
    };
    watcher.on('all', schedule).on('ready', schedule).on('error', () => {
      if (this.watchers.get(id) !== watcher) return;
      this.watcherWarnings.set(id, [polling ? '변경 감지가 제한됩니다. 1분마다 다시 확인하며, 새로고침도 사용할 수 있습니다.' : '운영체제 감시 대신 주기적으로 파일 변경을 확인합니다.']);
      this.emit('changed', id);
      if (!polling) {
        this.watchers.delete(id);
        watcher.close().then(() => { if (!this.closed && this.db.prepare('SELECT id FROM workspaces WHERE id=?').get(id)) return this.startWatcher(id, true); }).catch(() => {});
      }
    });
  }
  async stopWatcher(id) {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    const watcher = this.watchers.get(id); this.watchers.delete(id);
    if (watcher) await watcher.close();
    if (this.scans.has(id)) await this.scans.get(id).promise;
  }
  async settings(id, value) {
    this.workspace(id);
    if (!value || typeof value.showHidden !== 'boolean' || typeof value.includeGenerated !== 'boolean') throw new Error('표시 설정이 올바르지 않습니다.');
    await this.stopWatcher(id);
    this.db.prepare('UPDATE workspaces SET show_hidden=?,include_generated=? WHERE id=?').run(Number(value.showHidden), Number(value.includeGenerated), id);
    await this.scan(id);
    if (this.watchFiles) await this.startWatcher(id);
    return this.snapshot(id);
  }
  savePositions(id, changes) {
    this.workspace(id);
    if (!Array.isArray(changes) || changes.length > 500 || changes.some(p => !uuid(p.id) || !coordinates(p.x) || !coordinates(p.y))) throw new Error('배치 정보가 올바르지 않습니다.');
    const exists = this.db.prepare(`SELECT e.id FROM entries e WHERE e.id=? AND e.workspace_id=? AND e.present=1 AND ${connectedEntrySQL()}`);
    if (changes.some(p => !exists.get(p.id, id))) throw new Error('이 작업 공간의 파일만 배치할 수 있습니다.');
    this.db.exec('BEGIN');
    try {
      const put = this.db.prepare('INSERT INTO positions(entry_id,x,y) VALUES(?,?,?) ON CONFLICT(entry_id) DO UPDATE SET x=excluded.x,y=excluded.y');
      for (const p of changes) {
        put.run(p.id, p.x, p.y);
        if (this.db.prepare("SELECT id FROM entries WHERE id=? AND kind='directory'").get(p.id)) {
          this.db.prepare('INSERT INTO local_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`folder-area:${id}:${p.id}`, '1');
        }
      }
      const grouped = new Map();
      for (const p of changes) {
        const row = this.db.prepare('SELECT e.parent_path,d.id FROM entries e JOIN local_documents d ON d.entry_id=e.id WHERE e.id=?').get(p.id);
        if (!row) continue;
        const scope = this.canvas.scope(id, row.parent_path);
        grouped.set(scope, [...(grouped.get(scope) || []), { document_id: row.id, x: p.x, y: p.y }]);
      }
      for (const [scope, positions] of grouped) {
        const key = `canvas-position-revision:${scope}`;
        const revision = Number(this.db.prepare('SELECT value FROM local_settings WHERE key=?').get(key)?.value || 0) + 1;
        this.db.prepare('INSERT INTO local_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(revision));
        this.documents.change(id, scope, 'canvas.positions.save', revision, { positions });
      }
      this.unified?.capture(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveView(id, directory, view) {
    this.workspace(id);
    const cameraCoordinate = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000_000;
    if (typeof directory !== 'string' || directory.length > 4096 || !view || !cameraCoordinate(view.x) || !cameraCoordinate(view.y) || !Number.isFinite(view.zoom) || view.zoom < .1 || view.zoom > 2_000_000) throw new Error('화면 위치가 올바르지 않습니다.');
    const focus = [':spatial:', ':spatial:compact', ':spatial:readable'].includes(directory) ? view.focus_directory : undefined;
    const editing = directory === ':spatial:readable' ? view.editing : undefined;
    if (editing !== undefined && typeof editing !== 'boolean') throw new Error('캔버스 편집 상태가 올바르지 않습니다.');
    if (focus !== undefined && (typeof focus !== 'string' || focus.length > 4096 || focus !== '' && !this.db.prepare("SELECT id FROM entries WHERE workspace_id=? AND kind='directory' AND relative_path=? AND present=1").get(id, focus))) throw new Error('작업할 폴더를 다시 선택해 주세요.');
    this.documents.transaction(() => {
      this.db.prepare('INSERT INTO views VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,directory) DO UPDATE SET x=excluded.x,y=excluded.y,zoom=excluded.zoom').run(id, directory, view.x, view.y, view.zoom);
      if (focus !== undefined) this.db.prepare('INSERT INTO local_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`spatial-focus:${id}`, focus);
      if (editing !== undefined) this.db.prepare('INSERT INTO local_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`spatial-editing:${id}`, String(editing));
    });
  }
  async resolveEntry(id, entryId) {
    const workspace = this.workspace(id); requireId(entryId);
    this.requireFileConnection(id, entryId);
    const entry = this.db.prepare('SELECT * FROM entries WHERE id=? AND workspace_id=? AND present=1').get(entryId, id);
    if (!entry) throw new Error('파일을 찾을 수 없습니다. 새로고침해 주세요.');
    if (entry.kind === 'link' || entry.kind === 'other') throw new Error('바로가기나 특수 파일은 직접 읽지 않습니다.');
    const root = await realpath(workspace.root);
    const filename = await realpath(path.join(root, entry.relative_path));
    if (root !== workspace.root || !inside(root, filename) || inside(this.dataDirectory, filename)) throw new Error('연결한 폴더 밖의 파일은 열 수 없습니다.');
    const stat = await lstat(filename);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('일반 파일이나 폴더만 열 수 있습니다.');
    return { ...entry, filename, size: stat.size, mtime: stat.mtimeMs, device: stat.dev, inode: stat.ino };
  }
  requireFileConnection(id, entryId) {
    if (this.db.prepare(`SELECT e.id FROM entries e WHERE e.workspace_id=? AND e.id=? AND NOT (${connectedEntrySQL()})`).get(id, entryId)) {
      const error = new Error('연결 해제한 파일입니다. 문서 관리에서 다시 연결해 주세요.');
      error.code = 'FILE_DISCONNECTED'; throw error;
    }
  }
  disconnectFile(id, entryId) {
    this.workspace(id); requireId(entryId);
    const entry = this.db.prepare("SELECT id FROM entries WHERE workspace_id=? AND id=? AND kind='file' AND present=1").get(id, entryId);
    if (!entry) throw new Error('이 작업 공간의 일반 파일만 연결 해제할 수 있습니다.');
    this.db.prepare('INSERT INTO local_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(fileConnectionKey(id, entryId), '1');
    this.emit('changed', id);
    if (this.processorOptions.indexDocuments) this.documents.indexWorkspace(id).catch(() => {});
  }
  async reconnectFile(id, entryId) {
    this.workspace(id); requireId(entryId);
    if (!this.db.prepare("SELECT id FROM entries WHERE workspace_id=? AND id=? AND kind='file'").get(id, entryId)) throw new Error('이 작업 공간의 파일을 찾을 수 없습니다.');
    this.db.prepare('DELETE FROM local_settings WHERE key=?').run(fileConnectionKey(id, entryId));
    await this.scan(id);
  }
  async disconnect(id) {
    this.cloud.cancel(id);
    this.workspace(id); this.mutating.add(id);
    try {
      await this.derivatives.pause(id);
      this.documents.cancelIndex(id); await this.stopWatcher(id);
      if (this.documents.indexJobs.has(id)) await this.documents.indexJobs.get(id).promise;
      this.documents.transaction(() => {
        for (const scope of this.db.prepare('SELECT id FROM local_canvas_scopes WHERE workspace_id=?').all(id)) this.db.prepare('DELETE FROM local_settings WHERE key=?').run(`canvas-position-revision:${scope.id}`);
        this.db.prepare('DELETE FROM local_settings WHERE key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ? OR key=?')
          .run(`ai-request:${id}:%`, `summary-request:${id}:%`, `change-summary:${id}:%`, `index-signature:${id}:%`, `index-paused:${id}`);
        this.db.prepare('DELETE FROM local_settings WHERE key LIKE ?').run(`folder-area:${id}:%`);
        this.db.prepare('DELETE FROM local_settings WHERE key LIKE ?').run(`disconnected-file:${id}:%`);
        this.db.prepare('DELETE FROM local_settings WHERE key=?').run(`spatial-focus:${id}`);
        this.db.prepare('DELETE FROM local_settings WHERE key=?').run(`spatial-editing:${id}`);
        this.db.prepare('DELETE FROM local_search WHERE workspace_id=?').run(id);
        this.db.prepare('DELETE FROM local_changes WHERE workspace_id=?').run(id);
        this.db.prepare('DELETE FROM save_journal WHERE workspace_id=?').run(id);
        this.db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
      });
    } finally { this.mutating.delete(id); }
    this.derivatives.kick();
    await rm(path.join(this.dataDirectory, 'sync-cache', id), { recursive: true, force: true });
    this.health.delete(id); this.watcherWarnings.delete(id); this.documents.indexStatus.delete(id); this.documents.indexPublished.delete(id);
    for (const key of this.documents.signatures.keys()) if (key.startsWith(`${id}:`)) this.documents.signatures.delete(key);
    this.emit('changed', id);
  }
  listConversions(id, documentId) { return this.derivatives.list(id, documentId); }
  cloudDevice() { return this.documents.deviceId; }
  cloudState(id, owner) { return this.cloud.get(id, owner); }
  cloudStatus(id, owner) { return this.cloud.status(id, owner); }
  cloudSet(id, owner, value) { return this.cloud.set(id, owner, value); }
  cloudPrepare(id, owner) { return this.cloud.prepare(id, owner); }
  cloudBlob(id, owner, request, version) { return this.cloud.blob(id, owner, request, version); }
  cloudFinish(id, owner, request, binding, committed) { return this.cloud.finish(id, owner, request, binding, committed); }
  cloudDiscard(id, owner) { return this.cloud.discard(id, owner); }
  cloudCancel(id) { this.cloud.cancel(id); }
  unifiedBind(id, owner) { return this.unified.bind(id, owner); }
  unifiedPrepare(id) { return this.unified.prepare(id).then(() => true); }
  unifiedIdentity(id) { return this.unified.identity(id); }
  unifiedPending(id) { return this.unified.store.pending(id); }
  unifiedBlob(id, blobId) { return this.unified.store.blob(id, blobId); }
  unifiedUploaded(id, blobId) { this.db.prepare('UPDATE unified_blobs SET uploaded=1 WHERE workspace_id=? AND id=?').run(id, blobId); }
  unifiedAcknowledge(id, receipts) { return this.unified.store.acknowledge(id, receipts); }
  unifiedBootstrap(id, state, cursor) { return this.unified.bootstrap(id, state, cursor); }
  unifiedReceive(id, changes, cursor) { return this.unified.receive(id, changes, cursor); }
  unifiedState(id) { return this.unified.store.state(id); }
  unifiedMissing(id) { return this.unified.files.missing(id); }
  unifiedReceiveBlob(id, blob, bytes) { return this.unified.files.receiveBlob(id, blob, bytes); }
  unifiedApply(id) { return this.unified.apply(id); }
  unifiedStatus(id) { return this.unified.status(id); }
  unifiedList() { return this.unified.list(); }
  unifiedAttach(root, state, cursor, owner) { return this.unified.attach(root, state, cursor, owner); }
  unifiedDetach(id) { return this.unified.detach(id); }
  unifiedConflicts(id) { return this.unified.conflicts(id); }
  unifiedRecovery(id) { return this.unified.recovery(id); }
  unifiedRecoveryOriginal(id, recordId) { return this.unified.recoveryOriginal(id, recordId); }
  unifiedWriteRecoveryOriginal(id, recordId, filename, expectedHash) { const output = this.unified.recoveryOriginal(id, recordId); return this.documents.writeFile(id, recordId, 0, filename, Buffer.from(output.data, 'base64'), expectedHash, () => this.unified.recoveryOriginal(id, recordId)); }
  unifiedRecoveryOutput(id, recordId) { return this.unified.recoveryOutput(id, recordId); }
  unifiedWriteRecovery(id, recordId, filename, expectedHash) { const output = this.unified.recoveryOutput(id, recordId); return this.documents.writeFile(id, recordId, 0, filename, Buffer.from(output.data, 'base64'), expectedHash, () => this.unified.recoveryOutput(id, recordId)); }
  unifiedResolve(id, type, payload, bases) { return this.unified.resolve(id, type, payload, bases); }
  requestConversion(id, versionId, format) { return this.derivatives.request(id, versionId, format); }
  conversionOutput(id, versionId, format) { return this.derivatives.output(id, versionId, format); }
  writeConversion(id, versionId, format, filename, expectedHash) { return this.derivatives.save(id, versionId, format, filename, expectedHash); }
  copyFile(id, entryId, requestId, versionId) { return this.derivatives.copy(id, entryId, requestId, versionId); }
  listDrafts(id) { return this.documents.list(id); }
  getDraft(id, draftId) { return this.documents.get(id, draftId); }
  createDraft(id, requestId) { return this.documents.create(id, requestId); }
  saveDraft(id, draftId, revision, content) { return this.documents.save(id, draftId, revision, content); }
  reviewDraft(id, draftId, revision, action) { return this.documents.review(id, draftId, revision, action); }
  deleteDraft(id, draftId, revision) { return this.documents.remove(id, draftId, revision); }
  openDocument(id, entryId) { return this.documents.open(id, entryId); }
  importDraft(id, entryId, requestId, versionId) { return this.documents.importDraft(id, entryId, requestId, versionId); }
  searchContent(id, query, scope, asOf) { return this.documents.search(id, query, scope, asOf); }
  indexDocuments(id) { this.documents.indexWorkspace(id, { resume: true }).catch(() => {}); }
  cancelIndex(id) { return this.documents.cancelIndex(id); }
  prepareGeneration(id, input) { return this.documents.prepareGeneration(id, input); }
  finishGeneration(id, input, result) { return this.documents.finishGeneration(id, input, result); }
  getDocument(id, entryId) { return this.documents.document(id, entryId); }
  documentEntries(id, documentIds) {
    this.workspace(id);
    if (!Array.isArray(documentIds) || documentIds.length > 30 || !documentIds.every(uuid)) throw new Error('참조 문서 정보가 올바르지 않습니다.');
    const find = this.db.prepare(`SELECT d.id AS document_id,e.id AS entry_id FROM local_documents d JOIN entries e ON e.id=d.entry_id WHERE d.workspace_id=? AND d.id=? AND e.present=1 AND ${connectedEntrySQL()}`);
    return documentIds.flatMap(documentId => { const row = find.get(id, documentId); return row ? [row] : []; });
  }
  setCurrentVersion(id, documentId, versionId, revision) { return this.documents.setCurrent(id, documentId, versionId, revision); }
  linkDocumentVersion(id, documentId, sourceId, requestId, revision, note) { return this.documents.linkVersion(id, documentId, sourceId, requestId, revision, note); }
  versionSources(id) { return this.documents.versionSources(id); }
  versionCandidates(id, documentId, versionId) { return this.documents.candidates(id, documentId, versionId); }
  getChangeSummary(id, documentId, left, right) { return this.insights.get(id, documentId, left, right); }
  prepareChangeSummary(id, documentId, left, right, requestId) { return this.insights.prepare(id, documentId, left, right, requestId); }
  finishChangeSummary(id, documentId, left, right, requestId, result, model) { return this.insights.finish(id, documentId, left, right, requestId, result, model); }
  getDocumentVersion(id, documentId, versionId) { return this.documents.getVersion(id, documentId, versionId); }
  compareDocumentVersions(id, documentId, left, right) { return this.documents.compare(id, documentId, left, right); }
  restoreDocumentVersion(id, documentId, versionId, expectedHash) { return this.documents.restore(id, documentId, versionId, expectedHash); }
  renderDocumentVersion(id, documentId, versionId, format) { return this.documents.renderVersion(id, documentId, versionId, format); }
  writeVersionExport(id, documentId, versionId, filename, data, expectedHash) { return this.documents.writeVersionExport(id, documentId, versionId, filename, data, expectedHash); }
  chatSessions(id, offset) { return this.chat.sessions(id, offset); }
  createChatSession(id, input) { return this.chat.create(id, input); }
  chatMessages(id, sessionId) { return this.chat.messages(id, sessionId); }
  chatSearch(id, input) { return this.chat.evidence(id, input); }
  chatIndexStatus(id) { return this.chat.indexStatus(id); }
  prepareChat(id, sessionId, input) { return this.chat.prepare(id, sessionId, input); }
  prepareChatRetry(id, sessionId, messageId) { return this.chat.retry(id, sessionId, messageId); }
  finishChat(id, sessionId, prepared, result) { return this.chat.finish(id, sessionId, prepared, result); }
  failChat(id, sessionId, prepared, code) { return this.chat.fail(id, sessionId, prepared, code); }
  readTextFile(id, entryId) { return this.files.text(id, entryId); }
  recoveryItems(id) { return this.documents.recoveryItems(id); }
  canvasSnapshot(id, directory) { return this.canvas.snapshot(id, directory); }
  prepareSummary(id, input) { return this.summaries.prepare(id, input); }
  summaryStatus(id, input) { return this.summaries.state(id, input).state?.status || null; }
  finishSummary(id, input, result) { return this.summaries.finish(id, input, result); }
  putCanvasItem(id, directory, kind, value, revision) { return this.canvas.put(id, directory, kind, value, revision); }
  removeCanvasItem(id, directory, itemId, revision) { return this.canvas.remove(id, directory, itemId, revision); }
  renderRecovery(id, journalId, original) { return this.documents.renderRecovery(id, journalId, original); }
  writeRecovery(id, journalId, original, filename, expectedHash) { return this.documents.writeRecovery(id, journalId, original, filename, expectedHash); }
  acknowledgeRecovery(id, journalId) { return this.documents.acknowledgeRecovery(id, journalId); }
  saveTextFile(id, entryId, revision, text) { return this.files.saveText(id, entryId, revision, text); }
  createTextFile(id, name, directoryId) { return this.files.createText(id, name, directoryId); }
  async renameFile(id, entryId, name, parent) {
    if (this.mutating.has(id)) throw new Error('파일 작업이 진행 중입니다.');
    this.mutating.add(id);
    try { await this.stopWatcher(id); await this.files.rename(id, entryId, name, parent); }
    finally {
      this.mutating.delete(id); await this.scan(id);
      if (this.watchFiles) await this.startWatcher(id);
    }
  }
  async moveFileToFolder(id, entryId, directoryId, options = {}) {
    const workspace = this.workspace(id);
    if (!options || options.position && (!coordinates(options.position.x) || !coordinates(options.position.y)) || options.expected_parent !== undefined && (typeof options.expected_parent !== 'string' || options.expected_parent.length > 4096)) throw new Error('파일을 이동할 위치가 올바르지 않습니다.');
    if (this.mutating.has(id)) throw new Error('파일 작업이 진행 중입니다.');
    this.mutating.add(id);
    let position;
    try {
      await this.stopWatcher(id);
      const source = await this.resolveEntry(id, entryId);
      const target = directoryId === null ? { kind: 'directory', filename: workspace.root, relative_path: '' } : await this.resolveEntry(id, directoryId);
      if (source.kind !== 'file' || target.kind !== 'directory') throw new Error('일반 파일을 폴더 위에 놓아 주세요.');
      if (options.expected_parent !== undefined && source.parent_path !== options.expected_parent) throw new Error('파일 위치가 바뀌었습니다. 현재 위치를 확인한 뒤 다시 옮겨 주세요.');
      if (this.excluded(workspace.root, path.join(target.filename, source.name), workspace)) throw new Error('숨김·제외 폴더로 이동할 수 없습니다. 폴더 설정을 먼저 변경해 주세요.');
      position = options.position || (source.parent_path === target.relative_path ? this.db.prepare('SELECT x,y FROM positions WHERE entry_id=?').get(entryId) || { x: 0, y: 0 } : this.files.freePosition(id, target.relative_path, entryId));
      try { await this.files.rename(id, entryId, source.name, target.filename, true); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('대상 폴더에 같은 이름의 파일이 있습니다. 기존 파일은 보존했습니다.'); throw error; }
    } finally {
      this.mutating.delete(id); await this.scan(id);
      if (this.watchFiles) await this.startWatcher(id);
    }
    this.savePositions(id, [{ id: entryId, ...position }]);
    const entry = this.snapshot(id).entries.find(entry => entry.id === entryId);
    if (!entry) throw new Error('이동한 파일을 다시 불러와 주세요.');
    return entry;
  }
  async renderTextExport(id, entryId, text) {
    this.workspace(id);
    const entry = this.db.prepare('SELECT * FROM entries WHERE workspace_id=? AND id=?').get(id, entryId);
    if (!entry || !['.txt', '.md'].includes(entry.extension) || typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('저장할 텍스트 정보가 올바르지 않습니다.');
    return { title: path.parse(entry.name).name, extension: entry.extension.slice(1), data: Buffer.from(text).toString('base64') };
  }
  writeTextExport(id, entryId, filename, data, expectedHash) {
    return this.documents.writeFile(id, entryId, 0, filename, Buffer.from(data, 'base64'), expectedHash, () => {
      this.workspace(id);
      if (!this.db.prepare('SELECT id FROM entries WHERE id=? AND workspace_id=?').get(entryId, id)) throw new Error('파일을 찾을 수 없습니다.');
    });
  }
  async renderDraft(id, draftId, revision, format) {
    if (!['docx', 'hwpx', 'pdf', 'txt', 'md'].includes(format)) throw new Error('지원하지 않는 출력 형식입니다.');
    const draft = this.documents.get(id, draftId, revision);
    const output = await runProcessor({ operation: 'export', content: draft.content, format }, this.processorOptions);
    return { ...output, title: draft.title };
  }
  async writeDraftExport(id, draftId, revision, filename, output, expectedHash) {
    return this.documents.writeFile(id, draftId, revision, filename, Buffer.from(output, 'base64'), expectedHash);
  }
  async close() {
    this.closed = true; clearInterval(this.reconcile);
    await this.derivatives.close();
    for (const job of this.documents.indexJobs.values()) { job.again = false; job.cancelled = true; job.controller.abort(); }
    for (const id of [...this.watchers.keys()]) await this.stopWatcher(id);
    await Promise.all([...this.scans.values()].map(scan => scan.promise));
    await Promise.all([...this.documents.indexJobs.values()].map(job => job.promise));
    await Promise.all([...this.documents.jobs.values()]);
    this.db.close();
  }
}
