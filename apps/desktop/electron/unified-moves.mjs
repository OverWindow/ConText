import { randomUUID } from 'node:crypto';
import { lstat, rename, link, unlink } from 'node:fs/promises';

const missing = async filename => lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
const same = (stat, expected) => !!stat && stat.dev === expected.device && stat.ino === expected.inode && !stat.isSymbolicLink();

/** Physical rename staging is device-only. No temporary name enters the shared tree. */
export class UnifiedMoves {
  constructor(files) { this.files = files; this.db = files.db; this.store = files.store; }
  mappings(id) { return this.db.prepare('SELECT * FROM unified_file_mappings WHERE workspace_id=?').all(id); }
  mapping(id, entryId) { return this.db.prepare('SELECT * FROM unified_file_mappings WHERE workspace_id=? AND entry_id=?').get(id, entryId); }
  subtree(id, source) { return this.db.prepare('SELECT * FROM unified_file_mappings WHERE workspace_id=? AND (relative_path=? OR (relative_path>=? AND relative_path<?))').all(id, source, source + '/', source + '0'); }
  remap(id, source, target) {
    this.store.transaction(() => {
      for (const row of this.subtree(id, source)) {
        this.files.mapping(id, row.entry_id, target + row.relative_path.slice(source.length), row.observed_version_id, row.observed_hash, 'applying');
      }
    });
  }
  async moveToStaging(id, payload) {
    const stage = await this.files.checked(id, payload.staging);
    const staged = await missing(stage);
    if (staged && !same(staged, payload)) throw new Error('이동 중간 위치가 다른 항목으로 바뀌었습니다. 원본을 보존했습니다.');
    const source = await this.files.checked(id, payload.source).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!staged) {
      if (!source) throw new Error('이동할 원본과 중간 파일을 찾지 못했습니다.');
      const stat = await lstat(source);
      if (!same(stat, payload) || (payload.kind === 'folder' ? !stat.isDirectory() : !stat.isFile())) throw new Error('이동할 원본의 종류나 식별자가 변경되었습니다.');
      if (payload.kind === 'folder') await rename(source, stage);
      else {
        const before = await this.files.read(source);
        if (payload.observed_hash && before.sha256 !== payload.observed_hash) throw new Error('외부 편집 내용이 있어 이동을 보류했습니다.');
        await link(source, stage);
      }
    }
    const original = source ? await missing(source) : null;
    if (payload.kind === 'file' && same(original, payload)) {
      const read = await this.files.read(source);
      if (payload.observed_hash && read.sha256 !== payload.observed_hash) throw new Error('이동 중 수정된 원본과 중간 파일을 모두 보존했습니다.');
      await unlink(source);
    }
    const verified = await lstat(stage);
    if (!same(verified, payload)) throw new Error('이동 중간 파일을 검증하지 못했습니다.');
  }
  async recover(id, state, paths) {
    const rows = this.db.prepare("SELECT * FROM unified_apply_journal WHERE workspace_id=? AND action='move' AND state!='complete' ORDER BY created_at,id").all(id);
    for (const row of rows) {
      const payload = JSON.parse(row.payload), entry = state.entries[row.entry_id];
      if (!entry || entry.deleted_at) continue; // Keep staging for explicit recovery after logical deletion.
      const stage = await this.files.checked(id, payload.staging), staged = await missing(stage);
      if (staged) {
        if (!same(staged, payload)) throw new Error('이동 중간 위치가 바뀌어 자동 복구를 보류했습니다.');
        // Complete an interrupted exclusive hardlink publication before remapping.
        await this.moveToStaging(id, payload);
        this.remap(id, payload.source, payload.staging);
      } else {
        const destination = await this.files.checked(id, paths.get(entry.id)), stat = await missing(destination);
        const mapping = this.mapping(id, entry.id);
        if (mapping?.relative_path === paths.get(entry.id) && mapping.status === 'ready' && (payload.kind === 'file' || same(stat, payload))) {
          this.db.prepare("UPDATE unified_apply_journal SET state='complete',error=NULL WHERE id=?").run(row.id);
        } else {
          await this.moveToStaging(id, payload);
          this.remap(id, payload.source, payload.staging);
        }
      }
    }
  }
  async stage(id, state, paths) {
    await this.recover(id, state, paths);
    const mappings = this.mappings(id), byEntry = new Map(mappings.map(row => [row.entry_id, row]));
    const moves = Object.values(state.entries).filter(entry => !entry.deleted_at && entry.parent_id && byEntry.has(entry.id))
      .map(entry => ({ entry, source: byEntry.get(entry.id).relative_path, target: paths.get(entry.id), mapping: byEntry.get(entry.id) }))
      .filter(move => move.source !== move.target);
    const staged = new Map(this.db.prepare("SELECT entry_id,payload FROM unified_apply_journal WHERE workspace_id=? AND action='move' AND state!='complete'").all(id).map(row => [row.entry_id, JSON.parse(row.payload).staging]));
    // A parent move already carries descendants whose final suffix is unchanged.
    const bySource = new Map(moves.filter(move => move.entry.kind === 'folder').map(move => [move.source, move]));
    const carried = move => { let split = move.source.lastIndexOf('/'); while (split > 0) { const parent = bySource.get(move.source.slice(0, split)); if (parent && move.target === parent.target + move.source.slice(parent.source.length)) return true; split = move.source.lastIndexOf('/', split - 1); } return false; };
    const roots = moves.filter(move => staged.get(move.entry.id) !== move.source && !carried(move))
      .sort((a, b) => (a.entry.kind === 'folder' ? 0 : 1) - (b.entry.kind === 'folder' ? 0 : 1) || a.source.split('/').length - b.source.split('/').length);
    if (!roots.length) return { blocked: new Set(), failures: [] };
    const failed = [], snapshots = new Map(), byPath = new Map(mappings.map(row => [row.relative_path.normalize('NFC'), row])), movingIds = new Set(moves.map(move => move.entry.id));
    const conflicted = new Set(Object.values(state.conflicts).filter(conflict => conflict.status === 'open' && conflict.entity_collection === 'documents').map(conflict => conflict.entity_id));
    // Check the entire rename set before touching any original. Unknown destination
    // occupants and an external write must never turn a valid graph into data loss.
    for (const move of roots) {
      try {
        if (move.entry.document_id && conflicted.has(move.entry.document_id)) throw new Error('문서 충돌이 해결될 때까지 원본의 위치를 보존합니다.');
        const source = await this.files.checked(id, move.source), stat = await missing(source);
        if (!stat) continue; // A durable previous publication is handled by the normal apply path.
        if (stat.isSymbolicLink() || (move.entry.kind === 'folder' ? !stat.isDirectory() : !stat.isFile())) throw new Error('이동할 원본의 종류가 변경되었습니다.');
        if (move.entry.kind === 'file' && move.mapping.observed_hash && (await this.files.read(source)).sha256 !== move.mapping.observed_hash) throw new Error('외부 편집 내용이 있어 이동을 보류했습니다.');
        snapshots.set(move.entry.id, { device: stat.dev, inode: stat.ino });
        const destination = await this.files.checked(id, move.target), target = await missing(destination);
        if (target && (target.ino !== stat.ino || target.dev !== stat.dev)) {
          const occupant = byPath.get(move.target.normalize('NFC'));
          const leaving = occupant && movingIds.has(occupant.entry_id);
          if (!leaving) throw new Error('이동할 위치에 다른 로컬 항목이 있습니다. 원본을 보존했습니다.');
        }
      } catch (error) {
        // A target parent may be created or moved later in this same apply pass.
        if (error.code !== 'ENOENT') failed.push({ entry_id: move.entry.id, message: error.message });
      }
    }
    const blocked = new Set();
    const blockAll = message => {
      for (const move of moves) { blocked.add(move.entry.id); if (!failed.some(item => item.entry_id === move.entry.id)) failed.push({ entry_id: move.entry.id, message }); }
      return { blocked, failures: failed };
    };
    if (failed.length) return blockAll('연결된 이름 이동 중 확인할 항목이 있어 원본 위치를 보존했습니다.');
    for (const move of roots) {
      const snapshot = snapshots.get(move.entry.id); if (!snapshot) continue;
      const current = this.mapping(id, move.entry.id);
      const payload = { schema_version: 1, source: current.relative_path, staging: `.context-save-${randomUUID()}.move`, destination: move.target, kind: move.entry.kind, ...snapshot, observed_hash: move.mapping.observed_hash };
      const journal = this.files.journal(id, move.entry, null, 'move', payload);
      try {
        await this.moveToStaging(id, payload);
        this.remap(id, payload.source, payload.staging);
      } catch (error) {
        this.db.prepare("UPDATE unified_apply_journal SET state='needs_review',error=? WHERE id=?").run(error.message, journal);
        failed.push({ entry_id: move.entry.id, message: error.message });
        return blockAll('중단된 이름 이동을 journal에 보존했습니다. 다음 실행에서 다시 확인합니다.');
      }
    }
    return { blocked, failures: failed };
  }
  async finish(id, state, paths) {
    const failures = [];
    for (const row of this.db.prepare("SELECT * FROM unified_apply_journal WHERE workspace_id=? AND action='move' AND state!='complete'").all(id)) {
      const entry = state.entries[row.entry_id], mapping = this.mapping(id, row.entry_id);
      if (!entry || entry.deleted_at || !mapping || mapping.status !== 'ready' || mapping.relative_path !== paths.get(entry.id)) continue;
      const payload = JSON.parse(row.payload), stage = await this.files.checked(id, payload.staging), staged = await missing(stage);
      if (staged) {
        // Normally publication moved/unlinked staging. Preserve any unexpected bytes.
        if (!same(staged, payload) || payload.kind === 'folder') { failures.push({ entry_id: entry.id, message: '이동 중간 위치를 확인해야 합니다. 내용을 보존했습니다.' }); continue; }
        if (payload.observed_hash && (await this.files.read(stage)).sha256 !== payload.observed_hash) { failures.push({ entry_id: entry.id, message: '이동 중 외부에서 수정한 내용이 있어 중간 원본을 보존했습니다.' }); continue; }
        const target = await this.files.read(await this.files.checked(id, mapping.relative_path));
        if (target.sha256 !== mapping.observed_hash) continue;
        await unlink(stage);
      }
      this.db.prepare("UPDATE unified_apply_journal SET state='complete',error=NULL WHERE id=?").run(row.id);
    }
    return failures;
  }
  async restoreDeleted(id) {
    const failures = [];
    const rows = this.db.prepare("SELECT * FROM unified_apply_journal WHERE workspace_id=? AND action='move' AND state!='complete' ORDER BY created_at DESC,id DESC").all(id);
    for (const row of rows) {
      const payload = JSON.parse(row.payload);
      try {
        const stage = await this.files.checked(id, payload.staging), staged = await missing(stage);
        if (staged) {
          if (!same(staged, payload)) throw new Error('삭제 전의 이동 중간 위치가 바뀌어 원본을 보존했습니다.');
          const source = await this.files.checked(id, payload.source), current = await missing(source);
          if (current && !same(current, payload)) throw new Error('삭제 전 원본 위치에 다른 파일이 있어 중간 원본을 보존했습니다.');
          if (payload.kind === 'folder') {
            if (!current) await rename(stage, source);
          } else {
            if (!current) await link(stage, source);
            const restored = await lstat(source);
            if (!same(restored, payload)) throw new Error('복구한 원본을 확인하지 못했습니다.');
            await unlink(stage);
          }
          this.remap(id, payload.staging, payload.source);
          // A workspace tombstone does not make the preserved OS original remote data.
          this.store.transaction(() => { for (const mapping of this.subtree(id, payload.source)) this.files.mapping(id, mapping.entry_id, mapping.relative_path, mapping.observed_version_id, mapping.observed_hash, 'ready'); });
        }
        else {
          const original = await missing(await this.files.checked(id, payload.source));
          const published = await missing(await this.files.checked(id, payload.destination));
          const preserved = same(original, payload) ? payload.source : same(published, payload) ? payload.destination : null;
          if (!preserved) throw new Error('복구할 원본의 위치를 확인하지 못했습니다. 이동 기록을 보존했습니다.');
          this.remap(id, payload.staging, preserved);
        }
        this.db.prepare("UPDATE unified_apply_journal SET state='complete',error=NULL WHERE id=?").run(row.id);
      } catch (error) {
        this.db.prepare("UPDATE unified_apply_journal SET state='needs_review',error=? WHERE id=?").run(error.message, row.id);
        failures.push({ entry_id: row.entry_id, message: error.message });
      }
    }
    return failures;
  }
}
