"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ControlButton, ConnectionMode, applyNodeChanges, type Connection, type NodeChange, type ReactFlowInstance } from '../shared/canvas/react-flow';
import { LuPencil, LuCheck, LuUndo2, LuRedo2, LuEye, LuEyeOff, LuSquareDashedMousePointer, LuLayoutGrid } from 'react-icons/lu';
import { useFolderVisibility } from '../shared/canvas/use-folder-visibility';
import { projectFolders } from '../shared/canvas/folder-projection';
import { planInsertion, type PlacementBox, type PlacementShift } from '../shared/canvas/local-placement';
import { settledCanvas } from '../shared/canvas/settled-canvas';
import { CanvasDock } from '../shared/canvas/canvas-dock';
import { CanvasSurface } from '../shared/canvas/canvas-surface';
import { CanvasDecoration, ElementTools, useCanvasElements, type ElementNode } from '../shared/canvas/canvas-elements';
import { useCanvasHistory } from '../shared/canvas/canvas-history';
import { folderMembership, planFolderMove } from '../shared/canvas/canvas-folders';
import { SelectionActions } from '../shared/canvas/selection-actions';
import { SelectionArea } from '../shared/canvas/selection-area';
import { ConnectionOptions, edgeFor } from '../shared/canvas/relations';
import { relationLabels, type CanvasElement, type CanvasElementRepository, type CanvasRelation, type RelationKind } from '../shared/core/canvas';
import { FileCard, paperHandles, type FileNode } from './file-card';
import { useWorkspaceRuntime, type Entry, type Snapshot, type Viewport } from './runtime';
import { FolderArea, type FolderAreaNode } from '../shared/canvas/folder-area';
import { spatialEntries, spatialLayout, storedPosition, referenceScene } from '../shared/canvas/spatial-layout';
const spatialView = ':spatial:readable';
const nodeTypes = { file: FileCard, directory: FolderArea, decoration: CanvasDecoration };
type EntryNode = FileNode | FolderAreaNode;
type CanvasNode = EntryNode | ElementNode;
export type CreateCanvasFile = (create: () => Promise<Entry>, name: string) => Promise<Entry>;
type Revisioned<T> = T & { revision: number };
type Position = { id: string; x: number; y: number };

export function WorkspaceCanvas({ snapshot, directory, navigationSequence, onFocusDirectory, query, limit, inspect, enter, error, rememberView, rememberPositions, rememberEntry, toolbarHost, topInset, onFlushReady, referenceIds, referenceSequence, onClearReferences, onCreateFileReady }: {
  onCreateFileReady: (create: CreateCanvasFile | undefined) => void;
  snapshot: Snapshot; directory: string; navigationSequence: number; onFocusDirectory: (directory: string) => void; query: string; limit: number; inspect: (entry: Entry) => void; enter: (entry: Entry) => void; error: (text: string) => void;
  rememberView: (id: string, directory: string, view: Viewport) => void; rememberPositions: (id: string, positions: Position[]) => void;
  rememberEntry: (entry: Entry) => void;
  toolbarHost: HTMLDivElement | null;
  topInset: number;
  onFlushReady: (flush: (() => Promise<boolean>) | undefined) => void;
  referenceIds: string[]; referenceSequence: number; onClearReferences: () => void;
}) {
  const api = useWorkspaceRuntime();
  const [dockHost, setDockHost] = useState<HTMLDivElement | null>(null);
  const [layoutMotion, setLayoutMotion] = useState(false);
  const motionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const creationDirectory = useRef<string | undefined>(undefined);
  const [pendingFile, setPendingFile] = useState<{ name: string; directory: string; existing: Set<string>; hideNew?: boolean }>();
  useEffect(() => () => { if (motionTimer.current) clearTimeout(motionTimer.current); }, []);
  const workspaceId = snapshot.workspace.id;
  const flow = useRef<ReactFlowInstance<CanvasNode> | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const starts = useRef(new Map<string, { x: number; y: number }>());
  const cache = useRef(new Map<string, Revisioned<CanvasElement>>());
  const [owners] = useState(() => new Map<string, string>());
  const relationOwners = useRef(new Map<string, string>());
  const [ready, setReady] = useState(false);
  const navigated = useRef(-1);
  const initialView = useRef(false);
  const navigationEpoch = useRef(0), programmaticView = useRef(false), mounted = useRef(true);
  const navigationTarget = useRef<Viewport | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const history = useCanvasHistory();
  const [editing, setEditing] = useState(!query && !!snapshot.spatial_editing), [selecting, setSelecting] = useState(false), [showLabels, setShowLabels] = useState(true);
  const [nodes, setNodes] = useState<EntryNode[]>([]), [relations, setRelations] = useState<Revisioned<CanvasRelation>[]>([]);
  const [kind, setKind] = useState<RelationKind>('REFERENCE'), [busy, setBusy] = useState(false);
  const [edgeMenu, setEdgeMenu] = useState<{ id: string; x: number; y: number }>();
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const transferring = useRef(false);
  const [zoom, setZoom] = useState(() => snapshot.views.find(view => view.directory === spatialView)?.zoom || .8);
  const [summaryBusy, setSummaryBusy] = useState(false), [summaryError, setSummaryError] = useState('');
  const focused = useRef(0);
  const referenceViewport = useRef<{ view: Viewport; navigation: number } | null>(null);
  const restoringReferences = useRef(false);
  const referenceMode = referenceIds.length > 0;
  const summaryRequest = useRef<{ signature: string; request_id: string; x: number; y: number } | null>(null);
  const repository = useMemo<CanvasElementRepository>(() => ({
    create: async value => { const owner = creationDirectory.current ?? directory; const result = await api.putCanvasItem(workspaceId, owner, 'element', value, 0); cache.current.set(value.id, result); owners.set(value.id, owner); return result; },
    update: async (id, patch) => {
      const current = cache.current.get(id); if (!current) throw new Error('요소를 새로 불러와 주세요.');
      const result = await api.putCanvasItem(workspaceId, owners.get(id) ?? directory, 'element', { ...current, ...patch }, current.revision);
      cache.current.set(id, result);
    },
    remove: async id => {
      const current = cache.current.get(id); if (!current) throw new Error('요소를 새로 불러와 주세요.');
      await api.removeCanvasItem(workspaceId, owners.get(id) ?? directory, id, current.revision); cache.current.delete(id);
    },
  }), [workspaceId, directory, api, owners]);
  const elements = useCanvasElements(repository, editing && !query);
  const { hydrate, epoch } = elements;
  const flushElements = elements.flush;
  useEffect(() => { onFlushReady(async () => !busy && !summaryBusy && !history.busy && await flushElements()); return () => onFlushReady(undefined); }, [busy, summaryBusy, history.busy, flushElements, onFlushReady]);
  const flat = !!query;
  const baseEntries = useMemo(() => flat ? snapshot.entries.filter(entry => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, limit) : spatialEntries(snapshot.entries, limit, directory), [snapshot.entries, query, limit, flat, directory]);
  const scopeNames = useMemo(() => {
    const names = new Set(baseEntries.filter(entry => entry.kind === 'directory').map(entry => entry.relative_path));
    const byId = new Map(snapshot.entries.map(entry => [entry.id, entry]));
    for (const id of referenceIds) {
      let parent = byId.get(id)?.parent_path || '';
      while (parent) { names.add(parent); parent = parent.slice(0, Math.max(0, parent.lastIndexOf('/'))); }
    }
    return JSON.stringify(['', ...names].sort());
  }, [snapshot.entries, baseEntries, referenceIds]);
  const elementGeometry = JSON.stringify(elements.nodes.map(node => [owners.get(node.data.element.id) || '', node.data.element]));
  const scopedElements = useMemo(() => {
    const result = new Map<string, CanvasElement[]>();
    for (const [scope, element] of JSON.parse(elementGeometry) as [string, CanvasElement][]) { const list = result.get(scope) || []; list.push(element); result.set(scope, list); }
    return result;
  }, [elementGeometry]);
  const baseLayout = useMemo(() => spatialLayout(flat ? [] : baseEntries, scopedElements, undefined, snapshot.entries), [baseEntries, scopedElements, flat, snapshot.entries]);
  const { entries, layout } = useMemo(() => flat ? { entries: baseEntries, layout: baseLayout } : referenceScene(baseEntries, baseLayout, snapshot.entries, referenceIds, scopedElements), [flat, baseEntries, baseLayout, snapshot.entries, referenceIds, scopedElements]);
  const layoutRef = useRef(layout); useLayoutEffect(() => { layoutRef.current = layout; }, [layout]);
  const logicalOwners = new Map<string, string>();
  const logicalFolders: { id: string; parentId?: string; scale: number }[] = [];
  for (const [name, decorations] of scopedElements) {
    const scope = layout.scopes.get(name);
    const logical = projectFolders([
      ...decorations.map(e => ({ id: `element:${e.id}`, x: e.x, y: e.y, width: e.width, height: e.height, folder: e.kind === 'rectangle', overlay: e.kind === 'text' })),
      ...entries.filter(entry => entry.kind !== 'directory' && entry.parent_path === name).map(entry => ({ id: entry.id, ...(layout.placements.get(entry.id)?.anchor || { x: entry.x || 0, y: entry.y || 0 }), width: 200, height: 290 })),
    ]);
    for (const [id, owner] of logical.owner) logicalOwners.set(id, owner);
    for (const e of decorations.filter(e => e.kind === 'rectangle')) logicalFolders.push({ id: `element:${e.id}`, parentId: logical.owner.get(`element:${e.id}`) || scope?.parentId, scale: scope?.scale || 1 });
  }
  const visibility = useFolderVisibility([
    ...[...layout.placements.values()].filter(p => p.entry.kind === 'directory').map(p => ({ id: p.entry.id, parentId: p.parentId, scale: p.visibilityScale, contentScale: layout.scopes.get(p.entry.relative_path)?.scale })),
    ...logicalFolders,
  ], zoom, referenceMode || flat || selecting);
  const revealFolder = visibility.reveal;

  const children = useMemo(() => {
    const result = new Map<string, Entry[]>();
    for (const entry of snapshot.entries) { const list = result.get(entry.parent_path) || []; list.push(entry); result.set(entry.parent_path, list); }
    return result;
  }, [snapshot.entries]);
  useEffect(() => {
    // React Flow owns selection and drag measurements; merge the external inventory after commit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNodes(previous => {
      const oldNodes = new Map(previous.map(node => [node.id, node]));
      return entries.map((entry, index) => {
        const old = oldNodes.get(entry.id), placement = layout.placements.get(entry.id);
        const scope = layout.scopes.get(entry.parent_path), scale = flat ? 1 : scope?.scale || 1;
        const position = placement?.position || { x: index % 4 * 255, y: Math.floor(index / 4) * 335 };
        const common = { ...old, id: entry.id, parentId: flat ? undefined : placement?.parentId, position: old?.dragging ? old.position : position, selected: old?.selected || false };
        if (entry.kind === 'directory' && placement && !flat) return { ...common, type: 'directory' as const, width: placement.width, height: placement.height, style: { width: placement.width, height: placement.height }, dragHandle: undefined, zIndex: -20,
          data: { entry, frame: scope!.frame, open: () => enter(entry), element: { id: entry.id, kind: 'rectangle' as const, text: entry.name, x: 0, y: 0, width: placement.width, height: placement.height, color: 'blue', font_size: 24 } } } as FolderAreaNode;
        return { ...common, type: 'file' as const, handles: paperHandles(scale), style: { width: 200 * scale, height: 244 * scale }, width: 200 * scale, height: 244 * scale, zIndex: 0, data: { entry, inspect, enter, scale, copy: async () => {} } } as FileNode;
      }).sort((a, b) => a.data.entry.relative_path.split('/').length - b.data.entry.relative_path.split('/').length);
    });
  }, [entries, inspect, enter, layout, flat]);
  const duration = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 350;
  const openBounds = useCallback((bounds: { x: number; y: number; width: number; height: number }, overview = false, targetDirectory?: string, animate = true, localScale?: number) => {
    const rect = area.current?.getBoundingClientRect(); if (!rect || !flow.current) return;
    const top = Math.min(topInset + 20, rect.height * .45), availableHeight = rect.height - top;
    const fitted = Math.min((rect.width - 100) / (bounds.width + 80), (availableHeight - 100) / (bounds.height + 80));
    const focusPlacement = [...layoutRef.current.placements.values()].find(p => p.entry.kind === 'directory' && p.entry.relative_path === targetDirectory);
    const visibilityScale = localScale || focusPlacement?.visibilityScale || 1;
    const zoom = overview ? Math.max(.1, Math.min(.32, fitted)) : Math.max(.55 / visibilityScale, Math.min(1 / visibilityScale, fitted));
    // Very large folders open at their first files, rather than centering empty space.
    const x = overview ? bounds.x + bounds.width / 2 : bounds.x + Math.min(bounds.width / 2, (rect.width - 100) / zoom / 2);
    const y = overview ? bounds.y + bounds.height / 2 : bounds.y + Math.min(bounds.height / 2, (availableHeight - 100) / zoom / 2);
    const epoch = ++navigationEpoch.current; programmaticView.current = true;
    const focus = targetDirectory ?? directory;
    const target = { x: rect.width / 2 - x * zoom, y: top + availableHeight / 2 - y * zoom, zoom, focus_directory: focus, editing };
    navigationTarget.current = target;
    rememberView(workspaceId, spatialView, target);
    onFocusDirectory(focus);
    // Save the destination before animating, so quitting mid-zoom restores the chosen area.
    api.saveView(workspaceId, spatialView, target).catch(reason => error(reason.message));
    const release = focusPlacement && !overview ? revealFolder(focusPlacement.entry.id, zoom) : () => {};
    requestAnimationFrame(() => { void flow.current?.setViewport(target, { duration: animate ? duration() : 0 }).finally(() => { release(); if (epoch === navigationEpoch.current) { programmaticView.current = false; navigationTarget.current = null; } }); });
  }, [onFocusDirectory, workspaceId, editing, topInset, rememberView, error, revealFolder, api, directory]);
  useEffect(() => {
    if (!ready || flat || referenceMode || !nodes.length || navigated.current === navigationSequence) return;
    navigated.current = navigationSequence;
    if (!initialView.current && snapshot.views.some(view => view.directory === spatialView)) { initialView.current = true; return; }
    const target = directory ? [...layout.placements.values()].find(p => p.entry.relative_path === directory && p.entry.kind === 'directory') : undefined;
    if (directory && target) openBounds({ ...target.world, width: target.width, height: target.height }, false, directory);
    else if (!initialView.current) {
      initialView.current = true;
      if (!snapshot.views.some(view => view.directory === spatialView)) openBounds(layout.bounds, entries.some(entry => entry.kind === 'directory'), '', false);
    } else openBounds(layout.bounds, entries.some(entry => entry.kind === 'directory'), '');
  }, [ready, flat, referenceMode, nodes.length, navigationSequence, directory, layout, openBounds, entries, snapshot.views]);
  useEffect(() => {
    if (!ready || flat || !referenceMode || focused.current === referenceSequence || !flow.current || !area.current) return;
    return settledCanvas(area.current, () => {
    const targets = referenceIds.map(id => layout.placements.get(id)).filter(item => !!item);
    const rect = area.current?.getBoundingClientRect(), instance = flow.current; if (!targets.length || !rect || !instance) return;
    focused.current = referenceSequence;
    if (!referenceViewport.current) referenceViewport.current = { view: instance.getViewport(), navigation: navigationSequence };
    const left = Math.min(...targets.map(item => item.world.x)), top = Math.min(...targets.map(item => item.world.y));
    const width = Math.max(...targets.map(item => item.world.x + item.width)) - left, height = Math.max(...targets.map(item => item.world.y + item.height)) - top;
    const inset = Math.min(topInset + 24, rect.height * .45), available = Math.max(1, rect.height - inset - 48);
    const zoom = Math.max(.1, Math.min(1.25, (rect.width - 64) / (width + 80), available / (height + 80)));
    void instance.setViewport({ x: rect.width / 2 - (left + width / 2) * zoom, y: inset + available / 2 - (top + height / 2) * zoom, zoom }, { duration: duration() });
    });
  }, [ready, flat, referenceSequence, referenceMode, referenceIds, layout, topInset, navigationSequence]);
  useEffect(() => {
    if (referenceMode || !referenceViewport.current) return;
    const previous = referenceViewport.current; referenceViewport.current = null;
    if (flat || previous.navigation !== navigationSequence || !flow.current) return;
    restoringReferences.current = true;
    void flow.current.setViewport(previous.view, { duration: duration() }).finally(() => { restoringReferences.current = false; });
  }, [referenceMode, flat, navigationSequence]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const started = epoch.current;
      try {
        const names = JSON.parse(scopeNames) as string[];
        const snapshots = await Promise.all(names.map(async name => ({ name, ...await api.canvasSnapshot(workspaceId, name) })));
        if (!active) return;
        const allElements: CanvasElement[] = [], allRelations: Revisioned<CanvasRelation>[] = [];
        for (const result of snapshots) {
          for (const e of result.elements) { owners.set(e.id, result.name); if ((cache.current.get(e.id)?.revision || 0) <= e.revision) cache.current.set(e.id, e); allElements.push(e); }
          for (const r of result.relations) { relationOwners.current.set(r.id, result.name); allRelations.push(r); }
        }
        hydrate(allElements, started); setRelations(allRelations);
      } catch (reason) { if (active) error((reason as Error).message); }
    };
    void load(); const unsubscribe = api.onChanged((id, update) => { if (id === workspaceId && !update?.indexing) void load(); });
    return () => { active = false; unsubscribe(); };
  }, [workspaceId, scopeNames, hydrate, epoch, error, api, owners]);
  useEffect(() => {
    if (ready && !flat && !referenceMode && !referenceViewport.current && !restoringReferences.current && flow.current) api.saveView(workspaceId, spatialView, { ...(navigationTarget.current || flow.current.getViewport()), focus_directory: directory, editing }).catch(reason => error(reason.message));
  }, [ready, flat, referenceMode, workspaceId, directory, editing, error, api]);
  const change = useCallback((changes: NodeChange<EntryNode>[]) => {
    setNodes(current => applyNodeChanges(changes, current));
  }, []);
  function showPositions(values: Position[]) {
    setNodes(current => current.map(node => {
      const p = values.find(p => p.id === node.id), placement = layoutRef.current.placements.get(node.id);
      const scale = layoutRef.current.scopes.get(node.data.entry.parent_path)?.scale || 1;
      return p && placement ? { ...node, position: { x: placement.position.x + (p.x - placement.anchor.x) * scale, y: placement.position.y + (p.y - placement.anchor.y) * scale } } : node;
    }));
  }
  async function positions(values: Position[]) {
    await api.savePositions(workspaceId, values);
    rememberPositions(workspaceId, values);
    showPositions(values);
  }
  const canonicalFile = (node: EntryNode) => {
    const scale = layout.scopes.get(node.data.entry.parent_path)?.scale || 1;
    return { ...node, position: storedPosition(layout, node.data.entry, node.position), measured: node.measured ? { width: node.measured.width ? node.measured.width / scale : undefined, height: node.measured.height ? node.measured.height / scale : undefined } : undefined };
  };
  async function move(values: Position[], label = '파일 이동') {
    if (busy || !values.length) return false;
    setBusy(true);
    const before = values.map(p => ({ id: p.id, ...(starts.current.get(p.id) || storedPosition(layout, nodes.find(n => n.id === p.id)!.data.entry, nodes.find(n => n.id === p.id)!.position)) }));
    const movedFiles = nodes.filter(n => n.type === 'file' && values.some(p => p.id === n.id));
    const plans = [...new Set(movedFiles.map(n => n.data.entry.parent_path))].map(name => {
      const localFiles = nodes.filter(n => n.type === 'file' && n.data.entry.parent_path === name).map(canonicalFile);
      return planFolderMove(elements.nodes.filter(n => (owners.get(n.data.element.id) || '') === name), localFiles, values.filter(p => localFiles.some(n => n.id === p.id)).map(p => ({ id: p.id, position: p, origin: before.find(b => b.id === p.id)! })));
    });
    const folderPlan = { changes: plans.flatMap(plan => plan.changes), tooLarge: plans.some(plan => plan.tooLarge) };
    const apply = async (points: Position[], undo: boolean) => {
      await positions(points);
      for (const f of folderPlan.changes) elements.edit(f.id, undo ? f.before : f.after);
      if (!await elements.flush()) throw new Error('폴더 배치를 저장하지 못했습니다. 텍스트·도형 저장 재시도를 눌러 주세요.');
    };
    try {
      await apply(values, false);
      history.record({ label, undo: () => apply(before, true), redo: () => apply(values, false) });
      if (folderPlan.tooLarge) error('폴더의 최대 크기를 넘어 파일 위치만 저장했습니다.');
      return true;
    } catch (reason) { error((reason as Error).message); return false; } finally { setBusy(false); }
  }
  async function compactFolders() {
    if (flat || busy || summaryBusy || history.busy || !await elements.flush()) return;
    const planned = spatialLayout(entries, scopedElements, directory);
    const values = [...planned.placements.values()].filter(p => p.entry.kind === 'directory' && p.entry.parent_path === directory).map(p => ({ id: p.entry.id, ...p.anchor }));
    if (!values.length) return;
    starts.current.clear();
    if (!await move(values, '폴더 영역 정렬')) return;
    const target = directory ? [...planned.placements.values()].find(p => p.entry.kind === 'directory' && p.entry.relative_path === directory) : undefined;
    openBounds(target ? { ...target.world, width: target.width, height: target.height } : planned.bounds, !directory, directory);
  }
  function fileDropTarget(event: MouseEvent | TouchEvent, dragged: EntryNode[]) {
    if (!dragged.length || dragged.some(node => node.data.entry.kind !== 'file') || !flow.current) return;
    const pointer = 'touches' in event ? event.touches[0] || event.changedTouches[0] : event;
    if (!pointer) return;
    const point = flow.current.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY });
    return nodes.filter((node): node is FolderAreaNode => node.type === 'directory' && !node.data.entry.excluded && dragged.some(file => file.data.entry.parent_path !== node.data.entry.relative_path))
      .filter(node => { const internal = flow.current!.getInternalNode(node.id); if (!internal || internal.hidden) return false; const p = internal.internals.positionAbsolute; return point.x >= p.x && point.y >= p.y && point.x <= p.x + node.width! && point.y <= p.y + node.height!; })
      .sort((a, b) => a.width! * a.height! - b.width! * b.height!)[0];
  }
  async function transferFiles(dragged: EntryNode[], target: FolderAreaNode) {
    if (transferring.current || busy || history.busy) return;
    transferring.current = true; setBusy(true);
    const before = dragged.map(node => ({ id: node.id, ...(starts.current.get(node.id) || storedPosition(layout, node.data.entry, node.position)) }));
    showPositions(before);
    try {
      if (!await elements.flush()) return;
      for (const node of dragged) {
        const entry = node.data.entry;
        if (entry.parent_path === target.data.entry.relative_path) continue;
        const origin = before.find(point => point.id === node.id)!;
        const parentId = snapshot.entries.find(item => item.kind === 'directory' && item.relative_path === entry.parent_path)?.id || null;
        const moved = await api.moveFileToFolder(workspaceId, node.id, target.id, { expected_parent: entry.parent_path });
        rememberEntry(moved);
        const apply = async (folder: string | null, position: { x: number; y: number }, expected: string) => { rememberEntry(await api.moveFileToFolder(workspaceId, node.id, folder, { position, expected_parent: expected })); };
        history.record({ label: '폴더로 파일 이동', undo: () => apply(parentId, origin, moved.parent_path), redo: () => apply(target.id, { x: moved.x!, y: moved.y! }, entry.parent_path) });
      }
    } catch (reason) { error((reason as Error).message); }
    finally { transferring.current = false; setBusy(false); }
  }
  async function relationSave(value: CanvasRelation, revision: number) {
    const result = await api.putCanvasItem(workspaceId, relationOwners.current.get(value.id) ?? directory, 'relation', value, revision);
    relationOwners.current.set(result.id, relationOwners.current.get(result.id) ?? directory); setRelations(current => [...current.filter(r => r.id !== result.id), result]); return result;
  }
  async function connect(connection: Connection) {
    if (!editing || busy || !connection.source || !connection.target || connection.source === connection.target) return;
    setBusy(true); setEdgeMenu(undefined);
    try {
      const previous = relations.find(r => r.source_document_id === connection.source && r.target_document_id === connection.target && r.relation_type === kind);
      const value: CanvasRelation = { id: previous?.id || crypto.randomUUID(), source_document_id: connection.source, target_document_id: connection.target, relation_type: kind, source_handle: connection.sourceHandle || 'right', target_handle: connection.targetHandle || 'left' };
      let saved = await relationSave(value, previous?.revision || 0);
      if (!previous && saved.id === value.id) history.record({ label: '문서 연결', undo: async () => { await api.removeCanvasItem(workspaceId, relationOwners.current.get(saved.id) ?? directory, saved.id, saved.revision); saved = { ...saved, revision: saved.revision + 1 }; setRelations(current => current.filter(r => r.id !== saved.id)); }, redo: async () => { saved = await relationSave(value, saved.revision); } });
      else if (previous && (previous.source_handle !== saved.source_handle || previous.target_handle !== saved.target_handle)) history.record({ label: '연결 방향 변경', undo: async () => { saved = await relationSave(previous, saved.revision); }, redo: async () => { saved = await relationSave(value, saved.revision); } });
    } catch (reason) { error((reason as Error).message); } finally { setBusy(false); }
  }
  async function removeRelation(value: Revisioned<CanvasRelation>) {
    setBusy(true);
    try {
      await api.removeCanvasItem(workspaceId, relationOwners.current.get(value.id) ?? directory, value.id, value.revision);
      let revision = value.revision + 1;
      setRelations(current => current.filter(r => r.id !== value.id)); setEdgeMenu(undefined);
      history.record({ label: '연결 삭제', undo: async () => { revision = (await relationSave(value, revision)).revision; }, redo: async () => { await api.removeCanvasItem(workspaceId, relationOwners.current.get(value.id) ?? directory, value.id, revision); revision++; setRelations(current => current.filter(r => r.id !== value.id)); } });
    } catch (reason) { error((reason as Error).message); } finally { setBusy(false); }
  }
  function insertionContext(fixedDirectory?: string, origin?: { x: number; y: number }) {
    const rect = area.current?.getBoundingClientRect();
    const point = origin || (rect && flow.current ? flow.current.screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + topInset + (rect.height - topInset - 64) / 2 }) : { x: 0, y: 0 });
    const physical = [...layout.placements.values()].filter(p => p.entry.kind === 'directory' && visibility.opened.has(p.entry.id) && point.x >= p.world.x && point.y >= p.world.y && point.x <= p.world.x + p.width && point.y <= p.world.y + p.height).sort((a, b) => a.width * a.height - b.width * b.height)[0];
    const name = fixedDirectory ?? physical?.entry.relative_path ?? directory, scope = layout.scopes.get(name);
    const scale = scope?.scale || 1;
    const local = { x: (point.x - (scope?.origin.x || 0)) / scale, y: (point.y - (scope?.origin.y || 0)) / scale };
    const parent = elements.nodes.filter(node => (owners.get(node.data.element.id) || '') === name && node.data.element.kind === 'rectangle' && visibility.opened.has(node.id))
      .filter(node => local.x >= node.position.x && local.y >= node.position.y && local.x <= node.position.x + node.data.element.width && local.y <= node.position.y + node.data.element.height)
      .sort((a, b) => a.data.element.width * a.data.element.height - b.data.element.width * b.data.element.height)[0];
    const parentId = parent?.id;
    const siblings: PlacementBox[] = [
      ...[...layout.placements.values()].filter(p => p.entry.parent_path === name && logicalOwners.get(p.entry.id) === parentId).map(p => ({ id: p.entry.id, x: (p.position.x - (scope?.inset.x || 0)) / scale, y: (p.position.y - (scope?.inset.y || 0)) / scale, width: p.width / scale, height: p.height / scale })),
      ...elements.nodes.filter(node => (owners.get(node.data.element.id) || '') === name && node.data.element.kind !== 'text' && logicalOwners.get(node.id) === parentId).map(node => ({ id: node.id, ...node.position, width: node.data.element.width, height: node.data.element.height })),
    ];
    return { name, point: local, siblings, parent: parent?.data.element };
  }
  async function pinFolderAnchors() {
    const values = nodes.filter(node => node.type === 'directory').map(node => ({ id: node.id, ...layout.placements.get(node.id)!.anchor }));
    if (values.length) { await api.savePositions(workspaceId, values); rememberPositions(workspaceId, values); }
  }
  function insertionShifts(shifts: PlacementShift[]) {
    const result = new Map<string, PlacementShift>();
    for (const shift of shifts) {
      const p = layout.placements.get(shift.id), dx = shift.after.x - shift.before.x, dy = shift.after.y - shift.before.y;
      result.set(shift.id, p ? { id: shift.id, before: p.anchor, after: { x: p.anchor.x + dx, y: p.anchor.y + dy } } : shift);
      if (!shift.id.startsWith('element:')) continue;
      for (const [id] of logicalOwners) {
        let owner = logicalOwners.get(id);
        while (owner && owner !== shift.id) owner = logicalOwners.get(owner);
        if (!owner) continue;
        const original = id.startsWith('element:') ? elements.nodes.find(node => node.id === id)?.position : layout.placements.get(id)?.anchor;
        if (original && !result.has(id)) result.set(id, { id, before: original, after: { x: original.x + dx, y: original.y + dy } });
      }
    }
    return [...result.values()];
  }
  async function applyInsertion(shifts: PlacementShift[], forward: boolean, bounds?: { id: string; before: CanvasElement; after: CanvasElement }) {
    setLayoutMotion(true);
    if (motionTimer.current) clearTimeout(motionTimer.current);
    try {
      const side = forward ? 'after' : 'before';
      const points = shifts.filter(item => !item.id.startsWith('element:')).map(item => ({ id: item.id, ...item[side] }));
      if (points.length) await positions(points);
      for (const item of shifts.filter(item => item.id.startsWith('element:'))) elements.patch(item.id.slice(8), item[side]);
      if (bounds) elements.patch(bounds.id, bounds[side]);
      if (!await elements.flush()) throw new Error('추가한 항목의 배치를 저장하지 못했습니다.');
    } finally { motionTimer.current = setTimeout(() => setLayoutMotion(false), 280); }
  }
  function insertionPlan(kind: 'file' | 'rectangle', context: ReturnType<typeof insertionContext>) {
    const size = kind === 'file' ? { width: 200, height: 290 } : { width: Math.min(320, context.parent ? Math.max(80, context.parent.width - 48) : 320), height: Math.min(240, context.parent ? Math.max(60, context.parent.height - 48) : 240) };
    const point = { x: Math.max(context.parent ? context.parent.x + 24 : -99000, Math.min(99000, context.point.x - size.width / 2)), y: Math.max(context.parent ? context.parent.y + 24 : -99000, Math.min(99000, context.point.y - size.height / 2)) };
    const parent = context.parent;
    const area = parent ? { x: parent.x + 24, y: parent.y + 24, width: 1952, height: 1952 } : undefined;
    const incoming = { id: 'new-item', ...point, ...size }, plan = planInsertion(incoming, context.siblings, true, area);
    const free = planInsertion(incoming, context.siblings, false, area).position;
    const moved = plan.shifts.map(shift => ({ ...context.siblings.find(item => item.id === shift.id)!, ...shift.after }));
    const right = Math.max(plan.position.x + size.width, ...moved.map(item => item.x + item.width));
    const bottom = Math.max(plan.position.y + size.height, ...moved.map(item => item.y + item.height));
    const bounds = parent ? { id: parent.id, before: parent, after: { ...parent, width: Math.min(2000, Math.max(parent.width, right + 24 - parent.x)), height: Math.min(2000, Math.max(parent.height, bottom + 24 - parent.y)) } } : undefined;
    return { ...plan, size, free, bounds };
  }
  async function insertElement(kind: CanvasElement['kind']) {
    if (busy || elements.busy || history.busy || !await elements.flush()) return;
    const context = insertionContext();
    if (kind === 'text' || kind === 'ellipse' || kind === 'triangle') {
      creationDirectory.current = context.name;
      try { await elements.add(kind, { x: context.point.x - 140, y: context.point.y - 70 }); }
      finally { creationDirectory.current = undefined; }
      return;
    }
    setBusy(true);
    try {
      const plan = insertionPlan('rectangle', context);
      await pinFolderAnchors(); creationDirectory.current = context.name;
      const created = await elements.add(kind, plan.position, plan.size);
      if (!created) return;
      const shifts = [...insertionShifts(plan.shifts), { id: `element:${created.id}`, before: plan.free, after: plan.position }];
      try { await applyInsertion(shifts, true, plan.bounds); }
      catch (reason) { await applyInsertion(shifts, false, plan.bounds); throw reason; }
      history.record({ label: '새 폴더 배치', undo: () => applyInsertion(shifts, false, plan.bounds), redo: () => applyInsertion(shifts, true, plan.bounds) });
    } catch (reason) { error((reason as Error).message); }
    finally { creationDirectory.current = undefined; setBusy(false); }
  }
  async function insertFile(create: () => Promise<Entry>, name: string, source?: Entry) {
    if (busy || history.busy || !await elements.flush()) throw new Error('캔버스 저장을 완료한 뒤 다시 추가해 주세요.');
    const placement = source ? layout.placements.get(source.id) : undefined;
    const origin = placement ? { x: placement.world.x + placement.width + 124 * (layout.scopes.get(source!.parent_path)?.scale || 1), y: placement.world.y + placement.height / 2 } : undefined;
    const context = insertionContext(source?.parent_path ?? directory, origin), plan = insertionPlan('file', context);
    setBusy(true); setPendingFile({ name, directory: context.name, hideNew: !!source, existing: new Set(snapshot.entries.map(entry => entry.id)) });
    let created: Entry | undefined;
    try {
      await pinFolderAnchors(); created = await create();
      // The native picker determines the physical parent. Only place in the scope
      // actually chosen by the creator, never move a file between directories here.
      if (created.parent_path !== context.name) return created;
      const shifts = [...insertionShifts(plan.shifts), { id: created.id, before: { x: created.x ?? plan.free.x, y: created.y ?? plan.free.y }, after: plan.position }];
      try { await applyInsertion(shifts, true, plan.bounds); }
      catch (reason) { await applyInsertion(shifts, false, plan.bounds); throw reason; }
      const entry = { ...created, ...plan.position }; rememberEntry(entry);
      history.record({ label: '새 파일 배치', undo: () => applyInsertion(shifts, false, plan.bounds), redo: () => applyInsertion(shifts, true, plan.bounds) });
      return entry;
    } catch (reason) {
      if (created) { error(`파일은 생성됐지만 배치를 완료하지 못했습니다. ${(reason as Error).message}`); return created; }
      throw reason;
    } finally { setPendingFile(undefined); setBusy(false); }
  }
  useEffect(() => { onCreateFileReady(insertFile); return () => onCreateFileReady(undefined); });
  const selectedFiles = nodes.filter(node => node.selected && node.data.entry.kind === 'file');
  const summaryReady = api.capabilities?.summarize !== false && selectedFiles.length > 0 && selectedFiles.length <= 8 && selectedFiles.every(node => ['.md', '.txt', '.pdf', '.docx', '.hwpx'].includes(node.data.entry.extension));
  async function summarize() {
    if (!summaryReady || summaryBusy) return;
    setSummaryBusy(true); setSummaryError('');
    const ids = selectedFiles.map(n => n.id).sort(), signature = JSON.stringify(selectedFiles.map(n => [n.id, n.data.entry.mtime, n.data.entry.size]).sort());
    if (summaryRequest.current?.signature !== signature) summaryRequest.current = { signature, request_id: crypto.randomUUID(), x: Math.min(99000, Math.max(...selectedFiles.map(n => storedPosition(layout, n.data.entry, n.position).x)) + 320), y: storedPosition(layout, selectedFiles[0].data.entry, selectedFiles[0].position).y };
    try {
      const { request_id, x, y } = summaryRequest.current;
      const entry = await insertFile(async () => {
        const created = await api.summarizeSelection(workspaceId, { request_id, entry_ids: ids, directory, x, y });
        if (!created) throw new Error('요약 파일을 만들지 못했습니다.');
        return created;
      }, '');
      summaryRequest.current = null; setSelecting(false); setNodes(current => current.map(n => ({ ...n, selected: false })));
      if (entry) inspect(entry);
    } catch (reason) { setSummaryError((reason as Error).message); } finally { setSummaryBusy(false); }
  }
  const interactive = editing && !flat && !referenceMode && !selecting && !busy && !history.busy && !summaryBusy;
  const projectedElements = elements.nodes.map(node => {
    const scope = layout.scopes.get(owners.get(node.data.element.id) || '');
    const scale = scope?.scale || 1;
    const width = (node.width ?? node.data.element.width) * scale, height = (node.height ?? node.data.element.height) * scale;
    return { ...node, parentId: scope?.parentId, position: { x: node.position.x * scale + (scope?.inset.x || 0), y: node.position.y * scale + (scope?.inset.y || 0) }, width, height, measured: node.measured ? { width: node.measured.width ? node.measured.width * scale : undefined, height: node.measured.height ? node.measured.height * scale : undefined } : undefined, style: { ...node.style, width, height }, data: { ...node.data, scale, element: { ...node.data.element, width, height, font_size: node.data.element.font_size * scale } } };
  });
  const folders = { owner: new Map<string, string>(), members: new Map<string, EntryNode[]>() };
  for (const name of scopedElements.keys()) {
    const membership = folderMembership(elements.nodes.filter(n => (owners.get(n.data.element.id) || '') === name), nodes.filter(n => n.type === 'file' && n.data.entry.parent_path === name).map(canonicalFile));
    for (const [id, owner] of membership.owner) folders.owner.set(id, owner);
    for (const [id, members] of membership.members) folders.members.set(id, members);
  }
  const isAncestor = (entry: Entry) => entry.kind === 'directory' && (entry.relative_path === directory || directory.startsWith(entry.relative_path + '/'));
  const physicallyHidden = (entry: Entry) => !flat && !referenceMode && visibility.hidden(logicalOwners.get(entry.id) || layout.placements.get(entry.id)?.parentId);
  const elementNodes = projectedElements.map(node => ({ ...node, hidden: flat || visibility.hidden(logicalOwners.get(node.id) || node.parentId), draggable: interactive, data: { ...node.data, editable: interactive, folder: node.data.element.kind === 'rectangle' ? {
    titles: (folders.members.get(node.id) || []).map(n => n.data.entry.name), overview: !visibility.opened.has(node.id),
    select: () => { elements.setNodes(current => current.map(n => ({ ...n, selected: n.id === node.id }))); },
    open: () => {
      const scope = layout.scopes.get(owners.get(node.data.element.id) || '');
      const release = revealFolder(node.id, .55 / (scope?.scale || 1));
      openBounds({ x: node.data.element.x * (scope?.scale || 1) + (scope?.origin.x || 0), y: node.data.element.y * (scope?.scale || 1) + (scope?.origin.y || 0), width: node.data.element.width * (scope?.scale || 1), height: node.data.element.height * (scope?.scale || 1) }, false, undefined, true, scope?.scale || 1);
      setTimeout(release, 400);
    },
  } : undefined } }));
  const selectedElement = elements.nodes.find(n => n.selected)?.data.element;
  const activeRelation = relations.find(r => r.id === edgeMenu?.id);
  const saved = snapshot.views.find(view => view.directory === spatialView);
  const renderedEntries: EntryNode[] = nodes.map(node => {
    const entry = node.data.entry;
    if (node.type === 'directory') return { ...node, hidden: physicallyHidden(entry), draggable: interactive && !isAncestor(entry), connectable: false, data: { ...node.data, editable: editing && !referenceMode, dropTarget: dropFolder === node.id, folder: { titles: (children.get(entry.relative_path) || []).map(e => e.name), overview: !visibility.opened.has(entry.id), open: node.data.open, select: () => {} } } };
    return { ...node, hidden: physicallyHidden(entry) || !!pendingFile && (pendingFile.hideNew || entry.name === pendingFile.name) && entry.parent_path === pendingFile.directory && !pendingFile.existing.has(entry.id), draggable: interactive, connectable: interactive, data: { ...node.data, copy: async (source: Entry, requestId: string, versionId?: string) => { await insertFile(() => api.copyFile(workspaceId, source.id, requestId, versionId), source.name + ' copy', source); }, referenced: referenceIds.includes(node.id), connections: relations.filter(r => r.source_document_id === node.id || r.target_document_id === node.id).length } };
  });
  const hiddenEntries = new Set(renderedEntries.filter(node => node.hidden).map(node => node.id));
  return <div className={`desktop-canvas-surface ${layoutMotion ? 'canvas-layout-motion' : ''} ${editing ? 'is-editing' : 'is-browsing'}`} ref={area} tabIndex={-1} onKeyDown={event => {
    if (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable=true],dialog')) return;
    if (event.key === 'Escape') { setSelecting(false); setEdgeMenu(undefined); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !busy && !history.busy) { event.preventDefault(); void history.run(event.shiftKey ? 'redo' : 'undo'); }
  }} onKeyUp={event => {
    if (editing && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && !(event.target instanceof HTMLElement && event.target.closest('input,textarea'))) void move(nodes.filter(n => n.selected).map(n => storedPosition(layout, n.data.entry, n.position)));
  }}>
    <CanvasSurface<CanvasNode> nodes={[...renderedEntries, ...elementNodes]}
      edges={relations.filter(r => nodes.some(n => n.id === r.source_document_id) && nodes.some(n => n.id === r.target_document_id)).map(r => ({ ...edgeFor(r), label: showLabels ? relationLabels[r.relation_type] : undefined, hidden: !!query || hiddenEntries.has(r.source_document_id) || hiddenEntries.has(r.target_document_id) }))}
      nodeTypes={nodeTypes} maxZoom={visibility.maxZoom} nodeExtent={undefined} onlyRenderVisibleElements={false} nodesConnectable={editing && !selecting && !busy && !history.busy && !summaryBusy && !query && !referenceMode} nodesDraggable={editing && !selecting && !busy && !history.busy && !summaryBusy && !query && !referenceMode} connectionMode={ConnectionMode.Loose}
      defaultViewport={flat ? { x: 64, y: Math.max(80, topInset + 24), zoom: .8 } : saved || { x: 64, y: Math.max(80, topInset + 24), zoom: .8 }} onInit={instance => { flow.current = instance; setZoom(instance.getZoom()); setReady(true); }} onMove={(_event, view) => setZoom(view.zoom)}
      onNodesChange={changes => {
        change(changes.filter(c => 'id' in c && !c.id.startsWith('element:')) as NodeChange<EntryNode>[]);
        elements.onChanges(changes.filter(c => 'id' in c && c.id.startsWith('element:')).map(c => {
          if (!('id' in c)) return c;
          const owner = owners.get(c.id.replace(/^element:/, '')) || '', scope = layout.scopes.get(owner);
          const scale = scope?.scale || 1;
          if (c.type === 'position' && c.position) return { ...c, position: { x: (c.position.x - (scope?.inset.x || 0)) / scale, y: (c.position.y - (scope?.inset.y || 0)) / scale } };
          if (c.type === 'dimensions' && c.dimensions) return { ...c, dimensions: { width: c.dimensions.width / scale, height: c.dimensions.height / scale } };
          return c;
        }) as NodeChange<ElementNode>[]);
      }}
      onNodeDoubleClick={(_event, node) => { if (node.type === 'directory') enter(node.data.entry); }}
      onNodeDragStart={() => { starts.current = new Map(nodes.map(n => [n.id, storedPosition(layout, n.data.entry, n.position)])); }}
      onNodeDrag={(event, node, dragged) => { const moving = (dragged.length ? dragged : [node]).filter((n): n is EntryNode => n.type !== 'decoration'); setDropFolder(fileDropTarget(event, moving)?.id || null); }}
      onNodeDragStop={(event, node, dragged) => { setDropFolder(null); const moving = (dragged.length ? dragged : [node]).filter((n): n is EntryNode => n.type !== 'decoration'); const target = fileDropTarget(event, moving); if (target) void transferFiles(moving, target); else if (moving.length) void move(moving.map(n => storedPosition(layout, n.data.entry, n.position))); }}
      onConnect={connection => void connect(connection)} onEdgeClick={(event, edge) => { if (editing) setEdgeMenu({ id: edge.id, x: Math.max(12, Math.min(event.clientX, innerWidth - 272)), y: Math.max(12, Math.min(event.clientY, innerHeight - 232)) }); }}
      onMoveEnd={async (_event, view) => {
        if (flat || referenceMode || referenceViewport.current || restoringReferences.current || !mounted.current) return;
        const persisted = navigationTarget.current || { ...view, focus_directory: directory, editing };
        rememberView(workspaceId, spatialView, persisted); api.saveView(workspaceId, spatialView, persisted).catch(reason => error(reason.message));
        const epoch = navigationEpoch.current;
        if (programmaticView.current || busy || summaryBusy || history.busy || !await elements.flush() || !mounted.current || epoch !== navigationEpoch.current) return;
        if (view.zoom < .38) onFocusDirectory('');
      }}>
      <SelectionArea active={selecting} busy={busy || summaryBusy} flow={flow as RefObject<ReactFlowInstance | null>} nodeType="file" onSelect={ids => { setNodes(current => current.map(n => ({ ...n, selected: ids.includes(n.id) }))); setSummaryError(''); }} />
      <CanvasDock host={setDockHost}><ControlButton title="영역 선택" aria-label="영역 선택" aria-pressed={selecting} disabled={summaryBusy} onClick={() => { if (selecting) setNodes(current => current.map(n => ({ ...n, selected: false }))); setSelecting(!selecting); }}><LuSquareDashedMousePointer /></ControlButton></CanvasDock>
    </CanvasSurface>
    {referenceMode && <button className="clear-local-references" onClick={onClearReferences}>참조 보기 종료</button>}
    {toolbarHost && createPortal(<div className="local-canvas-toolbar" role="toolbar" aria-label="캔버스 편집 도구"><button className="icon-button canvas-edit-toggle" disabled={busy || history.busy || referenceMode || selecting} aria-label={editing ? '캔버스 수정 완료' : '캔버스 수정'} title={editing ? '수정 완료' : '캔버스 수정'} aria-pressed={editing} onClick={async () => { if (!await elements.flush()) return; setEditing(!editing); setEdgeMenu(undefined); }}>{editing ? <LuCheck /> : <LuPencil />}</button><div className="canvas-history-tools" role="group" aria-label="캔버스 실행 취소와 다시 실행"><button className="icon-button" aria-label="되돌리기" disabled={busy || history.busy || selecting || !history.undoLabel} title={history.undoLabel ? `${history.undoLabel} 되돌리기 (Ctrl/⌘+Z)` : '되돌리기'} onClick={() => void history.run('undo')}><LuUndo2 /></button><button className="icon-button" aria-label="다시 실행" title="다시 실행 (Ctrl/⌘+Shift+Z)" disabled={busy || history.busy || selecting || !history.redoLabel} onClick={() => void history.run('redo')}><LuRedo2 /></button></div><button className="icon-button" aria-label={showLabels ? '참조 표시 숨기기' : '참조 표시 보이기'} title={showLabels ? '참조 표시 숨기기' : '참조 표시 보이기'} aria-pressed={!showLabels} onClick={() => setShowLabels(!showLabels)}>{showLabels ? <LuEye /> : <LuEyeOff />}</button><button className="icon-button" aria-label="폴더 영역 모아 정렬" title="폴더 영역 모아 정렬" disabled={flat || busy || summaryBusy || history.busy || selecting || !nodes.some(n => n.type === 'directory' && n.data.entry.parent_path === directory)} onClick={() => void compactFolders()}><LuLayoutGrid /></button></div>, toolbarHost)}
    {selecting && <SelectionActions names={selectedFiles.map(n => n.data.entry.name)} ready={summaryReady} busy={summaryBusy} error={summaryError} onClose={() => { setSelecting(false); setNodes(current => current.map(n => ({ ...n, selected: false }))); }} onSummarize={() => void summarize()} onNewRequest={() => { summaryRequest.current = null; setSummaryError(''); }} />}
    <ElementTools toolbarHost={dockHost} selected={selectedElement} editable={editing && !query && !selecting && !referenceMode} busy={elements.busy || busy || history.busy} add={kind => { void insertElement(kind); }} edit={elements.edit} remove={id => void elements.remove(id)} clear={() => elements.setNodes(current => current.map(n => ({ ...n, selected: false })))} />
    {editing && !selecting && !selectedElement && dockHost && createPortal(<div className="local-relation-options"><select aria-label="연결 유형" title="새 연결 유형" value={kind} onChange={event => setKind(event.target.value as RelationKind)}>{Object.entries(relationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>, dockHost)}
    {activeRelation && edgeMenu && <ConnectionOptions relation={activeRelation} x={edgeMenu.x} y={edgeMenu.y} source={snapshot.entries.find(e => e.id === activeRelation.source_document_id)?.name || '파일'} target={snapshot.entries.find(e => e.id === activeRelation.target_document_id)?.name || '파일'} busy={busy} error="" onClose={() => setEdgeMenu(undefined)} onDelete={() => void removeRelation(activeRelation)} />}
    {(elements.status || elements.error || history.error) && <div className="local-canvas-status" role="status">{elements.error || history.error || elements.status}{elements.error && <button onClick={() => void elements.flush()}>텍스트·도형 저장 재시도</button>}</div>}
  </div>;
}

export type WorkspaceCanvasProps = Parameters<typeof WorkspaceCanvas>[0];
