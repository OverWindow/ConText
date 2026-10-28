"use client";
import { useEffect, useRef, useState } from 'react';
import { BlockEditor, type EditorHandle } from '../shared/writing/block-editor';
import { blockText, type WritingBlock } from '../shared/core/writing';
import type { NormalizedDocument } from '../shared/core/documents';
import { DocumentPreviewFrame } from '../shared/ui/document-preview-frame';
import '../shared/writing/writing.css';

export function SampleDocumentEditor({ name, content, onSave, onClose }: { name: string; content: NormalizedDocument; onSave: (content: NormalizedDocument) => Promise<void>; onClose: () => void }) {
  const editor = useRef<EditorHandle>(null), [title, setTitle] = useState(content.title || name), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [discard, setDiscard] = useState(false);
  const [blocks] = useState<WritingBlock[]>(() => content.blocks.length ? content.blocks.map(block => ({ id: `sample-block-${block.id}`, type: block.type === 'table' ? 'table' : block.type === 'heading' ? 'heading' : block.type === 'list_item' ? 'list' : 'paragraph', text: block.text, level: block.level || 2, items: block.type === 'list_item' ? [block.text] : [], rows: block.rows || [], source_ids: [] })) : [{ id: 'empty', type: 'paragraph', text: '', level: 2, items: [], rows: [], source_ids: [] }]);
  const close = () => { if (!busy) { if (dirty) setDiscard(true); else onClose(); } };
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  return <DocumentPreviewFrame className="sample-document-editor" labelledBy="sample-edit-title" onClose={close}>
    <header className="preview-heading"><div><h2 id="sample-edit-title">샘플 본문 편집 · {name}</h2><p>본문과 표를 수정합니다. 저장한 내용으로 AI가 답변하며, 수정 전 내용은 인용 확인용으로 보관됩니다.</p></div><button disabled={busy} aria-label="샘플 편집 닫기" onClick={close}>닫기</button></header>
    <div className="panel-scroll sample-reader-content"><label>문서 제목<input aria-label="샘플 문서 제목" value={title} maxLength={200} disabled={busy} onChange={event => { setTitle(event.target.value); setDirty(true); }} /></label>{error && <p role="alert" className="error">{error}</p>}<BlockEditor ref={editor} blocks={blocks} readOnly={false} onDirty={() => setDirty(true)} onSelect={() => {}} /></div>
    <footer className="preview-footer"><span>수정 내용은 이 기기에 저장됩니다.</span><button className="primary" disabled={busy || !dirty || !title.trim()} onClick={async () => {
      if (!editor.current || busy) return; setBusy(true); setError('');
      try {
        const edited = await editor.current.read();
        const normalized = edited.flatMap(block => block.type === 'list' ? block.items.map(text => ({ type: 'list_item', text, source: {} })) : [{ type: block.type === 'paragraph' && content.blocks.find(original => `sample-block-${original.id}` === block.id)?.type === 'code' ? 'code' : block.type, text: blockText(block), ...(block.type === 'table' ? { rows: block.rows } : {}), ...(block.type === 'heading' ? { level: block.level } : {}), source: {} }]);
        await onSave({ ...content, title: title.trim(), page_count: null, blocks: normalized.map((block, index) => ({ ...block, id: index + 1 })) }); onClose();
      } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
    }}>{busy ? '저장 중…' : '샘플 저장'}</button></footer>
    {discard && <div className="writing-discard" role="alertdialog" aria-label="저장하지 않은 변경"><p>저장하지 않은 변경을 버릴까요?</p><button onClick={() => setDiscard(false)}>계속 편집</button><button onClick={onClose}>변경 버리기</button></div>}
  </DocumentPreviewFrame>;
}
