"use client";
import { useEffect, useRef } from "react";
import { MarkerType } from "@xyflow/react";
import { LuArrowUpRight, LuTrash2, LuX } from "react-icons/lu";
import { relationLabels, type CanvasRelation } from "../core/canvas";
export function edgeFor(relation: CanvasRelation) {
  return { id: relation.id, source: relation.source_document_id, target: relation.target_document_id,
    sourceHandle: relation.source_handle || "right", targetHandle: relation.target_handle || "left",
    type: "smoothstep", label: relationLabels[relation.relation_type], markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "var(--primary)", strokeWidth: 2 }, labelStyle: { fontSize: 12, fill: "var(--primary-strong)" } };
}

export function ConnectionOptions({ relation, x, y, source, target, busy, error, onClose, onDelete }: { relation: CanvasRelation; x: number; y: number; source: string; target: string; busy: boolean; error: string; onClose: () => void; onDelete: () => void }) {
  const popup = useRef<HTMLElement>(null);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    const outside = (event: PointerEvent) => { if (event.target instanceof globalThis.Node && !popup.current?.contains(event.target)) onClose(); };
    document.addEventListener("keydown", close, true); document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", close, true); document.removeEventListener("pointerdown", outside); };
  }, [onClose]);
  return <aside ref={popup} className="connection-options" role="dialog" aria-label="연결 옵션" style={{ left: x, top: y }}><div className="connection-options-heading"><strong>{relationLabels[relation.relation_type]} 연결</strong><button className="icon-button" aria-label="연결 옵션 닫기" onClick={onClose}><LuX /></button></div><p>{source} <LuArrowUpRight /> {target}</p><button className="connection-delete" disabled={busy} onClick={onDelete}><LuTrash2 /> {busy ? "삭제 중…" : "연결 삭제"}</button>{error && <p className="error" role="alert">{error}</p>}</aside>;
}
