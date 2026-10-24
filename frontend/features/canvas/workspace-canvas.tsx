"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { BrandLogo } from "@/features/brand/brand-logo";
import { LuUndo2, LuRedo2, LuLayoutDashboard, LuFiles, LuUsers, LuPlus, LuChevronDown, LuSearch, LuX, LuUpload, LuArrowUpRight, LuRefreshCw, LuPencil, LuTrash2, LuCheck, LuPanelLeftClose, LuPanelLeftOpen, LuPanelRightOpen, LuMessageCircle, LuMenu, LuEye, LuEyeOff, LuUserPlus } from "react-icons/lu";
import { DocumentPanel } from "@/features/documents/document-panel";
import { ChatPanel, type DocumentReference } from "@/features/chat/chat-panel";
import { WritingStudio } from "@/features/writing/writing-studio";
import { DocumentPreview } from "@/features/documents/document-preview";
import type { Conversion } from "@/features/documents/conversion-api";
import { SelectionArea, useDocumentSelection } from "./canvas-selection";
import { folderMembership, planFolderMove, applyFolderBounds, type FolderChange } from "./canvas-folders";
import { useCanvasHistory } from "./canvas-history";
import { DocumentCard, type DocumentNode } from "./document-card";
import { AddMemberDialog } from "@/features/workspace/add-member-dialog";
import { SignOut } from "@/features/auth/sign-out";
import { roles } from "@/lib/labels";
import {
  ReactFlow, Background, BackgroundVariant, Controls, MarkerType, ConnectionMode,
  useNodesState, useEdgesState, type Edge, type Connection, type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CanvasDecoration, ElementTools, useCanvasElements, type CanvasElement, type ElementNode } from "./canvas-elements";
import type { ReactFlowInstance } from "@xyflow/react";
import { api, type Workspace } from "@/lib/api";
import { type WorkspaceDocument } from "@/features/documents/api";

type Coordinates = { document_id: string; x: number; y: number };
type RelationKind = "REFERENCE" | "DERIVED_FROM" | "GENERATED_FROM" | "RELATED_TO";
type Relation = { id: string; source_document_id: string; target_document_id: string; relation_type: RelationKind; source_handle?: string; target_handle?: string };
type Snapshot = { conversions?: Conversion[]; elements?: CanvasElement[]; documents: WorkspaceDocument[]; positions: Coordinates[]; relations: Relation[] };
const labels: Record<RelationKind, string> = { REFERENCE: "참조", DERIVED_FROM: "파생", GENERATED_FROM: "생성 출처", RELATED_TO: "관련 문서" };

type CanvasNode = DocumentNode | ElementNode;
const nodeTypes = { document: DocumentCard, decoration: CanvasDecoration };
const mobileQuery = "(max-width: 760px)";
function subscribeViewport(callback: () => void) {
  const query = window.matchMedia(mobileQuery);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}
const mobileSnapshot = () => window.matchMedia(mobileQuery).matches;
const serverSnapshot = () => false;

export function WorkspaceCanvas({ workspace, revision }: { workspace: Workspace; revision: number }) {
  const history = useCanvasHistory();
  const isMobile = useSyncExternalStore(subscribeViewport, mobileSnapshot, serverSnapshot);

  const [showLabels, setShowLabels] = useState(true);
  const [showConnections, setShowConnections] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [writingOpen, setWritingOpen] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [preview, setPreview] = useState<WorkspaceDocument | null>(null);
  const [panel, setPanel] = useState<"documents" | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [edgeMenu, setEdgeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const relationEpoch = useRef(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const compact = isMobile ? !sidebarOpen : sidebarCompact;
  const chatToggle = useRef<HTMLButtonElement>(null);
  const mainArea = useRef<HTMLDivElement>(null);
  const fitOptions = { maxZoom: 1, padding: { top: "150px", bottom: "100px", left: compact ? "100px" : "300px", right: "24px" } } as const;
  function collapseChat() {
    setChatOpen(false);
    requestAnimationFrame(() => chatToggle.current?.focus());
  }
  const [uploadMenu, setUploadMenu] = useState(false);
  const [search, setSearch] = useState("");
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [uploadKey, setUploadKey] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const quickFile = useRef<HTMLInputElement>(null);
  const [members, setMembers] = useState<{ id: string; display_name: string; role: keyof typeof roles }[]>([]);
  const [memberError, setMemberError] = useState("");
  useEffect(() => { let active = true; api<typeof members>(`/workspaces/${workspace.id}/members`).then(items => { if (active) setMembers(items); }).catch((err: Error) => { if (active) setMemberError(err.message); }); return () => { active = false; }; }, [workspace.id]);
  useEffect(() => { if (panel) dialog.current?.showModal(); else dialog.current?.close(); }, [panel]);
  function openUpload(file?: File) { setDroppedFile(file || null); setUploadKey(v => v + 1); setUploadMenu(false); setPanel("documents"); setSidebarOpen(false); }
  const editable = workspace.role !== "VIEWER";
  const editing = editable && editMode && !history.busy;
  const elements = useCanvasElements(workspace.id, editing);
  const { hydrate: hydrateElements, epoch: elementEpoch } = elements;
  const flow = useRef<ReactFlowInstance<CanvasNode> | null>(null);
  const [nodes, setNodes, applyNodeChanges] = useNodesState<DocumentNode>([]);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [folderPreview, setFolderPreview] = useState<FolderChange[]>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [documents, setDocuments] = useState<WorkspaceDocument[]>([]);
  const [reload, setReload] = useState(0);
  const selection = useDocumentSelection(workspace.id, documents, flow as React.RefObject<ReactFlowInstance | null>, ids => {
    setNodes(current => current.map(node => ({ ...node, selected: ids.includes(node.id) })));
    elements.setNodes(current => current.map(node => ({ ...node, selected: false })));
  }, result => {
    setSearch("");
    setDocuments(current => [...current.filter(doc => doc.id !== result.document.id), result.document]);
    setNodes(current => [...current.filter(node => node.id !== result.document.id).map(node => ({ ...node, selected: false })), { id: result.document.id, type: "document", zIndex: 20, selected: true, ariaLabel: `문서: ${result.document.title}`, data: { document: result.document }, position: { x: result.x, y: result.y } }]);
    setReload(value => value + 1);
    const area = mainArea.current;
    if (flow.current && area) {
      const left = compact ? 100 : 300;
      const zoom = Math.min(1, Math.max(.1, (area.clientWidth - left - 24) / 280));
      void flow.current.setViewport({ x: (left + area.clientWidth - 24) / 2 - (result.x + 100) * zoom, y: area.clientHeight / 2 - (result.y + 122) * zoom, zoom }, { duration: 300 });
    }
  });
  const [conversions, setConversions] = useState<Conversion[]>([]);
  const conversionEpoch = useRef(0);
  const conversionChanged = useCallback((job: Conversion) => {
    conversionEpoch.current++;
    setConversions(current => [...current.filter(item => item.version_id !== job.version_id || item.format !== job.format), job]);
  }, []);
  const copyDocument = useCallback(async (document: WorkspaceDocument, versionId: string, requestId: string) => {
    const instance = flow.current;
    const origin = instance?.getNode(document.id)?.position || { x: 0, y: 0 };
    const others = instance?.getNodes() || [];
    const position = { x: Math.min(99600, origin.x + 300), y: Math.min(99500, origin.y + 40) };
    while (others.some(node => Math.abs(node.position.x - position.x) < 240 && Math.abs(node.position.y - position.y) < 320)) {
      position.y += 340;
      if (position.y > 99500) { position.y = -99500; position.x = Math.max(-99500, position.x - 300); }
    }
    const result = await api<{ document: WorkspaceDocument; x: number; y: number }>(`/documents/${document.id}/copy`, {
      method: "POST", body: JSON.stringify({ request_id: requestId, version_id: versionId, ...position }),
    });
    setSearch("");
    setDocuments(current => [...current.filter(doc => doc.id !== result.document.id), result.document]);
    setNodes(current => [...current.filter(node => node.id !== result.document.id).map(node => ({ ...node, selected: false })), {
      id: result.document.id, type: "document", zIndex: 20, ariaLabel: `문서: ${result.document.title}`, selected: true,
      data: { document: result.document }, position: { x: result.x, y: result.y },
    }]);
    setReload(value => value + 1);
    const area = mainArea.current;
    if (instance && area) {
      const left = isMobile ? 80 : (area.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect().right || 0) - area.getBoundingClientRect().left + 24;
      const zoom = Math.min(1, Math.max(.1, (area.clientWidth - left - 24) / 280));
      void instance.setViewport({ x: (left + area.clientWidth - 24) / 2 - (result.x + 100) * zoom, y: area.clientHeight / 2 - (result.y + 122) * zoom, zoom }, { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 350 });
    }
  }, [isMobile, setNodes]);
  const [relations, setRelations] = useState<Relation[]>([]);
  const relationSnapshot = useRef<Relation[]>([]);
  const moveOrigins = useRef(new Map<string, Coordinates>());
  const [loaded, setLoaded] = useState(false);
  const [referenceFocus, setReferenceFocus] = useState<{ sources: DocumentReference[]; sequence: number }>({ sources: [], sequence: 0 });
  const revealSources = useCallback((sources: DocumentReference[]) => {
    if (sources.length) setSearch("");
    setReferenceFocus(previous => ({ sources, sequence: previous.sequence + 1 }));
  }, []);
  const referenceVersions = useMemo(() => {
    const grouped = new Map<string, number[]>();
    for (const source of referenceFocus.sources) {
      const versions = grouped.get(source.document_id) || [];
      if (!versions.includes(source.version_number)) versions.push(source.version_number);
      grouped.set(source.document_id, versions);
    }
    return grouped;
  }, [referenceFocus]);
  const hasReferences = referenceFocus.sources.some(source => documents.some(doc => doc.id === source.document_id));
  useEffect(() => {
    if (!loaded || !hasReferences || !chatOpen) return;
    let frame = 0;
    const center = () => {
      const instance = flow.current;
      const area = mainArea.current;
      const target = referenceFocus.sources.map(source => instance?.getNode(source.document_id)).find(Boolean);
      if (!instance || !area || !target) return;
      // Center the paper in the usable canvas, excluding navigation and the chat dock.
      const sidebar = area.querySelector<HTMLElement>(".sidebar");
      const left = isMobile ? 16 : (sidebar?.getBoundingClientRect().right || 0) - area.getBoundingClientRect().left + 24;
      const top = isMobile ? 32 : 180;
      const bottom = isMobile ? 40 : 90;
      const zoom = Math.max(.1, Math.min(1, (area.clientWidth - left - 24) / 260, (area.clientHeight - top - bottom) / 300));
      const x = (left + area.clientWidth - 24) / 2 - (target.position.x + 100) * zoom;
      const y = (top + area.clientHeight - bottom) / 2 - (target.position.y + 122) * zoom;
      void instance.setViewport({ x, y, zoom }, { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 550 });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(center); };
    const observer = new ResizeObserver(schedule);
    if (mainArea.current) observer.observe(mainArea.current);
    schedule();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [referenceFocus, hasReferences, loaded, chatOpen, compact, isMobile]);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [actionError, setActionError] = useState("");
  const [saveState, setSaveState] = useState("모든 변경사항 저장됨");
  const [kind, setKind] = useState<RelationKind>("REFERENCE");
  const [actionBusy, setActionBusy] = useState(false);
  const pending = useRef(new Map<string, Coordinates>());
  const saving = useRef(false);
  const inFlight = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const writeEpoch = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const warn = (event: BeforeUnloadEvent) => {
      if (pending.current.size || saving.current) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); window.removeEventListener("beforeunload", warn); };
  }, []);

  const flush = useCallback(async function savePending() {
    if (saving.current || !pending.current.size || !mounted.current) return;
    const batch = [...pending.current.values()].slice(0, 100);
    batch.forEach(item => pending.current.delete(item.document_id));
    inFlight.current = new Set(batch.map(item => item.document_id));
    saving.current = true; setSaveState("위치 저장 중…"); setSaveError("");
    let succeeded = false;
    try {
      await api<Coordinates[]>(`/workspaces/${workspace.id}/canvas/positions`, { method: "PATCH", body: JSON.stringify({ positions: batch }) });
      succeeded = true;
      if (mounted.current) setSaveState(pending.current.size ? "저장 대기 중" : "모든 변경사항 저장됨");
    } catch (error) {
      batch.forEach(item => { if (!pending.current.has(item.document_id)) pending.current.set(item.document_id, item); });
      if (mounted.current) { setSaveState("위치 저장 실패"); setSaveError(error instanceof Error ? error.message : "위치를 저장하지 못했습니다."); }
    } finally {
      saving.current = false; inFlight.current.clear(); writeEpoch.current++;
      if (succeeded && pending.current.size && mounted.current) await savePending();
    }
  }, [workspace.id]);

  useEffect(() => {
    let active = true;
    const epoch = writeEpoch.current;
    const edgesEpoch = relationEpoch.current;
    const decorationEpoch = elementEpoch.current;
    const exportsEpoch = conversionEpoch.current;
    api<Snapshot>(`/workspaces/${workspace.id}/canvas`).then(snapshot => {
      if (!active) return;
      if (exportsEpoch === conversionEpoch.current) setConversions(snapshot.conversions || []);
      setDocuments(snapshot.documents); setLoaded(true); setLoadError("");
      setNodes(current => snapshot.documents.map((doc, index) => {
        const old = current.find(node => node.id === doc.id);
        const stored = snapshot.positions.find(position => position.document_id === doc.id);
        const keepLocal = old?.dragging || pending.current.has(doc.id) || inFlight.current.has(doc.id) || epoch !== writeEpoch.current;
        return { id: doc.id, type: "document", zIndex: 20, ariaLabel: `문서: ${doc.title}`, selected: old?.selected, dragging: old?.dragging,
          data: { document: doc }, position: old && keepLocal ? old.position : stored ? { x: stored.x, y: stored.y } : { x: (index % 3) * 390, y: Math.floor(index / 3) * 370 } };
      }));
      if (edgesEpoch === relationEpoch.current) { relationSnapshot.current = snapshot.relations; setRelations(snapshot.relations); setEdges(snapshot.relations.map(edgeFor)); }
      hydrateElements(snapshot.elements || [], decorationEpoch);
    }).catch((error: Error) => { if (active) setLoadError(error.message); });
    return () => { active = false; };
  }, [workspace.id, revision, reload, setNodes, setEdges, hydrateElements, elementEpoch]);

  useEffect(() => {
    if (!documents.some(doc => doc.versions.some(v => ["UPLOADED", "PROCESSING"].includes(v.status))) && !conversions.some(job => ["QUEUED", "RUNNING"].includes(job.state))) return;
    const interval = setInterval(() => setReload(value => value + 1), 5000);
    return () => clearInterval(interval);
  }, [documents, conversions]);

  async function restorePositions(positions: Coordinates[]) {
    if (timer.current) clearTimeout(timer.current);
    for (const position of positions) pending.current.set(position.document_id, position);
    writeEpoch.current++;
    setNodes(current => current.map(node => {
      const position = positions.find(item => item.document_id === node.id);
      return position ? { ...node, position: { x: position.x, y: position.y } } : node;
    }));
    setSaveState("저장 대기 중");
    await flush();
    if (positions.some(position => pending.current.has(position.document_id))) throw new Error("위치를 저장하지 못했습니다. 다시 눌러 재시도할 수 있습니다.");
  }

  function onNodesChange(changes: NodeChange<DocumentNode>[]) {
    if (editing) {
      const before: Coordinates[] = [];
      const after: Coordinates[] = [];
      const moving: { id: string; origin: { x: number; y: number }; position: { x: number; y: number } }[] = [];
      let draggingFiles = false;
      for (const change of changes) {
        if (change.type !== "position" || !change.position) continue;
        const old = nodes.find(node => node.id === change.id);
        if (!old) continue;
        if (!moveOrigins.current.has(change.id)) moveOrigins.current.set(change.id, { document_id: change.id, ...old.position });
        const origin = moveOrigins.current.get(change.id)!;
        moving.push({ id: change.id, origin, position: change.position });
        if (change.dragging === true) { draggingFiles = true; continue; }
        moveOrigins.current.delete(change.id);
        if (origin.x === change.position.x && origin.y === change.position.y) continue;
        before.push(origin); after.push({ document_id: change.id, ...change.position });
      }
      const plan = planFolderMove(elements.nodes, nodes, moving);
      const expansions = plan.changes;
      if (moving.length) {
        setFolderPreview(draggingFiles ? expansions : []);
        if (!draggingFiles && before.length) {
          if (plan.tooLarge) setActionError("폴더의 최대 크기를 넘습니다. 파일을 폴더 안쪽으로 조금 더 옮겨 주세요.");
          for (const expansion of expansions) elements.edit(expansion.id, expansion.after);
        }
      }
      async function restore(positions: Coordinates[], direction: "before" | "after") {
        await restorePositions(positions);
        for (const expansion of expansions) elements.edit(expansion.id, expansion[direction]);
        if (expansions.length && !await elements.flush()) throw new Error("폴더 크기를 저장하지 못했습니다. 다시 눌러 재시도할 수 있습니다.");
      }
      if (before.length) history.record({ label: "파일 이동", undo: () => restore(before, "before"), redo: () => restore(after, "after") });
    }
    applyNodeChanges(changes);
    if (!editing) return;
    for (const change of changes) {
      if (change.type !== "position" || !change.position || change.dragging === true) continue;
      const { x, y } = change.position;
      pending.current.set(change.id, { document_id: change.id, x, y });
      writeEpoch.current++;
      setSaveState("저장 대기 중");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 400);
    }
  }

  function toggleEditing() {
    selection.close();
    setFolderPreview([]);
    if (editing) { void flush(); void elements.flush(); }
    setEditMode(!editMode); setEdgeMenu(null); setActionError("");
    elements.setNodes(current => current.map(node => ({ ...node, selected: false })));
    setNodes(current => current.map(node => ({ ...node, selected: false })));
    setEdges(current => current.map(edge => ({ ...edge, selected: false })));
  }

  function putRelation(relation: Relation) {
    relationEpoch.current++;
    relationSnapshot.current = [...relationSnapshot.current.filter(item => item.id !== relation.id && !sameRelation(item, relation)), relation];
    setRelations(relationSnapshot.current);
    setEdges(relationSnapshot.current.map(edgeFor));
  }
  function forgetRelation(id: string) {
    relationEpoch.current++;
    relationSnapshot.current = relationSnapshot.current.filter(item => item.id !== id);
    setRelations(relationSnapshot.current);
    setEdges(relationSnapshot.current.map(edgeFor));
    setEdgeMenu(null);
  }
  async function restoreRelation(wanted: Relation | null, identity: Relation) {
    setActionError(""); setEdgeMenu(null);
    if (wanted) {
      const relation = await api<Relation>(`/workspaces/${workspace.id}/relations`, { method: "POST", body: JSON.stringify({ source_document_id: wanted.source_document_id, target_document_id: wanted.target_document_id, relation_type: wanted.relation_type, source_handle: wanted.source_handle || "right", target_handle: wanted.target_handle || "left" }) });
      putRelation(relation);
    } else {
      // Restoring a deleted relation can give it a new server ID. Resolve by its logical identity.
      const current = relationSnapshot.current.find(item => sameRelation(item, identity));
      if (!current) return;
      await api<void>(`/workspaces/${workspace.id}/relations/${current.id}`, { method: "DELETE" });
      forgetRelation(current.id);
    }
  }

  async function connect(connection: Pick<Connection, "source" | "target" | "sourceHandle" | "targetHandle">) {
    if (!editing || !connection.source || !connection.target || connection.source === connection.target || actionBusy) return;
    setActionBusy(true); setActionError("");
    const previous = relationSnapshot.current.find(item => item.source_document_id === connection.source && item.target_document_id === connection.target && item.relation_type === kind) || null;
    try {
      const relation = await api<Relation>(`/workspaces/${workspace.id}/relations`, { method: "POST", body: JSON.stringify({ source_document_id: connection.source, target_document_id: connection.target, relation_type: kind, source_handle: connection.sourceHandle || "right", target_handle: connection.targetHandle || "left" }) });
      putRelation(relation);
      if (!previous || (previous.source_handle || "right") !== (relation.source_handle || "right") || (previous.target_handle || "left") !== (relation.target_handle || "left")) {
        history.record({ label: previous ? "연결 방향 변경" : "연결 추가", undo: () => restoreRelation(previous, relation), redo: () => restoreRelation(relation, relation) });
      }
    } catch (error) { setActionError(error instanceof Error ? error.message : "문서를 연결하지 못했습니다."); }
    finally { setActionBusy(false); }
  }

  async function removeRelation(id: string) {
    if (!editing || actionBusy) return;
    const previous = relationSnapshot.current.find(item => item.id === id);
    if (!previous) return;
    setActionBusy(true); setActionError("");
    try {
      await api<void>(`/workspaces/${workspace.id}/relations/${id}`, { method: "DELETE" });
      forgetRelation(id);
      history.record({ label: "연결 삭제", undo: () => restoreRelation(previous, previous), redo: () => restoreRelation(null, previous) });
    } catch (error) { setActionError(error instanceof Error ? error.message : "연결을 삭제하지 못했습니다."); }
    finally { setActionBusy(false); }
  }

  const jobsByVersion = useMemo(() => {
    const grouped = new Map<string, Conversion[]>();
    for (const job of conversions) grouped.set(job.version_id, [...(grouped.get(job.version_id) || []), job]);
    return grouped;
  }, [conversions]);
  const connectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const relation of relations) {
      counts.set(relation.source_document_id, (counts.get(relation.source_document_id) || 0) + 1);
      counts.set(relation.target_document_id, (counts.get(relation.target_document_id) || 0) + 1);
    }
    return counts;
  }, [relations]);
  const selectedElement = elements.nodes.find(node => node.selected)?.data.element;
  const displayedElements = elements.nodes.map(node => {
    const preview = editing ? folderPreview.find(item => item.id === node.data.element.id) : undefined;
    if (node.data.element.kind !== "rectangle") return node;
    return { ...(preview ? applyFolderBounds(node, preview.after) : node), className: `folder-animated ${node.dragging || node.resizing ? "folder-direct-manipulation" : ""} ${preview ? "folder-drop-preview" : ""}` };
  });
  const folders = folderMembership(displayedElements, nodes);
  const folderOverview = canvasZoom < .38 && !editing && !selection.active && !search && !(chatOpen && hasReferences);
  const hiddenInFolder = (id: string) => folderOverview && folders.owner.has(id);
  function openFolder(node: ElementNode) {
    const area = mainArea.current;
    if (!area || !flow.current) return;
    const left = compact ? 100 : 300;
    const zoom = Math.max(.55, Math.min(1, (area.clientWidth - left - 24) / (node.data.element.width + 80), (area.clientHeight - 260) / (node.data.element.height + 80)));
    void flow.current.setViewport({ x: (left + area.clientWidth - 24) / 2 - (node.position.x + node.data.element.width / 2) * zoom, y: (area.clientHeight + 80) / 2 - (node.position.y + node.data.element.height / 2) * zoom, zoom }, { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 350 });
  }
  const folderNodes = displayedElements.map(node => node.data.element.kind === "rectangle" ? { ...node, data: { ...node.data, folder: { titles: (folders.members.get(node.id) || []).map(member => member.data.document.title), overview: folderOverview, open: () => openFolder(node), select: () => { elements.setNodes(current => current.map(item => ({ ...item, selected: item.id === node.id }))); setNodes(current => current.map(item => ({ ...item, selected: false }))); } } } } : node);
  function matchesSearch(node: DocumentNode) {
    const query = search.toLocaleLowerCase();
    const folder = elements.nodes.find(element => element.id === folders.owner.get(node.id));
    return node.data.document.title.toLocaleLowerCase().includes(query) || !!folder?.data.element.text.toLocaleLowerCase().includes(query);
  }
  const activeRelation = editing && edgeMenu && showConnections ? relations.find(item => item.id === edgeMenu.id) : undefined;
  const historyBlocked = history.busy || actionBusy || saveState === "위치 저장 중…" || nodes.some(node => node.dragging);
  const titleFor = (id: string) => documents.find(doc => doc.id === id)?.title || "문서";
  return <section className={`workspace-canvas ${editable && editMode ? "has-edit-mode" : ""} ${selection.active ? "is-selecting" : ""} ${editing ? "is-editing" : "is-browsing"} ${compact ? "sidebar-compact" : ""} ${chatOpen ? "chat-open" : ""} ${hasReferences ? "has-ai-references" : ""}`} aria-label="문서 워크스페이스"
    onKeyDown={event => {
      if (event.key === "Escape" && selection.active) { selection.close(); return; }
      if (!editable || selection.active || historyBlocked || event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable=true],dialog,.chat-panel")) return;
      const key = event.key.toLowerCase();
      const direction = key === "z" ? (event.shiftKey ? "redo" : "undo") : key === "y" && event.ctrlKey ? "redo" : null;
      if (direction) { event.preventDefault(); event.stopPropagation(); void history.run(direction); }
    }}
    onDragEnter={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); dragDepth.current++; if (editable) setDragging(true); } }}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = editable ? "copy" : "none"; } }}
    onDragLeave={event => { event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); if (editable && event.dataTransfer.files[0]) openUpload(event.dataTransfer.files[0]); }}>
    <div className="workspace-main" ref={mainArea}>
    <div className="canvas-surface" aria-label="문서 캔버스">
      <ReactFlow<CanvasNode> nodes={[...folderNodes, ...nodes.map(node => ({ ...node, data: { ...node.data, onCopy: editable ? copyDocument : undefined, reference: referenceVersions.has(node.id) ? { versions: referenceVersions.get(node.id)!, sequence: referenceFocus.sequence } : undefined, conversions: node.data.document.versions.flatMap(version => jobsByVersion.get(version.id) || []), onConversion: conversionChanged, connectionCount: connectionCounts.get(node.id) || 0 }, hidden: hiddenInFolder(node.id) || (!!search && !matchesSearch(node)) }))]} onInit={instance => { flow.current = instance; setCanvasZoom(instance.getZoom()); }} onMove={(_, viewport) => setCanvasZoom(viewport.zoom)} elevateNodesOnSelect={false} edges={edges.map(edge => ({ ...edge, label: showLabels ? edge.label : undefined, hidden: !showConnections || hiddenInFolder(edge.source) || hiddenInFolder(edge.target) }))} nodeTypes={nodeTypes} onNodesChange={changes => { onNodesChange(changes.filter(change => "id" in change && !change.id.startsWith("element:")) as NodeChange<DocumentNode>[]); elements.onChanges(changes.filter(change => "id" in change && change.id.startsWith("element:")) as NodeChange<ElementNode>[]); }} onEdgesChange={onEdgesChange}
        connectionMode={ConnectionMode.Loose} isValidConnection={connection => connection.source !== connection.target}
        onConnect={connection => void connect(connection)} onNodeClick={(_, node) => { setEdgeMenu(null); if (!selection.active && node.type === "document") setPreview(node.data.document); }}
        onPaneClick={() => setEdgeMenu(null)} onMoveStart={() => setEdgeMenu(null)}
        onEdgeClick={(event, edge) => { if (editing) { setActionError(""); setEdgeMenu({ id: edge.id, x: Math.max(12, Math.min(event.clientX, window.innerWidth - 272)), y: Math.max(12, Math.min(event.clientY, window.innerHeight - 232)) }); elements.setNodes(current => current.map(node => ({ ...node, selected: false }))); } }}
        nodesDraggable={editing && !selection.active} nodesConnectable={editing && !selection.active && !actionBusy} elementsSelectable
        deleteKeyCode={null} selectionOnDrag={false} multiSelectionKeyCode={null} fitView fitViewOptions={fitOptions}
        ariaLabelConfig={{ 'controls.ariaLabel': '캔버스 보기 도구', 'handle.ariaLabel': '문서 연결점', 'node.a11yDescription.ariaLiveMessage': ({ x, y }) => `문서 위치가 가로 ${x}, 세로 ${y}로 변경되었습니다.`, 'controls.zoomIn.ariaLabel': '확대', 'controls.zoomOut.ariaLabel': '축소', 'controls.fitView.ariaLabel': '전체 보기', 'node.a11yDescription.default': 'Enter 키로 문서를 선택하세요. 방향키로 문서를 이동합니다.', 'node.a11yDescription.keyboardDisabled': 'Enter 키로 문서를 선택하세요.', 'edge.a11yDescription.default': '문서 연결선입니다.' }}
        minZoom={.1} maxZoom={2} nodeExtent={[[-100000, -100000], [100000, 100000]]}>
        <Background variant={BackgroundVariant.Lines} gap={28} color="var(--grid)" />
      {selection.active && <SelectionArea active busy={selection.busy} flow={flow as React.RefObject<ReactFlowInstance | null>} onSelect={selection.choose} />}
        <Controls showInteractive={false} position="bottom-center" fitViewOptions={fitOptions}>{editable && loaded && selection.toggle}</Controls>
      </ReactFlow>
      {loaded && documents.length === 0 && elements.nodes.length === 0 && <div className="canvas-empty"><div className="empty-symbol"><LuFiles /></div><span className="eyebrow">함께 연결하는 지식</span><h2>첫 문서에서 시작해 보세요</h2><p>파일을 이곳에 끌어다 놓으면<br />팀의 생각이 하나의 공간으로 연결됩니다.</p>{editable && <button className="primary" onClick={() => openUpload()}><LuPlus /> 문서 추가</button>}<small>PDF · DOCX · HWPX · TXT · Markdown</small></div>}
    </div>
    <ElementTools selected={selectedElement} editable={editing && !selection.active} busy={!loaded || elements.busy}
      add={kind => { setEdgeMenu(null); const position = flow.current?.screenToFlowPosition({ x: ((mainArea.current?.clientWidth || window.innerWidth) + (compact ? 80 : 280)) / 2, y: window.innerHeight / 2 }); if (position) { setNodes(current => current.map(n => ({ ...n, selected: false }))); void elements.add(kind, { x: Math.max(-100000, Math.min(100000, position.x - 140)), y: Math.max(-100000, Math.min(100000, position.y - 70)) }); } }}
      edit={elements.edit} remove={id => void elements.remove(id)} clear={() => elements.setNodes(current => current.map(n => ({ ...n, selected: false })))} />
    {selection.actions}
    <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="주 메뉴" id="workspace-navigation">
      <Link className="brand" href="/workspaces" aria-label="ConText 홈" title="ConText"><BrandLogo responsive /></Link>
      <button className="icon-button sidebar-toggle" aria-label={compact ? "메뉴 펼치기" : "메뉴 접기"} title={compact ? "메뉴 펼치기" : "메뉴 접기"} aria-expanded={!compact} aria-controls="workspace-navigation" onClick={() => isMobile ? setSidebarOpen(value => !value) : setSidebarCompact(value => !value)}>{compact ? <LuPanelLeftOpen /> : <LuPanelLeftClose />}</button>
      <Link href="/workspaces" className="workspace-switch" aria-label={`${workspace.name} · 워크스페이스 전환`} title={workspace.name}><span className="workspace-monogram">{workspace.name.slice(0, 1)}</span><span>{workspace.name}<small>{roles[workspace.role]} 워크스페이스</small></span><LuChevronDown /></Link>
      <p className="nav-caption">워크스페이스</p>
      <nav aria-label="워크스페이스 메뉴"><button className="nav-item active" aria-label="캔버스" title="캔버스" onClick={() => { setEdgeMenu(null); setSidebarOpen(false); }}><LuLayoutDashboard /><span className="sidebar-label">캔버스</span> <span className="nav-count">{documents.length}</span></button>
        <button className="nav-item" aria-label="문서 관리" title="문서 관리" onClick={() => openUpload()}><LuFiles /><span className="sidebar-label">문서 관리</span></button>
        <button className="nav-item" aria-label="AI 문서 작성" title="AI 문서 작성" onClick={() => { setWritingOpen(true); setSidebarOpen(false); }}><LuPencil /><span className="sidebar-label">AI 문서 작성</span></button>
        <button className={`nav-item ${chatOpen ? "selected" : ""}`} aria-label="AI 채팅" title="AI 채팅" aria-expanded={chatOpen} aria-controls="workspace-chat" onClick={() => { setChatOpen(value => !value); setSidebarOpen(false); }}><LuMessageCircle /><span className="sidebar-label">AI 채팅</span></button>
      </nav>
      <div className="sidebar-team"><p className="nav-caption"><LuUsers /><span className="sidebar-label team-caption">함께하는 팀원</span><span className="team-count">{members.length}</span>{workspace.role === "OWNER" && <button className="icon-button add-member-button" aria-label="팀원 추가" title="팀원 추가" onClick={() => { setAddingMember(true); setSidebarOpen(false); }}><LuUserPlus /></button>}</p>
        {memberError && <p role="alert" className="error">{memberError}</p>}
        <ul className="member-list">{members.map((member, i) => <li key={member.id} title={`${member.display_name} · ${roles[member.role]}`}><span className={`avatar avatar-${i % 4}`}>{member.display_name.slice(0, 1)}</span><span>{member.display_name}<small>{roles[member.role]}</small></span></li>)}</ul>
      </div>
      <div className="sidebar-bottom"><span className="sidebar-label"><span className="online-dot" /> 나의 팀 문서 공간</span><SignOut compact={compact} /></div>
    </aside>
    <header className="canvas-header"><div className="canvas-title"><button className="icon-button mobile-menu" aria-label="메뉴 열기" onClick={() => setSidebarOpen(true)}><LuMenu /></button><div><p className="eyebrow">워크스페이스 / 캔버스</p><h1>{workspace.name}</h1></div></div>
      <div className="header-actions"><label className="search-box"><LuSearch /><input aria-label="문서 검색" placeholder="문서 검색" value={search} onChange={event => setSearch(event.target.value)} /></label>
        {editable && <button type="button" className={`icon-button canvas-edit-toggle ${editing ? "active" : ""}`} aria-label={editing ? "캔버스 수정 완료" : "캔버스 수정"} title={editing ? "수정 완료" : "캔버스 수정"} aria-pressed={editing} disabled={!loaded || actionBusy || elements.busy || history.busy || selection.busy} onClick={toggleEditing}>{editing ? <LuCheck /> : <LuPencil />}</button>}
        {editable && <div className="canvas-history-tools" role="group" aria-label="캔버스 실행 취소와 다시 실행"><button type="button" className="icon-button" aria-label="되돌리기" title={history.undoLabel ? `${history.undoLabel} 되돌리기 (Ctrl/⌘+Z)` : "파일 이동·연결 되돌리기"} disabled={selection.active || historyBlocked || !history.undoLabel} onClick={() => void history.run("undo")}><LuUndo2 /></button><button type="button" className="icon-button" aria-label="다시 실행" title={history.redoLabel ? `${history.redoLabel} 다시 실행 (Ctrl/⌘+Shift+Z)` : "다시 실행"} disabled={selection.active || historyBlocked || !history.redoLabel} onClick={() => void history.run("redo")}><LuRedo2 /></button></div>}
        <button type="button" className="icon-button reference-toggle" aria-label={showLabels ? "참조 표시 숨기기" : "참조 표시 보이기"} title={showLabels ? "참조 표시 숨기기" : "참조 표시 보이기"} aria-pressed={!showLabels} onClick={() => setShowLabels(value => !value)}>{showLabels ? <LuEye /> : <LuEyeOff />}</button>
        <button type="button" className="icon-button" aria-label="캔버스 새로고침" title="캔버스 새로고침" disabled={saveState !== "모든 변경사항 저장됨" || actionBusy} onClick={() => setReload(value => value + 1)}><LuRefreshCw /></button>
        {editable && <div className="upload-actions"><button className="primary upload-icon" aria-label="파일 선택하여 올리기" onClick={() => quickFile.current?.click()}><LuPlus /><span>문서 추가</span></button><button className="primary upload-chevron" aria-label="업로드 메뉴" aria-expanded={uploadMenu} onClick={() => setUploadMenu(v => !v)}><LuChevronDown /></button>
          {uploadMenu && <div className="upload-menu"><button onClick={() => quickFile.current?.click()}><LuUpload /> 파일에서 업로드</button><button onClick={() => openUpload()}><LuFiles /> 업로드 및 문서 관리</button><p>파일을 캔버스에 끌어 놓아도 됩니다.</p></div>}
        </div>}
      </div>
    </header>
    {editable && <input ref={quickFile} className="visually-hidden" tabIndex={-1} aria-label="빠른 파일 선택" type="file" accept=".pdf,.docx,.hwpx,.txt,.md" onChange={event => { const file = event.target.files?.[0]; if (file) openUpload(file); event.target.value = ""; }} />}
    <div className="canvas-notices">
      {elements.error && <p className="error" role="alert">{elements.error} <button className="text-button" onClick={() => void elements.flush()}>텍스트·도형 저장 재시도</button></p>}
      {!loaded && !loadError && <p role="status">캔버스를 불러오는 중…</p>}
      {saveError && <p role="alert" className="error">{saveError} <button className="text-button" onClick={() => void flush()}>위치 저장 재시도</button></p>}
      {loadError && <p role="alert" className="error">{loadError}</p>}
      {history.error && <p role="alert" className="error">{history.error}</p>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      {search && !nodes.some(n => n.data.document.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <p role="status">검색 결과가 없습니다.</p>}
    </div>
    <footer className="canvas-footer"><span role="status">{elements.status}</span><span role="status"><span className="online-dot" />{editing ? saveState : "둘러보기 모드"}</span><span className="canvas-hint">{editing ? "요소를 끌어 이동 · 연결선을 눌러 옵션 보기" : "문서를 눌러 미리보기 · 스크롤하여 확대/축소"}</span></footer>
    {editing && !selection.active && !selectedElement && <div className="canvas-edit-options" aria-label="연결 편집 설정"><label htmlFor="canvas-relation-type">새 연결 유형</label><select id="canvas-relation-type" aria-label="연결 유형" value={kind} disabled={actionBusy} onChange={event => setKind(event.target.value as RelationKind)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><label className="connection-visibility"><input type="checkbox" checked={showConnections} onChange={event => { setShowConnections(event.target.checked); setEdgeMenu(null); }} /> 연결선 표시</label><small>문서의 상하좌우 점을 이어 연결하세요.</small></div>}
    {activeRelation && edgeMenu && <ConnectionOptions relation={activeRelation} x={edgeMenu.x} y={edgeMenu.y} source={titleFor(activeRelation.source_document_id)} target={titleFor(activeRelation.target_document_id)} busy={actionBusy} error={actionError} onClose={() => setEdgeMenu(null)} onDelete={() => void removeRelation(activeRelation.id)} />}
    <dialog ref={dialog} className="document-dialog" onCancel={() => setPanel(null)} onClose={() => setPanel(null)}><div className="panel-heading"><span className="eyebrow">워크스페이스 문서</span><button className="icon-button" aria-label="문서 관리 닫기" onClick={() => setPanel(null)}><LuX /></button></div><div className="panel-scroll">{panel && <DocumentPanel key={uploadKey} workspace={workspace} initialFile={droppedFile} onPreview={doc => { setPanel(null); setPreview(doc); }} onChange={() => setReload(v => v + 1)} />}</div></dialog>
    {preview && <DocumentPreview document={documents.find(doc => doc.id === preview.id) || preview} editable={editable} onClose={() => { setPreview(null); setReload(value => value + 1); }} onChange={() => setReload(v => v + 1)} />}
    {addingMember && <AddMemberDialog workspaceId={workspace.id} onClose={() => setAddingMember(false)} onAdded={member => { setMemberError(""); setMembers(current => [...current.filter(item => item.id !== member.id), member]); }} />}
    {dragging && <div className="drop-overlay"><LuUpload /><h2>여기에 파일을 놓아 주세요</h2><p>문서를 확인한 뒤 업로드를 시작합니다.</p></div>}
    </div>
    <button ref={chatToggle} className="chat-launcher" aria-label="AI 채팅 펼치기" title="AI 채팅 펼치기" aria-expanded={chatOpen} aria-controls="workspace-chat" hidden={chatOpen} onClick={() => setChatOpen(true)}><LuPanelRightOpen /><LuMessageCircle /><span>AI</span></button>
    <ChatPanel workspace={workspace} open={chatOpen} onClose={collapseChat} onRevealSources={revealSources} />
    {writingOpen && <WritingStudio workspace={workspace} onClose={() => setWritingOpen(false)} />}
  </section>;
}

function sameRelation(a: Relation, b: Relation) {
  return a.source_document_id === b.source_document_id && a.target_document_id === b.target_document_id && a.relation_type === b.relation_type;
}

function edgeFor(relation: Relation) {
  return { id: relation.id, source: relation.source_document_id, target: relation.target_document_id,
    sourceHandle: relation.source_handle || "right", targetHandle: relation.target_handle || "left",
    type: "smoothstep", label: labels[relation.relation_type], markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "var(--primary)", strokeWidth: 2 }, labelStyle: { fontSize: 12, fill: "var(--primary-strong)" } };
}

function ConnectionOptions({ relation, x, y, source, target, busy, error, onClose, onDelete }: { relation: Relation; x: number; y: number; source: string; target: string; busy: boolean; error: string; onClose: () => void; onDelete: () => void }) {
  const popup = useRef<HTMLElement>(null);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    const outside = (event: PointerEvent) => { if (event.target instanceof globalThis.Node && !popup.current?.contains(event.target)) onClose(); };
    document.addEventListener("keydown", close, true); document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", close, true); document.removeEventListener("pointerdown", outside); };
  }, [onClose]);
  return <aside ref={popup} className="connection-options" role="dialog" aria-label="연결 옵션" style={{ left: x, top: y }}><div className="connection-options-heading"><strong>{labels[relation.relation_type]} 연결</strong><button className="icon-button" aria-label="연결 옵션 닫기" onClick={onClose}><LuX /></button></div><p>{source} <LuArrowUpRight /> {target}</p><button className="connection-delete" disabled={busy} onClick={onDelete}><LuTrash2 /> {busy ? "삭제 중…" : "연결 삭제"}</button>{error && <p className="error" role="alert">{error}</p>}</aside>;
}
