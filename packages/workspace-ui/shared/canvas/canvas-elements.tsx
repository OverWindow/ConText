"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { NodeResizer, NodeToolbar, Position, useNodesState, useStore, type Node, type NodeChange, type NodeProps, type XYPosition } from "@xyflow/react";
import { LuType, LuFolder, LuCircle, LuTriangle, LuTrash2, LuGripHorizontal, LuX } from "react-icons/lu";
import type { CanvasElementRepository } from "../core/canvas";

import type { CanvasElement, Patch, ElementKind } from "../core/canvas";
export type { CanvasElement, Patch, ElementKind } from "../core/canvas";
export type ElementNode = Node<{ element: CanvasElement; editable?: boolean; scale?: number; onEdit?: (id: string, patch: Patch) => void; folder?: { titles: string[]; overview: boolean; open: () => void; select: () => void } }, "decoration">;
export const elementNames = { text: "텍스트", rectangle: "사각형", ellipse: "타원", triangle: "삼각형" };
const palette: Record<string, [string, string, string]> = {
  violet: ["var(--secondary-soft)", "var(--secondary-border)", "var(--secondary-strong)"],
  blue: ["var(--primary-soft)", "var(--primary-border)", "var(--primary-strong)"],
  green: ["var(--success-soft)", "var(--success-border)", "var(--success)"],
  amber: ["var(--warning-soft)", "var(--warning-border)", "var(--warning)"],
  rose: ["var(--danger-soft)", "var(--danger-border)", "var(--danger)"],
  slate: ["var(--surface-subtle)", "var(--border)", "var(--text-secondary)"],
};
// Keep persisted color keys compatible while naming the current theme accurately.
const colors = { violet: "와인", blue: "크림슨", green: "초록", amber: "노랑", rose: "분홍", slate: "회색" };
export const elementNodeId = (id: string) => `element:${id}`;
const databaseId = (id: string) => id.replace(/^element:/, "");
function toNode(element: CanvasElement): ElementNode {
  return { id: elementNodeId(element.id), type: "decoration", data: { element }, position: { x: element.x, y: element.y },
    style: { width: element.width, height: element.height }, width: element.width, height: element.height,
    zIndex: element.kind === "text" ? 30 : -10, connectable: false, ariaLabel: `캔버스 ${elementNames[element.kind]}` };
}

export function CanvasDecoration({ data, selected, width, height, hideLabel = false }: NodeProps<ElementNode> & { hideLabel?: boolean }) {
  const e = data.element;
  const scale = data.scale || 1;
  const zoom = useStore(state => state.transform[2]);
  const folder = e.kind === "rectangle";
  const name = e.text.trim() || "이름 없는 폴더";
  const count = data.folder?.titles.length || 0;
  const [fill, stroke, ink] = palette[e.color] || palette.violet;
  const projectedHeight = (height ?? e.height) * zoom;
  const folderStyle = { "--shape-fill": fill, "--shape-stroke": stroke, "--shape-ink": ink, "--folder-label-width": `${Math.max(0, Math.min(260, (width ?? e.width) * zoom - 20))}px`, "--folder-label-height": `${Math.max(0, projectedHeight - 20)}px` } as CSSProperties;
  return <div className={`canvas-decoration decoration-${e.kind} ${folder ? "canvas-folder" : ""} ${data.folder?.overview ? "folder-overview" : ""} ${selected ? "selected-decoration" : ""}`} style={folderStyle}>
    <NodeResizer isVisible={!!selected && !!data.editable && (!folder || count < 8)} minWidth={80 * scale} minHeight={60 * scale} maxWidth={(data.folder ? 1093 : 2000) * scale} maxHeight={(data.folder ? 793 : 2000) * scale} color="var(--primary)" />
    {e.kind === "text" ? <>
      {selected && data.editable && <span className="decoration-grip" title="끌어서 이동"><LuGripHorizontal /></span>}
      {selected && data.editable ? <textarea className="nodrag nowheel" aria-label="캔버스 텍스트 내용" placeholder="여기에 생각을 적어보세요" value={e.text} maxLength={5000} style={{ fontSize: e.font_size }} onChange={event => data.onEdit?.(e.id, { text: event.target.value })} /> : <div className="decoration-text-content" style={{ fontSize: e.font_size }}>{e.text || "텍스트를 입력하세요"}</div>}
    </> : <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{e.kind === "rectangle" ? <rect x="1" y="1" width="98" height="98" rx="4" /> : e.kind === "ellipse" ? <ellipse cx="50" cy="50" rx="49" ry="49" /> : <polygon points="50,2 98,98 2,98" />}</svg>}
    {folder && !hideLabel && <NodeToolbar isVisible={(width ?? e.width) * zoom >= 32 && projectedHeight >= 32} position={Position.Bottom} offset={data.folder?.overview ? -projectedHeight / 2 : -10} className={`folder-title-overlay ${(width ?? e.width) * zoom < 140 ? "folder-narrow" : ""} ${projectedHeight < 96 ? "folder-tiny" : ""}`} style={{ ...folderStyle, zIndex: 35 }}>
      {data.folder?.overview ? <button className={`folder-overview-open${data.editable ? "" : " nodrag nopan"}`} aria-label={`${name} 폴더 펼치기`} title={name} onClick={event => { event.stopPropagation(); data.folder?.open(); }}><strong className="folder-name">{name}</strong></button> : <div className="folder-label nodrag nopan" title={name} onClick={event => { event.stopPropagation(); if (data.editable) data.folder?.select(); }}>
        <LuFolder aria-hidden="true" />
        {selected && data.editable ? <input className="nodrag nopan nowheel" aria-label="폴더 이름" placeholder="폴더 이름" maxLength={80} value={e.text} onChange={event => data.onEdit?.(e.id, { text: event.target.value })} onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") event.currentTarget.blur(); }} /> : <span className="folder-name">{name}</span>}
        <span className="folder-count" aria-label={`포함된 파일 ${count}개`}>{count}</span>
      </div>}
    </NodeToolbar>}
  </div>;
}

export function useCanvasElements(repository: CanvasElementRepository, editable: boolean) {
  const [nodes, setNodes, applyChanges] = useNodesState<ElementNode>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(new Map<string, Patch>());
  const flight = useRef(new Set<string>());
  const saving = useRef(false);
  const saveRun = useRef<Promise<boolean> | null>(null);
  const deleted = useRef(new Set<string>());
  const mounted = useRef(true);
  const epoch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    const warn = (event: BeforeUnloadEvent) => { if (saving.current || pending.current.size) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); window.removeEventListener("beforeunload", warn); };
  }, []);
  const flush = useCallback(async function save(): Promise<boolean> {
    if (saveRun.current) {
      const succeeded = await saveRun.current;
      return succeeded ? save() : false;
    }
    if (!mounted.current) return false;
    if (!pending.current.size) return true;
    const operation = (async () => {
      saving.current = true; setStatus("텍스트·도형 저장 중…"); setError("");
      let succeeded = true;
      // Save one element at a time; new edits remain queued and override older failed values.
      while (pending.current.size && mounted.current) {
        const [id, patch] = pending.current.entries().next().value!;
        pending.current.delete(id); flight.current.add(id);
        try { await repository.update(id, patch); }
        catch (err) { pending.current.set(id, { ...patch, ...pending.current.get(id) }); setError(err instanceof Error ? err.message : "저장하지 못했습니다."); succeeded = false; break; }
        finally { flight.current.delete(id); epoch.current++; }
      }
      saving.current = false;
      if (mounted.current) setStatus(succeeded ? "텍스트·도형 저장됨" : "텍스트·도형 저장 실패");
      return succeeded;
    })();
    saveRun.current = operation;
    try { return await operation; }
    finally { saveRun.current = null; }
  }, [repository]);
  const patchElement = useCallback((id: string, patch: Patch) => {
    setNodes(current => current.map(node => node.data.element.id === id ? { ...node, data: { ...node.data, element: { ...node.data.element, ...patch } },
      position: { x: patch.x ?? node.position.x, y: patch.y ?? node.position.y },
      width: patch.width ?? node.width, height: patch.height ?? node.height,
      style: { ...node.style, width: patch.width ?? node.style?.width, height: patch.height ?? node.style?.height } } : node));
    pending.current.set(id, { ...pending.current.get(id), ...patch }); epoch.current++;
    setStatus("텍스트·도형 저장 대기 중");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 500);
  }, [flush, setNodes]);
  const edit = useCallback((id: string, patch: Patch) => { if (editable) patchElement(id, patch); }, [editable, patchElement]);
  const hydrate = useCallback((elements: CanvasElement[], startedEpoch: number) => {
    setNodes(current => elements.filter(e => !deleted.current.has(e.id)).map(e => {
      const old = current.find(n => n.data.element.id === e.id);
      if (old && (old.dragging || old.resizing || pending.current.has(e.id) || flight.current.has(e.id) || startedEpoch !== epoch.current)) return old;
      return { ...toNode(e), selected: old?.selected };
    }).concat(current.filter(n => !elements.some(e => e.id === n.data.element.id) && (startedEpoch !== epoch.current || pending.current.has(n.data.element.id) || flight.current.has(n.data.element.id)))));
  }, [setNodes]);
  function onChanges(changes: NodeChange<ElementNode>[]) {
    applyChanges(changes);
    if (!editable) return;
    for (const change of changes) {
      if (change.type === "position" && change.position && !change.dragging) edit(databaseId(change.id), change.position);
      if (change.type === "dimensions" && change.dimensions && change.resizing === false) edit(databaseId(change.id), change.dimensions);
    }
  }
  async function add(kind: ElementKind, position: XYPosition, dimensions?: { width: number; height: number }) {
    if (!editable || busy) return;
    setBusy(true); setError("");
    try {
      const element = await repository.create({ id: crypto.randomUUID(), kind, text: kind === "rectangle" ? "새 폴더" : "", ...position, width: kind === "text" ? 320 : kind === "rectangle" ? 320 : 400, height: kind === "text" ? 140 : kind === "rectangle" ? 240 : 280, color: "violet", font_size: 24, ...dimensions });
      epoch.current++;
      setNodes(current => [...current.map(n => ({ ...n, selected: false })), { ...toNode(element), selected: true }]);
      setStatus("텍스트·도형 저장됨");
      return element;
    } catch (err) { setError(err instanceof Error ? err.message : "추가하지 못했습니다."); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!editable || busy) return;
    // Keep failed edits available for explicit save retry before deleting.
    if (saving.current || pending.current.size) { await flush(); if (saving.current || pending.current.size) return; }
    setBusy(true); setError("");
    try { await repository.remove(id); deleted.current.add(id); epoch.current++; setNodes(current => current.filter(n => n.data.element.id !== id)); setStatus("요소 삭제됨"); }
    catch (err) { setError(err instanceof Error ? err.message : "삭제하지 못했습니다."); }
    finally { setBusy(false); }
  }
  return { nodes: nodes.map(n => ({ ...n, data: { ...n.data, editable: editable && !busy, onEdit: edit } })), setNodes, onChanges, hydrate, epoch, edit, patch: patchElement, add, remove, busy, status, error, flush };
}

export function ElementTools({ selected, editable, busy, add, edit, remove, clear, toolbarHost, sizeLocked = false }: { sizeLocked?: boolean; toolbarHost?: HTMLElement | null; selected?: CanvasElement; editable: boolean; busy: boolean; add: (kind: ElementKind) => void; edit: (id: string, patch: Patch) => void; remove: (id: string) => void; clear: () => void }) {
  if (!editable) return null;
  const tools = <div className="canvas-drawing-tools" role="toolbar" aria-label="텍스트와 배경 도형"><button title="텍스트 추가" aria-label="텍스트 추가" disabled={busy} onClick={() => add("text")}><LuType /></button><span className="tool-divider" />{([["rectangle", LuFolder], ["ellipse", LuCircle], ["triangle", LuTriangle]] as const).map(([kind, Icon]) => <button key={kind} title={kind === "rectangle" ? "파일을 묶는 사각형 폴더 추가" : `${elementNames[kind]} 배경 추가`} aria-label={kind === "rectangle" ? "사각형 폴더 추가" : `${elementNames[kind]} 배경 추가`} disabled={busy} onClick={() => add(kind)}><Icon /></button>)}</div>;
  return <>
    {toolbarHost ? createPortal(tools, toolbarHost) : tools}
    {editable && selected && <aside className="element-inspector" aria-label="텍스트·도형 편집"><div className="element-inspector-heading"><strong>{elementNames[selected.kind]} 편집</strong><button className="icon-button" aria-label="요소 선택 해제" onClick={clear}><LuX /></button></div>{!sizeLocked && <p className="muted">모서리를 끌어 크기를 조절하세요.</p>}
      <div className="element-colors" aria-label="요소 색상">{Object.entries(colors).map(([color, name]) => <button key={color} aria-label={`${name} 색상`} aria-pressed={selected.color === color} title={name} disabled={busy} style={{ background: palette[color][0], borderColor: selected.color === color ? palette[color][2] : "transparent" }} onClick={() => edit(selected.id, { color })} />)}</div>
      <div className="element-dimensions">{(["width", "height"] as const).map(key => <label key={key}>{key === "width" ? "너비" : "높이"}<input type="number" aria-label={`요소 ${key === "width" ? "너비" : "높이"}`} min={key === "width" ? 80 : 60} max={selected.kind === "rectangle" ? (key === "width" ? 1093 : 793) : 2000} disabled={busy || sizeLocked} value={Math.round(selected[key])} onChange={event => { const n = Number(event.target.value); if (n >= (key === "width" ? 80 : 60) && n <= 2000) edit(selected.id, { [key]: n }); }} /></label>)}</div>
      {selected.kind === "text" && <label className="element-font">글자 크기<select aria-label="글자 크기" value={selected.font_size} disabled={busy} onChange={event => edit(selected.id, { font_size: Number(event.target.value) })}>{[12, 16, 20, 24, 32, 40, 48, 64, 96].map(size => <option key={size} value={size}>{size}px</option>)}</select></label>}
      {selected.kind === "rectangle" && <label className="element-folder-name">폴더 이름<input aria-label="폴더 이름 편집" maxLength={80} value={selected.text} placeholder="폴더 이름" disabled={busy} onChange={event => edit(selected.id, { text: event.target.value })} /></label>}
      {selected.kind !== "text" && <p className="muted">{selected.kind === "rectangle" ? "파일을 안쪽에 놓아 묶습니다. 8개부터 내부 항목을 축소해 담습니다." : "도형은 문서와 텍스트 뒤에 표시됩니다."}</p>}<button className="text-button element-delete" disabled={busy} onClick={() => remove(selected.id)}><LuTrash2 /> 요소 삭제</button>
    </aside>}
  </>;
}
