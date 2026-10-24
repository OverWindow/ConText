import { EventEmitter } from 'node:events';
import { mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { watch } from 'chokidar';

const GENERATED = new Set(['node_modules', '.git', '.next', '.venv', '__pycache__']);
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MAX_ENTRIES = 25000;
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function requireId(id) { if (!uuid(id)) throw new Error('작업 공간 또는 파일 식별자가 올바르지 않습니다.'); }
function coordinates(value) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000; }

/** Runs in a worker thread. The renderer never supplies an unrestricted filesystem path. */
export class WorkspaceEngine extends EventEmitter {
  constructor(dataDirectory) {
    super();
    this.dataDirectory = path.resolve(dataDirectory);
    this.watchers = new Map(); this.scans = new Map(); this.timers = new Map(); this.health = new Map();
    this.closed = false; this.watcherWarnings = new Map();
  }
  async init({ watchFiles = true } = {}) {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(this.dataDirectory, 'workspace.sqlite'));
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
      ); PRAGMA user_version=1;`);
    this.watchFiles = watchFiles;
    // Reconcile cached folders on launch, even if their OS watcher missed changes while closed.
    for (const workspace of this.list()) {
      await this.scan(workspace.id);
      if (watchFiles) await this.startWatcher(workspace.id);
    }
    if (watchFiles) {
      this.reconcile = setInterval(() => {
        for (const item of this.list()) this.scan(item.id).catch(() => {});
      }, 60000);
      this.reconcile.unref();
    }
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
    const entries = this.db.prepare(`SELECT e.*, p.x, p.y FROM entries e LEFT JOIN positions p ON p.entry_id=e.id
      WHERE e.workspace_id=? AND e.present=1 ORDER BY e.relative_path LIMIT ?`).all(id, MAX_ENTRIES);
    const views = this.db.prepare('SELECT directory,x,y,zoom FROM views WHERE workspace_id=?').all(id);
    const health = this.health.get(id) || { status: 'ready', warnings: [] };
    return { workspace, entries, views, ...health, warnings: [...health.warnings, ...(this.watcherWarnings.get(id) || [])] };
  }
  excluded(root, filename, workspace) {
    if (inside(this.dataDirectory, filename)) return true;
    const parts = path.relative(root, filename).split(path.sep);
    return parts.some(part => (!workspace.show_hidden && part.startsWith('.')) || (!workspace.include_generated && GENERATED.has(part)));
  }
  async scan(id) {
    if (this.closed) return;
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
          if (inside(this.dataDirectory, full)) continue;
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
      for (const record of records) {
        if (record.id) continue;
        const previous = byPath.get(record.relative);
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
        for (const r of records) put.run(r.id, id, r.relative, r.parent, r.name, r.kind, r.extension, r.size, r.mtime, r.identity, r.excluded);
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
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.health.set(id, { status: 'ready', warnings: warnings.slice(0, 10), truncated });
    } catch {
      this.health.set(id, { status: 'unavailable', warnings: ['폴더에 접근하지 못했습니다. 드라이브 연결과 접근 권한을 확인하거나 위치를 다시 지정해 주세요.'] });
    }
    this.emit('changed', id);
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
    const exists = this.db.prepare('SELECT id FROM entries WHERE id=? AND workspace_id=? AND present=1');
    if (changes.some(p => !exists.get(p.id, id))) throw new Error('이 작업 공간의 파일만 배치할 수 있습니다.');
    this.db.exec('BEGIN');
    try {
      const put = this.db.prepare('INSERT INTO positions(entry_id,x,y) VALUES(?,?,?) ON CONFLICT(entry_id) DO UPDATE SET x=excluded.x,y=excluded.y');
      for (const p of changes) put.run(p.id, p.x, p.y);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveView(id, directory, view) {
    this.workspace(id);
    if (typeof directory !== 'string' || directory.length > 4096 || !view || !coordinates(view.x) || !coordinates(view.y) || !Number.isFinite(view.zoom) || view.zoom < .1 || view.zoom > 2) throw new Error('화면 위치가 올바르지 않습니다.');
    this.db.prepare('INSERT INTO views VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,directory) DO UPDATE SET x=excluded.x,y=excluded.y,zoom=excluded.zoom').run(id, directory, view.x, view.y, view.zoom);
  }
  async resolveEntry(id, entryId) {
    const workspace = this.workspace(id); requireId(entryId);
    const entry = this.db.prepare('SELECT * FROM entries WHERE id=? AND workspace_id=? AND present=1').get(entryId, id);
    if (!entry) throw new Error('파일을 찾을 수 없습니다. 새로고침해 주세요.');
    if (entry.kind === 'link' || entry.kind === 'other') throw new Error('바로가기나 특수 파일은 직접 읽지 않습니다.');
    const root = await realpath(workspace.root);
    const filename = await realpath(path.join(root, entry.relative_path));
    if (root !== workspace.root || !inside(root, filename) || inside(this.dataDirectory, filename)) throw new Error('연결한 폴더 밖의 파일은 열 수 없습니다.');
    const stat = await lstat(filename);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('일반 파일이나 폴더만 열 수 있습니다.');
    return { ...entry, filename, size: stat.size, mtime: stat.mtimeMs };
  }
  async disconnect(id) {
    this.workspace(id); await this.stopWatcher(id);
    this.db.prepare('DELETE FROM workspaces WHERE id=?').run(id); this.health.delete(id); this.watcherWarnings.delete(id);
    this.emit('changed', id);
  }
  async close() {
    this.closed = true; clearInterval(this.reconcile);
    for (const id of [...this.watchers.keys()]) await this.stopWatcher(id);
    await Promise.all([...this.scans.values()].map(scan => scan.promise));
    this.db.close();
  }
}
