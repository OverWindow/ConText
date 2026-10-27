"use client";
import { useState } from 'react';
import { LuCheck, LuDownload, LuHistory, LuLink } from 'react-icons/lu';
import { verifiedVersion, statusLabels, type VersionItem } from '../core/versions';

export function VersionTimelineView({ versions, currentId, selectedId, editable, onSelect, onAction, onRestore, currentLabel = '현재 수정 이력으로 지정' }: {
  versions: VersionItem[]; currentId: string | null; selectedId: string; editable: boolean; onSelect: (id: string) => void;
  onAction: (version: VersionItem, action: 'current' | 'complete' | 'download') => Promise<void>; currentLabel?: string;
  onRestore?: (version: VersionItem) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function action(version: VersionItem, kind: 'current' | 'complete' | 'download') {
    setBusy(true); setError('');
    try { await onAction(version, kind); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  async function restore(version: VersionItem) {
    setBusy(true); setError('');
    try { await onRestore?.(version); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  return <section aria-label="수정 이력 타임라인" className="version-timeline"><h3><LuHistory /> 수정 이력 <span className="badge">{versions.length}개</span></h3>{error && <p className="error" role="alert">{error}</p>}
    <ol>{[...versions].reverse().map(version => <li key={version.id} className={selectedId === version.id ? 'selected-version' : ''}>
      <div className="timeline-marker">{version.version_number}</div><div className="timeline-entry"><button className="version-select" aria-label={`수정 이력 ${version.version_number} 미리보기`} onClick={() => onSelect(version.id)}><strong>수정 이력 {version.version_number}</strong>{currentId === version.id && <span className="current-badge"><LuCheck /> 현재 수정 이력</span>}<span>{version.original_filename}</span></button>
        <p className="muted">{version.author_name || '팀원'} · {version.created_at ? new Date(version.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '등록 시각 정보 없음'} · {statusLabels[version.status] || version.status}</p>
        {version.change_note && <p className="version-note">{version.change_note}</p>}{version.source_version_id && <p className="muted"><LuLink /> 다른 문서의 수정 이력에서 연결됨</p>}
        <div className="document-actions">{verifiedVersion(version) && <button className="secondary" disabled={busy} onClick={() => void action(version, 'download')}><LuDownload /> 원본</button>}{editable && verifiedVersion(version) && currentId !== version.id && <button className="secondary" aria-label={`수정 이력 ${version.version_number}을 ${currentLabel}`} disabled={busy} onClick={() => void action(version, 'current')}>{currentLabel}</button>}{editable && onRestore && verifiedVersion(version) && <button className="secondary" disabled={busy} aria-label={`수정 이력 ${version.version_number}을 원본 복원`} onClick={() => void restore(version)}>원본 복원</button>}{editable && version.status === 'UPLOADING' && <button className="secondary" disabled={busy} onClick={() => void action(version, 'complete')}>업로드 완료 확인</button>}</div>
      </div></li>)}</ol>
  </section>;
}
