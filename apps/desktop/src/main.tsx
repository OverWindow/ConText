import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Background, Controls, ReactFlow, applyNodeChanges, type Node, type NodeProps, type NodeChange } from '@xyflow/react';
import { LuArrowLeft, LuArrowUpRight, LuChevronRight, LuFolder, LuFolderPlus, LuHardDrive, LuImage, LuLayoutGrid, LuRefreshCw, LuSearch, LuSettings2, LuUnplug, LuX } from 'react-icons/lu';
import { DocumentPaper, fileSize } from '@context/ui';
import type { Entry, Preview, Snapshot, Workspace, Viewport } from './contracts';
import '@xyflow/react/dist/style.css';
import '../../../frontend/design/tokens.css';
import './style.css';
import brandLogo from '../../../frontend/public/brand/context-logo.png';

const api = window.contextDesktop;
const images = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
function appearance(entry: Entry) {
  if (entry.kind === 'directory') return { kind: 'folder', name: 'FOLDER', description: '하위 폴더' };
  if (images.has(entry.extension)) return { kind: 'image', name: entry.extension.slice(1).toUpperCase(), description: '이미지' };
  const ext = entry.extension.slice(1);
  return { kind: ['pdf', 'docx', 'hwpx', 'md'].includes(ext) ? ext : 'file', name: ext.toUpperCase() || 'FILE', description: entry.kind === 'link' ? '바로가기' : '로컬 파일' };
}
type FileNode = Node<{ entry: Entry; inspect: (entry: Entry) => void; enter: (entry: Entry) => void }, 'file'>;
function FileCard({ data, selected }: NodeProps<FileNode>) {
  const { entry } = data;
  const [thumbnail, setThumbnail] = useState<string>();
  useEffect(() => {
    let active = true;
    setThumbnail(undefined);
    if (entry.kind === 'file' && images.has(entry.extension)) api.preview(entry.workspace_id, entry.id, true).then(value => { if (active && value.kind === 'image') setThumbnail(value.url); }).catch(() => {});
    return () => { active = false; };
  }, [entry.id, entry.workspace_id, entry.kind, entry.extension, entry.mtime, entry.size]);
  const style = appearance(entry);
  return <div className={`canvas-document paper-document file-theme-${style.kind} ${selected ? 'is-selected' : ''}`} data-testid={`file-${entry.name}`}>
    <DocumentPaper {...style} filename={entry.name} size={entry.kind === 'directory' ? undefined : entry.size} status={entry.excluded ? '내용 제외됨' : entry.kind === 'directory' ? '폴더' : entry.kind === 'link' ? '바로가기' : '로컬'} thumbnail={thumbnail} />
    <button className="card-action nodrag nopan" title={entry.kind === 'directory' ? '폴더 열기' : '미리보기'} aria-label={`${entry.name} ${entry.kind === 'directory' ? '폴더 열기' : '미리보기'}`} onClick={() => entry.kind === 'directory' ? data.enter(entry) : data.inspect(entry)}><LuArrowUpRight /></button>
  </div>;
}
const nodeTypes = { file: FileCard };

function Canvas({ snapshot, directory, query, limit, inspect, enter, error, rememberView, rememberPositions }: {
  snapshot: Snapshot; directory: string; query: string; limit: number; inspect: (entry: Entry) => void; enter: (entry: Entry) => void; error: (text: string) => void; rememberView: (id: string, directory: string, view: Viewport) => void; rememberPositions: (id: string, positions: {id: string; x: number; y: number}[]) => void;
}) {
  const local = useRef(new Map<string, { x: number; y: number }>());
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const entries = useMemo(() => snapshot.entries.filter(entry => query ? entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) : entry.parent_path === directory).slice(0, limit), [snapshot.entries, directory, query, limit]);
  useEffect(() => {
    setNodes(previous => entries.map((entry, index) => ({ id: entry.id, type: 'file', data: { entry, inspect, enter },
      position: !query && local.current.get(entry.id) || (!query && entry.x !== null && entry.y !== null ? { x: entry.x, y: entry.y } : { x: index % 4 * 255, y: Math.floor(index / 4) * 335 }),
      selected: previous.find(node => node.id === entry.id)?.selected || false,
    })));
  }, [entries, inspect, enter, query]);
  const change = useCallback((changes: NodeChange<FileNode>[]) => {
    for (const item of changes) if (item.type === 'position' && item.position) local.current.set(item.id, item.position);
    setNodes(current => applyNodeChanges(changes, current));
  }, []);
  const saved = snapshot.views.find(view => view.directory === directory);
  return <ReactFlow<FileNode> nodes={nodes} edges={[]} nodeTypes={nodeTypes} onNodesChange={change} onlyRenderVisibleElements
    nodesConnectable={false} nodesDraggable={!query} deleteKeyCode={null} minZoom={.1} maxZoom={2} defaultViewport={saved || { x: 64, y: 45, zoom: .8 }}
    onNodeClick={(_event, node) => inspect(node.data.entry)} onNodeDoubleClick={(_event, node) => enter(node.data.entry)}
    onNodeDragStop={(_event, node, dragged) => {
      const positions = (dragged.length ? dragged : [node]).map(item => ({ id: item.id, ...item.position }));
      rememberPositions(snapshot.workspace.id, positions);
      api.savePositions(snapshot.workspace.id, positions).catch(reason => error(`배치를 저장하지 못했습니다: ${reason.message}`));
    }}
    onMoveEnd={(_event, view) => { if (!query) { rememberView(snapshot.workspace.id, directory, view); api.saveView(snapshot.workspace.id, directory, view).catch(reason => error(reason.message)); } }}>
    <Background color="#d4dced" gap={24} size={1} />
    <Controls showInteractive={false} />
  </ReactFlow>;
}
function PreviewPanel({ entry, close, error }: { entry: Entry; close: () => void; error: (text: string) => void }) {
  const [preview, setPreview] = useState<Preview>();
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let active = true; setPreview(undefined); setProblem('');
    if (entry.kind === 'directory') { setPreview({ kind: 'unsupported' }); return; }
    api.preview(entry.workspace_id, entry.id).then(value => { if (active) setPreview(value); }).catch(reason => { if (active) setProblem(reason.message); });
    return () => { active = false; };
  }, [entry.id, entry.workspace_id, entry.kind, entry.mtime, entry.size]);
  return <aside className="preview-panel" aria-label="파일 미리보기">
    <div className="panel-heading"><span>파일 살펴보기</span><button className="icon-button" onClick={close} aria-label="미리보기 닫기"><LuX /></button></div>
    <div className="preview-content">
      <span className="eyebrow">{appearance(entry).name}</span><h2>{entry.name}</h2>
      <p className="file-path">{entry.relative_path}</p>
      <dl><dt>크기</dt><dd>{entry.kind === 'directory' ? '폴더' : fileSize(entry.size)}</dd><dt>수정한 날짜</dt><dd>{new Date(entry.mtime).toLocaleString('ko-KR')}</dd></dl>
      <div className="preview-actions"><button onClick={() => api.open(entry.workspace_id, entry.id).catch(reason => error(reason.message))} disabled={entry.kind !== 'file'}>원본 열기 <LuArrowUpRight /></button><button onClick={() => api.reveal(entry.workspace_id, entry.id).catch(reason => error(reason.message))}>탐색기에서 보기</button></div>
      <div className="preview-body">{problem ? <p>{problem}</p> : !preview ? <p>미리보기를 불러오는 중…</p> : preview.kind === 'image' ? <img src={preview.url} alt={entry.name} /> : preview.kind === 'text' ? <><pre>{preview.text}</pre>{preview.truncated && <p>처음 64KB만 표시합니다. 전체 내용은 원본으로 열어 주세요.</p>}</> : <div className="unsupported"><LuLayoutGrid /><p>{entry.kind === 'directory' ? '폴더 카드를 두 번 눌러 들어가세요.' : '내용은 원본 앱에서 확인할 수 있습니다.'}</p></div>}</div>
    </div>
  </aside>;
}
function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const active = useRef<string | undefined>(undefined);
  const requestVersion = useRef(0);
  const [directory, setDirectory] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(200);
  const [selected, setSelected] = useState<Entry>();
  const [busy, setBusy] = useState(true);
  const [problem, setProblem] = useState('');
  const [settings, setSettings] = useState(false);
  const rememberView = useCallback((id: string, directory: string, view: Viewport) => setSnapshot(current => current?.workspace.id === id ? { ...current, views: [...current.views.filter(item => item.directory !== directory), { directory, ...view }] } : current), []);
  const rememberPositions = useCallback((id: string, positions: {id: string; x: number; y: number}[]) => setSnapshot(current => current?.workspace.id === id ? { ...current, entries: current.entries.map(entry => { const position = positions.find(item => item.id === entry.id); return position ? { ...entry, x: position.x, y: position.y } : entry; }) } : current), []);
  const inspect = useCallback((entry: Entry) => setSelected(entry), []);
  const enter = useCallback((entry: Entry) => {
    if (entry.kind === 'directory') { setDirectory(entry.relative_path); setQuery(''); setSelected(undefined); setLimit(200); }
    else setSelected(entry);
  }, []);
  const load = useCallback(async (id: string) => {
    const version = ++requestVersion.current;
    active.current = id; setBusy(true); setSelected(undefined); setDirectory(''); setQuery(''); setProblem('');
    try { const value = await api.snapshot(id); if (version === requestVersion.current) setSnapshot(value); }
    catch (reason) { setProblem((reason as Error).message); }
    finally { if (version === requestVersion.current) setBusy(false); }
  }, []);
  useEffect(() => {
    api.list().then(async rows => { setWorkspaces(rows); if (rows[0]) await load(rows[0].id); }).catch(reason => setProblem(reason.message)).finally(() => setBusy(false));
    return api.onChanged(id => {
      if (id !== active.current) return;
      const version = requestVersion.current;
      api.snapshot(id).then(value => { if (id === active.current && version === requestVersion.current) setSnapshot(value); }).catch(() => {});
    });
  }, [load]);
  useEffect(() => { setLimit(200); }, [directory, query]);
  useEffect(() => {
    if (!snapshot) return;
    if (directory && !snapshot.entries.some(entry => entry.kind === 'directory' && entry.relative_path === directory)) setDirectory('');
    if (selected) setSelected(snapshot.entries.find(entry => entry.id === selected.id));
  }, [snapshot]);
  async function accept(value: Snapshot | null) {
    if (!value) return;
    ++requestVersion.current; active.current = value.workspace.id; setSnapshot(value); setDirectory(''); setQuery(''); setSelected(undefined);
    setWorkspaces(await api.list());
  }
  async function action(fn: () => Promise<unknown>) {
    setBusy(true); setProblem(''); try { await fn(); } catch (reason) { setProblem((reason as Error).message); } finally { setBusy(false); }
  }
  const matchCount = snapshot?.entries.filter(entry => query ? entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) : entry.parent_path === directory).length || 0;
  const parts = directory.split('/').filter(Boolean);
  return <div className="desktop-shell">
    <aside className="sidebar">
      <div className="brand"><img src={brandLogo} alt="ConText" /><small>DESKTOP</small></div>
      <button className="primary connect" onClick={() => action(async () => accept(await api.connect()))} disabled={busy}><LuFolderPlus />폴더 연결</button>
      <div className="sidebar-label">내 컴퓨터 <span>{workspaces.length}</span></div>
      <nav aria-label="연결된 폴더">{workspaces.map(item => <button className={`workspace-item ${active.current === item.id ? 'active' : ''}`} key={item.id} onClick={() => load(item.id)} disabled={busy} title={item.root}><LuFolder /><span>{item.label}<small>{item.root}</small></span></button>)}</nav>
      <div className="sidebar-foot"><LuHardDrive /><div>로컬 작업 공간<small>파일과 배치는 이 기기에 저장됩니다.</small></div></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="workspace-heading"><span className="eyebrow">YOUR LOCAL CONTEXT</span><h1>{snapshot?.workspace.label || '나의 파일, 하나의 캔버스'}</h1></div><span className="local-pill"><i />로컬</span>
        {snapshot && <><label className="search"><LuSearch /><input placeholder="연결한 폴더 전체에서 파일 이름 검색" aria-label="파일 이름 검색" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button" onClick={() => setQuery('')} aria-label="검색 지우기"><LuX /></button>}</label><button className="icon-button" title="새로고침" aria-label="새로고침" disabled={busy} onClick={() => action(async () => { const value = await api.refresh(snapshot.workspace.id); setSnapshot(value); })}><LuRefreshCw className={snapshot.status === 'scanning' ? 'spin' : ''} /></button><button className="icon-button" title="폴더 설정" aria-label="폴더 설정" onClick={() => setSettings(!settings)}><LuSettings2 /></button></>}
      </header>
      {problem && <div className="notice error" role="alert">{problem}<button className="icon-button" aria-label="오류 닫기" onClick={() => setProblem('')}><LuX /></button></div>}
      {snapshot?.warnings.map(warning => <div className="notice" key={warning}>{warning}</div>)}
      {snapshot && settings && <section className="settings"><label><input type="checkbox" checked={!!snapshot.workspace.show_hidden} disabled={busy} onChange={event => action(async () => setSnapshot(await api.settings(snapshot.workspace.id, { showHidden: event.target.checked, includeGenerated: !!snapshot.workspace.include_generated })))} />숨김 파일 표시</label><label><input type="checkbox" checked={!!snapshot.workspace.include_generated} disabled={busy} onChange={event => action(async () => setSnapshot(await api.settings(snapshot.workspace.id, { showHidden: !!snapshot.workspace.show_hidden, includeGenerated: event.target.checked })))} />개발용 생성 폴더 내용 포함</label><button disabled={busy} onClick={() => action(async () => accept(await api.relink(snapshot.workspace.id)))}>위치 다시 지정</button><button className="danger" disabled={busy} onClick={() => action(async () => { if (await api.disconnect(snapshot.workspace.id)) { active.current = undefined; ++requestVersion.current; setSnapshot(undefined); setSelected(undefined); setSettings(false); const rows = await api.list(); setWorkspaces(rows); if (rows[0]) await load(rows[0].id); } })}><LuUnplug />연결 해제</button></section>}
      {snapshot ? <>
        <div className="breadcrumb-bar"><button className="icon-button" aria-label="상위 폴더" disabled={!directory} onClick={() => { setDirectory(parts.slice(0, -1).join('/')); setQuery(''); }}><LuArrowLeft /></button><button onClick={() => { setDirectory(''); setQuery(''); }}>{snapshot.workspace.label}</button>{parts.map((part, index) => <React.Fragment key={index}><LuChevronRight /><button onClick={() => { setDirectory(parts.slice(0, index + 1).join('/')); setQuery(''); }}>{part}</button></React.Fragment>)}<span className="count">{query ? '전체 검색 · ' : ''}{matchCount.toLocaleString()}개</span></div>
        <div className="workspace-body"><div className="canvas-area" aria-label="로컬 파일 캔버스">
          <Canvas key={`${snapshot.workspace.id}:${directory}:${query ? 'search' : 'folder'}`} snapshot={snapshot} directory={directory} query={query} limit={limit} inspect={inspect} enter={enter} error={setProblem} rememberView={rememberView} rememberPositions={rememberPositions} />
          {!matchCount && <div className="canvas-empty"><LuFolder /><h2>{query ? '일치하는 파일이 없습니다' : '이 폴더는 비어 있습니다'}</h2><p>{query ? '다른 파일 이름으로 검색해 보세요.' : '파일을 추가하면 이곳에 자동으로 나타납니다.'}</p></div>}
          {matchCount > limit && <button className="load-more" onClick={() => setLimit(limit + 200)}>다음 200개 표시 ({limit.toLocaleString()} / {matchCount.toLocaleString()})</button>}
          <div className="canvas-tip">드래그하여 배치 · 두 번 눌러 폴더 열기</div>
        </div>{selected && <PreviewPanel entry={selected} close={() => setSelected(undefined)} error={setProblem} />}</div>
        <footer className="statusbar"><span><i className={snapshot.status} />{busy || snapshot.status === 'scanning' ? '파일을 확인하고 있습니다…' : snapshot.status === 'unavailable' ? '저장된 목록 표시 중' : '변경 사항 자동 반영'}</span><span title={snapshot.workspace.root}>{snapshot.workspace.root}</span><span>배치 자동 저장</span></footer>
      </> : <section className="welcome"><div className="welcome-art"><div className="mini-paper"><LuFolder /></div><div className="mini-paper"><LuImage /></div></div><span className="eyebrow">FILES BECOME YOUR WORKSPACE</span><h2>폴더를 연결하면,<br />파일이 캔버스가 됩니다.</h2><p>문서와 이미지를 한눈에 살펴보고,<br />생각의 흐름에 맞게 자유롭게 배치하세요.</p><button className="primary" disabled={busy} onClick={() => action(async () => accept(await api.connect()))}><LuFolderPlus />{busy ? '작업 공간 불러오는 중…' : '첫 폴더 연결하기'}</button><small>원본 파일 위치는 유지됩니다. 하위 폴더도 함께 탐색합니다.</small></section>}
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
