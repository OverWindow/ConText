"use client";
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { LuArrowRight, LuBookOpen, LuEye, LuFolderOpen, LuX } from 'react-icons/lu';
import { sampleData } from '../assets/harulab-sample';
import { ApplicationShell, ApplicationToolbar, ApplicationStatus, type ApplicationNavigation } from './application';
import { WorkspaceRuntimeProvider, type WorkspaceRuntime, type Entry, type Snapshot } from './runtime';
import { WorkspaceCanvas } from './workspace-canvas';
import { DocumentLibrary } from './document-library';
import { DocumentPreviewFrame } from '../shared/ui/document-preview-frame';
import { DocumentBlocks } from '../shared/ui/document-blocks';
import { fileSize } from '../shared/ui/document-paper';
import type { CanvasElement, CanvasRelation } from '../shared/core/canvas';
import './workspace.css';
import './sample-workspace.css';
const noop = () => {};
const noChange = async (): Promise<never> => { throw new Error('샘플은 읽기 전용입니다. 내 워크스페이스에서 작업해 주세요.'); };
const entryByPath = new Map(sampleData.entries.map(entry => [entry.relative_path, entry]));
const documents = new Map(sampleData.documents.map(document => [document.entry_id, document]));
const focus = '02_제품기획';
const links: [string, string][] = [
  ['02_제품기획/제품요구사항_v1.2.md', '02_제품기획/API명세.json'],
  ['02_제품기획/제품요구사항_v1.2.md', '02_제품기획/데이터사전.md'],
  ['02_제품기획/제품요구사항_v1.2.md', '02_제품기획/출시체크리스트.csv'],
  ['01_회사소개/회사와팀.md', '01_회사소개/회사소개.pdf'],
];
function runtime(): WorkspaceRuntime {
  return {
    capabilities: { nativeFiles: false, label: '샘플', summarize: false, canEdit: false },
    async canvasSnapshot(_id, directory) {
      const relations: (CanvasRelation & { revision: number })[] = links.flatMap(([from, to], index) => {
        const source = entryByPath.get(from), target = entryByPath.get(to);
        return source && target && source.parent_path === directory ? [{ id: `sample-link-${index}`, source_document_id: source.id, target_document_id: target.id, relation_type: 'REFERENCE' as const, source_handle: 'right', target_handle: 'left', revision: 1 }] : [];
      });
      const elements: (CanvasElement & { revision: number })[] = directory === focus ? [{ id: 'sample-guide-note', kind: 'text', text: '모아오더 출시 준비\n요구사항 → API·데이터사전·출시 점검표\n파일을 두 번 클릭해 내용을 살펴보세요.', x: 510, y: 335, width: 330, height: 180, color: 'violet', font_size: 20, revision: 1 }] : [];
      return { elements, relations };
    },
    putCanvasItem: noChange, removeCanvasItem: noChange, savePositions: noChange,
    moveFileToFolder: noChange, copyFile: noChange, summarizeSelection: noChange,
    async saveView() {},
    async preview(_id, entryId) { const document = documents.get(entryId); return document?.image_url ? { kind: 'image', url: document.image_url } : { kind: 'unsupported' }; },
    onChanged: () => noop,
  };
}
export function SampleWorkspace({ navigation, onStart = navigation.onHome }: { navigation: ApplicationNavigation; onStart?: () => void }) {
  const api = useMemo(runtime, []);
  const snapshot = useMemo<Snapshot>(() => {
    const order = ['제품요구사항_v1.2.md', 'API명세.json', '데이터사전.md', '출시체크리스트.csv', '화면설계_모바일재고.png', '제품요구사항_v1.2 copy.md'];
    const entries = sampleData.entries.map(entry => ({ ...entry })).sort((a, b) => a.parent_path === focus && b.parent_path === focus ? order.indexOf(a.name) - order.indexOf(b.name) : 0);
    return { workspace: { id: sampleData.workspace_id, root: '기본 샘플 · 읽기 전용', label: sampleData.name, show_hidden: 0, include_generated: 0, scanned_at: null }, entries, disconnected_files: [], spatial_focus: focus, views: [], status: 'ready', warnings: [] };
  }, []);
  const [directory, setDirectory] = useState(focus), [sequence, setSequence] = useState(0), [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Entry>(), [library, setLibrary] = useState(false), [problem, setProblem] = useState('');
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null), [topInset, setTopInset] = useState(0);
  useLayoutEffect(() => { if (!overlay) return; const measure = () => setTopInset(Math.ceil(overlay.getBoundingClientRect().height)); const observer = new ResizeObserver(measure); measure(); observer.observe(overlay); return () => observer.disconnect(); }, [overlay]);
  const inspect = useCallback((entry: Entry) => setSelected(entry), []);
  const enter = useCallback((entry: Entry) => { if (entry.kind === 'directory') { setDirectory(entry.relative_path); setSequence(value => value + 1); setQuery(''); } else setSelected(entry); }, []);
  const document = selected && documents.get(selected.id);
  const menu = { available: true, preview: true, count: sampleData.documents.length, active: library ? 'documents' as const : 'canvas' as const, canvas: () => { setLibrary(false); setSelected(undefined); }, documents: () => setLibrary(true), writing: noop, chat: noop, settings: noop };
  return <div className="sample-workspace" data-sample-workspace="harulab"><WorkspaceRuntimeProvider runtime={api}><ApplicationShell navigation={navigation} menu={menu}>
    <div className="workspace-body"><div className="canvas-area" aria-label="샘플 파일 캔버스" style={{ '--canvas-chrome-height': `${topInset}px` } as import('react').CSSProperties}>
      <WorkspaceCanvas key={query ? 'sample-search' : 'sample-folder'} snapshot={snapshot} directory={directory} navigationSequence={sequence} onFocusDirectory={setDirectory} query={query} limit={200} inspect={inspect} enter={enter} error={setProblem} rememberView={noop} rememberPositions={noop} rememberEntry={noop} toolbarHost={null} topInset={topInset} onFlushReady={noop} referenceIds={[]} referenceSequence={0} onClearReferences={noop} onCreateFileReady={noop} />
      <div className="canvas-overlay" ref={setOverlay}><ApplicationToolbar name={sampleData.name} directory={directory} onHome={() => { setDirectory(''); setSequence(value => value + 1); setQuery(''); }} query={query} onQuery={setQuery} />
        <div className="sample-notice" role="region" aria-label="샘플 프리뷰 안내"><span><LuEye /><strong>샘플 프리뷰</strong><span>가상 스타트업의 자료 {sampleData.documents.length}개를 자유롭게 살펴보세요.</span></span><button className="secondary" onClick={onStart}>내 워크스페이스로 <LuArrowRight /></button></div>
        {problem && <p role="alert" className="notice error">{problem}</p>}
      </div>
      {query && !sampleData.entries.some(entry => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <div className="canvas-empty"><LuFolderOpen /><h2>일치하는 샘플 파일이 없습니다</h2></div>}
    </div></div>
    <ApplicationStatus message="읽기 전용 샘플" location="파일을 두 번 클릭하면 내용을 볼 수 있습니다.">개인 자료와 별도로 제공됩니다</ApplicationStatus>
    {library && <DocumentLibrary entries={snapshot.entries} onClose={() => setLibrary(false)} onOpen={enter} />}
    {selected && document && <DocumentPreviewFrame className="sample-reader" onClose={() => setSelected(undefined)}><header className="preview-heading"><LuBookOpen /><div><p className="eyebrow">{selected.extension.slice(1).toUpperCase()} · 샘플 미리보기</p><h2 id="preview-title">{selected.name}</h2><p className="muted">{selected.relative_path} · {fileSize(selected.size)}</p></div><button className="icon-button" aria-label="미리보기 닫기" onClick={() => setSelected(undefined)}><LuX /></button></header><div className="panel-scroll sample-reader-content">
      {document.image_url ? <img src={document.image_url} alt={selected.name} /> : document.content ? <DocumentBlocks blocks={document.content.blocks} /> : <p className="muted">내용이 없는 빈 샘플 파일입니다.</p>}
    </div><footer className="preview-footer"><span>하루랩과 모아오더의 회사·고객·수치는 모두 가상입니다.</span></footer></DocumentPreviewFrame>}
  </ApplicationShell></WorkspaceRuntimeProvider></div>;
}
