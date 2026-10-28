"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LuArrowRight, LuBookOpen, LuEye, LuFolderOpen, LuPencil, LuX } from 'react-icons/lu';
import { sampleData } from '../assets/harulab-sample';
import { ApplicationShell, ApplicationToolbar, ApplicationStatus, type ApplicationNavigation } from './application';
import { WorkspaceRuntimeProvider, type Entry } from './runtime';
import { WorkspaceCanvas } from './workspace-canvas';
import { DocumentLibrary } from './document-library';
import { DocumentPreviewFrame } from '../shared/ui/document-preview-frame';
import { DocumentBlocks } from '../shared/ui/document-blocks';
import { fileSize } from '../shared/ui/document-paper';
import { createSampleStore } from './sample-store';
import { SampleDocumentEditor } from './sample-document-editor';
import { CreateEntryDialog } from './create-entry-dialog';
import type { CreateCanvasFile } from './workspace-canvas';
import { createSampleRepositories, type SampleAIAdapter } from './sample-ai';
import { DraftStudio } from '../shared/writing/draft-studio';
import { ChatPanelView } from '../shared/chat/chat-panel';
import { AISettings } from '../shared/ui/ai-settings';
import type { DocumentReference } from '../shared/core/chat';
import './workspace.css';
import './sample-workspace.css';
const noop = () => {};
const focus = '02_제품기획';
export function SampleWorkspace({ navigation, ai, onStart = navigation.onHome }: { navigation: ApplicationNavigation; ai: SampleAIAdapter; onStart?: () => void }) {
  const store = useMemo(() => createSampleStore(sampleData), []), api = store.api;
  const [loaded, setLoaded] = useState(false);
  const [snapshot, setSnapshot] = useState(store.snapshot), [epoch, setEpoch] = useState(0), [reset, setReset] = useState(false), [resetting, setResetting] = useState(false);
  const [editingDocument, setEditingDocument] = useState(false), [newFile, setNewFile] = useState(false), [renaming, setRenaming] = useState<Entry>();
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const flush = useRef<(() => Promise<boolean>) | undefined>(undefined), createFile = useRef<CreateCanvasFile | undefined>(undefined);
  const registerFlush = useCallback((value: (() => Promise<boolean>) | undefined) => { flush.current = value; }, []);
  const registerCreate = useCallback((value: CreateCanvasFile | undefined) => { createFile.current = value; }, []);
  const repositories = useMemo(() => createSampleRepositories(store.data, ai), [store, ai]);
  const [writing, setWriting] = useState(false), [chatOpen, setChatOpen] = useState(false), [settings, setSettings] = useState(false);
  const [references, setReferences] = useState<DocumentReference[]>([]);
  const [referenceSequence, setReferenceSequence] = useState(0);
  const reveal = useCallback((items: DocumentReference[]) => { setReferences(items); setReferenceSequence(value => value + 1); }, []);
  const [directory, setDirectory] = useState(focus), [sequence, setSequence] = useState(0), [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>(), [selectedRevision, setSelectedRevision] = useState<number>(), [library, setLibrary] = useState(false), [problem, setProblem] = useState('');
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null), [topInset, setTopInset] = useState(0);
  useLayoutEffect(() => { if (!overlay) return; const measure = () => setTopInset(Math.ceil(overlay.getBoundingClientRect().height)); const observer = new ResizeObserver(measure); measure(); observer.observe(overlay); return () => observer.disconnect(); }, [overlay]);
  const inspect = useCallback((entry: Entry) => { setSelectedId(entry.id); setSelectedRevision(undefined); }, []);
  const enter = useCallback((entry: Entry) => { if (entry.kind === 'directory') { setDirectory(entry.relative_path); setSequence(value => value + 1); setQuery(''); } else inspect(entry); }, [inspect]);
  useEffect(() => {
    const unsubscribe = store.subscribe(() => setSnapshot(store.snapshot()));
    const load = () => { try { store.load(); setLoaded(true); } catch (reason) { setProblem((reason as Error).message); } };
    load();
    const changed = (event: StorageEvent) => { if (event.key === `context:sample-workspace:v1:${sampleData.workspace_id}`) load(); };
    window.addEventListener('storage', changed);
    return () => { unsubscribe(); window.removeEventListener('storage', changed); };
  }, [store]);
  const selected = snapshot.entries.find(entry => entry.id === selectedId);
  const document = selected && store.document(selected.id, selectedRevision);
  const closePreview = () => { setSelectedId(undefined); setSelectedRevision(undefined); };
  const leave = async (action: () => void) => { if (!flush.current || await flush.current()) action(); };
  const renameDialog = renaming && <CreateEntryDialog kind="rename" initialName={renaming.name} onClose={() => setRenaming(undefined)} onSubmit={async name => { const before = renaming.relative_path; await store.rename(renaming.id, name); const after = store.data.entries.find(entry => entry.id === renaming.id)!.relative_path; if (directory === before || directory.startsWith(before + '/')) { setDirectory(after + directory.slice(before.length)); setSequence(value => value + 1); } setRenaming(undefined); }} />;
  const menu = { available: true, count: snapshot.entries.filter(entry => entry.kind === 'file').length, active: writing ? 'writing' as const : library ? 'documents' as const : 'canvas' as const, canvas: () => { setLibrary(false); closePreview(); }, documents: () => setLibrary(true), writing: () => setWriting(true), chat: () => setChatOpen(value => !value), chatOpen, settings: () => setSettings(true) };
  return <div className="sample-workspace" data-sample-workspace="harulab"><WorkspaceRuntimeProvider runtime={api}><ApplicationShell navigation={{ ...navigation, onHome: () => void leave(navigation.onHome) }} menu={menu}>
    <div className="workspace-body"><div className="canvas-area" aria-label="샘플 파일 캔버스" style={{ '--canvas-chrome-height': `${topInset}px` } as import('react').CSSProperties}>
      {loaded && <WorkspaceCanvas key={`${epoch}:${query ? 'sample-search' : 'sample-folder'}`} snapshot={snapshot} directory={directory} navigationSequence={sequence} onFocusDirectory={setDirectory} query={query} limit={200} inspect={inspect} enter={enter} error={setProblem} rememberView={noop} rememberPositions={noop} rememberEntry={noop} toolbarHost={toolbarHost} topInset={topInset} onFlushReady={registerFlush} referenceIds={references.map(item => item.document_id)} referenceSequence={referenceSequence} onClearReferences={() => reveal([])} onCreateFileReady={registerCreate} />}
      <div className="canvas-overlay" ref={setOverlay}><ApplicationToolbar name={sampleData.name} directory={directory} onHome={() => { setDirectory(''); setSequence(value => value + 1); setQuery(''); }} query={query} onQuery={setQuery} toolsRef={setToolbarHost} onCreate={() => setNewFile(true)} />
        <div className="sample-notice" role="region" aria-label="샘플 프리뷰 안내"><span><LuEye /><strong>하루랩 샘플</strong><span>샘플 자료 {store.data.documents.length}개 · 파일·본문·캔버스를 자유롭게 수정하세요. 변경 내용은 이 기기에 저장됩니다.</span></span><button className="secondary" onClick={() => setReset(true)}>샘플 초기화</button><button className="secondary" onClick={() => void leave(onStart)}>내 워크스페이스로 <LuArrowRight /></button></div>
        {problem && <p role="alert" className="notice error">{problem}</p>}
      </div>
      {query && !snapshot.entries.some(entry => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <div className="canvas-empty"><LuFolderOpen /><h2>일치하는 샘플 파일이 없습니다</h2></div>}
    </div>
    <ChatPanelView workspace={{ id: sampleData.workspace_id, name: sampleData.name, role: 'OWNER' }} repository={repositories.chat} open={chatOpen} onClose={() => setChatOpen(false)} onRevealSources={reveal} onOpenSource={async source => { if (!store.document(source.document_id, source.version_number)) throw new Error('인용한 수정 이력을 찾을 수 없습니다.'); setSelectedId(source.document_id); setSelectedRevision(source.version_number); }} onAISettings={() => setSettings(true)} />
    </div>
    <ApplicationStatus message="편집 가능한 샘플" location="AI 문서와 대화는 이 기기에 저장됩니다.">AI 연결 설정은 내 워크스페이스와 함께 사용합니다</ApplicationStatus>
    {writing && <DraftStudio workspace={{ id: sampleData.workspace_id, name: sampleData.name, role: 'OWNER' }} repository={repositories.drafts} onClose={() => setWriting(false)} onAISettings={() => setSettings(true)} exportFormats={ai.export ? ['docx', 'hwpx'] : ['md', 'txt']} />}
    {settings && <AISettings repository={ai.connection} onClose={() => setSettings(false)} onSignIn={ai.signIn} />}
    {library && <DocumentLibrary entries={snapshot.entries} onClose={() => setLibrary(false)} onOpen={enter} onCreate={() => setNewFile(true)} actions={entry => <button className="icon-button" onClick={() => setRenaming(entry)} aria-label={`${entry.name} 이름 변경`}><LuPencil /></button>} />}
    {selected && document && <DocumentPreviewFrame className="sample-reader" onClose={closePreview}><header className="preview-heading"><LuBookOpen /><div><p className="eyebrow">{selected.extension.slice(1).toUpperCase()} · 샘플 미리보기</p><h2 id="preview-title">{selected.name}{selectedRevision && selectedRevision !== (selected.version_number || 1) ? ` · 인용 이력 ${selectedRevision}` : ''}</h2><p className="muted">{selected.relative_path} · {fileSize(selected.size)}</p></div><button onClick={() => setRenaming(selected)}>이름 변경</button>{!document.image_url && (selectedRevision === undefined || selectedRevision === (selected.version_number || 1)) && <button className="primary" onClick={() => setEditingDocument(true)}>본문 수정</button>}<button className="icon-button" aria-label="미리보기 닫기" onClick={closePreview}><LuX /></button></header><div className="panel-scroll sample-reader-content">
      {document.image_url ? <img src={document.image_url} alt={selected.name} /> : document.content ? <DocumentBlocks blocks={document.content.blocks} /> : <p className="muted">내용이 없는 빈 샘플 파일입니다.</p>}
    </div><footer className="preview-footer"><span>하루랩과 모아오더의 회사·고객·수치는 모두 가상입니다.</span></footer></DocumentPreviewFrame>}
    {editingDocument && selected && document && <SampleDocumentEditor key={`${selected.id}:${selected.version_number || 1}`} name={selected.name} content={document.content || { schema_version: 1, title: selected.name, blocks: [], warnings: [], page_count: null }} onSave={content => store.saveDocument(selected.id, selected.version_number || 1, content)} onClose={() => setEditingDocument(false)} />}
    {newFile && <CreateEntryDialog kind="file" initialName="새 문서.md" onClose={() => setNewFile(false)} onSubmit={async name => { const created = createFile.current ? await createFile.current(() => store.createFile(name, directory), name) : await store.createFile(name, directory); setNewFile(false); if (created) { inspect(created); setEditingDocument(true); } }} />}
    {renameDialog}
    {reset && <DocumentPreviewFrame className="sample-reset" labelledBy="sample-reset-title" onClose={() => { if (!resetting) setReset(false); }}><h2 id="sample-reset-title">샘플을 처음 상태로 되돌릴까요?</h2><p>샘플의 파일·본문·배치·메모·연결을 초기화합니다. 추가한 샘플 파일은 제거됩니다. AI로 작성한 문서와 대화, AI 연결 설정은 유지됩니다.</p><button disabled={resetting} onClick={() => setReset(false)}>취소</button><button className="primary" disabled={resetting} onClick={async () => { setResetting(true); try { if (flush.current && !await flush.current()) return; await store.reset(); closePreview(); setDirectory(focus); setQuery(''); reveal([]); setEpoch(value => value + 1); setReset(false); } catch (reason) { setProblem((reason as Error).message); } finally { setResetting(false); } }}>초기화 확인</button></DocumentPreviewFrame>}
  </ApplicationShell></WorkspaceRuntimeProvider></div>;
}
