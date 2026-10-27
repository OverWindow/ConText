/** Portable workspace protocol. This package must not import platform APIs. */
export const SCHEMA_VERSION = 2 as const;
export type Id = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Role = 'OWNER' | 'EDITOR' | 'VIEWER';

export interface Workspace {
  id: Id; name: string; root_entry_id: Id; epoch: number; revision: number;
  created_at: string; updated_at: string; deleted_at: string | null;
}
export interface Entry {
  id: Id; workspace_id: Id; parent_id: Id | null; kind: 'folder' | 'file'; name: string;
  document_id: Id | null; revision: number; position_revision: number;
  x: number | null; y: number | null; area_positioned: boolean; deleted_at: string | null;
}
export interface Document {
  id: Id; workspace_id: Id; content_head_id: Id | null; reference_head_id: Id | null;
  reference_pinned: boolean; revision: number; deleted_at: string | null;
}
export interface BlobReference {
  id: Id; sha256: string; size: number; mime_type: string;
}
export interface SourceLocation { block_id?: number | string; page?: number; line?: number; [key: string]: JsonValue | undefined }
interface SourceBase {
  id: Id; quote: string; label: string; captured_at?: string; locations?: SourceLocation[];
  /** Original source fields survive migrations without changing reference identity. */
  metadata?: { [key: string]: JsonValue };
}
export type SourceSnapshot =
  | (SourceBase & { kind: 'document'; document_id: Id; version_id: Id; chunk_id?: string; version_number?: number })
  | (SourceBase & { kind: 'note'; element_id: Id; scope_id: Id })
  | (SourceBase & { kind: 'chat'; session_id: Id; message_id: Id })
  | (SourceBase & { kind: 'draft'; draft_id: Id; history_id?: Id });

export interface DocumentVersion {
  id: Id; workspace_id: Id; document_id: Id; blob: BlobReference;
  parent_version_ids: Id[]; sources: SourceSnapshot[]; created_at: string; created_by: Id;
  display_number?: number; change_note: string;
}
export interface CanvasElement {
  id: Id; workspace_id: Id; scope_id: Id; kind: 'note' | 'text' | 'rectangle' | 'ellipse' | 'triangle' | 'group';
  x: number; y: number; width: number; height: number; content: string; color: string | null;
  sources: SourceSnapshot[]; font_size?: number; revision: number; deleted_at: string | null;
}
export interface Relation {
  id: Id; workspace_id: Id; scope_id: Id; source_document_id: Id; target_document_id: Id;
  relation_type: string; label: string; source_handle?: string | null; target_handle?: string | null; revision: number; deleted_at: string | null;
}
export interface DraftHistory {
  id: Id; content: string; sources: SourceSnapshot[]; created_at: string; created_by: Id;
  review?: JsonValue;
}
export interface Draft {
  id: Id; workspace_id: Id; scope_id: Id; title: string; content: string;
  sources: SourceSnapshot[]; history: DraftHistory[]; review: JsonValue;
  revision: number; deleted_at: string | null;
}
export interface Proposal {
  id: Id; workspace_id: Id; draft_id: Id; base_revision: number; content: string;
  sources: SourceSnapshot[]; status: 'pending' | 'accepted' | 'rejected'; review: JsonValue;
  created_at: string; created_by: Id; revision: number;
}
export interface ChatSession {
  id: Id; workspace_id: Id; scope_id: Id; title: string; sync: 'shared' | 'device';
  revision: number; deleted_at: string | null;
  metadata?: { [key: string]: JsonValue };
}
export interface ChatMessage {
  id: Id; workspace_id: Id; session_id: Id; role: 'user' | 'assistant' | 'system';
  content: string; sources: SourceSnapshot[]; request_id: Id | null;
  created_at: string; created_by: Id;
  revision?: number; metadata?: { [key: string]: JsonValue };
}
export interface DerivedArtifact {
  id: Id; workspace_id: Id; document_id: Id; version_id: Id; kind: string;
  processor_fingerprint: string; blob: BlobReference; created_at: string;
}
export interface SyncConflict {
  id: Id; workspace_id: Id; operation_id: Id; entity_collection: EntityCollection;
  entity_id: Id; reason: string; expected_revision: number | null; actual_revision: number | null;
  candidate: JsonValue; status: 'open' | 'resolved'; resolution: JsonValue;
  created_at: string; resolved_at: string | null; revision: number;
}
export interface WorkspaceState {
  workspace: Workspace;
  entries: Record<Id, Entry>; documents: Record<Id, Document>; versions: Record<Id, DocumentVersion>;
  canvas_elements: Record<Id, CanvasElement>; relations: Record<Id, Relation>;
  drafts: Record<Id, Draft>; proposals: Record<Id, Proposal>;
  chat_sessions: Record<Id, ChatSession>; chat_messages: Record<Id, ChatMessage>;
  artifacts: Record<Id, DerivedArtifact>; conflicts: Record<Id, SyncConflict>;
}
export type EntityCollection = Exclude<keyof WorkspaceState, 'workspace'>;
export type Collection = keyof WorkspaceState;
export type Entity = Workspace | Entry | Document | DocumentVersion | CanvasElement | Relation | Draft | Proposal | ChatSession | ChatMessage | DerivedArtifact | SyncConflict;
export interface EntityChange { collection: Collection; id: Id; value: Entity | null }

export interface CommandPayloads {
  /** Owner-only one-time bootstrap into an empty workspace, never a general patch operation. */
  ImportWorkspace: { state: WorkspaceState };
  CreateEntry: { id: Id; parent_id: Id; kind: 'folder' | 'file'; name: string; document_id?: Id; x?: number | null; y?: number | null; area_positioned?: boolean };
  MoveEntry: { id: Id; parent_id: Id; name: string };
  /** One atomic filesystem reconciliation, including swaps whose intermediate names would collide. */
  MoveEntries: { moves: { id: Id; parent_id: Id; name: string }[] };
  /** Reconcile a completed native inventory in one transaction, including new parent folders. */
  ReconcileEntries: { creates: CommandPayloads['CreateEntry'][]; moves: CommandPayloads['MoveEntry'][] };
  TrashEntry: { id: Id; observed_heads?: Record<Id, Id | null> };
  RestoreEntry: { id: Id; parent_id: Id; name?: string };
  AppendDocumentVersion: { version: DocumentVersion; select_head?: boolean };
  SelectContentHead: { document_id: Id; version_id: Id };
  SelectReferenceHead: { document_id: Id; version_id: Id; pinned: boolean };
  SetEntryPositions: { positions: { id: Id; x: number | null; y: number | null; area_positioned?: boolean }[] };
  PutCanvasElement: { element: CanvasElement };
  RemoveCanvasElement: { id: Id };
  PutRelation: { relation: Relation };
  RemoveRelation: { id: Id };
  CreateDraft: { id: Id; scope_id: Id; title: string; content?: string; sources?: SourceSnapshot[]; review?: JsonValue };
  SaveDraft: { id: Id; title: string; content: string; sources: SourceSnapshot[]; review?: JsonValue };
  TrashDraft: { id: Id };
  CreateProposal: { id: Id; draft_id: Id; content: string; sources: SourceSnapshot[]; review?: JsonValue };
  ReviewProposal: { id: Id; decision: 'accept' | 'reject' };
  CreateChatSession: { id: Id; scope_id: Id; title: string; sync?: 'shared' | 'device' };
  RenameChatSession: { id: Id; title: string };
  TrashChatSession: { id: Id };
  AppendChatMessage: { message: ChatMessage };
  UpdateChatMessage: { message: ChatMessage };
  CompleteAIRequest: { request_id: Id; message?: ChatMessage; proposal?: { id: Id; draft_id: Id; content: string; sources: SourceSnapshot[]; review?: JsonValue }; artifacts?: DerivedArtifact[] };
  PutDerivedArtifact: { artifact: DerivedArtifact };
  ResolveConflict: { id: Id; resolution: 'keep_current' | 'apply_candidate'; merged_content?: string };
  RenameWorkspace: { name: string };
  DeleteWorkspace: Record<string, never>;
}
export type CommandType = keyof CommandPayloads;
export type CommandEnvelope<T extends CommandType = CommandType> = {
  [K in T]: {
    schema_version: typeof SCHEMA_VERSION; operation_id: Id; workspace_id: Id; device_id: Id;
    workspace_epoch: number; type: K; payload: CommandPayloads[K];
    /** Keys are collection:id; entry positions use entry_positions:id. */
    base_revisions?: Record<string, number>;
  }
}[T];
export type DomainErrorCode = 'invalid_command' | 'forbidden' | 'workspace_mismatch' | 'workspace_deleted' | 'epoch_mismatch' | 'not_found' | 'already_exists' | 'revision_required' | 'revision_conflict' | 'invalid_tree' | 'name_conflict' | 'invalid_reference' | 'blob_unavailable' | 'immutable_version' | 'conflict_unresolved';
export interface DomainError { code: DomainErrorCode; message: string; details?: JsonValue }
export interface CommandResult {
  status: 'applied' | 'conflict' | 'rejected'; state: WorkspaceState; changes: EntityChange[];
  conflict_ids: Id[]; error?: DomainError;
}
export interface ApplyContext {
  actor_id: Id; role: Role; now: string;
  /** Server adapters supply only checksum/size-verified blobs. Native local adapters may omit this. */
  available_blobs?: ReadonlySet<string>;
}

export function revisionKey(collection: Collection | 'entry_positions', id: Id): string { return `${collection}:${id}`; }
export class ContractError extends Error {
  readonly path: string;
  constructor(path: string, message: string) { super(`${path}: ${message}`); this.name = 'ContractError'; this.path = path; }
}
type Obj = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown, path: string): Obj => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new ContractError(path, 'expected plain object');
  return value as Obj;
};
const str = (value: unknown, path: string): string => { if (typeof value !== 'string') throw new ContractError(path, 'expected string'); return value; };
const id = (value: unknown, path: string): string => { const s = str(value, path); if (!uuid.test(s)) throw new ContractError(path, 'expected UUID'); return s; };
const integer = (value: unknown, path: string): number => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ContractError(path, 'expected nonnegative safe integer'); return value as number; };
const finite = (value: unknown, path: string): number => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new ContractError(path, 'expected finite number'); return value; };
const bool = (value: unknown, path: string): boolean => { if (typeof value !== 'boolean') throw new ContractError(path, 'expected boolean'); return value; };
const arr = (value: unknown, path: string): unknown[] => { if (!Array.isArray(value)) throw new ContractError(path, 'expected array'); return value; };
const oneOf = (value: unknown, values: readonly string[], path: string): string => { const s = str(value, path); if (!values.includes(s)) throw new ContractError(path, `expected ${values.join('|')}`); return s; };
const timestamp = (value: unknown, path: string): string => { const s = str(value, path); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s) || !Number.isFinite(Date.parse(s))) throw new ContractError(path, 'expected ISO timestamp with timezone'); return s; };
function fields(o: Obj, allowed: string[], path: string): void { for (const key of Object.keys(o)) if (!allowed.includes(key)) throw new ContractError(`${path}.${key}`, 'unknown field'); }
function json(value: unknown, path: string, seen = new Set<unknown>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { finite(value, path); return; }
  if (seen.has(value)) throw new ContractError(path, 'cyclic JSON');
  seen.add(value);
  if (Array.isArray(value)) value.forEach((v, i) => json(v, `${path}[${i}]`, seen));
  else { const o = object(value, path); for (const [k, v] of Object.entries(o)) { if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw new ContractError(path, 'unsafe JSON key'); json(v, `${path}.${k}`, seen); } }
  seen.delete(value);
}
export function validatePortableName(value: unknown, path = 'name'): string {
  const name = str(value, path);
  if (!name.trim() || name === '.' || name === '..' || /[\x00-\x1f\x7f/\\]/.test(name)) throw new ContractError(path, 'invalid portable entry name');
  if (name !== name.normalize('NFC')) throw new ContractError(path, 'name must be Unicode NFC');
  return name;
}
export function validateBlob(value: unknown, path = 'blob'): BlobReference {
  const o = object(value, path); fields(o, ['id', 'sha256', 'size', 'mime_type'], path);
  id(o.id, `${path}.id`); if (!/^[a-f0-9]{64}$/.test(str(o.sha256, `${path}.sha256`))) throw new ContractError(path, 'expected lowercase SHA-256');
  integer(o.size, `${path}.size`); if (!str(o.mime_type, `${path}.mime_type`).trim() || /[\r\n]/.test(o.mime_type as string)) throw new ContractError(path, 'invalid MIME type');
  return value as BlobReference;
}
export function validateSourceSnapshot(value: unknown, path = 'source'): SourceSnapshot {
  const o = object(value, path); const kind = oneOf(o.kind, ['document', 'note', 'chat', 'draft'], `${path}.kind`);
  const extra: Record<string, string[]> = { document: ['document_id', 'version_id', 'chunk_id', 'version_number'], note: ['element_id', 'scope_id'], chat: ['session_id', 'message_id'], draft: ['draft_id', 'history_id'] };
  fields(o, ['id', 'kind', 'quote', 'label', 'captured_at', 'locations', 'metadata', ...extra[kind]], path);
  id(o.id, `${path}.id`); str(o.quote, `${path}.quote`); str(o.label, `${path}.label`);
  if (o.captured_at !== undefined) timestamp(o.captured_at, `${path}.captured_at`);
  if (o.metadata !== undefined) { object(o.metadata, `${path}.metadata`); json(o.metadata, `${path}.metadata`); }
  if (o.locations !== undefined) arr(o.locations, `${path}.locations`).forEach((v, i) => {
    const locationPath = `${path}.locations[${i}]`; const location = object(v, locationPath); json(v, locationPath);
    if (location.block_id !== undefined && typeof location.block_id !== 'string') integer(location.block_id, `${locationPath}.block_id`);
    for (const key of ['page', 'line']) if (location[key] !== undefined) integer(location[key], `${locationPath}.${key}`);
  });
  for (const key of extra[kind]) {
    if (key === 'chunk_id') { if (o[key] !== undefined) str(o[key], `${path}.${key}`); }
    else if (key === 'version_number') { if (o[key] !== undefined) integer(o[key], `${path}.${key}`); }
    else if (key !== 'history_id' || o[key] !== undefined) id(o[key], `${path}.${key}`);
  }
  return value as SourceSnapshot;
}
const sources = (value: unknown, path: string): void => { const ids = new Set<string>(); arr(value, path).forEach((v, i) => { const s = validateSourceSnapshot(v, `${path}[${i}]`); if (ids.has(s.id)) throw new ContractError(path, 'duplicate source ID'); ids.add(s.id); }); };
function entityBase(o: Obj, path: string): void { id(o.id, `${path}.id`); id(o.workspace_id, `${path}.workspace_id`); }
export function validateVersion(value: unknown, path = 'version'): DocumentVersion {
  const o = object(value, path); fields(o, ['id', 'workspace_id', 'document_id', 'blob', 'parent_version_ids', 'sources', 'created_at', 'created_by', 'display_number', 'change_note'], path);
  entityBase(o, path); id(o.document_id, `${path}.document_id`); validateBlob(o.blob, `${path}.blob`);
  const parents = arr(o.parent_version_ids, `${path}.parent_version_ids`); parents.forEach((p, i) => id(p, `${path}.parent_version_ids[${i}]`));
  if (new Set(parents).size !== parents.length || parents.includes(o.id)) throw new ContractError(path, 'invalid version parents');
  sources(o.sources, `${path}.sources`); timestamp(o.created_at, `${path}.created_at`); id(o.created_by, `${path}.created_by`); str(o.change_note, `${path}.change_note`);
  if (o.display_number !== undefined) integer(o.display_number, `${path}.display_number`);
  return value as DocumentVersion;
}
function validateElement(value: unknown, path: string): void {
  const o = object(value, path); fields(o, ['id', 'workspace_id', 'scope_id', 'kind', 'x', 'y', 'width', 'height', 'content', 'color', 'sources', 'font_size', 'revision', 'deleted_at'], path);
  entityBase(o, path); id(o.scope_id, `${path}.scope_id`); oneOf(o.kind, ['note', 'text', 'rectangle', 'ellipse', 'triangle', 'group'], `${path}.kind`);
  ['x', 'y', 'width', 'height'].forEach(k => finite(o[k], `${path}.${k}`));
  if ((o.width as number) <= 0 || (o.height as number) <= 0) throw new ContractError(path, 'positive dimensions required');
  str(o.content, `${path}.content`); if (o.color !== null) str(o.color, `${path}.color`); sources(o.sources, `${path}.sources`); integer(o.revision, `${path}.revision`);
  if (o.font_size !== undefined && finite(o.font_size, `${path}.font_size`) <= 0) throw new ContractError(path, 'positive font size required');
  if (o.deleted_at !== null) timestamp(o.deleted_at, `${path}.deleted_at`);
}
function validateRelation(value: unknown, path: string): void {
  const o = object(value, path); fields(o, ['id', 'workspace_id', 'scope_id', 'source_document_id', 'target_document_id', 'relation_type', 'label', 'source_handle', 'target_handle', 'revision', 'deleted_at'], path);
  entityBase(o, path); ['scope_id', 'source_document_id', 'target_document_id'].forEach(k => id(o[k], `${path}.${k}`));
  str(o.relation_type, `${path}.relation_type`); str(o.label, `${path}.label`); integer(o.revision, `${path}.revision`); if (o.deleted_at !== null) timestamp(o.deleted_at, `${path}.deleted_at`);
  for (const key of ['source_handle', 'target_handle']) if (o[key] !== undefined && o[key] !== null) str(o[key], `${path}.${key}`);
}
function validateMessage(value: unknown, path: string): void {
  const o = object(value, path); fields(o, ['id', 'workspace_id', 'session_id', 'role', 'content', 'sources', 'request_id', 'created_at', 'created_by', 'revision', 'metadata'], path);
  entityBase(o, path); id(o.session_id, `${path}.session_id`); oneOf(o.role, ['user', 'assistant', 'system'], `${path}.role`);
  str(o.content, `${path}.content`); sources(o.sources, `${path}.sources`); if (o.request_id !== null) id(o.request_id, `${path}.request_id`);
  timestamp(o.created_at, `${path}.created_at`); id(o.created_by, `${path}.created_by`);
  if (o.revision !== undefined) integer(o.revision, `${path}.revision`);
  if (o.metadata !== undefined) { object(o.metadata, `${path}.metadata`); json(o.metadata, `${path}.metadata`); }
}
function validateArtifact(value: unknown, path: string): void {
  const o = object(value, path); fields(o, ['id', 'workspace_id', 'document_id', 'version_id', 'kind', 'processor_fingerprint', 'blob', 'created_at'], path);
  entityBase(o, path); id(o.document_id, `${path}.document_id`); id(o.version_id, `${path}.version_id`); str(o.kind, `${path}.kind`); str(o.processor_fingerprint, `${path}.processor_fingerprint`); validateBlob(o.blob, `${path}.blob`); timestamp(o.created_at, `${path}.created_at`);
}
function validateCreateEntryPayload(value: unknown, path: string): void {
  const p = object(value, path); fields(p, ['id', 'parent_id', 'kind', 'name', 'document_id', 'x', 'y', 'area_positioned'], path);
  id(p.id, `${path}.id`); id(p.parent_id, `${path}.parent_id`); oneOf(p.kind, ['folder', 'file'], `${path}.kind`); validatePortableName(p.name, `${path}.name`);
  if (p.kind === 'file') id(p.document_id, `${path}.document_id`); else if (p.document_id !== undefined) throw new ContractError(path, 'folder cannot have a document');
  for (const k of ['x', 'y']) if (p[k] !== undefined && p[k] !== null) finite(p[k], `${path}.${k}`);
  if (p.area_positioned !== undefined) bool(p.area_positioned, `${path}.area_positioned`);
}
function validateMoveEntryPayload(value: unknown, path: string): void {
  const move = object(value, path); fields(move, ['id', 'parent_id', 'name'], path); id(move.id, `${path}.id`); id(move.parent_id, `${path}.parent_id`); validatePortableName(move.name, `${path}.name`);
}
function validateEntryBatch(value: unknown, path: string, validate: (value: unknown, path: string) => void): void {
  const seen = new Set<string>(); arr(value, path).forEach((value, index) => { const itemPath = `${path}[${index}]`; validate(value, itemPath); const key = (value as Obj).id as string; if (seen.has(key)) throw new ContractError(path, 'duplicate entry ID'); seen.add(key); });
}

/** Runtime parser used at every trust boundary. No arbitrary table-patch command exists. */
export function validateCommand(value: unknown): CommandEnvelope {
  const o = object(value, 'command'); fields(o, ['schema_version', 'operation_id', 'workspace_id', 'device_id', 'workspace_epoch', 'type', 'payload', 'base_revisions'], 'command');
  if (o.schema_version !== SCHEMA_VERSION) throw new ContractError('command.schema_version', 'expected protocol 2');
  ['operation_id', 'workspace_id', 'device_id'].forEach(k => id(o[k], `command.${k}`)); integer(o.workspace_epoch, 'command.workspace_epoch');
  if (o.base_revisions !== undefined) { const bases = object(o.base_revisions, 'command.base_revisions'); for (const [key, revision] of Object.entries(bases)) { if (!/^(workspace|entries|entry_positions|documents|versions|canvas_elements|relations|drafts|proposals|chat_sessions|chat_messages|artifacts|conflicts):[0-9a-f-]{36}$/i.test(key)) throw new ContractError('command.base_revisions', 'invalid revision key'); integer(revision, `command.base_revisions.${key}`); } }
  const type = str(o.type, 'command.type'); const p = object(o.payload, 'command.payload'); const path = 'command.payload';
  const only = (...keys: string[]) => fields(p, keys, path);
  const ids = (...keys: string[]) => keys.forEach(k => id(p[k], `${path}.${k}`));
  const text = (...keys: string[]) => keys.forEach(k => str(p[k], `${path}.${k}`));
  switch (type) {
    case 'CreateEntry': validateCreateEntryPayload(p, path); break;
    case 'MoveEntry': validateMoveEntryPayload(p, path); break;
    case 'MoveEntries': only('moves'); validateEntryBatch(p.moves, `${path}.moves`, validateMoveEntryPayload); break;
    case 'ReconcileEntries': only('creates', 'moves'); validateEntryBatch(p.creates, `${path}.creates`, validateCreateEntryPayload); validateEntryBatch(p.moves, `${path}.moves`, validateMoveEntryPayload); break;
    case 'RestoreEntry': only('id', 'parent_id', 'name'); ids('id', 'parent_id'); if (p.name !== undefined) validatePortableName(p.name); break;
    case 'TrashEntry': only('id', 'observed_heads'); ids('id'); if (p.observed_heads !== undefined) { const heads = object(p.observed_heads, `${path}.observed_heads`); for (const [document, version] of Object.entries(heads)) { id(document, `${path}.observed_heads`); if (version !== null) id(version, `${path}.observed_heads.${document}`); } } break;
    case 'RemoveCanvasElement': case 'RemoveRelation': case 'TrashDraft': case 'TrashChatSession': only('id'); ids('id'); break;
    case 'AppendDocumentVersion': only('version', 'select_head'); validateVersion(p.version); if (p.select_head !== undefined) bool(p.select_head, `${path}.select_head`); break;
    case 'SelectContentHead': only('document_id', 'version_id'); ids('document_id', 'version_id'); break;
    case 'SelectReferenceHead': only('document_id', 'version_id', 'pinned'); ids('document_id', 'version_id'); bool(p.pinned, `${path}.pinned`); break;
    case 'SetEntryPositions': only('positions'); { const seen = new Set<string>(); arr(p.positions, `${path}.positions`).forEach((v, i) => { const q = object(v, `${path}.positions[${i}]`); fields(q, ['id', 'x', 'y', 'area_positioned'], `${path}.positions[${i}]`); const key = id(q.id, 'position.id'); if (seen.has(key)) throw new ContractError(path, 'duplicate position ID'); seen.add(key); for (const k of ['x', 'y']) if (q[k] !== null) finite(q[k], `position.${k}`); if (q.area_positioned !== undefined) bool(q.area_positioned, 'position.area_positioned'); }); } break;
    case 'PutCanvasElement': only('element'); validateElement(p.element, `${path}.element`); break;
    case 'PutRelation': only('relation'); validateRelation(p.relation, `${path}.relation`); break;
    case 'CreateDraft': only('id', 'scope_id', 'title', 'content', 'sources', 'review'); ids('id', 'scope_id'); text('title'); if (p.content !== undefined) text('content'); if (p.sources !== undefined) sources(p.sources, `${path}.sources`); if (p.review !== undefined) json(p.review, `${path}.review`); break;
    case 'SaveDraft': only('id', 'title', 'content', 'sources', 'review'); ids('id'); text('title', 'content'); sources(p.sources, `${path}.sources`); if (p.review !== undefined) json(p.review, `${path}.review`); break;
    case 'CreateProposal': only('id', 'draft_id', 'content', 'sources', 'review'); ids('id', 'draft_id'); text('content'); sources(p.sources, `${path}.sources`); if (p.review !== undefined) json(p.review, `${path}.review`); break;
    case 'ReviewProposal': only('id', 'decision'); ids('id'); oneOf(p.decision, ['accept', 'reject'], `${path}.decision`); break;
    case 'CreateChatSession': only('id', 'scope_id', 'title', 'sync'); ids('id', 'scope_id'); text('title'); if (p.sync !== undefined) oneOf(p.sync, ['shared', 'device'], `${path}.sync`); break;
    case 'RenameChatSession': only('id', 'title'); ids('id'); text('title'); break;
    case 'AppendChatMessage': case 'UpdateChatMessage': only('message'); validateMessage(p.message, `${path}.message`); break;
    case 'CompleteAIRequest': only('request_id', 'message', 'proposal', 'artifacts'); ids('request_id'); if (p.message !== undefined) validateMessage(p.message, `${path}.message`); if (p.proposal !== undefined) { const q = object(p.proposal, `${path}.proposal`); fields(q, ['id', 'draft_id', 'content', 'sources', 'review'], `${path}.proposal`); id(q.id, 'proposal.id'); id(q.draft_id, 'proposal.draft_id'); str(q.content, 'proposal.content'); sources(q.sources, 'proposal.sources'); if (q.review !== undefined) json(q.review, 'proposal.review'); } if (p.artifacts !== undefined) arr(p.artifacts, `${path}.artifacts`).forEach((a, i) => validateArtifact(a, `${path}.artifacts[${i}]`)); if (!p.message && !p.proposal && (!Array.isArray(p.artifacts) || !p.artifacts.length)) throw new ContractError(path, 'AI completion must publish an output'); break;
    case 'PutDerivedArtifact': only('artifact'); validateArtifact(p.artifact, `${path}.artifact`); break;
    case 'ResolveConflict': only('id', 'resolution', 'merged_content'); ids('id'); oneOf(p.resolution, ['keep_current', 'apply_candidate'], `${path}.resolution`); if (p.merged_content !== undefined) text('merged_content'); break;
    case 'RenameWorkspace': only('name'); validatePortableName(p.name); break;
    case 'DeleteWorkspace': only(); break;
    case 'ImportWorkspace': only('state'); validateWorkspaceState(p.state); break;
    default: throw new ContractError('command.type', 'unknown named command');
  }
  return value as CommandEnvelope;
}
export const parseCommand = validateCommand;

/** Strict portable shape validation; graph and cross-entity ownership checks live in domain. */
export function validateWorkspaceState(value: unknown): WorkspaceState {
  const o = object(value, 'state');
  const maps = ['entries', 'documents', 'versions', 'canvas_elements', 'relations', 'drafts', 'proposals', 'chat_sessions', 'chat_messages', 'artifacts', 'conflicts'] as const;
  fields(o, ['workspace', ...maps], 'state');
  const w = object(o.workspace, 'state.workspace'); fields(w, ['id', 'name', 'root_entry_id', 'epoch', 'revision', 'created_at', 'updated_at', 'deleted_at'], 'state.workspace');
  id(w.id, 'workspace.id'); validatePortableName(w.name, 'workspace.name'); id(w.root_entry_id, 'workspace.root_entry_id');
  integer(w.epoch, 'workspace.epoch'); integer(w.revision, 'workspace.revision'); timestamp(w.created_at, 'workspace.created_at'); timestamp(w.updated_at, 'workspace.updated_at');
  if (w.deleted_at !== null) timestamp(w.deleted_at, 'workspace.deleted_at');
  const revision = (e: Obj, path: string) => integer(e.revision, `${path}.revision`);
  const deletion = (e: Obj, path: string) => { if (e.deleted_at !== null) timestamp(e.deleted_at, `${path}.deleted_at`); };
  const history = (value: unknown, path: string) => {
    const seen = new Set<string>();
    arr(value, path).forEach((v, i) => { const e = object(v, `${path}[${i}]`); fields(e, ['id', 'content', 'sources', 'created_at', 'created_by', 'review'], `${path}[${i}]`);
      const key = id(e.id, `${path}[${i}].id`); if (seen.has(key)) throw new ContractError(path, 'duplicate history ID'); seen.add(key);
      str(e.content, `${path}[${i}].content`); sources(e.sources, `${path}[${i}].sources`); timestamp(e.created_at, `${path}[${i}].created_at`); id(e.created_by, `${path}[${i}].created_by`); if (e.review !== undefined) json(e.review, `${path}[${i}].review`); });
  };
  for (const collection of maps) for (const [key, value] of Object.entries(object(o[collection], `state.${collection}`))) {
    const path = `state.${collection}.${key}`; const e = object(value, path); id(key, path); entityBase(e, path);
    if (e.id !== key || e.workspace_id !== w.id) throw new ContractError(path, 'entity ID or workspace does not match map');
    switch (collection) {
      case 'entries': fields(e, ['id', 'workspace_id', 'parent_id', 'kind', 'name', 'document_id', 'revision', 'position_revision', 'x', 'y', 'area_positioned', 'deleted_at'], path);
        if (e.parent_id !== null) id(e.parent_id, `${path}.parent_id`); oneOf(e.kind, ['folder', 'file'], `${path}.kind`); validatePortableName(e.name, `${path}.name`);
        if (e.document_id !== null) id(e.document_id, `${path}.document_id`); revision(e, path); integer(e.position_revision, `${path}.position_revision`);
        if (e.x !== null) finite(e.x, `${path}.x`); if (e.y !== null) finite(e.y, `${path}.y`); bool(e.area_positioned, `${path}.area_positioned`); deletion(e, path); break;
      case 'documents': fields(e, ['id', 'workspace_id', 'content_head_id', 'reference_head_id', 'reference_pinned', 'revision', 'deleted_at'], path);
        for (const k of ['content_head_id', 'reference_head_id']) if (e[k] !== null) id(e[k], `${path}.${k}`); bool(e.reference_pinned, `${path}.reference_pinned`); revision(e, path); deletion(e, path); break;
      case 'versions': validateVersion(e, path); break;
      case 'canvas_elements': validateElement(e, path); break;
      case 'relations': validateRelation(e, path); break;
      case 'drafts': fields(e, ['id', 'workspace_id', 'scope_id', 'title', 'content', 'sources', 'history', 'review', 'revision', 'deleted_at'], path);
        id(e.scope_id, `${path}.scope_id`); str(e.title, `${path}.title`); str(e.content, `${path}.content`); sources(e.sources, `${path}.sources`); history(e.history, `${path}.history`); json(e.review, `${path}.review`); revision(e, path); deletion(e, path); break;
      case 'proposals': fields(e, ['id', 'workspace_id', 'draft_id', 'base_revision', 'content', 'sources', 'status', 'review', 'created_at', 'created_by', 'revision'], path);
        id(e.draft_id, `${path}.draft_id`); integer(e.base_revision, `${path}.base_revision`); str(e.content, `${path}.content`); sources(e.sources, `${path}.sources`); oneOf(e.status, ['pending', 'accepted', 'rejected'], `${path}.status`); json(e.review, `${path}.review`); timestamp(e.created_at, `${path}.created_at`); id(e.created_by, `${path}.created_by`); revision(e, path); break;
      case 'chat_sessions': fields(e, ['id', 'workspace_id', 'scope_id', 'title', 'sync', 'revision', 'deleted_at', 'metadata'], path);
        id(e.scope_id, `${path}.scope_id`); str(e.title, `${path}.title`); oneOf(e.sync, ['shared', 'device'], `${path}.sync`); revision(e, path); deletion(e, path); if (e.metadata !== undefined) { object(e.metadata, `${path}.metadata`); json(e.metadata, `${path}.metadata`); } break;
      case 'chat_messages': validateMessage(e, path); break;
      case 'artifacts': validateArtifact(e, path); break;
      case 'conflicts': fields(e, ['id', 'workspace_id', 'operation_id', 'entity_collection', 'entity_id', 'reason', 'expected_revision', 'actual_revision', 'candidate', 'status', 'resolution', 'created_at', 'resolved_at', 'revision'], path);
        id(e.operation_id, `${path}.operation_id`); oneOf(e.entity_collection, maps, `${path}.entity_collection`); id(e.entity_id, `${path}.entity_id`); str(e.reason, `${path}.reason`);
        if (e.expected_revision !== null) integer(e.expected_revision, `${path}.expected_revision`); if (e.actual_revision !== null) integer(e.actual_revision, `${path}.actual_revision`);
        json(e.candidate, `${path}.candidate`); oneOf(e.status, ['open', 'resolved'], `${path}.status`); json(e.resolution, `${path}.resolution`); timestamp(e.created_at, `${path}.created_at`); if (e.resolved_at !== null) timestamp(e.resolved_at, `${path}.resolved_at`); revision(e, path); break;
    }
  }
  return value as WorkspaceState;
}

export * from './worker.generated.ts';
