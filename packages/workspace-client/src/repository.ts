import type { WorkspaceRuntime, Snapshot, Entry } from '../../workspace-ui/src/runtime';
import type { DraftRepository } from '../../workspace-ui/shared/core/writing';
import type { ChatRepository } from '../../workspace-ui/shared/core/chat';
import type { VersionDocument } from '../../workspace-ui/shared/core/versions';
import type { LocalDocument } from '../../workspace-ui/shared/core/documents';
import type { TextRepository } from '../../workspace-ui/shared/core/text';
import type { SourceSnapshot } from '../../contracts/src/index';
import type { ConversionFormat } from '../../workspace-ui/shared/core/conversions';

export type WorkspaceConflict = { id: string; entity_id: string; reason: string; local?: unknown; remote?: unknown; resolved_at?: string | null; base_revisions?: Record<string, number> };
export type WorkspaceRecovery = { id: string; title: string; reason: string; candidate: unknown; created_at?: number; has_original?: boolean; };
export type SyncStatus = { state: 'loading' | 'local' | 'pending' | 'synced' | 'offline' | 'conflict' | 'deleted'; pending: number; cursor: number; message?: string };
/** The shell consumes application repositories, never Electron globals or raw SQL. */
export interface WorkspaceRepository extends WorkspaceRuntime {
  role: 'OWNER' | 'EDITOR' | 'VIEWER';
  load(): Promise<Snapshot>;
  refresh(): Promise<Snapshot>;
  synchronize?(): Promise<void>;
  listEntries(directory: string, cursor?: string): Promise<{ entries: Entry[]; cursor?: string }>;
  searchEntries(query: string, cursor?: string): Promise<{ entries: Entry[]; cursor?: string }>;
  createFolder(name: string, directory: string): Promise<Entry>;
  createText(name: string, directory: string): Promise<Entry>;
  upload(file: File, directory: string): Promise<Entry>;
  rename(entry: Entry, name: string): Promise<void>;
  trash(entry: Entry): Promise<void>;
  document(entry: Entry): Promise<VersionDocument>;
  documentVersion(entry: Entry, versionId: string): Promise<LocalDocument>;
  download(entry: Entry, versionId?: string): Promise<void>;
  selectReference(entry: Entry, versionId: string | null): Promise<void>;
  restoreVersion(entry: Entry, versionId: string): Promise<void>;
  versionSources(entry: Entry, versionId: string): Promise<SourceSnapshot[]>;
  convertVersion(entry: Entry, versionId: string, format: ConversionFormat): Promise<void>;
  text(entry: Entry): TextRepository;
  drafts: DraftRepository;
  chats: ChatRepository;
  conflicts(): Promise<WorkspaceConflict[]>;
  recovery?(): Promise<WorkspaceRecovery[]>;
  exportRecovery?(id: string): Promise<void>;
  downloadRecoveryOriginal?(id: string): Promise<void>;
  resolveConflict(id: string, resolution: 'keep_local' | 'keep_remote', reviewedBases?: Record<string, number>): Promise<void>;
  status(): SyncStatus;
  dispose(): void;
}
