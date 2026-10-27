import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { LuDownload, LuLoaderCircle, LuRotateCw } from 'react-icons/lu';
import { DocumentConversions } from '@context/workspace-ui/shared/canvas/document-conversions';
import type { ConversionJob, ConversionFormat } from '@context/workspace-ui/shared/core/conversions';
import type { VersionDocument } from '@context/workspace-ui/shared/core/versions';
import type { Entry } from './contracts';

const api = window.contextDesktop;
const formats: ConversionFormat[] = ['pdf', 'docx', 'hwpx', 'txt', 'md'];
const supported = new Set(formats.map(format => `.${format}`));

function useConversions(workspaceId: string, documentId?: string) {
  const [jobs, setJobs] = useState<ConversionJob[]>([]), [error, setError] = useState('');
  const epoch = useRef(0);
  const load = useCallback(async () => {
    const request = ++epoch.current;
    if (!documentId) return;
    try { const next = await api.listConversions(workspaceId, documentId); if (request === epoch.current) { setJobs(next); setError(''); } }
    catch (reason) { if (request === epoch.current) setError((reason as Error).message); }
  }, [workspaceId, documentId]);
  useEffect(() => {
    setJobs([]); void load();
    const unsubscribe = api.onChanged((id, update) => { if (id === workspaceId && update?.conversions) void load(); });
    return () => { epoch.current++; unsubscribe(); };
  }, [load, workspaceId]);
  const request = useCallback(async (version: string, format: ConversionFormat) => {
    const result = await api.requestConversion(workspaceId, version, format); await load(); return result;
  }, [workspaceId, load]);
  return { jobs, error, request };
}

export function LocalFileDerivatives({ entry, active, dragging, onCopy, children }: {
  entry: Entry; active: boolean; dragging: boolean; onCopy: (entry: Entry, requestId: string, versionId?: string) => Promise<void>; children: ReactNode;
}) {
  const [document, setDocument] = useState<VersionDocument>();
  const alive = useRef(true), generation = useRef(0), preparing = useRef<Promise<void> | null>(null);
  const canConvert = entry.kind === 'file' && supported.has(entry.extension) && !entry.excluded;
  useEffect(() => {
    alive.current = true; const request = ++generation.current;
    if (canConvert) api.getDocument(entry.workspace_id, entry.id).then(value => { if (alive.current && request === generation.current) setDocument(value); }).catch(() => {});
    return () => { alive.current = false; generation.current++; };
  }, [entry.workspace_id, entry.id, entry.mtime, entry.size, entry.version_count, entry.version_number, canConvert]);
  const prepare = async () => {
    if (!canConvert) return;
    if (!preparing.current) preparing.current = (async () => {
      await api.openDocument(entry.workspace_id, entry.id);
      const value = await api.getDocument(entry.workspace_id, entry.id);
      if (alive.current) setDocument(value);
    })().finally(() => { preparing.current = null; });
    await preparing.current;
  };
  const conversions = useConversions(entry.workspace_id, document?.id);
  const version = document?.versions.find(item => item.id === document.current_version_id) || document?.versions.at(-1);
  return <DocumentConversions document={document || { title: entry.name, current_version_id: null, versions: [] }} version={version}
    jobs={conversions.jobs} active={active} dragging={dragging} formats={formats} saveLabel="저장" conversionEnabled={canConvert} allowUnversionedCopy
    onPrepare={prepare} request={conversions.request} save={(id, format) => api.saveConversion(entry.workspace_id, id, format)}
    onCopy={entry.kind === 'file' ? (_id, request) => onCopy(entry, request) : undefined}>{children}</DocumentConversions>;
}

export function LocalDocumentExport({ workspaceId, documentId, versionId, versionNumber }: { workspaceId: string; documentId: string; versionId: string; versionNumber: number }) {
  const { jobs, error, request } = useConversions(workspaceId, documentId);
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState('');
  const states = { QUEUED: '변환 대기 중', RUNNING: '변환 중', COMPLETED: '저장 준비 완료', FAILED: '변환 실패' };
  async function action(format: ConversionFormat, completed: boolean) {
    if (busy) return; setBusy(true); setProblem('');
    try { if (completed) await api.saveConversion(workspaceId, versionId, format); else await request(versionId, format); }
    catch (reason) { setProblem((reason as Error).message); } finally { setBusy(false); }
  }
  return <section aria-label="문서 내보내기"><h3>수정 이력 {versionNumber} 내보내기</h3>
    <p>텍스트·제목·목록·표를 중심으로 변환합니다. 원본 이미지와 정밀한 배치는 포함되지 않습니다.</p>
    {(problem || error) && <p role="alert" className="error">{problem || error}</p>}
    <div className="local-export-formats">{formats.map(format => {
      const job = jobs.find(item => item.version_id === versionId && item.format === format), pending = job?.state === 'QUEUED' || job?.state === 'RUNNING', completed = job?.state === 'COMPLETED';
      return <article key={format}><strong>{format.toUpperCase()}</strong><small role="status">{job ? states[job.state] : '변환 전'}</small>
        <button disabled={busy || pending} aria-label={`${format.toUpperCase()} ${completed ? '저장' : job?.state === 'FAILED' ? '변환 다시 시도' : '변환'}`} onClick={() => void action(format, completed)}>{pending ? <LuLoaderCircle className="spin" /> : job?.state === 'FAILED' ? <LuRotateCw /> : <LuDownload />}{completed ? '저장' : job?.state === 'FAILED' ? '다시 시도' : '변환'}</button>
        {job?.error_message && <p role="alert" className="error">{job.error_message}</p>}{job?.warnings?.map(warning => <p className="muted" key={warning}>{warning}</p>)}
      </article>;
    })}</div>
  </section>;
}
