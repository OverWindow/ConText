import { LuSparkles, LuX } from 'react-icons/lu';

export function SelectionActions({ names, ready, busy, error, onClose, onSummarize, onNewRequest }: { names: string[]; ready: boolean; busy: boolean; error: string; onClose: () => void; onSummarize: () => void; onNewRequest?: () => void }) {
  return <div className="canvas-selection-actions" role="region" aria-label="선택한 파일 작업"><div className="selection-status"><strong>{names.length ? `${names.length}개 파일 선택` : '파일을 감싸도록 드래그하세요'}</strong><button className="icon-button" aria-label="영역 선택 종료" disabled={busy} onClick={onClose}><LuX /></button></div>
    {names.length > 0 && <><p className="selected-file-names">{names.join(' · ')}</p><button className="primary" disabled={!ready || busy} onClick={onSummarize}><LuSparkles />{busy ? '요약 파일 생성 중…' : '요약 파일 만들기'}</button></>}
    {!ready && names.length > 0 && <small>{names.length > 8 ? '한 번에 최대 8개 파일을 요약할 수 있습니다.' : '선택한 파일의 본문 처리가 완료되면 요약할 수 있습니다.'}</small>}
    {busy && <small role="status">완료되면 새 파일 아이콘과 출처 연결이 생깁니다.</small>}{error && <p role="alert" className="error">{error}</p>}
    {error && onNewRequest && <><small>새 요청은 크레딧이 다시 차감될 수 있습니다. 문서 작성 목록에서 이전 결과를 먼저 확인해 주세요.</small><button onClick={onNewRequest}>새 요약 요청 준비</button></>}
  </div>;
}
