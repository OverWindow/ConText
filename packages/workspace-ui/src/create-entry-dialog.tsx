"use client";
import { useState } from 'react';
import { DocumentPreviewFrame } from '../shared/ui/document-preview-frame';
export function CreateEntryDialog({ kind, initialName, onClose, onSubmit }: { kind: 'file' | 'folder' | 'rename'; initialName: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initialName), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const title = kind === 'file' ? '새 텍스트 파일' : kind === 'folder' ? '새 폴더' : '이름 변경';
  return <DocumentPreviewFrame className="new-text-file" labelledBy="application-create-title" onClose={() => { if (!busy) onClose(); }}><form onSubmit={event => { event.preventDefault(); if (busy) return; if (kind === 'file' && !/\.(txt|md)$/i.test(name.trim())) { setError('파일 이름은 .txt 또는 .md로 끝나야 합니다.'); return; } setBusy(true); setError(''); void onSubmit(name.trim()).catch(reason => setError(reason.message)).finally(() => setBusy(false)); }}><h2 id="application-create-title">{title}</h2><label>이름<input aria-label="이름" required autoFocus disabled={busy} value={name} maxLength={240} onChange={event => setName(event.target.value)} /></label>{kind === 'file' && <p>현재 폴더에 TXT 또는 Markdown 파일을 만듭니다.</p>}{error && <p className="error" role="alert">{error}</p>}<button type="button" disabled={busy} onClick={onClose}>취소</button><button className="primary" disabled={busy || !name.trim()}>{busy ? '저장 중…' : kind === 'file' ? '파일 만들기' : '확인'}</button></form></DocumentPreviewFrame>;
}
