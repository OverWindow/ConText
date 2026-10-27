"use client";
import { useEffect, useState } from 'react';
import type { TextDocument, TextRepository } from '../core/text';
import { DocumentPreviewFrame } from './document-preview-frame';
import './text-editor.css';

export function TextEditor({ repository, onClose }: { repository: TextRepository; onClose: () => void }) {
  const [document, setDocument] = useState<TextDocument>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [discard, setDiscard] = useState<'close' | 'reload'>();
  const dirty = !!document && document.text !== text;
  useEffect(() => {
    let active = true;
    repository.load().then(value => { if (active) { setDocument(value); setText(value.text); } }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [repository]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  async function reload() {
    setBusy(true); setError('');
    try { const value = await repository.load(); setDocument(value); setText(value.text); }
    catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  async function save() {
    if (busy || !document || !dirty) return;
    setBusy(true); setError('');
    try { const value = await repository.save(document.revision, text); setDocument(value); setText(value.text); }
    catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  return <DocumentPreviewFrame className="text-editor-dialog" labelledBy="text-editor-title" onClose={() => { if (busy) return; if (dirty) setDiscard('close'); else onClose(); }}>
    <header className="preview-heading"><div><h2 id="text-editor-title">텍스트 편집 · {document?.filename || '문서'}</h2><p>UTF-8 TXT/Markdown 원본을 편집합니다. 저장 전 내용은 수정 이력에 보존됩니다.</p></div><button disabled={busy} aria-label="텍스트 편집 닫기" onClick={() => dirty ? setDiscard('close') : onClose()}>닫기</button></header>
    {error && <div role="alert" className="text-editor-error"><p>{error}</p><button disabled={busy} onClick={() => dirty ? setDiscard('reload') : void reload()}>원본 다시 불러오기</button></div>}
    <textarea className="text-editor-content" aria-label="원본 텍스트" spellCheck={false} value={text} disabled={busy || !document} onChange={event => setText(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); } }} />
    <footer className="preview-footer"><span role="status">{busy ? '저장 중…' : dirty ? '저장하지 않은 변경' : '저장됨'}</span>{repository.saveAs && <button disabled={busy || !document} onClick={async () => { setBusy(true); setError(''); try { await repository.saveAs!(text); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }}>다른 이름으로 저장</button>}<button className="primary" disabled={busy || !dirty} onClick={() => void save()}>원본 저장</button></footer>
    {discard && <div className="text-editor-discard" role="alertdialog" aria-label="저장하지 않은 변경"><p>저장하지 않은 변경을 버릴까요?</p><button onClick={() => setDiscard(undefined)}>계속 편집</button><button onClick={() => { const action = discard; setDiscard(undefined); if (action === 'close') onClose(); else void reload(); }}>변경 버리기</button></div>}
  </DocumentPreviewFrame>;
}
