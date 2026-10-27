import { open, realpath, lstat, link, unlink } from 'node:fs/promises';
import path from 'node:path';

export class LocalFiles {
  constructor(engine) { this.engine = engine; }
  freePosition(workspaceId, directory, entryId) {
    const rectangles = this.engine.snapshot(workspaceId).entries.filter(entry => entry.id !== entryId && entry.parent_path === directory && entry.kind !== 'directory')
      .map(entry => ({ x: entry.x || 0, y: entry.y || 0, width: 200, height: 290 }));
    rectangles.push(...this.engine.canvas.snapshot(workspaceId, directory).elements);
    const columns = Math.max(4, Math.min(64, Math.ceil(Math.sqrt(rectangles.length || 1)))), rows = Math.floor(1_000_000 / 335), occupied = new Set();
    for (const rect of rectangles) {
      const left = Math.max(0, Math.floor((rect.x - 224) / 255) + 1), right = Math.min(columns - 1, Math.ceil((rect.x + rect.width + 24) / 255) - 1);
      const top = Math.max(0, Math.floor((rect.y - 314) / 335) + 1), bottom = Math.min(rows, Math.ceil((rect.y + rect.height + 24) / 335) - 1);
      for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) occupied.add(`${x}:${y}`);
    }
    for (let i = 0; i < columns * (rows + 1); i++) if (!occupied.has(`${i % columns}:${Math.floor(i / columns)}`)) return { x: i % columns * 255, y: Math.floor(i / columns) * 335 };
    throw new Error('이 폴더에 빈 배치 공간이 없습니다. 파일 배치를 정리한 뒤 다시 옮겨 주세요.');
  }
  async text(workspaceId, entryId) {
    const { entry, data, sha256 } = await this.engine.documents.readEntry(workspaceId, entryId);
    if (!['.txt', '.md'].includes(entry.extension) || data.length > 2 * 1024 * 1024) throw new Error('2MB 이하 UTF-8 TXT/Markdown만 원본을 직접 편집할 수 있습니다.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new Error('UTF-8 파일만 직접 편집할 수 있습니다. 새 초안으로 편집을 사용해 주세요.'); }
    if (text.includes('\0')) throw new Error('텍스트 파일로 읽을 수 없는 내용입니다.');
    return { filename: entry.name, text: text.replace(/\r\n/g, '\n'), revision: sha256,
      bom: data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), eol: data.includes(Buffer.from('\r\n')) ? '\r\n' : '\n' };
  }
  async saveText(workspaceId, entryId, revision, text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('텍스트는 최대 2MB까지 저장할 수 있습니다.');
    const current = await this.text(workspaceId, entryId);
    if (current.revision !== revision) throw new Error('외부에서 파일이 변경됐습니다. 편집 내용을 보존한 뒤 원본을 다시 열어 주세요.');
    const version = await this.engine.documents.open(workspaceId, entryId);
    const entry = await this.engine.resolveEntry(workspaceId, entryId);
    const data = Buffer.concat([current.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text.replace(/\r?\n/g, current.eol), 'utf8')]);
    if (data.length > 2 * 1024 * 1024) throw new Error('원래 줄바꿈과 BOM을 보존하면 2MB를 넘습니다. 내용을 줄이거나 다른 이름으로 저장해 주세요.');
    await this.engine.documents.writeFile(workspaceId, version.document_id, version.version_number, entry.filename, data, revision,
      () => this.engine.documents.version(workspaceId, version.document_id, version.version_id));
    await this.engine.scan(workspaceId);
    await this.engine.documents.open(workspaceId, entryId);
    return this.text(workspaceId, entryId);
  }
  async rename(workspaceId, entryId, name, parent, preserveName = false) {
    if (typeof name !== 'string' || !name || /[\\/\0]/.test(name) || ['.', '..'].includes(name) || !preserveName && (!name.trim() || name.length > 240 || /[. ]$/.test(name))) throw new Error('경로 구분자 없이 올바른 파일 이름을 입력해 주세요.');
    const entry = await this.engine.resolveEntry(workspaceId, entryId);
    if (entry.kind !== 'file') throw new Error('파일의 이름과 위치만 변경할 수 있습니다.');
    const root = this.engine.workspace(workspaceId).root;
    const directory = parent ? await realpath(parent) : path.dirname(entry.filename);
    const relative = path.relative(root, directory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('연결한 폴더 안에서만 이동할 수 있습니다.');
    if (!(await lstat(directory)).isDirectory()) throw new Error('이동할 폴더를 찾지 못했습니다.');
    const destination = path.join(directory, preserveName ? name : name.trim());
    if (destination === entry.filename) return;
    try { await link(entry.filename, destination); }
    catch (error) { if (error.code === 'EXDEV') throw new Error('서로 다른 볼륨 사이의 이동은 탐색기에서 진행해 주세요. 원본은 유지했습니다.'); throw error; }
    const [source, target] = await Promise.all([lstat(entry.filename), lstat(destination)]);
    if (source.ino !== entry.inode || source.dev !== entry.device || target.ino !== entry.inode || target.dev !== entry.device) throw new Error('파일이 변경되어 이동을 중단했습니다. 원본과 대상 위치를 확인해 주세요.');
    await unlink(entry.filename);
  }
  async createText(workspaceId, name, directoryId) {
    if (typeof name !== 'string' || !['.txt', '.md'].includes(path.extname(name).toLowerCase()) || name.length > 240 || /[\\/\0]/.test(name)) throw new Error('TXT 또는 Markdown 파일 이름을 입력해 주세요.');
    const workspace = this.engine.workspace(workspaceId);
    if (await realpath(workspace.root) !== workspace.root) throw new Error('연결한 폴더의 위치가 변경되었습니다. 위치를 다시 지정해 주세요.');
    const parent = directoryId ? await this.engine.resolveEntry(workspaceId, directoryId) : { filename: workspace.root, kind: 'directory' };
    if (parent.kind !== 'directory') throw new Error('파일을 만들 폴더를 선택해 주세요.');
    const filename = path.join(parent.filename, name);
    if (this.engine.excluded(workspace.root, filename, workspace)) throw new Error('현재 숨김·제외 설정에 해당하는 파일입니다. 폴더 설정을 변경한 뒤 만들어 주세요.');
    const file = await open(filename, 'wx', 0o600);
    try { await file.writeFile(''); await file.sync(); } finally { await file.close(); }
    await this.engine.scan(workspaceId);
    const entry = this.engine.snapshot(workspaceId).entries.find(entry => entry.relative_path === path.relative(workspace.root, filename).split(path.sep).join('/'));
    if (!entry) throw new Error('파일은 저장됐지만 목록에 반영되지 않았습니다. 폴더를 새로고침해 주세요.');
    return entry;
  }
}
