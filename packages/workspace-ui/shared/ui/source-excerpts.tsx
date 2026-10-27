import { useState } from 'react';
import { LuArrowUpRight, LuBookOpen, LuChevronDown, LuHistory } from 'react-icons/lu';
import { sourceLabel, type Source } from '../core/sources';

export function SourceExcerpts({ items, prefix = 'search', onOpen, onReveal }: { items: Source[]; prefix?: string; onOpen: (source: Source) => void; onReveal?: (source: Source) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  return <details className="chat-sources" onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open); }}>
    <summary className="chat-sources-toggle" aria-label={expanded ? '참조한 내용 접기' : '참조한 내용 더 보기'} title={expanded ? '참조한 내용 접기' : '참조한 내용 더 보기'}><LuBookOpen aria-hidden="true" /><span>참조 {items.length}</span><LuChevronDown className="chat-sources-chevron" aria-hidden="true" /></summary>
    <div className="chat-source-list">{items.map(source => <details className="chat-source" key={source.id} id={`${prefix}-source-${source.chunk_id}`}>
    <summary onClick={() => { if ((!source.kind || source.kind === 'document') && source.available !== false) onReveal?.(source); }} title={`${source.document_title} · ${source.kind && source.kind !== 'document' ? ({ note: '메모', chat: '대화', draft: '초안' })[source.kind] : `이력 ${source.version_number}`}`}>
      <LuBookOpen aria-hidden="true" /><span className="chat-source-ref">{sourceLabel(source.id, items)}</span><strong>{source.document_title}</strong>
      <span className="chat-source-version">{source.kind && source.kind !== 'document' ? ({ note: '메모 인용', chat: '대화 인용', draft: '초안 인용' })[source.kind] : <>v{source.version_number}{!source.is_current && <LuHistory aria-label="과거 수정 이력" />}{source.locations[0]?.page ? ` · p.${source.locations[0].page}` : ` · #${source.locations[0]?.block_id || 1}`}</>}{source.available === false && ' · 원본 연결 없음'}</span>
    </summary>
    <p className="source-excerpt">{source.text}</p>
    {(!source.kind || source.kind === 'document') && source.available !== false && <button type="button" className="icon-button source-open" aria-label="인용한 수정 이력 열기" title="인용 원문 열기" onClick={() => void onOpen(source)}><LuArrowUpRight /></button>}
  </details>)}</div></details>;
}
