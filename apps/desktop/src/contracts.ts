export type Workspace = { id: string; root: string; label: string; show_hidden: number; include_generated: number; scanned_at: number | null };
export type Entry = { id: string; workspace_id: string; relative_path: string; parent_path: string; name: string; kind: 'file' | 'directory' | 'link' | 'other'; extension: string; size: number; mtime: number; excluded: number; x: number | null; y: number | null };
export type Viewport = { x: number; y: number; zoom: number };
export type Snapshot = { workspace: Workspace; entries: Entry[]; views: (Viewport & { directory: string })[]; status: 'ready' | 'scanning' | 'unavailable'; warnings: string[]; truncated?: boolean };
export type Preview = { kind: 'image'; url: string } | { kind: 'text'; text: string; truncated: boolean } | { kind: 'unsupported' };
export interface DesktopAPI {
  list(): Promise<Workspace[]>;
  connect(): Promise<Snapshot | null>;
  snapshot(id: string): Promise<Snapshot>;
  refresh(id: string): Promise<Snapshot>;
  relink(id: string): Promise<Snapshot | null>;
  disconnect(id: string): Promise<boolean>;
  settings(id: string, settings: { showHidden: boolean; includeGenerated: boolean }): Promise<Snapshot>;
  savePositions(id: string, positions: { id: string; x: number; y: number }[]): Promise<void>;
  saveView(id: string, directory: string, view: Viewport): Promise<void>;
  preview(id: string, entryId: string, small?: boolean): Promise<Preview>;
  open(id: string, entryId: string): Promise<void>;
  reveal(id: string, entryId: string): Promise<void>;
  onChanged(callback: (id: string) => void): () => void;
}
declare global { interface Window { contextDesktop: DesktopAPI } }
