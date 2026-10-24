"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { LuSparkles } from "react-icons/lu";
import { DocumentPaper } from "../../shared/ui/document-paper";
import { fileStyle } from "@/features/documents/file-style";
import type { WorkspaceDocument } from "@/features/documents/api";
import { statuses } from "@/lib/labels";
import type { Conversion } from "@/features/documents/conversion-api";
import { DocumentConversions } from "./document-conversions";

export type DocumentNode = Node<{ document: WorkspaceDocument; reference?: { versions: number[]; sequence: number }; onCopy?: (document: WorkspaceDocument, versionId: string, requestId: string) => Promise<void>; connectionCount?: number; conversions?: Conversion[]; onConversion?: (job: Conversion) => void }, "document">;

export function DocumentCard({ data, selected, isConnectable, dragging }: NodeProps<DocumentNode>) {
  const doc = data.document;
  const version = doc.versions.find(item => item.id === doc.current_version_id) || doc.versions.at(-1);
  const { kind, name, description } = fileStyle(version?.original_filename);
  const state = version?.status || "PENDING";
  const status = statuses[state];
  const connections = data.connectionCount || 0;
  return <div className={`canvas-document paper-document file-theme-${kind} ${selected ? "is-selected" : ""} ${data.reference ? "is-ai-reference" : ""}`}>
    {data.reference && <><span key={data.reference.sequence} className="paper-reference-glow" aria-hidden="true" /><span className="paper-reference-badge"><LuSparkles aria-hidden="true" />AI 참조 · {data.reference.versions.map(number => `이력 ${number}`).join(", ")}</span></>}
    {([ [Position.Left, "왼쪽"], [Position.Right, "오른쪽"], [Position.Top, "위쪽"], [Position.Bottom, "아래쪽"] ] as const).map(([position, label]) =>
      <Handle key={position} id={position} type="source" position={position} aria-label={`${label} 연결점`} title={`${label} 연결점`} isConnectable={isConnectable} style={{ visibility: isConnectable ? "visible" : "hidden" }} />
    )}
    <DocumentConversions key={version?.id || "empty"} document={doc} version={version} jobs={data.conversions || []} onConversion={data.onConversion} onCopy={data.onCopy} dragging={dragging}>
    <DocumentPaper kind={kind} name={name} description={description} filename={version?.original_filename || doc.title} size={version?.size} state={state} status={status} connections={connections}
      badge={<span className="paper-version" title={`${doc.versions.length}개 수정 이력`} aria-label={`수정 이력 ${version?.version_number || 1}, 전체 ${doc.versions.length}개 수정 이력`}>이력 {version?.version_number || 1}{doc.versions.length > 1 && <small> / {doc.versions.length}</small>}</span>} />
    </DocumentConversions>
  </div>;
}
