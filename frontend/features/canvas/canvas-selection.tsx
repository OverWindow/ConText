"use client";

import { useRef, useState, type PointerEvent, type RefObject } from "react";
import { LuSquareDashedMousePointer, LuSparkles, LuX } from "react-icons/lu";
import { ControlButton, type ReactFlowInstance } from "@xyflow/react";
import { api } from "@/lib/api";
import type { WorkspaceDocument } from "@/features/documents/api";

type Point = { x: number; y: number };
type SelectionProps = {
  active: boolean; busy: boolean; flow: RefObject<ReactFlowInstance | null>;
  onSelect: (ids: string[]) => void;
};

export function SelectionArea({ active, busy, flow, onSelect }: SelectionProps) {
  const origin = useRef<Point | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  function bounds(event: PointerEvent<HTMLDivElement>) {
    const start = origin.current!;
    return { left: Math.min(start.x, event.clientX), top: Math.min(start.y, event.clientY), width: Math.abs(start.x - event.clientX), height: Math.abs(start.y - event.clientY) };
  }
  if (!active) return null;
  return <div className="canvas-selection-area" aria-label="파일 영역 선택" onPointerDown={event => {
    if (busy || !event.isPrimary || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = { x: event.clientX, y: event.clientY }; setBox(bounds(event));
  }} onPointerMove={event => { if (origin.current) setBox(bounds(event)); }} onPointerUp={event => {
    if (!origin.current) return;
    const rect = bounds(event), instance = flow.current;
    origin.current = null; setBox(null);
    if (instance && rect.width > 4 && rect.height > 4) {
      const from = instance.screenToFlowPosition({ x: rect.left, y: rect.top });
      const to = instance.screenToFlowPosition({ x: rect.left + rect.width, y: rect.top + rect.height });
      onSelect(instance.getNodes().filter(node => node.type === "document" && !node.hidden && node.position.x >= from.x && node.position.y >= from.y && node.position.x + (node.measured?.width || 200) <= to.x && node.position.y + (node.measured?.height || 290) <= to.y).map(node => node.id));
    } else onSelect([]);
  }} onPointerCancel={() => { origin.current = null; setBox(null); }}>
    {box && <div className="canvas-selection-box" style={box} />}
  </div>;
}

export function useDocumentSelection(workspaceId: string, documents: WorkspaceDocument[], flow: RefObject<ReactFlowInstance | null>, select: (ids: string[]) => void, created: (result: { document: WorkspaceDocument; x: number; y: number }) => void) {
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
      setActive(false); choose([]); created(result); request.current = null;
    } catch (err) { setError(err instanceof Error ? err.message : "요약 파일을 만들지 못했습니다. 다시 시도해 주세요."); }
    finally { running.current = false; setBusy(false); }
  }
  const toggle = <ControlButton className="canvas-area-select" title="영역 선택 · 드래그로 파일 선택" aria-label="영역 선택" aria-pressed={active} disabled={busy} onClick={() => { if (active) close(); else { choose([]); setActive(true); } }}><LuSquareDashedMousePointer /></ControlButton>;
  const actions = active && <div className="canvas-selection-actions" role="region" aria-label="선택한 파일 작업">
    <div className="selection-status"><strong>{selected.length ? `${selected.length}개 파일 선택` : "파일을 감싸도록 드래그하세요"}</strong><button className="icon-button" aria-label="영역 선택 종료" disabled={busy} onClick={close}><LuX /></button></div>
    {selected.length > 0 && <><p className="selected-file-names">{selected.map(doc => doc.title).join(" · ")}</p><button className="primary" disabled={!ready || busy} onClick={() => void summarize()}><LuSparkles />{busy ? "요약 파일 생성 중…" : "요약 파일 만들기"}</button></>}
    {!ready && selected.length > 0 && <small>{selected.length > 8 ? "한 번에 최대 8개 파일을 요약할 수 있습니다." : "선택한 파일의 본문 처리가 완료되면 요약할 수 있습니다."}</small>}
    {busy && <small role="status">완료되면 새 파일 아이콘과 출처 연결이 생깁니다.</small>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
  return { active, busy, choose, close, toggle, actions };
}
