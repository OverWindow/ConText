import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LuArrowUpRight, LuFolder, LuFolderPlus, LuLayoutGrid, LuUnplug, LuX } from 'react-icons/lu';
import { fileSize } from '@context/workspace-ui/shared/ui/document-paper';
import type { Entry, Preview, Snapshot, Workspace, Viewport } from './contracts';
import '@xyflow/react/dist/style.css';
import '@context/workspace-ui/assets/tokens.css';
import '@context/workspace-ui/shared/canvas/canvas.css';
import './style.css';
import brandSymbol from '@context/workspace-ui/assets/context-symbol.png';
import brandLogo from '@context/workspace-ui/assets/context-logo.png';
import { DraftStudio } from '@context/workspace-ui/shared/writing/draft-studio';
import { localDraftRepository, desktopAIRepository } from './draft-repository';
import { AISettings } from '@context/workspace-ui/shared/ui/ai-settings';
import { LocalDocumentPreview } from './document-preview';
import type { DocumentReference } from '@context/workspace-ui/shared/core/chat';
import type { Source } from '@context/workspace-ui/shared/core/sources';
import { ChatPanelView } from '@context/workspace-ui/shared/chat/chat-panel';
import { localChatRepository } from './chat-repository';
import { LocalTextEditor } from './text-editor';
import { FileActions } from './file-actions';
import { RecoveryPanel } from './recovery-panel';
import { DesktopCanvas, type CreateCanvasFile } from './local-canvas';
import { appearance } from './file-card';
import { ApplicationShell, ApplicationHomeShell, ApplicationToolbar, ApplicationHome, ApplicationStatus } from '@context/workspace-ui/application';
import { CreateEntryDialog } from '@context/workspace-ui/create-entry-dialog';
import { DesktopAccountControl } from './account-control';
import { CloudControl, CloudWorkspacePicker } from './cloud-control';
import { LocalDocumentLibrary } from './document-library';
import '@context/workspace-ui/shared/ui/workspace-navigation.css';

const api = window.contextDesktop;
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
      {entry.kind === 'file' && <FileActions entry={entry} onDeleted={close} />}
      <div className="preview-body">{problem ? <p>{problem}</p> : !preview ? <p>미리보기를 불러오는 중…</p> : preview.kind === 'image' ? <img src={preview.url} alt={entry.name} /> : preview.kind === 'text' ? <><pre>{preview.text}</pre>{preview.truncated && <p>처음 64KB만 표시합니다. 전체 내용은 원본으로 열어 주세요.</p>}</> : <div className="unsupported"><LuLayoutGrid /><p>{entry.kind === 'directory' ? '폴더 카드를 두 번 눌러 들어가세요.' : '내용은 원본 앱에서 확인할 수 있습니다.'}</p></div>}</div>
    </div>
  </aside>;
}
function App() {
  const [home, setHome] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const active = useRef<string | undefined>(undefined);
  const requestVersion = useRef(0);
  const canvasFlush = useRef<(() => Promise<boolean>) | undefined>(undefined);
  const registerCanvasFlush = useCallback((flush: (() => Promise<boolean>) | undefined) => { canvasFlush.current = flush; }, []);
  const [directory, setDirectory] = useState('');
  const [navigationSequence, setNavigationSequence] = useState(0);
  const focusDirectory = useCallback((value: string) => setDirectory(value), []);
  const [referenceFocus, setReferenceFocus] = useState<{ ids: string[]; sequence: number }>({ ids: [], sequence: 0 });
  const revealRequest = useRef(0);
  const clearReferences = useCallback(() => { ++revealRequest.current; setReferenceFocus(current => ({ ids: [], sequence: current.sequence + 1 })); }, []);
  const [query, setQuery] = useState('');
  const queryRequest = useRef(0);
  const changeQuery = useCallback(async (value: string) => { const request = ++queryRequest.current; if (canvasFlush.current && !await canvasFlush.current()) { setProblem('캔버스 저장을 완료한 뒤 검색해 주세요.'); return; } if (request === queryRequest.current) { clearReferences(); setQuery(value); } }, []);
  const [limit, setLimit] = useState(200);
  const [selected, setSelected] = useState<Entry>();
  const [busy, setBusy] = useState(true);
  const [problem, setProblem] = useState('');
  const [settings, setSettings] = useState(false);
  const [writing, setWriting] = useState(false);
  const [aiSettings, setAISettings] = useState(false);
  const [sourceReference, setSourceReference] = useState<Source>();
  const [chatOpen, setChatOpen] = useState(false);
  const [textEntry, setTextEntry] = useState<Entry>();
  const [library, setLibrary] = useState(false);
  const [canvasToolbarHost, setCanvasToolbarHost] = useState<HTMLDivElement | null>(null);
  const [canvasOverlay, setCanvasOverlay] = useState<HTMLDivElement | null>(null);
  const [canvasTopInset, setCanvasTopInset] = useState(0);
  useLayoutEffect(() => {
    if (!canvasOverlay) { setCanvasTopInset(0); return; }
    const measure = () => setCanvasTopInset(Math.ceil(canvasOverlay.getBoundingClientRect().height));
    const observer = new ResizeObserver(measure);
    measure(); observer.observe(canvasOverlay);
    return () => observer.disconnect();
  }, [canvasOverlay]);
  const canvasCreate = useRef<CreateCanvasFile | undefined>(undefined);
  const registerCanvasCreate = useCallback((create: CreateCanvasFile | undefined) => { canvasCreate.current = create; }, []);
  const [newFile, setNewFile] = useState(false);
  const chatRepository = useMemo(() => snapshot ? localChatRepository(snapshot.workspace.id) : null, [snapshot?.workspace.id]);
  const [initialDraftId, setInitialDraftId] = useState<string>();
  const draftRepository = useMemo(() => snapshot ? localDraftRepository(snapshot.workspace.id) : null, [snapshot?.workspace.id]);
  const rememberView = useCallback((id: string, directory: string, view: Viewport) => setSnapshot(current => current?.workspace.id === id ? { ...current, spatial_editing: view.editing ?? current.spatial_editing, views: [...current.views.filter(item => item.directory !== directory), { directory, ...view }] } : current), []);
  const rememberPositions = useCallback((id: string, positions: {id: string; x: number; y: number}[]) => setSnapshot(current => current?.workspace.id === id ? { ...current, entries: current.entries.map(entry => { const position = positions.find(item => item.id === entry.id); return position ? { ...entry, x: position.x, y: position.y, area_positioned: entry.kind === 'directory' || entry.area_positioned } : entry; }) } : current), []);
  const rememberEntry = useCallback((entry: Entry) => setSnapshot(current => current?.workspace.id === entry.workspace_id ? { ...current, entries: [...current.entries.filter(item => item.id !== entry.id), entry] } : current), []);
  const inspect = useCallback((entry: Entry) => {
    // A newly created file can arrive before its inventory event is rendered.
    setSnapshot(current => current?.workspace.id === entry.workspace_id && !current.entries.some(item => item.id === entry.id) ? { ...current, entries: [...current.entries, entry] } : current);
    setDirectory(entry.parent_path); setSourceReference(undefined); setSelected(entry);
  }, []);
  const changeDirectory = useCallback(async (directory: string) => {
    if (canvasFlush.current && !await canvasFlush.current()) { setProblem('캔버스 저장을 완료한 뒤 폴더를 변경해 주세요.'); return; }
    clearReferences(); setDirectory(directory); setNavigationSequence(current => current + 1); setQuery(''); setSelected(undefined);
  }, []);
  const enter = useCallback((entry: Entry) => {
    if (entry.kind === 'directory') void changeDirectory(entry.relative_path);
    else setSelected(entry);
  }, [changeDirectory]);
  const load = useCallback(async (id: string) => {
    if (canvasFlush.current && !await canvasFlush.current()) { setProblem('캔버스 저장을 완료한 뒤 작업 공간을 변경해 주세요.'); return; }
    const version = ++requestVersion.current;
    setHome(false); clearReferences(); active.current = id; setBusy(true); setSelected(undefined); setDirectory(''); setQuery(''); setProblem('');
    try { const value = await api.snapshot(id); if (version === requestVersion.current) { setSnapshot(value); setDirectory(value.spatial_focus || ''); } }
    catch (reason) { setProblem((reason as Error).message); }
    finally { if (version === requestVersion.current) setBusy(false); }
  }, []);
  useEffect(() => {
    api.list().then(async rows => { setWorkspaces(rows); if (rows[0]) await load(rows[0].id); }).catch(reason => setProblem(reason.message)).finally(() => setBusy(false));
    return api.onChanged((id, update) => {
      if (id !== active.current || update?.conversions) return;
      if (update?.indexing) { setSnapshot(current => current?.workspace.id === id ? { ...current, indexing: update.indexing } : current); if (update.indexing.state !== 'complete') return; }
      const version = requestVersion.current;
      api.snapshot(id).then(value => { if (id === active.current && version === requestVersion.current) setSnapshot(value); }).catch(() => {});
    });
  }, [load]);
  useEffect(() => { setLimit(200); }, [snapshot?.workspace.id, query]);
  useEffect(() => {
    if (!snapshot) return;
    if (directory && !snapshot.entries.some(entry => entry.kind === 'directory' && entry.relative_path === directory)) void changeDirectory('');
    if (selected && !sourceReference) setSelected(snapshot.entries.find(entry => entry.id === selected.id));
  }, [snapshot]);
  async function accept(value: Snapshot | null) {
    if (!value) return;
    if (canvasFlush.current && !await canvasFlush.current()) { setProblem('캔버스 저장을 완료한 뒤 작업 공간을 변경해 주세요.'); return; }
    setHome(false); ++requestVersion.current; active.current = value.workspace.id; setSnapshot(value); setDirectory(value.spatial_focus || ''); setQuery(''); setSelected(undefined);
    setWorkspaces(await api.list());
  }
  async function disconnectWorkspace(id: string) {
    if (id === active.current && canvasFlush.current && !await canvasFlush.current()) throw new Error('캔버스 저장을 완료한 뒤 연결을 해제해 주세요.');
    if (!await api.disconnect(id)) return;
    const rows = await api.list(); setWorkspaces(rows);
    if (id !== active.current) return;
    active.current = undefined; ++requestVersion.current; clearReferences(); canvasFlush.current = undefined;
    setSnapshot(undefined); setSelected(undefined); setSourceReference(undefined); setDirectory(''); setQuery('');
    setSettings(false); setChatOpen(false); setLibrary(false); setWriting(false); setTextEntry(undefined); setNewFile(false);
    setHome(true);
  }
  async function action(fn: () => Promise<unknown>) {
    setBusy(true); setProblem(''); try { await fn(); } catch (reason) { setProblem((reason as Error).message); } finally { setBusy(false); }
  }
  async function revealSources(sources: DocumentReference[]) {
    const request = ++revealRequest.current;
    if (!snapshot || !sources.length) { setReferenceFocus(current => ({ ids: [], sequence: current.sequence + 1 })); return; }
    if (canvasFlush.current && !await canvasFlush.current()) return;
    try {
      const entries = await api.documentEntries(snapshot.workspace.id, [...new Set(sources.map(source => source.document_id))]);
      if (request === revealRequest.current) { setQuery(''); setReferenceFocus(current => ({ ids: entries.map(entry => entry.entry_id), sequence: current.sequence + 1 })); }
    } catch (reason) { setProblem((reason as Error).message); }
  }
  async function openSource(source: Source) {
    if (!snapshot) return;
    const version = await api.getDocumentVersion(snapshot.workspace.id, source.document_id, source.version_id);
    const entry = snapshot.entries.find(entry => entry.id === version.entry_id) || { id: version.entry_id, workspace_id: snapshot.workspace.id, relative_path: version.filename, parent_path: '', name: version.filename, kind: 'file' as const, extension: '.' + version.filename.split('.').at(-1)!.toLowerCase(), size: 0, mtime: version.created_at, excluded: 0, x: null, y: null, cached_only: true, disconnected: snapshot.disconnected_files.some(file => file.id === version.entry_id) };
    setSourceReference(source); setSelected(entry);
  }
  const matchCount = snapshot?.entries.filter(entry => query ? entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) : entry.parent_path === directory).length || 0;
  const canvasCount = query ? matchCount : snapshot?.entries.length || 0;
  const workspaceChrome = <>
      <ApplicationToolbar name={snapshot?.workspace.label || '나의 워크스페이스'} directory={directory} onHome={snapshot ? () => { void changeDirectory(''); } : undefined} query={query} onQuery={snapshot ? value => void changeQuery(value) : undefined} onRefresh={snapshot ? () => void action(async () => setSnapshot(await api.refresh(snapshot.workspace.id))) : undefined} onSettings={snapshot ? () => setSettings(!settings) : undefined} onCreate={snapshot ? () => setNewFile(true) : undefined} busy={busy} toolsRef={setCanvasToolbarHost} sync={snapshot && <CloudControl key={snapshot.workspace.id} workspaceId={snapshot.workspace.id} flush={async () => canvasFlush.current ? canvasFlush.current() : true} />} />
      {problem && <div className="notice error" role="alert">{problem}<button className="icon-button" aria-label="오류 닫기" onClick={() => setProblem('')}><LuX /></button></div>}
      {snapshot?.warnings.map(warning => <div className="notice" key={warning}>{warning}</div>)}
      {snapshot && <RecoveryPanel key={snapshot.workspace.id} workspaceId={snapshot.workspace.id} />}
      {snapshot && settings && <section className="settings"><label><input type="checkbox" checked={!!snapshot.workspace.show_hidden} disabled={busy} onChange={event => action(async () => setSnapshot(await api.settings(snapshot.workspace.id, { showHidden: event.target.checked, includeGenerated: !!snapshot.workspace.include_generated })))} />숨김 파일 표시</label><label><input type="checkbox" checked={!!snapshot.workspace.include_generated} disabled={busy} onChange={event => action(async () => setSnapshot(await api.settings(snapshot.workspace.id, { showHidden: !!snapshot.workspace.show_hidden, includeGenerated: event.target.checked })))} />개발용 생성 폴더 내용 포함</label><button disabled={busy} onClick={() => action(async () => accept(await api.relink(snapshot.workspace.id)))}>위치 다시 지정</button><button className="danger" disabled={busy} onClick={() => action(() => disconnectWorkspace(snapshot.workspace.id))}><LuUnplug />연결 해제</button></section>}
  </>;
  const spaces = workspaces.map(item => ({ id: item.id, name: item.label, detail: item.root, kind: 'local' as const, onOpen: () => void load(item.id), onRemove: () => void action(() => disconnectWorkspace(item.id)), removeLabel: `${item.label} 폴더 전체 연결 해제` }));
  const connect = <button className="primary connect" onClick={() => void action(async () => accept(await api.connect()))} disabled={busy}><LuFolderPlus />폴더 연결</button>;
  const cloudPicker = <CloudWorkspacePicker onAttach={value => { void action(() => accept(value)); }} />;
  const Shell = snapshot && !home ? ApplicationShell : ApplicationHomeShell;
  return <Shell navigation={{ logo: brandLogo, symbol: brandSymbol, onHome: () => { void action(async () => { if (canvasFlush.current && !await canvasFlush.current()) throw new Error('캔버스 저장을 완료해 주세요.'); setHome(true); }); }, spaces, activeId: !home ? snapshot?.workspace.id : undefined, account: <DesktopAccountControl />, primary: connect, secondary: cloudPicker, loading: busy && !workspaces.length }} menu={{ available: !!snapshot && !home, count: snapshot?.entries.length, active: library ? 'documents' : writing ? 'writing' : 'canvas', canvas: () => { setHome(false); setSelected(undefined); setLibrary(false); }, documents: () => setLibrary(true), writing: () => { setInitialDraftId(undefined); setWriting(true); }, chat: () => setChatOpen(!chatOpen), chatOpen, settings: () => setAISettings(true) }}>
      {snapshot && !home ? <>
        <div className="workspace-body"><div className="canvas-area" aria-label="로컬 파일 캔버스" style={{ '--canvas-chrome-height': `${canvasTopInset}px` } as React.CSSProperties}>
          <DesktopCanvas onCreateFileReady={registerCanvasCreate} key={`${snapshot.workspace.id}:${query ? 'search' : 'folder'}`} snapshot={snapshot} directory={directory} navigationSequence={navigationSequence} onFocusDirectory={focusDirectory} query={query} limit={limit} inspect={inspect} enter={enter} error={setProblem} rememberView={rememberView} rememberPositions={rememberPositions} rememberEntry={rememberEntry} toolbarHost={canvasToolbarHost} topInset={canvasTopInset} onFlushReady={registerCanvasFlush} referenceIds={referenceFocus.ids} referenceSequence={referenceFocus.sequence} onClearReferences={clearReferences} />
          <div className="canvas-overlay" ref={setCanvasOverlay}>{workspaceChrome}
          {canvasCount > limit && <button className="load-more" onClick={() => setLimit(limit + 200)}>다음 200개 표시 ({limit.toLocaleString()} / {canvasCount.toLocaleString()})</button>}
          </div>
          {!canvasCount && <div className="canvas-empty"><LuFolder /><h2>{query ? '일치하는 파일이 없습니다' : '이 폴더는 비어 있습니다'}</h2><p>{query ? '다른 파일 이름으로 검색해 보세요.' : '파일을 추가하면 이곳에 자동으로 나타납니다.'}</p></div>}
        </div>{chatRepository && <ChatPanelView key={snapshot.workspace.id} workspace={{ id: snapshot.workspace.id, name: snapshot.workspace.label, role: 'OWNER' }} repository={chatRepository} open={chatOpen} onClose={() => setChatOpen(false)} onRevealSources={sources => void revealSources(sources)} onOpenSource={openSource} onAISettings={() => setAISettings(true)} />}{selected && (selected.kind === 'file' && ['.txt', '.md', '.pdf', '.docx', '.hwpx'].includes(selected.extension) ? <LocalDocumentPreview entry={selected} initialVersionId={sourceReference?.version_id} initialBlockId={sourceReference?.locations[0]?.block_id} onClose={() => { setSelected(undefined); setSourceReference(undefined); }} onEdit={id => { setInitialDraftId(id); setWriting(true); }} onEditText={() => setTextEntry(selected)} /> : <PreviewPanel entry={selected} close={() => setSelected(undefined)} error={setProblem} />)}</div>
        <ApplicationStatus message={busy || snapshot.status === 'scanning' ? '파일을 확인하고 있습니다…' : snapshot.status === 'unavailable' ? '저장된 목록 표시 중' : '변경 사항 자동 반영'} location={snapshot.workspace.root}>{snapshot.indexing?.state === 'running' ? <><span>본문 준비 {snapshot.indexing.completed}/{snapshot.indexing.total}</span><button onClick={() => void action(() => api.cancelIndex(snapshot.workspace.id))}>본문 처리 중단</button></> : snapshot.indexing?.state === 'cancelled' ? <><span>본문 처리 중단됨</span><button onClick={() => void action(() => api.indexDocuments(snapshot.workspace.id))}>본문 처리 계속</button></> : snapshot.indexing?.failed ? `본문 처리 실패 ${snapshot.indexing.failed}개` : '배치 자동 저장'}</ApplicationStatus>
      </> : <>{problem && <p className="notice error" role="alert">{problem}</p>}<ApplicationHome spaces={spaces} busy={busy && !workspaces.length} primary={workspaces.length ? connect : <button className="primary" disabled={busy} onClick={() => void action(async () => accept(await api.connect()))}><LuFolderPlus />첫 폴더 연결하기</button>} secondary={cloudPicker} /></>}
    {writing && snapshot && draftRepository && <DraftStudio workspace={{ id: snapshot.workspace.id, name: snapshot.workspace.label, role: 'OWNER' }} repository={draftRepository} initialDraftId={initialDraftId} onAISettings={() => setAISettings(true)} onClose={() => setWriting(false)} />}
    {library && snapshot && <LocalDocumentLibrary workspaceId={snapshot.workspace.id} entries={snapshot.entries} disconnectedFiles={snapshot.disconnected_files} onClose={() => setLibrary(false)} onOpen={entry => entry.kind === 'directory' ? enter(entry) : inspect(entry)} onCreate={() => setNewFile(true)} />}
    {aiSettings && <AISettings repository={desktopAIRepository} onClose={() => setAISettings(false)} />}
    {textEntry && <LocalTextEditor entry={textEntry} onClose={() => setTextEntry(undefined)} />}
    {newFile && snapshot && <CreateEntryDialog kind="file" initialName="새 문서.md" onClose={() => setNewFile(false)} onSubmit={async name => { const parent = snapshot.entries.find(entry => entry.kind === 'directory' && entry.relative_path === directory); const create = () => api.createTextFile(snapshot.workspace.id, name, parent?.id); const entry = canvasCreate.current ? await canvasCreate.current(create, name) : await create(); setNewFile(false); setTextEntry(entry); }} />}
  </Shell>;
}
createRoot(document.getElementById('root')!).render(<App />);
