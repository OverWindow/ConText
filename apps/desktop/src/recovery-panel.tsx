import { useEffect, useState } from 'react';
import type { DesktopAPI } from './contracts';

export function RecoveryPanel({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<Awaited<ReturnType<DesktopAPI['recoveryItems']>>>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => window.contextDesktop.recoveryItems(workspaceId).then(value => { if (active) setItems(value); }).catch(reason => { if (active) setError(reason.message); });
    void load(); const unsubscribe = window.contextDesktop.onChanged((id, update) => { if (id === workspaceId && !update?.indexing) void load(); });
    return () => { active = false; unsubscribe(); };
  }, [workspaceId]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); setItems(await window.contextDesktop.recoveryItems(workspaceId)); }
    catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  if (!items.length && !error) return null;
  return <section className="save-recovery notice" aria-label="중단된 파일 저장 복구"><strong>확인이 필요한 파일 저장 {items.length}개</strong><p>저장이 중단된 자료를 새 파일로 보관할 수 있습니다. 저장 전 원본과 임시 자료는 확인 후에도 남습니다.</p>
    {items.map(item => <div key={item.id}><span>{item.filename} · {new Date(item.created_at).toLocaleString('ko-KR')}</span><button disabled={busy} onClick={() => void run(() => window.contextDesktop.exportRecovery(workspaceId, item.id, false))}>작성 내용 복구</button><button disabled={busy} onClick={() => void run(() => window.contextDesktop.exportRecovery(workspaceId, item.id, true))}>저장 전 자료 복구</button><button disabled={busy} onClick={() => void run(() => window.contextDesktop.acknowledgeRecovery(workspaceId, item.id))}>확인 완료</button></div>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
