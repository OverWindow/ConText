"use client";
import { useEffect, useRef, useState } from 'react';
import { Position, useUpdateNodeInternals, type Node, type NodeProps } from '../shared/canvas/react-flow';
import { LuArrowUpRight } from 'react-icons/lu';
import { FileDerivatives } from './file-derivatives';
import { DocumentPaper } from '../shared/ui/document-paper';
import { DocumentHandles } from '../shared/canvas/document-handles';
import { useWorkspaceRuntime, type Entry } from './runtime';
const images = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const pendingMeasurements = new WeakMap<object, { ids: Set<string>; update: (ids: string[]) => void }>();
function measureCards(runtime: object, id: string, update: (ids: string[]) => void) {
  let pending = pendingMeasurements.get(runtime);
  if (!pending) {
    pending = { ids: new Set(), update }; pendingMeasurements.set(runtime, pending);
    requestAnimationFrame(() => { const batch = pendingMeasurements.get(runtime); pendingMeasurements.delete(runtime); if (batch) batch.update([...batch.ids]); });
  }
  pending.ids.add(id);
}
export function appearance(entry: Entry) {
  if (entry.kind === 'directory') return { kind: 'folder', name: 'FOLDER', description: '하위 폴더' };
  if (images.has(entry.extension)) return { kind: 'image', name: entry.extension.slice(1).toUpperCase(), description: '이미지' };
  const ext = entry.extension.slice(1);
  return { kind: ['pdf', 'docx', 'hwpx', 'md', 'txt'].includes(ext) ? ext : 'file', name: ext.toUpperCase() || 'FILE', description: entry.kind === 'link' ? '바로가기' : '문서 파일' };
}
export type FileNode = Node<{ entry: Entry; inspect: (entry: Entry) => void; enter: (entry: Entry) => void; copy: (entry: Entry, requestId: string, versionId?: string) => Promise<void>; connections?: number; referenced?: boolean; scale?: number }, 'file'>;
/** Same centers as document-paper.css; edges remain available before DOM measurement. */
export function paperHandles(scale = 1): NonNullable<FileNode['handles']> {
  const half = 5.5 * scale;
  return [[Position.Left, 0, 122], [Position.Right, 200, 122], [Position.Top, 100, 0], [Position.Bottom, 100, 244]].map(([position, x, y]) => ({
    id: position as Position, type: 'source', position: position as Position,
    x: Number(x) * scale - half, y: Number(y) * scale - half, width: half * 2, height: half * 2,
  }));
}
export function FileCard({ id, data, selected, isConnectable, dragging }: NodeProps<FileNode>) {
  const { entry } = data;
  const api = useWorkspaceRuntime();
  const updateInternals = useUpdateNodeInternals();
  // New cards and their relations may arrive before their first resize notification.
  useEffect(() => { measureCards(api, id, updateInternals); }, [api, id, data.connections, data.scale, updateInternals]);
  const thumbnailKey = `${entry.id}:${entry.mtime}:${entry.size}`;
  const [thumbnail, setThumbnail] = useState<{ key: string; url: string }>();
  const [actionsOpen, setActionsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!actionsOpen) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof globalThis.Node && !root.current?.contains(event.target)) setActionsOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [actionsOpen]);
  const interactiveTarget = (target: EventTarget) => target instanceof Element && !!target.closest('button,a,input,select,textarea,.react-flow__handle');
  useEffect(() => {
    let active = true;
    if (entry.kind === 'file' && images.has(entry.extension)) api.preview(entry.workspace_id, entry.id, true).then(value => { if (active && value.kind === 'image') setThumbnail({ key: thumbnailKey, url: value.url }); }).catch(() => {});
    return () => { active = false; };
  }, [api, entry.id, entry.workspace_id, entry.kind, entry.extension, thumbnailKey]);
  const style = appearance(entry);
  const paper = <DocumentPaper {...style} filename={entry.name} size={entry.kind === 'directory' ? undefined : entry.size} status={entry.excluded ? '내용 제외됨' : entry.kind === 'directory' ? '폴더' : entry.kind === 'link' ? '바로가기' : api.capabilities?.label || '로컬'} thumbnail={thumbnail?.key === thumbnailKey ? thumbnail.url : undefined} connections={data.connections}
    badge={!!entry.version_count && <span className="paper-version" title={`${entry.version_count}개 수정 이력`}>이력 {entry.version_number || entry.version_count}{entry.version_count > 1 && <small> / {entry.version_count}</small>}</span>} />;
  // Capture before the canvas pan/zoom listener consumes native double clicks.
  return <div ref={root} role="group" tabIndex={0} aria-label={entry.name} data-file-actions-open={actionsOpen} title="한 번 클릭: 파일 작업 · 두 번 클릭: 미리보기" onPointerDownCapture={event => { pointer.current = { x: event.clientX, y: event.clientY }; }} onClick={event => { if (interactiveTarget(event.target) || dragging || pointer.current && Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 5) return; setActionsOpen(true); }} onDoubleClickCapture={event => { event.stopPropagation(); if (interactiveTarget(event.target) || dragging) return; event.preventDefault(); setActionsOpen(false); if (entry.kind === 'directory') data.enter(entry); else data.inspect(entry); }} onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); setActionsOpen(false); if (entry.kind === 'directory') data.enter(entry); else data.inspect(entry); } else if (event.key === ' ') { event.preventDefault(); event.stopPropagation(); setActionsOpen(true); } else if (event.key === 'Escape') { event.stopPropagation(); setActionsOpen(false); } }} className={`canvas-document paper-document file-theme-${style.kind} ${selected ? 'is-selected' : ''} ${data.referenced ? 'is-ai-reference' : ''}`} style={data.scale && data.scale !== 1 ? { transform: `scale(${data.scale})`, transformOrigin: 'top left' } : undefined} data-testid={`file-${entry.name}`}>
    {data.referenced && <><span className="paper-reference-glow" aria-hidden="true" /><span className="paper-reference-badge">AI 참조</span></>}
    <DocumentHandles isConnectable={isConnectable && entry.kind === 'file'} />
    {api.renderFileActions ? api.renderFileActions({ entry, active: actionsOpen, dragging, onCopy: data.copy, children: paper }) : <FileDerivatives entry={entry} active={actionsOpen} dragging={dragging} onCopy={data.copy}>{paper}</FileDerivatives>}
    {entry.kind === 'directory' && <button className="card-action nodrag nopan" title="폴더 열기" aria-label={`${entry.name} 폴더 열기`} onClick={event => { event.stopPropagation(); data.enter(entry); }}><LuArrowUpRight /></button>}
  </div>;
}
