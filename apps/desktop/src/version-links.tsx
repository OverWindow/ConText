import { useEffect, useRef, useState } from 'react';
import { VersionCandidatesView } from '@context/workspace-ui/shared/ui/version-candidates';
import type { VersionDocument, VersionCandidates, VersionCandidate } from '@context/workspace-ui/shared/core/versions';

export function LocalVersionLinks({ workspaceId, document, versionId, onChange }: { workspaceId: string; document: VersionDocument; versionId: string; onChange: () => Promise<void> }) {
  const [sources, setSources] = useState<VersionDocument[]>([]), [sourceDoc, setSourceDoc] = useState(''), [sourceVersion, setSourceVersion] = useState(''), [note, setNote] = useState('');
  const [data, setData] = useState<VersionCandidates>(), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState(''), [linked, setLinked] = useState<string[]>([]);
  const requests = useRef(new Map<string, string>());
  const api = window.contextDesktop;
  useEffect(() => {
    let active = true;
    Promise.all([api.versionSources(workspaceId), api.versionCandidates(workspaceId, document.id, versionId)]).then(([sources, candidates]) => { if (active) { setSources(sources); setData(candidates); setError(''); } }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [api, workspaceId, document.id, versionId, revision]);
  async function link(targetId: string, source: string, expected: number, note: string) {
    if (busy) return; setBusy(true); setError(''); setSuccess('');
    const signature = JSON.stringify([targetId, source, note]);
    if (!requests.current.has(signature)) requests.current.set(signature, crypto.randomUUID());
    try {
      await api.linkDocumentVersion(workspaceId, targetId, source, requests.current.get(signature)!, expected, note);
      setSuccess('원본을 보존한 새 수정 이력으로 연결했습니다. 현재 수정 이력은 별도로 지정할 수 있습니다.');
      setLinked(current => [...current, targetId]); await onChange(); setRevision(value => value + 1);
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  function linkCandidate(candidate: VersionCandidate) {
    void link(candidate.document_id, versionId, candidate.document_revision!, `수정 이력 후보 확인 후 연결: ${document.title}`.slice(0, 500));
  }
  return <><section className="version-registration" aria-label="새 수정 이력 등록"><h3>기존 수정 이력 연결</h3><p>같은 작업 공간의 저장된 스냅샷을 이 문서의 새 이력으로 연결합니다. 두 파일의 원본 내용은 유지됩니다.</p><form onSubmit={event => { event.preventDefault(); void link(document.id, sourceVersion, document.revision, note); }}><label>원본 문서<select aria-label="원본 문서" required value={sourceDoc} disabled={busy} onChange={event => { setSourceDoc(event.target.value); setSourceVersion(''); }}><option value="">연결할 문서 선택</option>{sources.filter(source => source.id !== document.id).map(source => <option key={source.id} value={source.id}>{source.title}</option>)}</select></label><label>원본 수정 이력<select aria-label="원본 수정 이력" required value={sourceVersion} disabled={busy || !sourceDoc} onChange={event => setSourceVersion(event.target.value)}><option value="">수정 이력 선택</option>{sources.find(source => source.id === sourceDoc)?.versions.map(version => <option key={version.id} value={version.id}>수정 이력 {version.version_number} · {version.original_filename}</option>)}</select></label><label>등록 메모 (선택)<input aria-label="등록 메모" value={note} maxLength={500} disabled={busy} onChange={event => setNote(event.target.value)} /></label><button className="primary" disabled={busy || !sourceVersion}>이 문서의 수정 이력으로 연결</button></form></section>
    <VersionCandidatesView data={data} busy={busy} editable error={error} success={success} linked={linked} analysis={<p className="muted">이 기기에서 파일명과 본문을 비교했습니다. 의미 임베딩은 사용하지 않습니다.</p>} onAnalyze={() => setRevision(value => value + 1)} onRetry={() => setRevision(value => value + 1)} onLink={linkCandidate} />
  </>;
}
