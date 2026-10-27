"use client";
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { message } from '@/lib/labels';
import type { DocumentVersion, WorkspaceDocument } from '@/features/documents/api';
import { downloadConversion, type Conversion, type ConversionFormat } from '@/features/documents/conversion-api';
import { DocumentConversions as SharedConversions } from '@/shared/canvas/document-conversions';

export function DocumentConversions({ document, version, jobs, onConversion, onCopy, dragging, children }: {
  document: WorkspaceDocument; version?: DocumentVersion; jobs: Conversion[];
  onConversion?: (job: Conversion) => void; onCopy?: (document: WorkspaceDocument, versionId: string, requestId: string) => Promise<void>;
  dragging: boolean; children: ReactNode;
}) {
  return <SharedConversions document={document} version={version} jobs={jobs} dragging={dragging} formatError={message}
    request={(id, format) => api<Conversion>(`/versions/${id}/conversions/${format}`, { method: 'POST' })}
    save={(id, format) => downloadConversion(id, format as ConversionFormat)}
    onConversion={job => onConversion?.(job as Conversion)}
    onCopy={onCopy ? async (id, request) => { if (id) await onCopy(document, id, request); } : undefined}>{children}</SharedConversions>;
}
