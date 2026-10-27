"use client";
import { useEffect, useState, type ReactNode } from 'react';
import { DocumentConversions } from '../shared/canvas/document-conversions';
import type { VersionDocument } from '../shared/core/versions';
import { useWorkspaceRuntime, type Entry } from './runtime';
const formats = ['pdf', 'docx', 'hwpx', 'txt', 'md'] as const;
const supported = new Set(formats.map(format => `.${format}`));
/** Browser downloads use the same card tools as native file conversions. */
export function FileDerivatives({ entry, active, dragging, onCopy, children }: {
  entry: Entry; active: boolean; dragging: boolean; onCopy: (entry: Entry, requestId: string, versionId?: string) => Promise<void>; children: ReactNode;
}) {
  const runtime = useWorkspaceRuntime(), [document, setDocument] = useState<VersionDocument>();
  const editable = runtime.capabilities?.canEdit !== false;
  const canConvert = editable && !!runtime.fileConversions && entry.kind === 'file' && supported.has(entry.extension) && !entry.excluded;
  useEffect(() => {
    let current = true;
    if (active && canConvert) void runtime.fileConversions!.load(entry).then(value => { if (current) setDocument(value); }).catch(() => {});
    return () => { current = false; };
  }, [active, canConvert, runtime, entry]);
  const version = document?.versions.find(item => item.id === document.current_version_id) || document?.versions.at(-1);
  return <DocumentConversions document={document || { title: entry.name, current_version_id: null, versions: [] }} version={version}
    active={active} dragging={dragging} jobs={[]} formats={[...formats]} conversionEnabled={canConvert} allowUnversionedCopy downloadOnConvert
    onPrepare={canConvert ? async () => setDocument(await runtime.fileConversions!.load(entry)) : undefined}
    save={async (id, format) => { if (!runtime.fileConversions) throw new Error('파일 변환을 사용할 수 없습니다.'); await runtime.fileConversions.save(entry, id, format); }}
    onCopy={editable && entry.kind === 'file' ? (versionId, requestId) => onCopy(entry, requestId, versionId) : undefined}>{children}</DocumentConversions>;
}
