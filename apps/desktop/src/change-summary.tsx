import { useEffect, useRef, useState } from 'react';
import { AIChangeSummary } from '@context/workspace-ui/shared/ui/ai-change-summary';
import type { ChangeSummary } from './contracts';

export function LocalChangeSummary({ workspaceId, documentId, left, right, scope }: { workspaceId: string; documentId: string; left: string; right: string; scope: string }) {
  const [result, setResult] = useState<ChangeSummary | null>(null), [pending, setPending] = useState(false), [allowNew, setAllowNew] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    let active = true;
    window.contextDesktop.getChangeSummary(workspaceId, documentId, left, right).then(value => { if (active) { setResult(value?.result || null); setPending(value?.state === 'pending'); } }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [workspaceId, documentId, left, right]);
  async function summarize() {
    if (busy || pending && !allowNew) return;
    setBusy(true); setError('');
    if (pending) requestId.current = crypto.randomUUID();
    try { setResult(await window.contextDesktop.summarizeChanges(workspaceId, documentId, left, right, requestId.current)); setPending(false); }
    catch (reason) { setError((reason as Error).message); const state = await window.contextDesktop.getChangeSummary(workspaceId, documentId, left, right).catch(() => null); setPending(state?.state === 'pending'); setAllowNew(false); }
    finally { setBusy(false); }
  }
  return <section className="change-intelligence" aria-label="변경 분석"><div className="intelligence-heading"><h3>변경 분석</h3><button disabled={busy || pending && !allowNew || !!result} onClick={() => void summarize()}>{busy ? '변경 요약 중…' : 'AI 요약 요청'}</button></div>
    {error && <p role="alert" className="error">{error}</p>}{pending && !result && <label className="notice"><input type="checkbox" checked={allowNew} onChange={event => setAllowNew(event.target.checked)} />이전 요청의 완료 여부가 불명확합니다. 크레딧이 다시 사용될 수 있음을 확인하고 새 요청을 보냅니다.</label>}
    {result && <AIChangeSummary summary={result.claims.length ? '' : '요약할 변경 근거가 충분하지 않습니다.'} partial={result.partial || result.insufficient} sections={[{ label: '핵심 변경', items: result.claims.map(claim => ({ description: claim.text, evidence_ids: claim.source_ids })) }]} scope={scope} model={result.model} finishedAt={result.finished_at} />}
  </section>;
}
