"use client";
import { useMemo, useState } from "react";
import { api, type Workspace } from "@/lib/api";
import type { WorkspaceDocument } from "../documents/api";
import { DocumentPreview } from "../documents/document-preview";
import { ChatPanelView } from "../../shared/chat/chat-panel";
import type { Source } from "../../shared/core/sources";
import type { DocumentReference } from "../../shared/core/chat";
import { webChatRepository } from "./web-chat-repository";
export type { DocumentReference } from "../../shared/core/chat";

export function ChatPanel({ workspace, open, onClose, onRevealSources, onAISettings }: { workspace: Workspace; open: boolean; onClose: () => void; onRevealSources: (sources: DocumentReference[]) => void; onAISettings: () => void }) {
  const repository = useMemo(() => webChatRepository(workspace.id), [workspace.id]);
  const [preview, setPreview] = useState<{ document: WorkspaceDocument; source: Source }>();
  return <><ChatPanelView workspace={workspace} repository={repository} open={open} onClose={onClose} onRevealSources={onRevealSources} onAISettings={onAISettings} onOpenSource={async source => {
    const document = await api<WorkspaceDocument>(`/documents/${source.document_id}`);
    if (!document.versions.some(version => version.id === source.version_id)) throw new Error("인용한 수정 이력을 찾지 못했습니다.");
    setPreview({ document, source });
  }} />{preview && <DocumentPreview key={`${preview.document.id}:${preview.source.version_id}`} document={preview.document} editable={workspace.role !== "VIEWER"} initialVersionId={preview.source.version_id} initialBlockId={preview.source.locations[0]?.block_id} onClose={() => setPreview(undefined)} onChange={() => {}} />}</>;
}
