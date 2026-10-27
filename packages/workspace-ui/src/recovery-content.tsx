import type { WorkspaceRecovery } from '../../workspace-client/src/repository';
import { ConflictContent } from './conflict-content';

export function RecoveryContent({ items, busy, onExport, onOriginal }: { items: WorkspaceRecovery[]; busy: boolean; onExport: (id: string) => void; onOriginal?: (id: string) => void }) {
  if (!items.length) return null;
  return <section aria-label="동기화 복구 자료"><h3>보존된 변경과 파일 적용 기록</h3><p>거절된 입력과 중단된 파일 적용 기록을 보관합니다. 내보내기는 복사본을 저장하며 보관 자료를 지우지 않습니다. 파일 내용은 원본 파일로 따로 저장할 수 있습니다.</p>{items.map(item => <article key={item.id}><h4>{item.title}</h4><p>{item.reason}</p><details><summary>보존된 내용 보기</summary><ConflictContent candidate={item.candidate} current={null} /></details><button disabled={busy} onClick={() => onExport(item.id)}>복구 기록 내보내기</button>{item.has_original && onOriginal && <button disabled={busy} onClick={() => onOriginal(item.id)}>보존된 원본 저장</button>}</article>)}</section>;
}
