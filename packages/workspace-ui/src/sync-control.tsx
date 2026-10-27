"use client";
import { useState } from 'react';
import { LuCloudUpload, LuExternalLink, LuPause, LuTrash2, LuUnplug, LuTriangleAlert } from 'react-icons/lu';
import { DocumentPreviewFrame } from '../shared/ui/document-preview-frame';
import { ConflictContent } from './conflict-content';
import { RecoveryContent } from './recovery-content';
import type { WorkspaceConflict, WorkspaceRecovery } from '../../workspace-client/src/repository';
import './sync-control.css';

export type ApplicationSyncState = { phase: string; pending?: boolean; pending_count?: number; download_count?: number; linked?: boolean; conflict_count?: number; last_synced_at?: number | null; message?: string; completed?: number; total?: number };
export type SyncActions = { sync: () => Promise<unknown>; cancel?: () => Promise<unknown>; openWeb?: () => Promise<unknown>; detach?: () => Promise<unknown>; remove?: () => Promise<unknown>; restart?: () => Promise<unknown>; review: () => Promise<unknown> };
const phases: Record<string, [string, string]> = {
  loading: ['불러오는 중', '워크스페이스 연결 상태를 확인하고 있습니다.'],
  local: ['로컬 저장', '이 기기에 저장했습니다. 동기화를 시작하면 같은 계정의 웹과 데스크톱에서 이어서 작업할 수 있습니다.'],
  pending: ['서버 반영 대기', '저장한 변경을 서버에 반영할 준비가 됐습니다. 양쪽 내용은 변경 기록에 보관합니다.'],
  synced: ['서버 반영됨', '서버에 변경을 반영했습니다. 다른 기기의 파일 적용 상태는 해당 기기에서 확인하세요.'],
  preparing: ['동기화 준비 중', '저장한 변경과 연결 상태를 확인하고 있습니다.'],
  uploading: ['서버에 반영 중', '새 원본과 변경을 안전하게 전송하고 있습니다.'],
  pulling: ['공유 변경 받는 중', '웹과 다른 데스크톱의 변경을 받고 있습니다.'],
  downloading: ['원본 받는 중', '공유 원본의 크기와 무결성을 확인하고 있습니다.'],
  applying: ['파일 적용 중', '현재 파일을 확인한 뒤 받은 변경을 적용합니다. 외부에서 수정한 원본은 보호합니다.'],
  paused: ['동기화 일시정지', '이 기기의 자동 동기화를 멈췄습니다. 다시 시작하면 같은 공간에 연결합니다.'],
  offline: ['연결 확인 필요', '연결을 확인하지 못했습니다. 보관된 변경을 지우지 말고 연결 후 다시 동기화해 주세요.'],
  conflict: ['충돌 확인 필요', '동시에 수정한 양쪽 내용을 보존했습니다. 충돌과 복구 자료에서 비교하고 선택해 주세요.'],
  deleted: ['삭제된 워크스페이스', '공유 공간의 접근과 이후 동기화가 중지됐습니다. 이 기기의 원본 파일은 보존됩니다.'],
};
export function normalizeSyncPhase(phase: string) { return ({ complete: 'synced', changed: 'pending', committing: 'uploading', failed: 'offline' } as Record<string, string>)[phase] || (phases[phase] ? phase : 'offline'); }
export function SyncControl({ state, actions }: { state: ApplicationSyncState; actions: SyncActions }) {
  const [expanded, setExpanded] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const phase = normalizeSyncPhase(state.phase), [label, description] = phases[phase];
  const running = ['preparing', 'uploading', 'pulling', 'downloading', 'applying'].includes(phase);
  async function run(action: () => Promise<unknown>) { if (busy) return; setBusy(true); setError(''); try { await action(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }
  return <div className="cloud-control" data-sync-phase={phase}><button className="secondary" aria-label={label} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><LuCloudUpload className={running ? 'spin' : ''} /><span>{label}</span></button>
    {expanded && <section className="cloud-popover" aria-label="동기화 상태"><strong>{label}</strong><p role="status">{description}</p><p className="sync-counts">서버 반영 대기 {state.pending_count || 0}개 · 파일 적용 대기 {state.download_count || 0}개</p>
      {state.last_synced_at && <small>마지막 확인 {new Date(state.last_synced_at).toLocaleString('ko-KR')}</small>}
      {running && !!state.total && <progress value={state.completed || 0} max={state.total} aria-label="동기화 진행률" />}
      {(error || phase === 'offline' && state.message) && <p className="error" role="alert">{error || state.message}</p>}
      <div className="preview-actions">{running && actions.cancel ? <button disabled={busy} onClick={() => void run(actions.cancel!)}><LuPause />전송 중단</button> : phase !== 'deleted' && <button className="primary" disabled={busy || running} onClick={() => void run(actions.sync)}><LuCloudUpload />{busy ? '확인 중…' : '지금 동기화'}</button>}{actions.openWeb && <button disabled={busy} onClick={() => void run(actions.openWeb!)}><LuExternalLink />웹에서 열기</button>}</div>
      <button className="text-button" disabled={busy} onClick={() => void run(actions.review)}><LuTriangleAlert />충돌과 복구 자료{state.conflict_count ? ` · ${state.conflict_count}` : ''}</button>
      {actions.detach && !running && phase !== 'deleted' && <button className="text-button" disabled={busy} onClick={() => void run(actions.detach!)}><LuUnplug />동기화 연결 해제</button>}
      {actions.restart && state.pending && !running && phase !== 'deleted' && <button className="text-button" disabled={busy} onClick={() => void run(actions.restart!)}>현재 내용으로 다시 준비</button>}
      {actions.remove && !running && phase !== 'deleted' && <button className="text-button danger" disabled={busy} onClick={() => void run(actions.remove!)}><LuTrash2 />워크스페이스 삭제</button>}
    </section>}
  </div>;
}
export function SyncReviewDialog({ conflicts, recovery, error, busy, onClose, onResolve, onExport, onOriginal }: { conflicts?: WorkspaceConflict[]; recovery: WorkspaceRecovery[]; error?: string; busy: boolean; onClose: () => void; onResolve: (conflict: WorkspaceConflict, resolution: 'keep_local' | 'keep_remote') => void; onExport: (id: string) => void; onOriginal: (id: string) => void }) {
  return <DocumentPreviewFrame className="cloud-library-dialog sync-review-dialog" labelledBy="application-sync-review" onClose={() => { if (!busy) onClose(); }}><header><h2 id="application-sync-review">동기화 상태와 충돌</h2><button disabled={busy} aria-label="충돌 창 닫기" onClick={onClose}>닫기</button></header>{error && <p className="error" role="alert">{error}</p>}<RecoveryContent items={recovery} busy={busy} onExport={onExport} onOriginal={onOriginal} />{conflicts === undefined ? <p role="status">충돌 내용을 불러오는 중…</p> : !conflicts.length ? <p>미해결 충돌이 없습니다.</p> : conflicts.map(conflict => <article key={conflict.id}><h3>동시에 수정한 내용</h3><ConflictContent candidate={conflict.local} current={conflict.remote} /><div className="preview-actions"><button disabled={busy} onClick={() => onResolve(conflict, 'keep_remote')}>현재 공유 내용 사용</button><button disabled={busy} onClick={() => onResolve(conflict, 'keep_local')}>보존된 변경 적용</button></div></article>)}</DocumentPreviewFrame>;
}
