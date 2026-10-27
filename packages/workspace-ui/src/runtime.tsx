"use client";
import { createContext, useContext, type ReactNode } from 'react';
import type { CanvasElement, CanvasRelation } from '../shared/core/canvas';
import type { FolderTreeEntry } from '../shared/core/folder-tree';

/** Presentation model. Absolute paths and OS handles never enter the shared UI. */
export type Entry = FolderTreeEntry;
export type Viewport = { x: number; y: number; zoom: number; focus_directory?: string; editing?: boolean };
export type Workspace = { id: string; root: string; label: string; show_hidden: number; include_generated: number; scanned_at: number | null };
export type Snapshot = {
  workspace: Workspace; entries: Entry[];
  disconnected_files: { id: string; name: string; relative_path: string; available: boolean }[];
  spatial_focus?: string; spatial_editing?: boolean; views: (Viewport & { directory: string })[];
  status: 'ready' | 'scanning' | 'unavailable'; warnings: string[]; truncated?: boolean;
  indexing?: { state: 'running' | 'complete' | 'cancelled'; total: number; completed: number; failed: number };
};
export type Preview = { kind: 'image'; url: string } | { kind: 'text'; text: string; truncated: boolean } | { kind: 'unsupported' };
export interface WorkspaceRuntime {
  capabilities?: { nativeFiles: boolean; label: string; summarize?: boolean; canEdit?: boolean };
  canvasSnapshot(id: string, directory: string): Promise<{ elements: (CanvasElement & { revision: number })[]; relations: (CanvasRelation & { revision: number })[] }>;
  putCanvasItem<T extends CanvasElement | CanvasRelation>(id: string, directory: string, kind: 'element' | 'relation', value: T, revision: number): Promise<T & { revision: number }>;
  removeCanvasItem(id: string, directory: string, itemId: string, revision: number): Promise<void>;
  savePositions(id: string, positions: { id: string; x: number; y: number }[]): Promise<void>;
  saveView(id: string, directory: string, view: Viewport): Promise<void>;
  moveFileToFolder(id: string, entryId: string, directoryId: string | null, options?: { position?: { x: number; y: number }; expected_parent?: string }): Promise<Entry>;
  copyFile(id: string, entryId: string, requestId: string, versionId?: string): Promise<Entry>;
  summarizeSelection(id: string, input: { request_id: string; entry_ids: string[]; directory: string; x: number; y: number }): Promise<Entry | null>;
  preview(id: string, entryId: string, small?: boolean): Promise<Preview>;
  onChanged(callback: (id: string, update?: { indexing?: NonNullable<Snapshot['indexing']>; conversions?: boolean }) => void): () => void;
  fileConversions?: { load: (entry: Entry) => Promise<import('../shared/core/versions').VersionDocument>; save: (entry: Entry, versionId: string, format: import('../shared/core/conversions').ConversionFormat) => Promise<void> };
  renderFileActions?: (props: { entry: Entry; active: boolean; dragging: boolean; onCopy: (entry: Entry, requestId: string, versionId?: string) => Promise<void>; children: ReactNode }) => ReactNode;
}
const RuntimeContext = createContext<WorkspaceRuntime | null>(null);
export function WorkspaceRuntimeProvider({ runtime, children }: { runtime: WorkspaceRuntime; children: ReactNode }) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}
export function useWorkspaceRuntime() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('WorkspaceRuntimeProvider가 필요합니다.');
  return runtime;
}
