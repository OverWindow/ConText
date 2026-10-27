import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, mkdir, rename, link, unlink, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { UnifiedMoves } from './unified-moves.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
export function workspacePaths(state) {
  const paths = new Map([[state.workspace.root_entry_id, '']]), active = Object.values(state.entries).filter(entry => !entry.deleted_at), children = new Map();
  for (const entry of active) if (entry.id !== state.workspace.root_entry_id) { const group = children.get(entry.parent_id) || []; group.push(entry); children.set(entry.parent_id, group); }
  const queue = [state.workspace.root_entry_id];
  for (let i = 0; i < queue.length; i++) for (const entry of children.get(queue[i]) || []) { if (paths.has(entry.id)) throw new Error('동기화 폴더 구조가 순환합니다.'); paths.set(entry.id, [paths.get(entry.parent_id), entry.name].filter(Boolean).join('/')); queue.push(entry.id); }
  if (paths.size !== active.length) throw new Error('동기화 폴더 구조가 완전하지 않습니다.');
  return paths;
}

export class UnifiedFileApplier {
  constructor(engine, store) { this.engine = engine; this.store = store; this.db = engine.db; this.moves = new UnifiedMoves(this); }
  receiveBlob(id, blob, input) {
    const data = Buffer.from(input);
    if (data.length !== blob.size || data.length > 50 * 1024**2 || hash(data) !== blob.sha256) throw new Error('다운로드한 원본의 크기 또는 해시가 일치하지 않습니다.');
    this.store.ensure(id);
    const existing = this.db.prepare('SELECT * FROM unified_blobs WHERE workspace_id=? AND id=?').get(id, blob.id);
    if (existing && (existing.sha256 !== blob.sha256 || existing.size !== blob.size)) throw new Error('불변 원본 정보가 변경되었습니다.');
    this.db.prepare('INSERT INTO unified_blobs(workspace_id,id,sha256,size,mime_type,data,uploaded) VALUES(?,?,?,?,?,?,1) ON CONFLICT(workspace_id,id) DO UPDATE SET data=CASE WHEN unified_blobs.local_version_id IS NULL THEN excluded.data ELSE unified_blobs.data END,uploaded=1')
      .run(id, blob.id, blob.sha256, blob.size, blob.mime_type, data);
    return true;
  }
  missing(id) {
    const state = this.store.state(id);
    return Object.values(state.versions).filter(version => !this.db.prepare('SELECT 1 FROM unified_blobs WHERE workspace_id=? AND id=? AND (data IS NOT NULL OR local_version_id IS NOT NULL)').get(id, version.blob.id))
      .map(version => ({ version_id: version.id, blob: version.blob }));
  }
  async checked(id, relative, { parent = false } = {}) {
    const root = this.engine.workspace(id).root;
    if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error('원본 폴더에 접근할 수 없습니다.');
    if (typeof relative !== 'string' || relative.startsWith('/') || relative.split('/').some(part => part === '..' || part === '.' || part.includes('\\') || part.includes('\0'))) throw new Error('파일 경로가 올바르지 않습니다.');
    const destination = path.join(root, ...relative.split('/').filter(Boolean));
    const r = path.relative(root, destination);
    if (r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) throw new Error('연결된 폴더를 벗어날 수 없습니다.');
    const parts = relative.split('/').filter(Boolean); if (!parent) parts.pop();
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) throw new Error('심볼릭 링크 또는 바뀐 폴더에는 적용할 수 없습니다.');
    }
    return destination;
  }
  async read(filename) {
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 50 * 1024**2) throw new Error('일반 파일만 동기화할 수 있습니다.');
      const data = await file.readFile(), after = await file.stat();
      if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || data.length !== before.size) throw new Error('읽는 동안 파일이 변경되었습니다.');
      return { sha256: hash(data), data, stat: after };
    } finally { await file.close(); }
  }
  async exactName(filename) {
    const names = await readdir(path.dirname(filename));
    if (!names.some(name => name.normalize('NFC') === path.basename(filename).normalize('NFC'))) throw new Error('이 기기에서 대소문자 또는 이름 표기가 같은 다른 항목이 있습니다. 두 항목의 원본을 보존하고 적용을 보류했습니다.');
  }
  journal(id, entry, versionId, action, payload) {
    const key = this.db.prepare("SELECT id FROM unified_apply_journal WHERE workspace_id=? AND entry_id=? AND version_id IS ? AND action=? AND state!='complete' ORDER BY created_at DESC LIMIT 1").get(id, entry.id, versionId, action)?.id || randomUUID();
    this.db.prepare('INSERT INTO unified_apply_journal(id,workspace_id,entry_id,version_id,action,payload,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
      .run(key, id, entry.id, versionId, action, JSON.stringify(payload), new Date().toISOString());
    return key;
  }
  mapping(id, entryId, relative, versionId, sha256, status = 'ready') {
    this.db.prepare('INSERT INTO unified_file_mappings(workspace_id,entry_id,relative_path,observed_version_id,observed_hash,status) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,entry_id) DO UPDATE SET relative_path=excluded.relative_path,observed_version_id=excluded.observed_version_id,observed_hash=excluded.observed_hash,status=excluded.status')
      .run(id, entryId, relative, versionId, sha256, status);
  }
  installVersions(id, state) {
    const entries = new Map(Object.values(state.entries).filter(entry => entry.document_id).map(entry => [entry.document_id, entry]));
    this.store.transaction(() => {
      for (const version of Object.values(state.versions)) {
        if (this.db.prepare('SELECT id FROM local_versions WHERE id=?').get(version.id)) continue;
        const entry = entries.get(version.document_id);
        if (!entry) continue;
        if (!this.db.prepare('SELECT id FROM entries WHERE id=? AND workspace_id=?').get(entry.id, id)) continue;
        this.db.prepare('INSERT OR IGNORE INTO local_documents(id,workspace_id,entry_id) VALUES(?,?,?)').run(version.document_id, id, entry.id);
        let blob;
        try { blob = this.store.blob(id, version.blob.id); } catch { continue; }
        const number = this.db.prepare('SELECT coalesce(max(version_number),0)+1 AS n FROM local_versions WHERE document_id=?').get(version.document_id).n;
        const normalized = { schema_version: 1, sync_only: true, title: entry.name, source_filename: entry.name, source_sha256: version.blob.sha256, blocks: [], warnings: [], page_count: null };
        this.db.prepare('INSERT INTO local_versions(id,document_id,version_number,filename,sha256,bytes,normalized,created_at,change_note) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(version.id, version.document_id, number, entry.name, version.blob.sha256, blob.data, JSON.stringify(normalized), Date.parse(version.created_at), version.change_note);
        this.db.prepare('UPDATE unified_blobs SET local_version_id=?,data=NULL WHERE workspace_id=? AND id=?').run(version.id, id, version.blob.id);
      }
    });
  }
  async apply(id) {
    const state = this.store.state(id);
    if (state.workspace.deleted_at) return { applied: 0, failures: await this.moves.restoreDeleted(id) };
    const paths = workspacePaths(state), failures = [];
    this.installVersions(id, state);
    this.store.applying.add(id);
    try {
      for (const entry of Object.values(state.entries).filter(item => item.deleted_at)) {
        const mapping = this.db.prepare('SELECT * FROM unified_file_mappings WHERE workspace_id=? AND entry_id=?').get(id, entry.id);
        if (mapping) this.mapping(id, entry.id, mapping.relative_path, mapping.observed_version_id, mapping.observed_hash, 'remote_deleted');
      }
      const entries = Object.values(state.entries).filter(entry => !entry.deleted_at && entry.id !== state.workspace.root_entry_id)
        .sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || paths.get(a.id).split('/').length - paths.get(b.id).split('/').length);
      const staged = await this.moves.stage(id, state, paths); failures.push(...staged.failures);
      for (const entry of entries) {
        if (staged.blocked.has(entry.id)) continue;
        const relative = paths.get(entry.id), mapping = this.db.prepare('SELECT * FROM unified_file_mappings WHERE workspace_id=? AND entry_id=?').get(id, entry.id);
        const document = entry.document_id ? state.documents[entry.document_id] : null;
        const version = document?.content_head_id ? state.versions[document.content_head_id] : null;
        const journal = this.journal(id, entry, version?.id || null, entry.kind === 'folder' ? 'folder' : 'file', { relative, previous: mapping?.relative_path || null, expected_hash: mapping?.observed_hash || null, desired_hash: version?.blob.sha256 || null });
        try {
          const destination = await this.checked(id, relative);
          if (entry.kind === 'folder') {
            if (mapping?.relative_path && mapping.relative_path !== relative) {
              const previous = await this.checked(id, mapping.relative_path);
              let old;
              try { old = await lstat(previous); } catch (error) { if (error.code !== 'ENOENT') throw error; }
              if (old) {
                if (!old.isDirectory() || old.isSymbolicLink()) throw new Error('기존 폴더의 종류가 변경되었습니다.');
                let target;
                try { target = await lstat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                if (target && (target.ino !== old.ino || target.dev !== old.dev)) throw new Error('이동할 위치에 다른 폴더가 있습니다.');
                await rename(previous, destination);
                for (const child of this.db.prepare('SELECT * FROM unified_file_mappings WHERE workspace_id=?').all(id)) if (child.relative_path.startsWith(mapping.relative_path + '/')) {
                  this.mapping(id, child.entry_id, relative + child.relative_path.slice(mapping.relative_path.length), child.observed_version_id, child.observed_hash, child.status);
                }
              }
            }
            try { await mkdir(destination); } catch (error) { if (error.code !== 'EEXIST') throw error; }
            const stat = await lstat(destination);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('다른 항목이 폴더 위치를 사용하고 있습니다.');
            await this.exactName(destination);
            this.mapping(id, entry.id, relative, null, null);
          } else {
            if (!version) { this.db.prepare("UPDATE unified_apply_journal SET state='complete',error=NULL WHERE id=?").run(journal); continue; }
            if (Object.values(state.conflicts).some(conflict => conflict.status === 'open' && conflict.entity_collection === 'documents' && conflict.entity_id === version.document_id)) throw new Error('문서의 동시 수정 충돌이 있습니다. 양쪽 버전을 보존하고 파일 적용을 보류했습니다.');
            if (mapping?.relative_path && mapping.relative_path !== relative) {
              const previous = await this.checked(id, mapping.relative_path);
              let original;
              try { original = await this.read(previous); } catch (error) { if (error.code !== 'ENOENT') throw error; }
              if (original) {
                if (mapping.observed_hash && original.sha256 !== mapping.observed_hash) throw new Error('외부에서 수정한 원본이 있어 이동을 보류했습니다.');
                const target = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
                if (target && (target.ino !== original.stat.ino || target.dev !== original.stat.dev)) throw new Error('이동할 위치에 다른 파일이 있습니다.');
                if (!target) { await link(previous, destination); const checked = await this.read(previous); if (checked.sha256 !== original.sha256) throw new Error('이동 중 파일이 변경되었습니다. 두 위치를 보존했습니다.'); await unlink(previous); }
                else if (previous !== destination) {
                  const same = await this.read(destination);
                  if (same.sha256 !== original.sha256 || same.stat.ino !== original.stat.ino || same.stat.dev !== original.stat.dev) throw new Error('이동 중 파일이 변경되어 원본을 보존했습니다.');
                  // A crash can leave both hardlink names. POSIX rename is a no-op for one inode.
                  const names = await readdir(path.dirname(previous));
                  if (path.dirname(previous) === path.dirname(destination) && !names.includes(path.basename(destination))) await rename(previous, destination);
                  else await unlink(previous);
                }
              }
            }
            let current;
            try { current = await this.read(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (!current && mapping?.observed_hash && mapping.status !== 'restore') throw new Error('마지막 관측 이후 원본이 삭제되었습니다. 삭제 의도를 보존하고 원격 적용을 보류했습니다.');
            if (current) await this.exactName(destination);
            if (current?.sha256 !== version.blob.sha256) {
              if (current && (!mapping?.observed_hash || current.sha256 !== mapping.observed_hash)) throw new Error('외부 편집 내용이 있어 원격 원본 적용을 보류했습니다. 로컬 원본은 유지됩니다.');
              const blob = this.store.blob(id, version.blob.id);
              await this.engine.documents.writeFile(id, version.document_id, 0, destination, Buffer.from(blob.data), current?.sha256 || null,
                async () => {
                  await this.checked(id, relative);
                  if (this.store.state(id).documents[version.document_id]?.content_head_id !== version.id) throw new Error('적용 중 문서 버전이 바뀌었습니다.');
                });
            }
            this.mapping(id, entry.id, relative, version.id, version.blob.sha256);
            this.db.prepare('UPDATE local_documents SET file_version_id=? WHERE id=?').run(version.id, version.document_id);
          }
          this.db.prepare("UPDATE unified_apply_journal SET state='complete',error=NULL WHERE id=?").run(journal);
        } catch (error) {
          this.db.prepare("UPDATE unified_apply_journal SET state='needs_review',error=? WHERE id=?").run(error.message, journal);
          failures.push({ entry_id: entry.id, message: error.message });
        }
      }
      failures.push(...await this.moves.finish(id, state, paths));
    } finally { this.store.applying.delete(id); }
    return { applied: Math.max(0, entriesCount(state) - new Set(failures.map(item => item.entry_id)).size), failures };
  }
}
const entriesCount = state => Object.values(state.entries).filter(entry => !entry.deleted_at).length - 1;
