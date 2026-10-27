"use client";
import { useState, type ReactNode } from 'react';
import { LuFolder, LuFiles, LuPlug, LuUnplug, LuX } from 'react-icons/lu';
import { DocumentPreviewFrame } from '../shared/ui/document-preview-frame';
import { fileSize } from '../shared/ui/document-paper';
import type { Entry } from './runtime';
export function DocumentLibrary({ entries, disconnectedFiles = [], onOpen, onClose, onCreate, onDisconnect, onReconnect, actions, onNext, hasMore }: {
  entries: Entry[]; disconnectedFiles?: { id: string; name: string; relative_path: string; available: boolean }[]; onOpen: (entry: Entry) => void; onClose: () => void; onCreate?: () => void;
  onDisconnect?: (id: string) => Promise<void>; onReconnect?: (id: string) => Promise<void>; actions?: (entry: Entry) => ReactNode; onNext?: () => Promise<void>; hasMore?: boolean;
}) {
  const [query, setQuery] = useState(''), [detached, setDetached] = useState(false), [limit, setLimit] = useState(200), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const matches = (value: { name: string }) => value.name.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const found = entries.filter(matches), removed = disconnectedFiles.filter(matches), count = detached ? removed.length : found.length;
  async function run(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await action(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }
  return <DocumentPreviewFrame className="local-library" labelledBy="application-library-title" onClose={onClose}>
    <header className="preview-heading"><h2 id="application-library-title">{detached ? '연결 해제한 파일' : '문서 관리'}</h2><button className="icon-button" aria-label="문서 관리 닫기" onClick={onClose}><LuX /></button></header>
    <div className="panel-scroll"><div className="local-library-tools"><input aria-label="관리할 파일 검색" placeholder="파일 이름 검색" value={query} onChange={event => { setQuery(event.target.value); setLimit(200); }} />{onReconnect && <button className={`icon-button ${detached ? 'active' : ''}`} aria-label="연결 해제한 파일 보기" aria-pressed={detached} onClick={() => setDetached(!detached)}><LuUnplug /><span>{disconnectedFiles.length}</span></button>}</div>
      {error && <p className="error" role="alert">{error}</p>}<p className="muted">{Math.min(limit, count)}개 표시{count > limit || hasMore ? ' · 뒤에 더 있음' : ''}</p>
      <ul>{detached ? removed.slice(0, limit).map(item => <li key={item.id}><span className="library-file-info"><strong>{item.name}</strong><small>{item.relative_path}{!item.available && ' · 원본 없음'}</small></span><button className="icon-button" aria-label={`${item.name} 다시 연결`} disabled={busy || !item.available} onClick={() => void run(() => onReconnect!(item.id))}><LuPlug /></button></li>) : found.slice(0, limit).map(entry => <li key={entry.id}><button className="library-file-info" aria-label={entry.name} onClick={() => { onClose(); onOpen(entry); }}>{entry.kind === 'directory' ? <LuFolder /> : <LuFiles />}<strong>{entry.name}</strong><small>{entry.relative_path}{entry.kind === 'file' ? ` · ${fileSize(entry.size)}` : ' · 폴더'}</small></button>{actions?.(entry)}{onDisconnect && entry.kind === 'file' && <button className="icon-button" aria-label={`${entry.name} 연결 해제`} disabled={busy} onClick={() => void run(() => onDisconnect(entry.id))}><LuUnplug /></button>}</li>)}</ul>
      {(count > limit || hasMore) && <button disabled={busy} onClick={() => void run(async () => { if (hasMore) await onNext?.(); setLimit(value => value + 200); })}>다음 파일 더 보기</button>}
    </div><footer className="preview-footer">{onCreate && <button className="primary" onClick={() => { onClose(); onCreate(); }}>새 텍스트 파일</button>}<span>선택한 항목의 원본과 수정 이력을 확인하세요.</span></footer>
  </DocumentPreviewFrame>;
}
