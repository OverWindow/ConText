import { useEffect, useRef, useState } from 'react';
import { LuCloudDownload, LuX } from 'react-icons/lu';
import type { CloudState, CloudWorkspace, Snapshot } from './contracts';
import { SyncControl, SyncReviewDialog } from '@context/workspace-ui/sync-control';
import type { WorkspaceConflict, WorkspaceRecovery } from '@context/workspace-client';
import './cloud-control.css';
const api = window.contextDesktop;
export function CloudControl({ workspaceId, flush }: { workspaceId: string; flush: () => Promise<boolean> }) {
  const [state, setState] = useState<CloudState>({ phase: 'local' }), [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<WorkspaceConflict[]>(), [review, setReview] = useState(false), [recovery, setRecovery] = useState<WorkspaceRecovery[]>([]), [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => api.syncStatus(workspaceId).then(value => { if (active) setState(value); }).catch(() => {});
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    const off = api.onSyncChanged((id, value) => { if (active && id === workspaceId) setState(value); });
    const account = api.onAccountChanged(() => { void refresh(); });
    return () => { active = false; clearInterval(timer); off(); account(); };
  }, [workspaceId]);
  async function loadReview() { setReview(true); const [items, saved] = await Promise.all([api.cloudConflicts(workspaceId), api.cloudRecovery(workspaceId)]); setConflicts(items.map(item => ({ id: item.id, entity_id: item.entity_id, reason: item.reason, local: item.candidate, remote: item.current, base_revisions: item.base_revisions }))); setRecovery(saved); }
  async function run(action: () => Promise<unknown>) { if (busy) return; setBusy(true); setError(''); try { await action(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }
  return <><SyncControl state={state} actions={{
    sync: async () => { if (!await flush()) throw new Error('캔버스 저장을 완료한 뒤 동기화해 주세요.'); setState(await api.syncStart(workspaceId)); },
    cancel: () => api.syncCancel(workspaceId),
    openWeb: state.linked || state.binding ? () => api.syncOpenWeb(workspaceId) : undefined,
    detach: state.linked ? async () => setState(await api.syncDetach(workspaceId)) : undefined,
    remove: state.linked || state.binding ? async () => setState(await api.syncDelete(workspaceId)) : undefined,
    restart: async () => setState(await api.syncRestart(workspaceId)), review: () => run(loadReview),
  }} />{review && <SyncReviewDialog conflicts={conflicts} recovery={recovery} error={error} busy={busy} onClose={() => setReview(false)} onResolve={(item, resolution) => void run(async () => { if (!await flush()) throw new Error('캔버스 저장을 완료해 주세요.'); setState(await api.cloudResolve(workspaceId, 'ResolveConflict', { id: item.id, resolution: resolution === 'keep_local' ? 'apply_candidate' : 'keep_current' }, item.base_revisions || {})); await loadReview(); })} onExport={id => void run(() => api.cloudExportRecovery(workspaceId, id))} onOriginal={id => void run(() => api.cloudRecoveryOriginal(workspaceId, id))} />}</>;
}

export function CloudWorkspacePicker({ onAttach }: { onAttach: (snapshot: Snapshot) => void }) {
  const [open, setOpen] = useState(false), [workspaces, setWorkspaces] = useState<CloudWorkspace[]>(), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  async function load() { setOpen(true); setError(''); try { setWorkspaces(await api.cloudList()); } catch (reason) { setError((reason as Error).message); } }
  async function attach(id: string) {
    if (busy) return; setBusy(id); setError('');
    try { const snapshot = await api.cloudAttach(id); if (snapshot) { setOpen(false); onAttach(snapshot); } }
    catch (reason) { setError((reason as Error).message); } finally { setBusy(''); }
  }
  return <><button className="secondary cloud-library-button" onClick={() => void load()}><LuCloudDownload />클라우드 워크스페이스 열기</button>{open && <dialog ref={dialog} className="document-dialog cloud-library-dialog" aria-labelledby="cloud-library-title" onCancel={event => { if (busy) event.preventDefault(); else setOpen(false); }}><header><h2 id="cloud-library-title">클라우드 워크스페이스</h2><button className="icon-button" disabled={!!busy} aria-label="클라우드 목록 닫기" onClick={() => setOpen(false)}><LuX /></button></header><p>공간을 선택한 뒤 이 기기에서 사용할 빈 폴더를 선택합니다. 원본과 수정 이력·메모·초안·공유 대화를 내려받습니다.</p>{error && <p className="error" role="alert">{error}</p>}{workspaces === undefined ? <p role="status">목록을 불러오는 중…</p> : !workspaces.length ? <p>이 계정에 연결된 클라우드 워크스페이스가 없습니다.</p> : <ul>{workspaces.map(workspace => <li key={workspace.id}><div><strong>{workspace.name}</strong><small>{workspace.role === 'OWNER' ? '소유자' : workspace.role === 'EDITOR' ? '편집 가능' : '보기 가능'} · 공유 수정 {workspace.revision}</small></div><button className="primary" disabled={!!busy} onClick={() => void attach(workspace.id)}>{busy === workspace.id ? '받는 중…' : '이 기기에서 열기'}</button></li>)}</ul>}<button className="secondary" disabled={!!busy} onClick={() => void load()}>목록 새로고침</button></dialog>}</>;
}
