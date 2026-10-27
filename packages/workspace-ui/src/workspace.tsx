"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LuUpload, LuTrash2, LuPencil } from 'react-icons/lu';
import { ApplicationShell, ApplicationToolbar, ApplicationStatus, type ApplicationNavigation } from './application';
import { SyncControl, SyncReviewDialog } from './sync-control';
import { CreateEntryDialog } from './create-entry-dialog';
import { DocumentLibrary } from './document-library';
import { AISettings } from '../shared/ui/ai-settings';
import type { AIConnectionRepository } from '../shared/core/ai';
import { DocumentPreviewFrame } from '../shared/ui/document-preview-frame';
import { DraftStudio } from '../shared/writing/draft-studio';
import { ChatPanelView } from '../shared/chat/chat-panel';
import { TextEditor } from '../shared/ui/text-editor';
import type { WorkspaceRepository, WorkspaceConflict, SyncStatus } from '../../workspace-client/src/repository';
import { WorkspaceRuntimeProvider, type Entry, type Snapshot } from './runtime';
import { WorkspaceCanvas, type CreateCanvasFile } from './workspace-canvas';
import { WorkspaceDocumentPreview } from './document-preview';
import './workspace.css';
import type { WorkspaceRecovery } from '../../workspace-client/src/repository';

export function Workspace({ repository, navigation: appNavigation, aiRepository, onDelete, overlays }: { repository: WorkspaceRepository; navigation: ApplicationNavigation; aiRepository?: AIConnectionRepository; onDelete?: () => void; overlays?: import('react').ReactNode }) {
  const [settings, setSettings] = useState(false), [aiSettings, setAISettings] = useState(false);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null), [topInset, setTopInset] = useState(0);
  useLayoutEffect(() => { if (!overlay) return; const measure = () => setTopInset(Math.ceil(overlay.getBoundingClientRect().height)); const observer = new ResizeObserver(measure); measure(); observer.observe(overlay); return () => observer.disconnect(); }, [overlay]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [directory, setDirectory] = useState(''), [navigation, setNavigation] = useState(0);
  const [query, setQuery] = useState(''), [search, setSearch] = useState('');
  const [searchEntries, setSearchEntries] = useState<Entry[]>([]), [searchCursor, setSearchCursor] = useState<string>();
  const [files, setFiles] = useState(false), [drafts, setDrafts] = useState(false), [chat, setChat] = useState(false);
  const [selected, setSelected] = useState<Entry>(), [editing, setEditing] = useState<Entry>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SyncStatus>(repository.status());
  const [conflicts, setConflicts] = useState<WorkspaceConflict[]>(), [showConflicts, setShowConflicts] = useState(false);
  const [recovery, setRecovery] = useState<WorkspaceRecovery[]>([]);
  const [create, setCreate] = useState<'file' | 'folder' | 'rename' | 'trash'>(), [name, setName] = useState('');
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const flush = useRef<(() => Promise<boolean>) | undefined>(undefined), createFile = useRef<CreateCanvasFile | undefined>(undefined);
  const upload = useRef<HTMLInputElement>(null);
  const [canvasEpoch, setCanvasEpoch] = useState(0);
  const [references, setReferences] = useState<string[]>([]), [referenceSequence, setReferenceSequence] = useState(0);
  const loaded = useRef(false), mounted = useRef(true), loadEpoch = useRef(0);
  const editable = repository.role !== 'VIEWER' && status.state !== 'deleted';
  const rememberEntry = useCallback((entry: Entry) => setSnapshot(current => current ? { ...current, entries: [...current.entries.filter(item => item.id !== entry.id), entry] } : current), []);
  const rememberPositions = useCallback((_id: string, positions: { id: string; x: number; y: number }[]) => setSnapshot(current => current ? { ...current, entries: current.entries.map(item => ({ ...item, ...positions.find(position => position.id === item.id) })) } : current), []);
  const rememberView = useCallback((_id: string, directory: string, view: { x: number; y: number; zoom: number }) => setSnapshot(current => current ? { ...current, views: [...current.views.filter(item => item.directory !== directory), { ...view, directory }] } : current), []);
  const onFlushReady = useCallback((value: (() => Promise<boolean>) | undefined) => { flush.current = value; }, []);
  const onCreateFileReady = useCallback((value: CreateCanvasFile | undefined) => { createFile.current = value; }, []);
  const report = useCallback((value: string) => setError(value), []);
  const refresh = useCallback(async () => {
    const next = await repository.refresh();
    if (mounted.current) { setSnapshot(next); setStatus(repository.status()); setConflicts(await repository.conflicts()); setRecovery(await repository.recovery?.() || []); }
  }, [repository]);
  useEffect(() => {
    mounted.current = true;
    repository.load().then(async value => { if (mounted.current) { loaded.current = true; setSnapshot(value); setDirectory(value.spatial_focus || ''); setStatus(repository.status()); setConflicts(await repository.conflicts()); } }).catch(reason => { if (mounted.current) setError(reason.message); });
    const unsubscribe = repository.onChanged(() => { setStatus(repository.status()); if (loaded.current) void refresh().catch(reason => setError(reason.message)); });
    return () => { mounted.current = false; loaded.current = false; unsubscribe(); repository.dispose(); };
  }, [repository, refresh]);
  const hasSnapshot = !!snapshot;
  useEffect(() => {
    const epoch = ++loadEpoch.current;
    if (!hasSnapshot || !search) return;
    repository.searchEntries(search).then(page => { if (mounted.current && epoch === loadEpoch.current) { setSearchEntries(page.entries); setSearchCursor(page.cursor); } }).catch(reason => { if (epoch === loadEpoch.current) setError(reason.message); });
  }, [repository, directory, search, hasSnapshot, status.cursor]);
  const focus = useCallback((path: string) => setDirectory(path), []);
  const enter = useCallback((entry: Entry) => { setDirectory(entry.relative_path); setSearch(''); setQuery(''); setNavigation(value => value + 1); }, []);
  const inspect = useCallback((entry: Entry) => setSelected(entry), []);
  const textRepository = useMemo(() => editing ? repository.text(editing) : undefined, [repository, editing]);
  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError('');
    try { await action(); await refresh(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  async function page() {
    await run(async () => {
      if (!search || !searchCursor) return;
      const result = await repository.searchEntries(search, searchCursor);
      setSearchEntries(items => [...items, ...result.entries.filter(item => !items.some(previous => previous.id === item.id))]); setSearchCursor(result.cursor);
    });
  }
  async function submit(name: string) {
      if (!await (flush.current?.() ?? Promise.resolve(true))) throw new Error('캔버스 저장을 먼저 완료해 주세요.');
      if (create === 'file') { const action = () => repository.createText(name, directory); const entry = await (createFile.current ? createFile.current(action, name) : action()); rememberEntry(entry); setEditing(entry); }
      if (create === 'folder') rememberEntry(await repository.createFolder(name, directory));
      if (create === 'rename' && selected) { await repository.rename(selected, name); setSelected(undefined); }
      if (create === 'trash' && selected) { await repository.trash(selected); setSelected(undefined); }
      setCreate(undefined); setName(''); await refresh();
  }
  async function uploadFiles(values: FileList | null) {
    if (!values) return;
    await run(async () => { if (!await (flush.current?.() ?? Promise.resolve(true))) throw new Error('캔버스 저장을 완료해 주세요.'); for (const file of [...values]) rememberEntry(await repository.upload(file, directory)); });
    if (upload.current) upload.current.value = '';
  }
  const scene = useMemo(() => snapshot && search ? { ...snapshot, entries: searchEntries } : snapshot, [snapshot, search, searchEntries]);
  const menu = { available: !!snapshot, count: snapshot?.entries.length, active: files ? 'documents' as const : drafts ? 'writing' as const : 'canvas' as const, canvas: () => { setFiles(false); setSelected(undefined); }, documents: () => setFiles(true), writing: () => setDrafts(true), chat: () => setChat(!chat), chatOpen: chat, settings: () => setAISettings(true) };
  if (!snapshot || !scene) return <ApplicationShell navigation={appNavigation} menu={menu}><ApplicationToolbar name="워크스페이스" /><div className="center-state"><p role={error ? 'alert' : 'status'}>{error || '워크스페이스를 불러오는 중…'}</p></div></ApplicationShell>;
  return <WorkspaceRuntimeProvider runtime={repository}><ApplicationShell navigation={appNavigation} menu={menu}>
    <div className="workspace-body"><div className="canvas-area" aria-label="파일 캔버스" style={{ '--canvas-chrome-height': `${topInset}px` } as import('react').CSSProperties}>
      {status.state !== 'deleted' && <WorkspaceCanvas key={canvasEpoch} snapshot={scene} directory={directory} navigationSequence={navigation} onFocusDirectory={focus} query={search} limit={search ? searchEntries.length : 200} inspect={inspect} enter={enter} error={report} rememberView={rememberView} rememberPositions={rememberPositions} rememberEntry={rememberEntry} toolbarHost={editable ? toolbar : null} topInset={topInset} onFlushReady={onFlushReady} referenceIds={references} referenceSequence={referenceSequence} onClearReferences={() => setReferences([])} onCreateFileReady={onCreateFileReady} />}
      <div className="canvas-overlay" ref={setOverlay}>
        <ApplicationToolbar name={snapshot.workspace.label} directory={directory} onHome={() => { setDirectory(''); setNavigation(value => value + 1); }} query={query} onQuery={value => { setQuery(value); if (!value) setSearch(''); }} onSearch={() => { setSearch(query.trim()); setFiles(true); }} onRefresh={() => void run(refresh)} onSettings={() => setSettings(!settings)} onCreate={editable ? () => { setName('새 문서.md'); setCreate('file'); } : undefined} busy={busy} toolsRef={setToolbar} sync={<SyncControl state={{ phase: status.state, pending_count: status.pending, conflict_count: conflicts?.length, message: status.message }} actions={{ sync: async () => { if (!await (flush.current?.() ?? Promise.resolve(true))) throw new Error('캔버스 저장을 완료해 주세요.'); await repository.synchronize?.(); await refresh(); }, review: async () => { setShowConflicts(true); setConflicts(await repository.conflicts()); setRecovery(await repository.recovery?.() || []); }, remove: repository.role === 'OWNER' && onDelete ? async () => onDelete() : undefined }} />} />
        {error && <div className="notice error" role="alert">{error}<button onClick={() => setError('')}>닫기</button></div>}
        {settings && <section className="settings">{editable && <><button onClick={() => { setName(''); setCreate('folder'); }}>새 폴더</button><button aria-label="파일 업로드" onClick={() => upload.current?.click()}><LuUpload />파일 업로드</button></>}<p>공유 변경은 서버에 반영됩니다. 기기의 파일 적용 상태는 동기화 메뉴에서 확인하세요.</p>{onDelete && repository.role === 'OWNER' && <button className="danger" onClick={onDelete}>워크스페이스 삭제</button>}</section>}
        {snapshot.entries.length > 200 && !search && <button className="load-more" onClick={() => setFiles(true)}>전체 {snapshot.entries.length.toLocaleString('ko-KR')}개 · 문서 관리에서 탐색</button>}
      </div>
      <input type="file" multiple ref={upload} hidden onChange={event => void uploadFiles(event.target.files)} />
      {status.state === 'deleted' && <div className="center-state" role="alert">삭제된 워크스페이스입니다. 이 기기의 원본 파일은 보존됩니다.</div>}
    </div>
    <ChatPanelView workspace={{ id: snapshot.workspace.id, name: snapshot.workspace.label, role: repository.role }} repository={repository.chats} open={chat} onClose={() => setChat(false)} onAISettings={() => setAISettings(true)} onRevealSources={sources => { setReferences(snapshot.entries.filter(entry => sources.some(source => source.document_id === entry.document_id)).map(entry => entry.id)); setReferenceSequence(value => value + 1); }} onOpenSource={async source => { const entry = snapshot.entries.find(item => item.document_id === source.document_id); if (!entry) throw new Error('원본 연결이 없습니다. 인용 당시 내용은 출처에 보존되어 있습니다.'); inspect(entry); }} />
    </div>
    <ApplicationStatus message={status.state === 'offline' ? '연결 확인 필요 · 변경 내용 보존됨' : status.state === 'pending' ? '서버 반영 대기' : '변경 사항 자동 반영'} location={snapshot.workspace.label} />
    {files && <DocumentLibrary entries={search ? searchEntries : snapshot.entries} hasMore={!!search && !!searchCursor} onNext={page} onClose={() => setFiles(false)} onOpen={entry => entry.kind === 'directory' ? enter(entry) : inspect(entry)} onCreate={editable ? () => { setName('새 문서.md'); setCreate('file'); } : undefined} actions={editable ? entry => <><button className="icon-button" aria-label={`${entry.name} 이름 변경`} onClick={() => { setSelected(entry); setName(entry.name); setCreate('rename'); setFiles(false); }}><LuPencil /></button><button className="icon-button" aria-label={`${entry.name} 휴지통으로 이동`} onClick={() => { setSelected(entry); setCreate('trash'); setFiles(false); }}><LuTrash2 /></button></> : undefined} />}
    {selected && !create && !editing && <WorkspaceDocumentPreview entry={selected} repository={repository} onClose={() => setSelected(undefined)} onEdit={() => setEditing(selected)} />}
    {editing && textRepository && <TextEditor repository={textRepository} onClose={() => { setEditing(undefined); setSelected(undefined); void refresh(); }} />}
    {drafts && <DraftStudio workspace={{ id: snapshot.workspace.id, name: snapshot.workspace.label, role: repository.role }} repository={repository.drafts} onAISettings={() => setAISettings(true)} onClose={() => setDrafts(false)} />}
    {aiSettings && aiRepository && <AISettings repository={aiRepository} onClose={() => setAISettings(false)} />}
    {create && create !== 'trash' && <CreateEntryDialog key={create} kind={create} initialName={name} onClose={() => setCreate(undefined)} onSubmit={submit} />}
    {create === 'trash' && <DocumentPreviewFrame className="new-text-file" labelledBy="application-trash-title" onClose={() => setCreate(undefined)}><form onSubmit={event => { event.preventDefault(); void run(() => submit('')); }}><h2 id="application-trash-title">휴지통으로 이동</h2><p>{selected?.name}을 워크스페이스에서 삭제할까요? 이미 수정된 기기 원본은 보호됩니다.</p><button type="button" onClick={() => setCreate(undefined)}>취소</button><button className="primary" disabled={busy}>확인</button></form></DocumentPreviewFrame>}
    {showConflicts && <SyncReviewDialog conflicts={conflicts} recovery={recovery} error={error} busy={busy} onClose={() => setShowConflicts(false)} onResolve={(conflict, choice) => void run(async () => { await repository.resolveConflict(conflict.id, choice, conflict.base_revisions); setConflicts(await repository.conflicts()); setCanvasEpoch(value => value + 1); })} onExport={id => void run(async () => { await repository.exportRecovery?.(id); })} onOriginal={id => void run(async () => { await repository.downloadRecoveryOriginal?.(id); })} />}
    {overlays}
  </ApplicationShell></WorkspaceRuntimeProvider>;
}
