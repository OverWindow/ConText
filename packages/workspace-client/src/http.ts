import type { WorkspaceState, CommandEnvelope, CommandPayloads, CommandType, EntityChange, SourceSnapshot, Draft, BlobReference, DocumentVersion, Entry as ProtocolEntry, Role } from '../../contracts/src/index.ts';
import { validateCommand } from '../../contracts/src/index.ts';
import { sourceAvailability, conflictResolutionBases } from '../../domain/src/index.ts';
import type { CanvasElement, CanvasRelation, RelationKind } from '../../workspace-ui/shared/core/canvas';
import type { WritingContent, WritingDraft, WritingSource } from '../../workspace-ui/shared/core/writing';
import type { ChatMessage } from '../../workspace-ui/shared/core/chat';
import type { Source } from '../../workspace-ui/shared/core/sources';
import type { Entry, Snapshot, Viewport, Preview } from '../../workspace-ui/src/runtime';
import type { WorkspaceRepository, SyncStatus } from './repository';

export type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Receipt = { operation_id: string; status: string; sequence: number; changes: EntityChange[]; conflict_ids: string[]; error?: { code: string; message: string } };
type Bootstrap = { state: WorkspaceState; cursor: number; epoch: number; role?: Role };
type LoadedText = { baseRevision: number; bom: boolean; eol: '\n' | '\r\n' };
const maxTextBytes = 2 * 1024 * 1024;
const workspaceIdSafe = (id: string) => encodeURIComponent(id);
const active = <T extends { deleted_at?: string | null }>(items: Record<string, T>) => Object.values(items).filter(item => !item.deleted_at);
const content = (text: string, title = ''): WritingContent => {
  try { const result = JSON.parse(text) as WritingContent; if (Array.isArray(result.blocks)) return { ...result, title }; } catch { /* Plain text imported from another editor remains editable. */ }
  return { title, blocks: [{ id: crypto.randomUUID(), type: 'paragraph', text, level: 1, items: [], rows: [], source_ids: [] }] };
};
const writingSource = (source: SourceSnapshot): WritingSource => ({ ...source, id: typeof source.metadata?.legacy_id === 'string' ? source.metadata.legacy_id : source.id, kind: source.kind, locations: source.locations?.map(location => ({ page: location.page, block_id: location.block_id === undefined ? undefined : Number(location.block_id) })), document_title: source.label, text: source.quote, version_number: source.kind === 'document' ? source.version_number : undefined });
const presentContent = (value: WritingContent, sources: SourceSnapshot[]): WritingContent => { const ids = new Map(sources.map(source => [source.id, typeof source.metadata?.legacy_id === 'string' ? source.metadata.legacy_id : source.id])); return { ...value, blocks: value.blocks.map(block => ({ ...block, source_ids: block.source_ids.map(id => ids.get(id) || id) })) }; };
const chatSource = (source: SourceSnapshot): Source => ({ ...source, id: typeof source.metadata?.legacy_id === 'string' ? source.metadata.legacy_id : source.id, chunk_id: source.kind === 'document' ? source.chunk_id || source.id : source.id, document_id: source.kind === 'document' ? source.document_id : '', version_id: source.kind === 'document' ? source.version_id : '', version_number: source.kind === 'document' ? source.version_number || 1 : 0, document_title: source.label, is_current: false, text: source.quote, locations: (source.locations || []).map(location => ({ ...location, block_id: Number(location.block_id || 0) })) });

/** Online browser adapter. Mutations use exactly the protocol consumed by native SQLite. */
export class HttpWorkspaceRepository implements WorkspaceRepository {
  role: Role = 'EDITOR';
  readonly fileConversions = { load: (entry: Entry) => this.document(entry), save: (entry: Entry, versionId: string, format: import('../../workspace-ui/shared/core/conversions').ConversionFormat) => this.convertVersion(entry, versionId, format) };
  readonly capabilities = { nativeFiles: false, label: '클라우드', summarize: true, canEdit: true };
  private state!: WorkspaceState;
  private cursor = 0;
  private actor = '';
  private listeners = new Set<(id: string) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private stopEvents?: () => void;
  private inFlight?: Promise<void>;
  private commandTail: Promise<void> = Promise.resolve();
  private sync: SyncStatus = { state: 'loading', pending: 0, cursor: 0 };
  private readonly prefix: string;
  private storageKey: string;
  private readonly device: string;
  private readonly views = new Map<string, Viewport>();
  private urls = new Set<string>();

  constructor(readonly workspaceId: string, private request: Request, private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = typeof window !== 'undefined' ? window.localStorage : { getItem: () => null, setItem: () => {}, removeItem: () => {} }, private options: { subscribe?: (onHint: () => void) => () => void } = {}) {
    this.prefix = `/workspaces/${encodeURIComponent(workspaceId)}`;
    const deviceKey = 'context.v2.browser-device';
    this.device = storage.getItem(deviceKey) || crypto.randomUUID(); storage.setItem(deviceKey, this.device);
    this.storageKey = `context.v2.pending.${workspaceId}.${this.device}`;
  }
  async load(): Promise<Snapshot> {
    const me = await this.request<{ id: string }>('/me'); this.actor = me.id; this.storageKey = `context.v2.pending.${workspaceIdSafe(this.workspaceId)}.${this.device}.${this.actor}`;
    await this.request(`${this.prefix}/devices`, { method: 'POST', body: JSON.stringify({ device_id: this.device, platform: 'web', name: '웹 브라우저' }) });
    const boot = await this.request<Bootstrap>(`${this.prefix}/bootstrap`);
    this.state = boot.state; this.cursor = boot.cursor; this.role = boot.role || this.role; this.capabilities.canEdit = this.role !== 'VIEWER';
    const savedView = this.storage.getItem(`context.v2.view.${this.workspaceId}.:spatial:readable`);
    if (savedView) { try { const view = JSON.parse(savedView) as Viewport; if ([view.x, view.y, view.zoom].every(Number.isFinite) && view.zoom > 0) this.views.set(':spatial:readable', view); } catch { /* A damaged view preference never prevents document access. */ } }
    this.sync = { state: this.readRecovery().length ? 'conflict' : 'synced', pending: 0, cursor: this.cursor };
    const pending = this.readPending();
    if (pending.length) { this.sync = { state: 'pending', pending: pending.length, cursor: this.cursor }; try { await this.send(pending); } catch { /* The saved command or conflict remains visible while offline. */ } }
    if (!this.timer) this.timer = setInterval(() => { void this.pull().catch(() => {}); }, 2500);
    if (!this.stopEvents && this.options.subscribe) this.stopEvents = this.options.subscribe(() => { void this.pull().catch(() => {}); });
    return this.snapshot();
  }
  async refresh() { await this.pull(); return this.snapshot(); }
  synchronize() {
    const execute = async () => { await this.pull(); if (this.state.workspace.deleted_at) return; const pending = this.readPending(); if (pending.length) await this.send(pending); await this.pull(); };
    const result = this.commandTail.then(execute); this.commandTail = result.catch(() => {}); return result;
  }
  status() { return this.sync; }
  dispose() { if (this.timer) clearInterval(this.timer); this.stopEvents?.(); this.stopEvents=undefined; this.listeners.clear(); for (const url of this.urls) URL.revokeObjectURL(url); this.urls.clear(); }
  onChanged(callback: (id: string) => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  private emit() { for (const listener of this.listeners) listener(this.workspaceId); }
  private readPending(): CommandEnvelope[] {
    try { const value = JSON.parse(this.storage.getItem(this.storageKey) || '[]'); return Array.isArray(value) ? value.map(validateCommand) : []; } catch { throw new Error('보류 중인 변경을 읽지 못했습니다. 브라우저 저장소를 보존하고 지원을 요청해 주세요.'); }
  }
  private recoveryKey() { return this.storageKey.replace('.pending.', '.recovery.'); }
  private readRecovery(): { command: CommandEnvelope; receipt: Receipt; created_at: number }[] {
    try { const records = JSON.parse(this.storage.getItem(this.recoveryKey()) || '[]'); if (!Array.isArray(records)) throw new Error('Invalid recovery records'); return records; }
    catch { throw new Error('보존된 변경을 읽지 못했습니다. 브라우저 저장소를 보존해 주세요.'); }
  }
  async recovery() { return this.readRecovery().map(item => ({ id: item.command.operation_id, title: item.command.type, reason: item.receipt.error?.message || '서버가 변경을 거절했습니다.', candidate: item.command, created_at: item.created_at, has_original: item.command.type === 'AppendDocumentVersion' })); }
  async downloadRecoveryOriginal(id: string) {
    const command = this.readRecovery().find(item => item.command.operation_id === id)?.command;
    if (command?.type !== 'AppendDocumentVersion') throw new Error('이 기록에는 원본 파일이 없습니다.');
    const expected = command.payload.version.blob;
    const result = await this.request<{ url: string; blob: BlobReference }>(`${this.prefix}/blobs/${expected.id}/recovery`);
    if (result.blob.sha256 !== expected.sha256 || result.blob.size !== expected.size) throw new Error('복구 원본의 무결성 정보가 다릅니다.');
    const link = document.createElement('a'); link.href = result.url; link.download = `context-recovered-${id}`; link.rel = 'noopener'; link.click();
  }
  async exportRecovery(id: string) {
    const item = this.readRecovery().find(row => row.command.operation_id === id);
    if (!item) throw new Error('보존된 변경을 찾지 못했습니다.');
    const url = URL.createObjectURL(new Blob([JSON.stringify({ schema_version: 2, workspace_id: this.workspaceId, ...item }, null, 2)], { type: 'application/json' }));
    try { const link = document.createElement('a'); link.href = url; link.download = `context-recovery-${id}.json`; link.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  private apply(changes: EntityChange[]) {
    for (const change of changes) {
      if (change.collection === 'workspace') this.state.workspace = change.value as WorkspaceState['workspace'];
      else if (change.value === null) delete this.state[change.collection][change.id];
      else (this.state[change.collection] as Record<string, unknown>)[change.id] = change.value;
    }
  }
  private async pull() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      let more = true;
      while (more) {
        const page = await this.request<{ changes: { sequence: number; changes: EntityChange[] }[]; cursor: number; has_more: boolean; epoch: number }>(`${this.prefix}/changes?after=${this.cursor}&limit=500`);
        for (const item of page.changes) this.apply(item.changes);
        this.cursor = page.cursor; more = page.has_more;
      }
      const pending = this.readPending().length;
      this.sync = { state: this.state.workspace.deleted_at ? 'deleted' : this.readRecovery().length || Object.values(this.state.conflicts).some(item => item.status === 'open') ? 'conflict' : pending ? 'pending' : 'synced', pending, cursor: this.cursor };
      this.emit();
    })().catch(reason => { this.sync = { ...this.sync, state: 'offline', message: (reason as Error).message }; this.emit(); throw reason; }).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async send(commands: CommandEnvelope[]) {
    this.sync = { state: 'pending', pending: commands.length, cursor: this.cursor }; this.emit();
    try {
      const reply = await this.request<{ results: Receipt[]; cursor: number; epoch: number }>(`${this.prefix}/commands`, { method: 'POST', body: JSON.stringify({ commands }) });
      // Save rejected input before removing pending entries. If storage is full,
      // leave the original pending write intact so an immutable receipt can be retried.
      const recovery = this.readRecovery();
      for (const receipt of reply.results.filter(item => item.status === 'rejected')) {
        const command = commands.find(item => item.operation_id === receipt.operation_id);
        if (command && !recovery.some(item => item.command.operation_id === command.operation_id)) recovery.push({ command, receipt, created_at: Date.now() });
      }
      if (recovery.length) this.storage.setItem(this.recoveryKey(), JSON.stringify(recovery));
      for (const receipt of reply.results) if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence > this.cursor) this.apply(receipt.changes);
      // Do not advance the pull cursor from command ACK: another actor's earlier changes may be unseen.
      const remaining = this.readPending().filter(command => !reply.results.some(result => result.operation_id === command.operation_id));
      this.storage.setItem(this.storageKey, JSON.stringify(remaining));
      const failed = reply.results.find(result => result.status !== 'applied');
      this.sync = { state: failed || recovery.length ? 'conflict' : 'synced', pending: remaining.length, cursor: this.cursor, message: failed?.error?.message };
      this.emit();
      if (failed) throw new Error(failed.status === 'conflict' ? '다른 곳에서 변경한 내용과 충돌했습니다. 입력한 내용은 충돌 목록에 보존했습니다.' : `${failed.error?.message || '변경을 반영하지 못했습니다.'} 입력한 내용은 동기화 복구 목록에 보존했습니다.`);
    } catch (reason) { if (this.readPending().length) this.sync = { ...this.sync, state: 'offline', message: (reason as Error).message }; this.emit(); throw reason; }
  }
  private command<T extends CommandType>(type: T, payload: CommandPayloads[T], bases: Record<string, number> = {}, operationId = crypto.randomUUID()) {
    const execute = async () => {
      if (type !== 'ResolveConflict' && Object.values(this.state.conflicts).some(conflict => conflict.status === 'open' && Object.hasOwn(bases, `${conflict.entity_collection}:${conflict.entity_id}`))) throw new Error('이 항목에는 해결하지 않은 충돌이 있습니다. 동기화 상태에서 양쪽 내용을 비교하고 선택해 주세요.');
      const command = validateCommand({ schema_version: 2, operation_id: operationId, workspace_id: this.workspaceId, device_id: this.device, workspace_epoch: this.state.workspace.epoch, type, payload, base_revisions: bases });
      const pending = this.readPending();
      if (pending.length) { await this.send(pending); await this.pull(); }
      this.storage.setItem(this.storageKey, JSON.stringify([command]));
      await this.send([command]);
    };
    const result = this.commandTail.then(execute);
    this.commandTail = result.catch(() => {});
    return result;
  }
  private async createFileWithVersion(id: string, documentId: string, parentId: string, name: string, version: DocumentVersion, operationId = crypto.randomUUID()) {
    const execute = async () => {
      const pending = this.readPending(); if (pending.length) { await this.send(pending); await this.pull(); }
      const common = { schema_version: 2, workspace_id: this.workspaceId, device_id: this.device, workspace_epoch: this.state.workspace.epoch };
      const commands = [validateCommand({ ...common, operation_id: operationId, type: 'CreateEntry', payload: { id, parent_id: parentId, kind: 'file', name, document_id: documentId }, base_revisions: {} }), validateCommand({ ...common, operation_id: crypto.randomUUID(), type: 'AppendDocumentVersion', payload: { version, select_head: true }, base_revisions: { [`documents:${documentId}`]: 0 } })];
      // Persist the complete creation transaction before sending either dependent operation.
      this.storage.setItem(this.storageKey, JSON.stringify(commands)); await this.send(commands);
    };
    const result = this.commandTail.then(execute); this.commandTail = result.catch(() => {}); return result;
  }
  private path(entry: ProtocolEntry): string {
    const names: string[] = []; let item: ProtocolEntry | undefined = entry; const seen = new Set<string>();
    while (item && item.id !== this.state.workspace.root_entry_id) { if (seen.has(item.id)) throw new Error('폴더 구조가 순환합니다.'); seen.add(item.id); names.unshift(item.name); item = item.parent_id ? this.state.entries[item.parent_id] : undefined; }
    return names.join('/');
  }
  private entry(id: string): Entry {
    const item = this.state.entries[id]; if (!item) throw new Error('항목을 찾을 수 없습니다.');
    const doc = item.document_id ? this.state.documents[item.document_id] : undefined;
    const versions = Object.values(this.state.versions).filter(value => value.document_id === item.document_id).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const head = versions.find(value => value.id === doc?.content_head_id);
    const path = this.path(item);
    return { id: item.id, workspace_id: this.workspaceId, relative_path: path, parent_path: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', name: item.name, kind: item.kind === 'folder' ? 'directory' : 'file', document_id: item.document_id || undefined, extension: item.kind === 'file' ? item.name.match(/\.[^.]+$/)?.[0].toLowerCase() || '' : '', size: head?.blob.size || 0, mtime: head ? Date.parse(head.created_at) : 0, excluded: 0, x: item.x, y: item.y, area_positioned: item.area_positioned, version_count: versions.length, version_number: head?.display_number || versions.findIndex(version => version.id === head?.id) + 1 };
  }
  private snapshot(): Snapshot {
    return { workspace: { id: this.workspaceId, root: '', label: this.state.workspace.name, show_hidden: 0, include_generated: 0, scanned_at: Date.now() }, entries: active(this.state.entries).filter(item => item.id !== this.state.workspace.root_entry_id).map(item => this.entry(item.id)), disconnected_files: [], spatial_focus: this.views.get(':spatial:readable')?.focus_directory, views: [...this.views].map(([directory, view]) => ({ ...view, directory })), status: this.state.workspace.deleted_at ? 'unavailable' : 'ready', warnings: [] };
  }
  private scope(directory: string) { return directory ? active(this.state.entries).find(item => item.kind === 'folder' && this.path(item) === directory)?.id || this.state.workspace.root_entry_id : this.state.workspace.root_entry_id; }
  async listEntries(directory: string, cursor?: string) {
    const page = await this.request<{ entries: ProtocolEntry[]; next_cursor?: string; has_more: boolean }>(`${this.prefix}/entries?parent_id=${this.scope(directory)}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const item of page.entries) this.state.entries[item.id] = item;
    return { entries: page.entries.map(item => this.entry(item.id)), cursor: page.has_more ? page.next_cursor : undefined };
  }
  async searchEntries(query: string, cursor?: string) {
    const page = await this.request<{ entries: ProtocolEntry[]; next_cursor?: string; has_more: boolean }>(`${this.prefix}/search?q=${encodeURIComponent(query)}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const item of page.entries) this.state.entries[item.id] = item;
    return { entries: page.entries.map(item => this.entry(item.id)), cursor: page.has_more ? page.next_cursor : undefined };
  }
  async createFolder(name: string, directory: string) { const id = crypto.randomUUID(); await this.command('CreateEntry', { id, parent_id: this.scope(directory), kind: 'folder', name }); return this.entry(id); }
  async createText(name: string, directory: string) { return this.upload(new File([''], name, { type: name.endsWith('.md') ? 'text/markdown' : 'text/plain' }), directory); }
  private async blob(file: Blob): Promise<BlobReference> {
    const bytes = await file.arrayBuffer(), sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    const prepared = await this.request<{ blob: BlobReference; upload_url: string | null; headers?: Record<string, string>; already_uploaded: boolean }>(`${this.prefix}/blobs/prepare`, { method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), sha256, size: bytes.byteLength, mime_type: file.type || 'application/octet-stream' }) });
    if (!prepared.already_uploaded) {
      if (!prepared.upload_url) throw new Error('업로드 주소를 받지 못했습니다.');
      const response = await fetch(prepared.upload_url, { method: 'PUT', headers: prepared.headers, body: bytes }); if (!response.ok) throw new Error('원본 파일을 업로드하지 못했습니다.');
      await this.request(`${this.prefix}/blobs/complete`, { method: 'POST', body: JSON.stringify({ id: prepared.blob.id }) });
    }
    return prepared.blob;
  }
  private async append(documentId: string, file: Blob, parent: string | null, operationId?: string, sources: SourceSnapshot[] = [], baseRevision = this.state.documents[documentId]?.revision || 0) {
    const version: DocumentVersion = { id: crypto.randomUUID(), workspace_id: this.workspaceId, document_id: documentId, blob: await this.blob(file), parent_version_ids: parent ? [parent] : [], sources, created_at: new Date().toISOString(), created_by: this.actor, change_note: '웹에서 저장' };
    await this.command('AppendDocumentVersion', { version, select_head: true }, { [`documents:${documentId}`]: baseRevision }, operationId);
    return version;
  }
  async upload(file: File, directory: string) {
    const id = crypto.randomUUID(), documentId = crypto.randomUUID();
    // Upload bytes before creating the file entry, so a failed transfer cannot publish a phantom file.
    const blob = await this.blob(file);
    await this.createFileWithVersion(id, documentId, this.scope(directory), file.name.normalize('NFC'), { id: crypto.randomUUID(), workspace_id: this.workspaceId, document_id: documentId, blob, parent_version_ids: [], sources: [], created_at: new Date().toISOString(), created_by: this.actor, change_note: '웹에서 업로드' });
    return this.entry(id);
  }
  async rename(entry: Entry, name: string) { const item = this.state.entries[entry.id]; await this.command('MoveEntry', { id: entry.id, parent_id: item.parent_id!, name: name.normalize('NFC') }, { [`entries:${entry.id}`]: item.revision }); }
  async trash(entry: Entry) { const bases: Record<string, number> = {}; const pending = [entry.id]; while (pending.length) { const id = pending.pop()!; const item = this.state.entries[id]; bases[`entries:${id}`] = item.revision; if (item.document_id) bases[`documents:${item.document_id}`] = this.state.documents[item.document_id].revision; for (const child of active(this.state.entries)) if (child.parent_id === id) pending.push(child.id); } await this.command('TrashEntry', { id: entry.id }, bases); }
  async moveFileToFolder(_id: string, entryId: string, directoryId: string | null, options?: { position?: { x: number; y: number }; expected_parent?: string }) {
    const entry = this.entry(entryId); if (options?.expected_parent !== undefined && entry.parent_path !== options.expected_parent) throw new Error('파일이 다른 폴더로 이동됐습니다. 다시 확인해 주세요.');
    await this.command('MoveEntry', { id: entryId, parent_id: directoryId || this.state.workspace.root_entry_id, name: entry.name }, { [`entries:${entryId}`]: this.state.entries[entryId].revision });
    if (options?.position) await this.savePositions(this.workspaceId, [{ id: entryId, ...options.position }]); return this.entry(entryId);
  }
  async copyFile(_id: string, entryId: string, requestId: string, versionId?: string) {
    const entry = this.entry(entryId), doc = this.state.documents[entry.document_id!], version = this.state.versions[versionId || doc.content_head_id!];
    if (!version) throw new Error('복사할 원본 이력이 없습니다.');
    const id = crypto.randomUUID(), documentId = crypto.randomUUID(), ext = entry.extension;
    const stem = ext ? entry.name.slice(0, -ext.length) : entry.name; let suffix = 1, name = `${stem} copy${ext}`; while (active(this.state.entries).some(item => item.parent_id === this.state.entries[entryId].parent_id && item.name === name)) name = `${stem} copy ${++suffix}${ext}`;
    await this.createFileWithVersion(id, documentId, this.state.entries[entryId].parent_id!, name, { ...version, id: crypto.randomUUID(), document_id: documentId, display_number: 1, parent_version_ids: [], sources: [{ id: crypto.randomUUID(), kind: 'document', document_id: doc.id, version_id: version.id, label: entry.name, quote: '', version_number: version.display_number }], created_at: new Date().toISOString(), created_by: this.actor, change_note: '복사본' }, requestId);
    return this.entry(id);
  }
  async savePositions(_id: string, positions: { id: string; x: number; y: number }[]) { await this.command('SetEntryPositions', { positions: positions.map(position => ({ ...position, area_positioned: true })) }, Object.fromEntries(positions.map(item => [`entry_positions:${item.id}`, this.state.entries[item.id].position_revision]))); }
  async saveView(_id: string, directory: string, view: Viewport) { this.views.set(directory, view); this.storage.setItem(`context.v2.view.${this.workspaceId}.${directory}`, JSON.stringify(view)); }
  async canvasSnapshot(_id: string, directory: string) {
    const scope = this.scope(directory), entryByDoc = new Map(active(this.state.entries).filter(item => item.document_id).map(item => [item.document_id, item.id]));
    return { elements: active(this.state.canvas_elements).filter(item => item.scope_id === scope).map(item => { let presentation: { text?: string; font_size?: number; shape?: CanvasElement['kind'] } = {}; try { presentation = JSON.parse(item.content); } catch { /* Plain notes are valid. */ } return { id: item.id, kind: presentation.shape || (item.kind === 'group' ? 'rectangle' : item.kind === 'note' ? 'text' : item.kind), text: presentation.text ?? item.content, x: item.x, y: item.y, width: item.width, height: item.height, color: item.color || 'yellow', font_size: item.font_size || presentation.font_size || 18, revision: item.revision } as CanvasElement & { revision: number }; }), relations: active(this.state.relations).filter(item => item.scope_id === scope).flatMap(item => entryByDoc.has(item.source_document_id) && entryByDoc.has(item.target_document_id) ? [{ id: item.id, source_document_id: entryByDoc.get(item.source_document_id)!, target_document_id: entryByDoc.get(item.target_document_id)!, relation_type: item.relation_type as RelationKind, source_handle: item.source_handle || 'right', target_handle: item.target_handle || 'left', revision: item.revision }] : []) };
  }
  async putCanvasItem<T extends CanvasElement | CanvasRelation>(_id: string, directory: string, kind: 'element' | 'relation', value: T, revision: number): Promise<T & { revision: number }> {
    if (kind === 'element') { const element = value as CanvasElement; await this.command('PutCanvasElement', { element: { id: element.id, workspace_id: this.workspaceId, scope_id: this.scope(directory), kind: element.kind, content: element.text, font_size: element.font_size, x: element.x, y: element.y, width: element.width, height: element.height, color: element.color, sources: this.state.canvas_elements[element.id]?.sources || [], revision, deleted_at: null } }, { [`canvas_elements:${element.id}`]: revision }); return { ...value, revision: this.state.canvas_elements[element.id].revision }; }
    const relation = value as CanvasRelation; const source = this.state.entries[relation.source_document_id]?.document_id, target = this.state.entries[relation.target_document_id]?.document_id;
    if (!source || !target) throw new Error('파일끼리 연결해 주세요.');
    await this.command('PutRelation', { relation: { id: relation.id, workspace_id: this.workspaceId, scope_id: this.scope(directory), source_document_id: source, target_document_id: target, relation_type: relation.relation_type, label: '', source_handle: relation.source_handle || 'right', target_handle: relation.target_handle || 'left', revision, deleted_at: null } }, { [`relations:${relation.id}`]: revision }); return { ...value, revision: this.state.relations[relation.id].revision };
  }
  async removeCanvasItem(_id: string, _directory: string, itemId: string, revision: number) { const element = !!this.state.canvas_elements[itemId]; await this.command(element ? 'RemoveCanvasElement' : 'RemoveRelation', { id: itemId }, { [`${element ? 'canvas_elements' : 'relations'}:${itemId}`]: revision }); }
  async document(entry: Entry) {
    const doc = this.state.documents[entry.document_id || this.state.entries[entry.id].document_id!]; if (!doc) throw new Error('문서 정보를 찾을 수 없습니다.');
    const versions = Object.values(this.state.versions).filter(item => item.document_id === doc.id).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    return { id: doc.id, entry_id: entry.id, title: entry.name, current_version_id: doc.reference_head_id, file_version_id: doc.content_head_id, current_is_pinned: doc.reference_pinned, revision: doc.revision, versions: versions.map((version, index) => ({ id: version.id, version_number: version.display_number || index + 1, original_filename: entry.name, status: 'READY', created_at: version.created_at, uploaded_at: version.created_at, size: version.blob.size, sha256: version.blob.sha256, change_note: version.change_note, source_version_id: version.sources.find(source => source.kind === 'document')?.kind === 'document' ? (version.sources.find(source => source.kind === 'document') as SourceSnapshot & { version_id: string }).version_id : null })) };
  }
  private async downloadInfo(versionId: string) { return this.request<{ url: string }>(`${this.prefix}/versions/${encodeURIComponent(versionId)}/download`); }
  async documentVersion(entry: Entry, versionId: string) {
    const doc = await this.document(entry), version = this.state.versions[versionId]; if (!version || version.document_id !== doc.id) throw new Error('이 문서의 이력이 아닙니다.');
    const artifact = Object.values(this.state.artifacts).find(item => item.version_id === versionId && item.kind === 'normalized');
    if (artifact) return this.request<import('../../workspace-ui/shared/core/documents').LocalDocument>(`${this.prefix}/versions/${versionId}/content`);
    if (['.pdf', '.docx', '.hwpx'].includes(entry.extension)) {
      let parsed = await this.request<{ state: string; normalized?: import('../../workspace-ui/shared/core/documents').NormalizedDocument; job?: { status?: string } | null }>(`${this.prefix}/versions/${versionId}/normalized`);
      if (parsed.state !== 'ready' && !parsed.job && this.role !== 'VIEWER') await this.request(`${this.prefix}/versions/${versionId}/processing`, { method: 'POST', body: JSON.stringify({ kind: 'parse', request_id: crypto.randomUUID() }) });
      for (let attempt = 0; parsed.state === 'pending' && attempt < 30; attempt++) { await new Promise(resolve => setTimeout(resolve, 1000)); parsed = await this.request(`${this.prefix}/versions/${versionId}/normalized`); }
      if (parsed.state === 'ready' && parsed.normalized) return { document_id: doc.id, entry_id: entry.id, version_id: versionId, version_number: doc.versions.find(item => item.id === versionId)?.version_number || 1, filename: entry.name, sha256: version.blob.sha256, created_at: Date.parse(version.created_at), normalized: parsed.normalized };
      if (parsed.state === 'failed') throw new Error('문서 분석을 완료하지 못했습니다. 원본을 다운로드하거나 나중에 다시 시도해 주세요.');
    }
    const text = ['.txt', '.md'].includes(entry.extension) ? await fetch((await this.downloadInfo(versionId)).url).then(response => { if (!response.ok) throw new Error('원본을 읽지 못했습니다.'); return response.text(); }) : '';
    return { document_id: doc.id, entry_id: entry.id, version_id: versionId, version_number: doc.versions.find(item => item.id === versionId)?.version_number || 1, filename: entry.name, sha256: version.blob.sha256, created_at: Date.parse(version.created_at), normalized: { schema_version: 1, title: entry.name, blocks: text ? text.split(/\n\n+/).map((text, id) => ({ id, type: 'paragraph', text, source: {} })) : [], warnings: [], page_count: null } };
  }
  async download(entry: Entry, versionId?: string) { const doc = await this.document(entry); const info = await this.downloadInfo(versionId || doc.file_version_id!); const link = document.createElement('a'); link.href = info.url; link.download = entry.name; link.rel = 'noopener'; link.click(); }
  async selectReference(entry: Entry, versionId: string | null) { const doc = this.state.documents[entry.document_id!]; await this.command('SelectReferenceHead', { document_id: doc.id, version_id: versionId || doc.content_head_id!, pinned: !!versionId }, { [`documents:${doc.id}`]: doc.revision }); }
  async convertVersion(entry: Entry, versionId: string, format: import('../../workspace-ui/shared/core/conversions').ConversionFormat) { const version = this.state.versions[versionId]; if (!version || version.document_id !== entry.document_id) throw new Error('이 문서의 이력이 아닙니다.'); const requestId = crypto.randomUUID(); await this.request(`${this.prefix}/versions/${versionId}/processing`, { method: 'POST', body: JSON.stringify({ request_id: requestId, kind: 'convert', format }) }); let job = await this.request<{ status: string; result?: { artifact_id?: string }; error?: { message?: string } }>(`${this.prefix}/jobs/${requestId}`); for (let attempt = 0; !['complete','failed'].includes(job.status) && attempt < 180; attempt++) { await new Promise(resolve => setTimeout(resolve, 1000)); job = await this.request(`${this.prefix}/jobs/${requestId}`); } if (job.status !== 'complete' || !job.result?.artifact_id) throw new Error(job.error?.message || '변환 상태를 확인하지 못했습니다. 작업 이력은 보존됩니다.'); const result = await this.request<{ url: string }>(`${this.prefix}/artifacts/${job.result.artifact_id}/download`); const link = document.createElement('a'); link.href = result.url; link.download = entry.name.replace(/\.[^.]+$/, '') + '.' + format; link.click(); }
  async versionSources(entry: Entry, versionId: string) { const version = this.state.versions[versionId]; if (!version || version.document_id !== entry.document_id) throw new Error('이 문서의 이력이 아닙니다.'); return version.sources; }
  async restoreVersion(entry: Entry, versionId: string) { const version = this.state.versions[versionId], doc = this.state.documents[entry.document_id!]; if (!version || version.document_id !== doc.id) throw new Error('복원할 원본이 없습니다.'); const response = await fetch((await this.downloadInfo(versionId)).url); if (!response.ok) throw new Error('복원할 원본을 다운로드하지 못했습니다.'); const bytes = await response.arrayBuffer(); const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2,'0')).join(''); if (hash !== version.blob.sha256) throw new Error('다운로드한 원본의 무결성을 확인하지 못했습니다.'); await this.append(doc.id, new Blob([bytes], { type: version.blob.mime_type }), doc.content_head_id, undefined, [{ id: crypto.randomUUID(), kind: 'document', document_id: doc.id, version_id: versionId, label: entry.name, quote: `수정 이력 ${version.display_number || version.id} 원본 복원` }]); }
  text(entry: Entry) {
    // An editor's CAS and byte format belong to the version it actually loaded, not a later pull.
    const loaded = new Map<string, LoadedText>();
    return {
      load: async () => {
        const doc = this.state.documents[entry.document_id!], versionId = doc?.content_head_id;
        const version = versionId ? this.state.versions[versionId] : undefined, baseRevision = doc?.revision;
        if (!['.txt', '.md'].includes(entry.extension) || !version || version.document_id !== doc.id || version.blob.size > maxTextBytes) throw new Error('2MB 이하 UTF-8 TXT/Markdown만 원본을 직접 편집할 수 있습니다.');
        const response = await fetch((await this.downloadInfo(version.id)).url);
        if (!response.ok) throw new Error('원본을 읽지 못했습니다.');
        const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let length = 0;
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read(); if (done) break;
              length += value.byteLength;
              if (length > maxTextBytes) { await reader.cancel(); throw new Error('2MB 이하 UTF-8 TXT/Markdown만 원본을 직접 편집할 수 있습니다.'); }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
        }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
        if (bytes.byteLength !== version.blob.size || hash !== version.blob.sha256) throw new Error('다운로드한 원본의 무결성을 확인하지 못했습니다.');
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new Error('UTF-8 파일만 직접 편집할 수 있습니다. 새 초안으로 편집을 사용해 주세요.'); }
        if (text.includes('\0')) throw new Error('텍스트 파일로 읽을 수 없는 내용입니다.');
        loaded.set(version.id, { baseRevision, bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, eol: text.includes('\r\n') ? '\r\n' : '\n' });
        return { filename: entry.name, text: text.replace(/\r\n/g, '\n'), revision: version.id };
      },
      save: async (revision: string, text: string) => {
        const format = loaded.get(revision);
        if (!format) throw new Error('편집한 원본 이력을 확인할 수 없습니다. 내용을 보존한 뒤 원본을 다시 열어 주세요.');
        if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > maxTextBytes) throw new Error('텍스트는 최대 2MB까지 저장할 수 있습니다.');
        const bytes = new TextEncoder().encode((format.bom ? '\ufeff' : '') + text.replace(/\r?\n/g, format.eol));
        if (bytes.byteLength > maxTextBytes) throw new Error('원래 줄바꿈과 BOM을 보존하면 2MB를 넘습니다. 내용을 줄이거나 다른 이름으로 저장해 주세요.');
        const version = await this.append(entry.document_id!, new Blob([bytes], { type: entry.extension === '.md' ? 'text/markdown' : 'text/plain' }), revision, undefined, [], format.baseRevision);
        loaded.set(version.id, { ...format, baseRevision: format.baseRevision + 1 });
        return { filename: entry.name, text: text.replace(/\r\n/g, '\n'), revision: version.id };
      },
    };
  }
  async preview(_id: string, entryId: string): Promise<Preview> { const entry = this.entry(entryId), doc = this.state.documents[entry.document_id!]; if (!doc?.content_head_id) return { kind: 'unsupported' }; if (/^\.(png|jpe?g|gif|webp|bmp)$/.test(entry.extension)) return { kind: 'image', url: (await this.downloadInfo(doc.content_head_id)).url }; return { kind: 'unsupported' }; }
  private writingDraft(draft: Draft): WritingDraft {
    const proposal = Object.values(this.state.proposals).find(item => item.draft_id === draft.id && item.status === 'pending');
    return { id: draft.id, title: draft.title, revision: draft.revision, content: presentContent(content(draft.content, draft.title), draft.sources), sources: draft.sources.map(writingSource), checks: Array.isArray(draft.review) ? draft.review.map(String) : draft.review && typeof draft.review === 'object' && !Array.isArray(draft.review) && Array.isArray(draft.review.checks) ? draft.review.checks.map(String) : [], can_undo: draft.history.length > 0, proposal: proposal ? { content: presentContent(content(proposal.content, draft.title), proposal.sources), sources: proposal.sources.map(writingSource), checks: [] } : null };
  }
  readonly drafts: WorkspaceRepository['drafts'] = {
    list: async () => active(this.state.drafts).map(({ id, title }) => ({ id, title })),
    get: async id => { const draft = this.state.drafts[id]; if (!draft || draft.deleted_at) throw new Error('초안을 찾을 수 없습니다.'); return this.writingDraft(draft); },
    create: async requestId => { const id = crypto.randomUUID(); await this.command('CreateDraft', { id, scope_id: this.state.workspace.root_entry_id, title: '새 초안', content: JSON.stringify({ title: '새 초안', blocks: [] }) }, {}, requestId); return this.writingDraft(this.state.drafts[id]); },
    save: async (id, revision, value) => { const draft = this.state.drafts[id]; await this.command('SaveDraft', { id, title: value.title, content: JSON.stringify(value), sources: draft.sources, review: draft.review }, { [`drafts:${id}`]: revision }); return this.writingDraft(this.state.drafts[id]); },
    remove: async (id, revision) => { await this.command('TrashDraft', { id }, { [`drafts:${id}`]: revision }); },
    review: async (id, revision, action) => { const draft = this.state.drafts[id]; if (action === 'undo') { const previous = draft.history.at(-1); if (!previous) throw new Error('이전 저장 이력이 없습니다.'); await this.command('SaveDraft', { id, title: draft.title, content: previous.content, sources: previous.sources }, { [`drafts:${id}`]: revision }); } else { const proposal = Object.values(this.state.proposals).find(item => item.draft_id === id && item.status === 'pending'); if (!proposal) throw new Error('검토할 제안이 없습니다.'); await this.command('ReviewProposal', { id: proposal.id, decision: action }, { [`proposals:${proposal.id}`]: proposal.revision, [`drafts:${id}`]: revision }); } return this.writingDraft(this.state.drafts[id]); },
    generate: async input => { let draftId = input.draftId; if (!draftId) { draftId = input.requestId; if (!this.state.drafts[draftId]) await this.command('CreateDraft', { id: draftId, scope_id: this.state.workspace.root_entry_id, title: '새 초안', content: JSON.stringify({ title: '새 초안', blocks: [] }) }, {}, input.requestId); } const current = this.state.drafts[draftId]; const evidence = await this.chats.search({ question: input.prompt, scope: 'auto', as_of: null }); const retrieved: SourceSnapshot[] = evidence.sources.map(source => ({ id: source.id, kind: 'document', document_id: source.document_id, version_id: source.version_id, quote: source.text, label: source.document_title, locations: source.locations, version_number: source.version_number })); const sources = [...new Map([...current.sources, ...retrieved].map(source => [source.id, source])).values()].slice(0, 20); await this.ai({ request_id: input.requestId, task: 'write', prompt: input.prompt, draft_id: draftId, current: content(current.content, current.title), sources, base_revision: input.revision ?? current.revision }); await this.pull(); return this.writingDraft(this.state.drafts[draftId]); },
    export: async (id, revision, format) => { const result = await this.request<{ url: string }>(`${this.prefix}/drafts/${id}/export`, { method: 'POST', body: JSON.stringify({ revision, format }) }); const link = document.createElement('a'); link.href = result.url; link.click(); },
  };
  private chatMessage(message: WorkspaceState['chat_messages'][string]): ChatMessage {
    const sources = message.sources.map(source => ({ ...chatSource(source), available: sourceAvailability(this.state, source) === 'available' }));
    const saved = message.metadata?.result && typeof message.metadata.result === 'object' && !Array.isArray(message.metadata.result) ? message.metadata.result : undefined;
    const result = saved || sources.length ? { sources, scope: 'auto' as const, as_of: null, warnings: saved && Array.isArray(saved.warnings) ? saved.warnings.map(String) : [], claims: saved && Array.isArray(saved.claims) ? (saved.claims as unknown as { text: string; source_ids: string[] }[]).map(claim => ({ ...claim, source_ids: claim.source_ids.map(id => { const source = message.sources.find(item => item.id === id); return typeof source?.metadata?.legacy_id === 'string' ? source.metadata.legacy_id : id; }) })) : [{ text: message.content, source_ids: sources.map(item => item.id) }], insufficient: !!saved?.insufficient } : null;
    return { id: message.id, role: message.role === 'assistant' ? 'assistant' : 'user', state: typeof message.metadata?.state === 'string' ? message.metadata.state : 'COMPLETED', content: message.content, error_code: typeof message.metadata?.error_code === 'string' ? message.metadata.error_code : null, created_at: message.created_at, result };
  }
  readonly chats: WorkspaceRepository['chats'] = {
    sessions: async offset => active(this.state.chat_sessions).filter(item => item.sync === 'shared').slice(offset, offset + 50).map(({ id, title }) => ({ id, title })),
    messages: async id => Object.values(this.state.chat_messages).filter(item => item.session_id === id && item.role !== 'system').sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(item => this.chatMessage(item)),
    createSession: async ({ requestId, title }) => { const id = crypto.randomUUID(); await this.command('CreateChatSession', { id, title, scope_id: this.state.workspace.root_entry_id, sync: 'shared' }, {}, requestId); return { id, title }; },
    indexStatus: async () => { const result = await this.request<{ ready: number; jobs: { kind: string; status: string; count: number }[] }>(`${this.prefix}/ai/index-status`); const total = Object.keys(this.state.versions).length; const failed = result.jobs.filter(item => item.kind === 'parse' && item.status === 'failed').reduce((sum, item) => sum + item.count, 0); const count = { versions: total, completed: result.ready, failed, chunks: result.ready, indexed_chunks: result.ready }; return { current: count, all: count }; },
    search: async input => { const result = await this.request<{ results: { id: string; document_id: string; version_id: string; document_title: string; text: string; locations: Source['locations'] }[] }>(`${this.prefix}/ai/search?q=${encodeURIComponent(input.question)}&limit=100&scope=${input.scope}${input.as_of ? `&as_of=${encodeURIComponent(input.as_of)}` : ''}`); return { scope: input.scope, as_of: input.as_of, warnings: [], sources: result.results.map(item => ({ ...item, chunk_id: item.id, version_number: this.state.versions[item.version_id]?.display_number || 1, is_current: this.state.documents[item.document_id]?.reference_head_id === item.version_id })) }; },
    ask: async (sessionId, input) => { if (!this.state.chat_messages[input.requestId]) await this.command('AppendChatMessage', { message: { id: input.requestId, workspace_id: this.workspaceId, session_id: sessionId, role: 'user', content: input.question, sources: [], request_id: null, created_at: new Date().toISOString(), created_by: this.actor } }, {}, input.requestId); const evidence = await this.chats.search(input); const sources: SourceSnapshot[] = evidence.sources.map(source => ({ id: source.id, kind: 'document', document_id: source.document_id, version_id: source.version_id, label: source.document_title, quote: source.text, locations: source.locations, version_number: source.version_number })); const result = await this.ai({ request_id: input.requestId, task: 'chat', prompt: input.question, session_id: sessionId, sources }); await this.pull(); const response = result.message_id ? this.state.chat_messages[result.message_id] : Object.values(this.state.chat_messages).find(item => item.request_id === input.requestId); if (!response) throw new Error('답변 게시 상태를 확인하지 못했습니다. 다시 열어 주세요.'); return this.chatMessage(response); },
    retry: async (sessionId, messageId) => { const message = this.state.chat_messages[messageId]; if (!message) throw new Error('재시도할 대화가 없습니다.'); return this.chats.ask(sessionId, { question: message.content, scope: 'auto', as_of: null, requestId: crypto.randomUUID() }); },
    reindex: async () => { await this.request(`${this.prefix}/ai/reindex`, { method: 'POST', body: '{}' }); },
  };
  private async ai(input: Record<string, unknown>): Promise<{ message_id?: string; draft_id?: string; content?: string; answer?: string }> { let job = await this.request<{ request_id: string; status: string; error?: { message?: string }; result?: { message_id?: string; draft_id?: string; content?: string; answer?: string } }>(`${this.prefix}/ai/context`, { method: 'POST', body: JSON.stringify({ ...input, device_id: this.device }) }); for (let attempt = 0; !['complete', 'failed'].includes(job.status) && attempt < 180; attempt++) { await new Promise(resolve => setTimeout(resolve, 1000)); job = await this.request(`${this.prefix}/jobs/${job.request_id}`); } if (job.status !== 'complete') throw new Error(job.error?.message || 'AI 응답 상태를 확인하지 못했습니다. 요청 이력을 보존했습니다.'); return job.result || {}; }
  async summarizeSelection(_id: string, input: { request_id: string; entry_ids: string[]; directory: string; x: number; y: number }) {
    // Replay an interrupted creation before deciding whether a summary already exists.
    await this.synchronize();
    const parentId = this.scope(input.directory);
    if (input.directory && parentId === this.state.workspace.root_entry_id) throw new Error('요약 파일을 만들 폴더를 찾을 수 없습니다.');
    const existing = this.state.entries[input.request_id];
    if (existing?.deleted_at) throw new Error('이 요약 파일은 삭제됐습니다. 새 요약을 시작해 주세요.');
    if (!existing) {
      const sources: SourceSnapshot[] = [];
      for (const id of input.entry_ids) {
        const entry = this.entry(id), doc = this.state.documents[entry.document_id!];
        if (!doc.reference_head_id) throw new Error(`${entry.name}: 요약할 본문이 없습니다.`);
        const parsed = await this.documentVersion(entry, doc.reference_head_id);
        sources.push({ id: crypto.randomUUID(), kind: 'document', document_id: doc.id, version_id: doc.reference_head_id, quote: parsed.normalized.blocks.map(block => block.text).join('\n').slice(0, 12000), label: entry.name, version_number: parsed.version_number });
      }
      const result = await this.ai({ request_id: input.request_id, task: 'summary', prompt: '선택한 문서들의 내용을 출처와 함께 요약해 주세요.', sources });
      const text = result.answer || result.content || '';
      if (!text.trim()) throw new Error('요약 내용이 비어 있습니다. AI 응답을 확인해 주세요.');
      const id = input.request_id, documentId = crypto.randomUUID();
      const blob = await this.blob(new File([text], `요약-${id.slice(0, 8)}.md`, { type: 'text/markdown' }));
      await this.createFileWithVersion(id, documentId, parentId, `요약-${id.slice(0, 8)}.md`, {
        id: crypto.randomUUID(), workspace_id: this.workspaceId, document_id: documentId, blob, parent_version_ids: [], sources,
        created_at: new Date().toISOString(), created_by: this.actor, change_note: '선택한 파일 요약',
      }, input.request_id);
    }
    const entry = this.entry(input.request_id), document = this.state.documents[entry.document_id!];
    if (!document.content_head_id) throw new Error('요약 파일의 저장 상태를 확인해 주세요.');
    if (!entry.area_positioned) await this.savePositions(this.workspaceId, [{ id: entry.id, x: input.x, y: input.y }]);
    const sources = this.state.versions[document.content_head_id].sources;
    for (const source of sources) {
      if (source.kind !== 'document') continue;
      const target = active(this.state.entries).find(item => item.document_id === source.document_id);
      if (!target || active(this.state.relations).some(item => item.source_document_id === document.id && item.target_document_id === source.document_id && item.relation_type === 'GENERATED_FROM')) continue;
      await this.putCanvasItem(this.workspaceId, entry.parent_path, 'relation', {
        id: crypto.randomUUID(), source_document_id: entry.id, target_document_id: target.id, relation_type: 'GENERATED_FROM',
      }, 0);
    }
    return this.entry(entry.id);
  }

  async conflicts() { return Object.values(this.state.conflicts).filter(item => item.status === 'open').map(item => ({ id: item.id, entity_id: item.entity_id, reason: item.reason, local: item.candidate, remote: (this.state[item.entity_collection] as Record<string, unknown>)[item.entity_id], resolved_at: item.resolved_at, base_revisions: conflictResolutionBases(this.state, item) })); }
  async resolveConflict(id: string, resolution: 'keep_local' | 'keep_remote', reviewedBases?: Record<string, number>) { const conflict = this.state.conflicts[id]; await this.command('ResolveConflict', { id, resolution: resolution === 'keep_local' ? 'apply_candidate' : 'keep_current' }, reviewedBases || conflictResolutionBases(this.state, conflict)); }
  async deleteWorkspace() { await this.command('DeleteWorkspace', {}, { [`workspace:${this.workspaceId}`]: this.state.workspace.revision }); }
}
