import type { CanvasElement, CanvasRelation } from '../shared/core/canvas';
import type { NormalizedDocument } from '../shared/core/documents';
import type { Entry, Snapshot, Viewport, WorkspaceRuntime } from './runtime';
import type { SampleWorkspaceData } from './sample-types';

type Item = { directory: string; kind: 'element' | 'relation'; value: CanvasElement | CanvasRelation; revision: number; deleted: boolean };
type State = { version: 1; data: SampleWorkspaceData; items: Item[]; views: Snapshot['views']; histories: Record<string, { revision: number; content: NormalizedDocument | null }[]>; requests: Record<string, string> };
const clone = <T,>(value: T): T => structuredClone(value);
const fail: (message: string) => never = message => { throw new Error(message); };
const focus = '02_제품기획';
const links = [
  ['02_제품기획/제품요구사항_v1.2.md', '02_제품기획/API명세.json'],
  ['02_제품기획/제품요구사항_v1.2.md', '02_제품기획/데이터사전.md'],
  ['02_제품기획/제품요구사항_v1.2.md', '02_제품기획/출시체크리스트.csv'],
  ['01_회사소개/회사와팀.md', '01_회사소개/회사소개.pdf'],
];

export function createSampleStore(original: SampleWorkspaceData, storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const key = `context:sample-workspace:v1:${original.workspace_id}`;
  function fresh(): State {
    const data = clone(original);
    const items: Item[] = links.flatMap(([from, to], index) => {
      const source = data.entries.find(entry => entry.relative_path === from), target = data.entries.find(entry => entry.relative_path === to);
      return source && target ? [{ directory: source.parent_path, kind: 'relation', revision: 1, deleted: false, value: { id: `sample-link-${index}`, source_document_id: source.id, target_document_id: target.id, relation_type: 'REFERENCE' } }] : [];
    });
    items.push({ directory: focus, kind: 'element', revision: 1, deleted: false, value: { id: 'sample-guide-note', kind: 'text', text: '모아오더 출시 준비\n요구사항 → API·데이터사전·출시 점검표\n파일을 두 번 클릭해 내용을 살펴보세요.', x: 510, y: 335, width: 330, height: 180, color: 'violet', font_size: 20 } });
    return { version: 1, data, items, views: [], histories: {}, requests: {} };
  }
  let state = fresh();
  // This object remains stable so the AI repositories always search the latest working copy.
  const data = clone(state.data), listeners = new Set<() => void>();
  const target = () => storage || localStorage;
  function read(): State {
    const raw = target().getItem(key);
    if (!raw) return fresh();
    const saved = JSON.parse(raw) as State;
    if (saved.version !== 1 || saved.data?.workspace_id !== original.workspace_id || !Array.isArray(saved.data.entries) || !Array.isArray(saved.data.documents) || !Array.isArray(saved.items) || !Array.isArray(saved.views) || !saved.histories || !saved.requests) fail('샘플 수정 내용을 불러오지 못했습니다.');
    return saved;
  }
  function publish(next: State, notify = true) {
    state = next; Object.assign(data, clone(next.data));
    if (notify) for (const listener of listeners) listener();
  }
  let queue = Promise.resolve<unknown>(undefined);
  function change<T>(action: (next: State) => T, notify = true): Promise<T> {
    const run = async () => {
      const commit = () => {
        const next = read(), result = action(next);
        try { target().setItem(key, JSON.stringify(next)); } catch { fail('샘플을 저장하지 못했습니다. 저장 공간과 브라우저 저장 권한을 확인해 주세요.'); }
        publish(next, notify); return clone(result);
      };
      return typeof navigator !== 'undefined' && navigator.locks ? await navigator.locks.request<Promise<T>>(key, async () => commit()) : commit();
    };
    const result = queue.then(run, run); queue = result.catch(() => {}); return result;
  }
  const entry = (next: State, id: string) => next.data.entries.find(entry => entry.id === id) || fail('샘플 파일을 찾을 수 없습니다.');
  function nameFor(next: State, name: string, directory: string, except?: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200 || /[\\/\x00-\x1f]/.test(trimmed) || ['.', '..'].includes(trimmed)) fail('파일 이름을 확인해 주세요.');
    if (next.data.entries.some(entry => entry.parent_path === directory && entry.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase() && entry.id !== except)) fail('같은 이름의 항목이 이미 있습니다.');
    return trimmed;
  }
  function relocate(next: State, item: Entry, name: string, directory: string) {
    const before = item.relative_path, after = directory ? `${directory}/${name}` : name;
    item.name = name; item.parent_path = directory; item.relative_path = after;
    if (item.kind === 'file') item.extension = name.includes('.') ? '.' + name.split('.').at(-1)!.toLowerCase() : '';
    for (const child of next.data.entries) if (child.id !== item.id && child.relative_path.startsWith(before + '/')) { child.relative_path = after + child.relative_path.slice(before.length); child.parent_path = child.parent_path === before ? after : after + child.parent_path.slice(before.length); }
    for (const document of next.data.documents) document.path = entry(next, document.entry_id).relative_path;
    for (const canvas of next.items) if (canvas.directory === before || canvas.directory.startsWith(before + '/')) canvas.directory = after + canvas.directory.slice(before.length);
  }
  const snapshot = (): Snapshot => ({ workspace: { id: data.workspace_id, root: '이 기기에 저장되는 샘플', label: data.name, show_hidden: 0, include_generated: 0, scanned_at: null }, entries: clone(data.entries), disconnected_files: [], spatial_focus: focus, spatial_editing: state.views.find(view => view.directory === ':spatial:readable')?.editing, views: clone(state.views), status: 'ready', warnings: [] });
  const api: WorkspaceRuntime = {
    capabilities: { nativeFiles: false, label: '샘플', summarize: false, canEdit: true },
    async canvasSnapshot(_id, directory) { const items = state.items.filter(item => !item.deleted && item.directory === directory); return { elements: items.filter(item => item.kind === 'element').map(item => ({ ...clone(item.value as CanvasElement), revision: item.revision })), relations: items.filter(item => item.kind === 'relation').map(item => ({ ...clone(item.value as CanvasRelation), revision: item.revision })) }; },
    putCanvasItem: (_id, directory, kind, value, revision) => change(next => {
      const previous = next.items.find(item => item.value.id === value.id);
      if ((previous?.revision || 0) !== revision || previous && (previous.directory !== directory || previous.kind !== kind)) fail('다른 곳에서 캔버스가 변경됐습니다. 샘플을 다시 열어 주세요.');
      const item = { directory, kind, value: clone(value), revision: revision + 1, deleted: false };
      if (previous) Object.assign(previous, item); else next.items.push(item);
      return { ...value, revision: item.revision };
    }),
    removeCanvasItem: (_id, directory, id, revision) => change(next => { const item = next.items.find(item => item.value.id === id && item.directory === directory); if (!item || item.deleted || item.revision !== revision) fail('다른 곳에서 캔버스가 변경됐습니다.'); item.deleted = true; item.revision++; }),
    savePositions: (_id, values) => change(next => { for (const value of values) { if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) fail('파일 위치가 올바르지 않습니다.'); const item = entry(next, value.id); Object.assign(item, { x: value.x, y: value.y, ...(item.kind === 'directory' ? { area_positioned: true } : {}) }); } }),
    saveView: (_id, directory, view) => change(next => { next.views = [...next.views.filter(item => item.directory !== directory), { ...view, directory }]; }, false),
    moveFileToFolder: (_id, id, directoryId, options) => change(next => {
      const item = entry(next, id), folder = directoryId ? entry(next, directoryId) : null;
      if (folder && folder.kind !== 'directory') fail('폴더를 선택해 주세요.');
      if (item.kind !== 'file') fail('파일만 다른 폴더로 이동할 수 있습니다.');
      if (options?.expected_parent !== undefined && item.parent_path !== options.expected_parent) fail('파일 위치가 변경되었습니다.');
      const directory = folder?.relative_path || ''; nameFor(next, item.name, directory, item.id); relocate(next, item, item.name, directory);
      item.x = options?.position?.x ?? null; item.y = options?.position?.y ?? null; return item;
    }),
    copyFile: (_id, id, requestId) => change(next => {
      if (next.requests[requestId]) return entry(next, next.requests[requestId]);
      const source = entry(next, id); if (source.kind !== 'file') fail('파일만 복사할 수 있습니다.');
      const extension = source.extension, stem = source.name.slice(0, extension ? -extension.length : undefined);
      let name = `${stem} copy${extension}`, sequence = 2;
      while (next.data.entries.some(item => item.parent_path === source.parent_path && item.name === name)) name = `${stem} copy ${sequence++}${extension}`;
      const item = { ...source, id: crypto.randomUUID(), name, relative_path: source.parent_path ? `${source.parent_path}/${name}` : name, x: null, y: null, mtime: Date.now(), version_number: 1, version_count: 1 };
      next.data.entries.push(item);
      const document = next.data.documents.find(document => document.entry_id === id);
      if (document) next.data.documents.push({ ...clone(document), entry_id: item.id, path: item.relative_path });
      next.requests[requestId] = item.id; return item;
    }),
    async summarizeSelection() { return fail('AI 문서 작성에서 샘플 자료의 요약을 요청해 주세요.'); },
    async preview(_id, id) { const document = data.documents.find(document => document.entry_id === id); return document?.image_url ? { kind: 'image', url: document.image_url } : { kind: 'unsupported' }; },
    onChanged: callback => { const listener = () => callback(data.workspace_id); listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    data, api, snapshot,
    load() { publish(read()); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    document(id: string, revision?: number) {
      const document = data.documents.find(document => document.entry_id === id);
      const current = data.entries.find(entry => entry.id === id)?.version_number || 1;
      if (revision === undefined || revision === current) return document;
      const saved = state.histories[id]?.find(item => item.revision === revision);
      return saved && document ? { ...document, content: clone(saved.content) } : undefined;
    },
    saveDocument: (id: string, revision: number, content: NormalizedDocument) => change(next => {
      const item = entry(next, id), document = next.data.documents.find(document => document.entry_id === id) || fail('문서를 찾을 수 없습니다.');
      if ((item.version_number || 1) !== revision) fail('다른 곳에서 문서가 변경됐습니다. 문서를 다시 열어 주세요.');
      if (document.image_url) fail('이미지 본문 편집은 지원하지 않습니다.');
      if (!content.title.trim() || !Array.isArray(content.blocks) || JSON.stringify(content).length > 200000) fail('문서 제목 또는 크기를 확인해 주세요.');
      const history = next.histories[id] ||= [];
      history.push({ revision, content: clone(document.content) });
      document.content = clone(content); item.version_number = revision + 1; item.version_count = revision + 1; item.mtime = Date.now(); item.size = new TextEncoder().encode(content.blocks.map(block => block.text).join('\n')).length;
    }),
    createFile: (name: string, directory: string) => change(next => {
      if (directory && !next.data.entries.some(item => item.kind === 'directory' && item.relative_path === directory)) fail('폴더를 찾을 수 없습니다.');
      name = nameFor(next, name, directory); if (!/\.(md|txt)$/i.test(name)) fail('TXT 또는 Markdown 파일 이름을 입력해 주세요.');
      const item: Entry = { id: crypto.randomUUID(), workspace_id: data.workspace_id, relative_path: directory ? `${directory}/${name}` : name, parent_path: directory, name, extension: '.' + name.split('.').at(-1)!.toLowerCase(), kind: 'file', size: 0, mtime: Date.now(), excluded: 0, x: null, y: null, version_number: 1, version_count: 1 };
      next.data.entries.push(item); next.data.documents.push({ entry_id: item.id, path: item.relative_path, sha256: '', image_url: null, content: { schema_version: 1, title: name, blocks: [{ id: 1, type: 'paragraph', text: '', source: {} }], warnings: [], page_count: null } }); return item;
    }),
    rename: (id: string, name: string) => change(next => { const item = entry(next, id); relocate(next, item, nameFor(next, name, item.parent_path, id), item.parent_path); }),
    reset: () => change(next => {
      const initial = fresh();
      // Preserve cited snapshots while restoring the visible sample files and canvas.
      for (const document of initial.data.documents) {
        const previous = next.data.documents.find(item => item.entry_id === document.entry_id), item = initial.data.entries.find(item => item.id === document.entry_id)!;
        const revision = next.data.entries.find(item => item.id === document.entry_id)?.version_number || 1;
        if (revision > 1 && previous) {
          (next.histories[item.id] ||= []).push({ revision, content: clone(previous.content) });
          item.version_number = revision + 1; item.version_count = revision + 1;
        }
      }
      Object.assign(next, initial, { histories: next.histories });
    }),
  };
}
