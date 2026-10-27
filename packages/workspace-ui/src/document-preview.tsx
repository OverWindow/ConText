"use client";
/* eslint-disable @next/next/no-img-element -- The portable native/browser renderer uses private immutable URLs without a Next image proxy. */
import { useEffect, useState } from 'react';
import { DocumentPreviewLayout, type DocumentPreviewTab } from './document-preview-layout';
import { LuDownload } from 'react-icons/lu';
import { DocumentBlocks } from '../shared/ui/document-blocks';
import { VersionTimelineView } from '../shared/ui/version-timeline';
import type { VersionDocument } from '../shared/core/versions';
import type { LocalDocument } from '../shared/core/documents';
import type { WorkspaceRepository } from '../../workspace-client/src/repository';
import type { Entry } from './runtime';
import type { SourceSnapshot } from '../../contracts/src/index';

export function WorkspaceDocumentPreview({ entry, repository, onClose, onEdit }: { entry: Entry; repository: WorkspaceRepository; onClose: () => void; onEdit: () => void }) {
  const [document, setDocument] = useState<VersionDocument>();
  const [version, setVersion] = useState('');
  const [content, setContent] = useState<LocalDocument>();
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<DocumentPreviewTab>('preview');
  const [left, setLeft] = useState(''), [right, setRight] = useState('');
  const [comparison, setComparison] = useState<[LocalDocument, LocalDocument]>();
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<SourceSnapshot[]>([]);
  const [converting, setConverting] = useState('');
  useEffect(() => {
    let active = true;
    repository.document(entry).then(value => { if (active) { setDocument(value); setVersion(value.file_version_id || value.current_version_id || value.versions.at(-1)?.id || ''); setLeft(value.versions.at(-2)?.id || ''); setRight(value.versions.at(-1)?.id || ''); } }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [repository, entry]);
  useEffect(() => {
    if (!version) return;
    let active = true;
    repository.documentVersion(entry, version).then(value => { if (active) { setContent(value); setError(''); } }).catch(reason => { if (active) { setContent(undefined); setError(reason.message); } });
    repository.preview(entry.workspace_id, entry.id).then(value => { if (active && value.kind === 'image') setImage(value.url); }).catch(() => {});
    repository.versionSources(entry, version).then(value => { if (active) setSources(value); }).catch(() => {});
    return () => { active = false; };
  }, [repository, entry, version]);
  async function select(id: string | null) {
    setError('');
    try { await repository.selectReference(entry, id); setDocument(await repository.document(entry)); }
    catch (reason) { setError((reason as Error).message); }
  }
  return <DocumentPreviewLayout name={entry.name} extension={entry.extension} detail={`공유 원본 · 수정 이력 ${content?.version_number || 1}`} tab={tab} onTab={setTab} versionCount={document?.versions.length || 0} canCompare={!!document && document.versions.length >= 2} onClose={onClose} footer={<><span>원본에서 추출한 텍스트입니다.</span>{repository.role !== 'VIEWER' && ['.txt', '.md'].includes(entry.extension) && <button onClick={onEdit}>텍스트 편집</button>}<button disabled={!version} onClick={() => void repository.download(entry, version).catch(reason => setError(reason.message))}><LuDownload />원본 저장</button></>}>
    <div className="panel-scroll preview-body">
      {error && <p className="error" role="alert">{error}</p>}
      {tab === 'preview' && <>{content?.normalized.warnings.map(warning => <p className="notice" key={warning}>{warning}</p>)}{content?.normalized.blocks.length ? <DocumentBlocks blocks={content.normalized.blocks} /> : image ? <img src={image} alt={entry.name} /> : <p className="muted">이 형식은 원본을 다운로드해 열 수 있습니다. 문서 분석이 진행 중이면 잠시 후 다시 열어 주세요.</p>}{!!sources.length && <section aria-label="이 수정 이력의 출처"><h3>출처</h3>{sources.map(source => <details key={source.id}><summary>{source.label} · {({ document: '문서', note: '메모', chat: '대화', draft: '초안' })[source.kind]}</summary><blockquote>{source.quote || '원본 이력 참조'}</blockquote></details>)}</section>}</>}
      {tab === 'history' && document && <><p className="muted">현재 수정 이력 지정은 인용 기준을 바꿉니다. 원본 복원은 선택한 내용을 새 수정 이력으로 저장합니다.</p><VersionTimelineView versions={document.versions} currentId={document.current_version_id} selectedId={version} onSelect={id => { setVersion(id); setTab('preview'); }} editable={repository.role !== 'VIEWER'} onAction={async (item, action) => { if (action === 'current') await select(item.id); else await repository.download(entry, item.id); }} onRestore={repository.role !== 'VIEWER' ? async item => { await repository.restoreVersion(entry, item.id); const next = await repository.document(entry); setDocument(next); setVersion(next.file_version_id || item.id); } : undefined} /></>}
      {tab === 'compare' && document && <section className="version-comparison" aria-label="수정 이력 비교"><form className="compare-form" onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); void Promise.all([repository.documentVersion(entry, left), repository.documentVersion(entry, right)]).then(setComparison).catch(reason => setError(reason.message)).finally(() => setBusy(false)); }}><label>이전 수정 이력<select aria-label="이전 수정 이력" value={left} onChange={event => { setLeft(event.target.value); setComparison(undefined); }}>{document.versions.map(item => <option key={item.id} value={item.id}>수정 이력 {item.version_number}</option>)}</select></label><label>비교할 수정 이력<select aria-label="비교할 수정 이력" value={right} onChange={event => { setRight(event.target.value); setComparison(undefined); }}>{document.versions.map(item => <option key={item.id} value={item.id}>수정 이력 {item.version_number}</option>)}</select></label><button className="primary" disabled={busy || !left || !right || left === right}>{busy ? '불러오는 중…' : '비교하기'}</button></form>{comparison && <div className="unified-conflict-sides">{comparison.map((item, index) => <section key={index}><h3>수정 이력 {item.version_number}</h3><DocumentBlocks blocks={item.normalized.blocks} /></section>)}</div>}</section>}
      {tab === 'export' && <section className="unified-preview-sources" aria-label="문서 변환"><h3>내보내기</h3><button disabled={!version} onClick={() => void repository.download(entry, version).catch(reason => setError(reason.message))}><LuDownload />원본 저장</button>{['.txt', '.md', '.pdf', '.docx', '.hwpx'].includes(entry.extension) && <><p className="muted">텍스트·제목·목록·표를 변환합니다. 원본의 정밀한 배치는 달라질 수 있습니다.</p>{(['pdf', 'docx', 'hwpx', 'txt', 'md'] as const).map(format => <button key={format} disabled={!!converting || !version || repository.role === 'VIEWER'} onClick={async () => { setConverting(format); setError(''); try { await repository.convertVersion(entry, version, format); } catch (reason) { setError((reason as Error).message); } finally { setConverting(''); } }}>{converting === format ? `${format.toUpperCase()} 변환 중…` : `${format.toUpperCase()} 다운로드`}</button>)}</>}</section>}
    </div>
  </DocumentPreviewLayout>;
}
