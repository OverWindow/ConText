"use client";

import { useRef, useState, type RefObject } from "react";
import { LuSquareDashedMousePointer } from "react-icons/lu";
import { ControlButton, type ReactFlowInstance } from "@xyflow/react";
import { api } from "@/lib/api";
import { SelectionActions } from "@/shared/canvas/selection-actions";
import type { WorkspaceDocument } from "@/features/documents/api";

export { SelectionArea } from "@/shared/canvas/selection-area";

export function useDocumentSelection(workspaceId: string, documents: WorkspaceDocument[], flow: RefObject<ReactFlowInstance | null>, select: (ids: string[]) => void, created: (result: { document: WorkspaceDocument; x: number; y: number }) => void | Promise<void>) {
  const [active, setActive] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const request = useRef<{ signature: string; request_id: string; x: number; y: number } | null>(null);
  const selected = documents.filter(doc => ids.includes(doc.id));
  const versions = selected.map(doc => doc.versions.find(version => version.id === doc.current_version_id));
  const ready = selected.length > 0 && selected.length <= 8 && versions.every(version => version?.status === "READY");
  function choose(next: string[]) { setIds(next); select(next); setError(""); }
  function close() { if (running.current) return; setActive(false); choose([]); }
  async function summarize() {
    if (!ready || running.current) return;
    running.current = true; setBusy(true); setError("");
    const version_ids = versions.map(version => version!.id).sort();
    const signature = JSON.stringify(version_ids);
    if (request.current?.signature !== signature) {
      const nodes = flow.current?.getNodes() || [];
      const chosen = nodes.filter(node => ids.includes(node.id));
      const x = Math.min(99500, Math.max(-99500, Math.max(...chosen.map(node => node.position.x), 0) + 320));
      let y = Math.min(99500, Math.max(-99500, chosen[0]?.position.y || 0));
      while (nodes.some(node => Math.abs(node.position.x - x) < 240 && Math.abs(node.position.y - y) < 320) && y < 99000) y += 340;
      request.current = { signature, request_id: crypto.randomUUID(), x, y };
    }
    try {
      const { request_id, x, y } = request.current;
      const result = await api<{ document: WorkspaceDocument; x: number; y: number }>(`/workspaces/${workspaceId}/canvas/summaries`, { method: "POST", body: JSON.stringify({ request_id, version_ids, x, y }) });
      await created(result); setActive(false); choose([]); request.current = null;
    } catch (err) { setError(err instanceof Error ? err.message : "요약 파일을 만들지 못했습니다. 다시 시도해 주세요."); }
    finally { running.current = false; setBusy(false); }
  }
  const toggle = <ControlButton className="canvas-area-select" title="영역 선택 · 드래그로 파일 선택" aria-label="영역 선택" aria-pressed={active} disabled={busy} onClick={() => { if (active) close(); else { choose([]); setActive(true); } }}><LuSquareDashedMousePointer /></ControlButton>;
  const actions = active && <SelectionActions names={selected.map(doc => doc.title)} ready={ready} busy={busy} error={error} onClose={close} onSummarize={() => void summarize()} />;
  return { active, busy, choose, close, toggle, actions };
}
