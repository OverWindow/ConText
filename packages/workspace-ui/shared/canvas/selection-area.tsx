"use client";
import { useRef, useState, type PointerEvent, type RefObject } from "react";
import type { ReactFlowInstance } from "@xyflow/react";
type Point = { x: number; y: number };
type SelectionProps = {
  active: boolean; busy: boolean; nodeType?: string; flow: RefObject<ReactFlowInstance | null>;
  onSelect: (ids: string[]) => void;
};

export function SelectionArea({ active, busy, flow, onSelect, nodeType = "document" }: SelectionProps) {
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
      onSelect(instance.getNodes().filter(node => {
        const position = instance.getInternalNode(node.id)?.internals.positionAbsolute || node.position;
        return node.type === nodeType && !node.hidden && position.x >= from.x && position.y >= from.y && position.x + (node.measured?.width || 200) <= to.x && position.y + (node.measured?.height || 290) <= to.y;
      }).map(node => node.id));
    } else onSelect([]);
  }} onPointerCancel={() => { origin.current = null; setBox(null); }}>
    {box && <div className="canvas-selection-box" style={box} />}
  </div>;
}

