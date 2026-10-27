import { useEffect, useState } from 'react';
import { LuDownload } from 'react-icons/lu';
import { DocumentPreviewLayout } from '@context/workspace-ui/document-preview-layout';
import { DocumentBlocks } from '@context/workspace-ui/shared/ui/document-blocks';
import { VersionTimelineView } from '@context/workspace-ui/shared/ui/version-timeline';
import { DocumentDiff } from '@context/workspace-ui/shared/ui/document-diff';
import type { LocalDocument } from '@context/workspace-ui/shared/core/documents';
import type { VersionDocument } from '@context/workspace-ui/shared/core/versions';
import type { Diff } from '@context/workspace-ui/shared/core/diff';
import { LocalDocumentExport } from './file-derivatives';
import type { Entry } from './contracts';
import { LocalChangeSummary } from './change-summary';
import { LocalVersionLinks } from './version-links';
import { FileActions } from './file-actions';

export function LocalDocumentPreview({ entry, onClose, onEdit, onEditText, initialVersionId, initialBlockId }: { entry: Entry; onClose: () => void; onEdit: (id: string) => void; onEditText: () => void; initialVersionId?: string; initialBlockId?: number }) {
  const [document, setDocument] = useState<VersionDocument>();
  const [selected, setSelected] = useState<LocalDocument>();
  const [tab, setTab] = useState<'preview' | 'history' | 'compare' | 'export'>('preview');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(''), [right, setRight] = useState('');
  const [diff, setDiff] = useState<Diff>();
  const api = window.contextDesktop;
  useEffect(() => {
    let active = true; setError('');
    (initialVersionId ? Promise.resolve(undefined) : api.openDocument(entry.workspace_id, entry.id)).then(async value => {
      const metadata = await api.getDocument(entry.workspace_id, entry.id);
      if (!active) return;
      const selectedVersion = initialVersionId ? await api.getDocumentVersion(entry.workspace_id, metadata.id, initialVersionId) : value;
      if (!active) return;
      setSelected(selectedVersion); setDocument(metadata); setLeft(metadata.versions.at(-2)?.id || ''); setRight(metadata.versions.at(-1)?.id || '');
    }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [api, entry.id, entry.workspace_id, entry.mtime, entry.size, initialVersionId]);
  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError('');
    try { await action(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  return <DocumentPreviewLayout name={entry.name} extension={entry.extension} detail={`${entry.disconnected ? '연결 해제 · 저장된 스냅샷' : entry.cached_only ? '원본 파일 없음 · 저장된 스냅샷' : '로컬 원본'} · 수정 이력 ${selected?.version_number || 1}`} tab={tab} onTab={setTab} versionCount={document?.versions.length || 0} canCompare={!!document && document.versions.length >= 2} onClose={onClose} actions={!entry.cached_only && <FileActions entry={entry} onDeleted={onClose} />} footer={<><span>원본에서 추출한 텍스트입니다.</span>{['.txt', '.md'].includes(entry.extension) && <button disabled={busy || entry.cached_only} onClick={onEditText}>텍스트 편집</button>}<button disabled={busy || entry.cached_only} onClick={() => void run(async () => api.open(entry.workspace_id, entry.id))}>원본 열기</button><button disabled={busy || !selected} onClick={() => void run(async () => { const draft = await api.importDraft(entry.workspace_id, entry.id, crypto.randomUUID(), selected!.version_id); onEdit(draft.id); })}>새 초안으로 편집</button>{selected && document && <button disabled={busy} onClick={() => void run(async () => api.exportDocumentVersion(entry.workspace_id, document.id, selected.version_id, 'original'))}><LuDownload /> 원본 저장</button>}</>}>
    <div className="panel-scroll preview-body">{error && <p role="alert" className="error">{error}</p>}{!selected && !error && <p role="status">문서를 읽고 있습니다…</p>}
      {tab === 'preview' && selected && <>{selected.normalized.warnings.map(warning => <p className="notice" key={warning}>{warning}</p>)}<DocumentBlocks blocks={selected.normalized.blocks} initialBlockId={selected.version_id === initialVersionId ? initialBlockId : undefined} /></>}
      {tab === 'history' && document && <><p className="muted">현재 수정 이력 지정은 검색 기준을 바꿉니다. 원본 복원은 확인 후 디스크 파일을 교체합니다.</p>{document.current_is_pinned && <button onClick={() => void run(async () => { await api.setCurrentVersion(entry.workspace_id, document.id, null, document.revision); setDocument(await api.getDocument(entry.workspace_id, entry.id)); })}>원본 파일을 현재 이력으로</button>}<VersionTimelineView versions={document.versions} currentId={document.current_version_id} selectedId={selected?.version_id || ''} editable onRestore={entry.cached_only ? undefined : async version => { const restored = await api.restoreDocumentVersion(entry.workspace_id, document.id, version.id); if (restored) { setSelected(restored); setDocument(await api.getDocument(entry.workspace_id, entry.id)); } }} onSelect={id => void run(async () => { setSelected(await api.getDocumentVersion(entry.workspace_id, document.id, id)); setTab('preview'); })} onAction={async (version, action) => {
        if (action === 'download') await api.exportDocumentVersion(entry.workspace_id, document.id, version.id, 'original');
        else if (action === 'current') { await api.setCurrentVersion(entry.workspace_id, document.id, version.id, document.revision); setDocument(await api.getDocument(entry.workspace_id, entry.id)); }
      }} />{selected && <LocalVersionLinks workspaceId={entry.workspace_id} document={document} versionId={selected.version_id} onChange={async () => { const next = await api.getDocument(entry.workspace_id, entry.id); setDocument(next); setLeft(next.versions.at(-2)?.id || ''); setRight(next.versions.at(-1)?.id || ''); }} />}</>}
      {tab === 'compare' && document && <section className="version-comparison" aria-label="수정 이력 비교"><form className="compare-form" onSubmit={event => { event.preventDefault(); void run(async () => setDiff(await api.compareDocumentVersions(entry.workspace_id, document.id, left, right))); }}><label>이전 수정 이력<select aria-label="이전 수정 이력" value={left} onChange={event => { setLeft(event.target.value); setDiff(undefined); }}>{document.versions.map(version => <option key={version.id} value={version.id}>수정 이력 {version.version_number}</option>)}</select></label><label>비교할 수정 이력<select aria-label="비교할 수정 이력" value={right} onChange={event => { setRight(event.target.value); setDiff(undefined); }}>{document.versions.map(version => <option key={version.id} value={version.id}>수정 이력 {version.version_number}</option>)}</select></label><button className="primary" disabled={busy || !left || !right || left === right}>비교하기</button></form>{diff && <><LocalChangeSummary key={`${left}:${right}`} workspaceId={entry.workspace_id} documentId={document.id} left={left} right={right} scope={`${document.id}:${left}:${right}`} /><DocumentDiff diff={diff} scope={`${document.id}:${left}:${right}`} /></>}</section>}
      {tab === 'export' && selected && document && <LocalDocumentExport key={selected.version_id} workspaceId={entry.workspace_id} documentId={document.id} versionId={selected.version_id} versionNumber={selected.version_number} />}
    </div>

  </DocumentPreviewLayout>;
}
