import { validateCommand, revisionKey, ContractError } from '../../contracts/src/index.ts';
import type {
  ApplyContext, CanvasElement, ChatMessage, Collection, CommandEnvelope, CommandPayloads,
  CommandResult, DerivedArtifact, DocumentVersion, DomainError, DomainErrorCode, Draft,
  Entity, EntityChange, EntityCollection, Entry, Id, JsonValue, Proposal, Relation,
  SourceSnapshot, SyncConflict, Workspace, WorkspaceState,
} from '../../contracts/src/index.ts';
export { revisionKey, validateCommand } from '../../contracts/src/index.ts';
export type * from '../../contracts/src/index.ts';

/** Storage assigns sequences/receipts; domain never reads a clock, network or filesystem. */
export function createWorkspaceState(workspace: Workspace): WorkspaceState {
  const root: Entry = { id: workspace.root_entry_id, workspace_id: workspace.id, parent_id: null,
    kind: 'folder', name: workspace.name, document_id: null, revision: 1, position_revision: 0,
    x: null, y: null, area_positioned: false, deleted_at: null };
  return { workspace: { ...workspace }, entries: { [root.id]: root }, documents: {}, versions: {},
    canvas_elements: {}, relations: {}, drafts: {}, proposals: {}, chat_sessions: {}, chat_messages: {}, artifacts: {}, conflicts: {} };
}

class Fault extends Error {
  detail: DomainError;
  constructor(code: DomainErrorCode, message: string, details?: JsonValue) { super(message); this.detail = { code, message, ...(details === undefined ? {} : { details }) }; }
}
function fail(code: DomainErrorCode, message: string, details?: JsonValue): never { throw new Fault(code, message, details); }
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  const x = a as Record<string, unknown>; const y = b as Record<string, unknown>;
  const keys = Object.keys(x); return keys.length === Object.keys(y).length && keys.every(k => Object.hasOwn(y, k) && equal(x[k], y[k]));
}

export type SourceAvailability = 'available' | 'deleted' | 'missing' | 'mismatched';
/** Saved quotations remain readable after deletion. Only available sources may be opened. */
export function sourceAvailability(state: WorkspaceState, source: SourceSnapshot): SourceAvailability {
  const own = (value: { workspace_id: Id; deleted_at?: string | null } | undefined): SourceAvailability => !value ? 'missing' : value.workspace_id !== state.workspace.id ? 'mismatched' : value.deleted_at ? 'deleted' : 'available';
  switch (source.kind) {
    case 'document': {
      const document = state.documents[source.document_id]; const version = state.versions[source.version_id];
      if (version && (version.workspace_id !== state.workspace.id || version.document_id !== source.document_id)) return 'mismatched';
      const status = own(document); return status === 'available' && !version ? 'missing' : status;
    }
    case 'note': { const note = state.canvas_elements[source.element_id]; if (note && note.scope_id !== source.scope_id) return 'mismatched'; return own(note); }
    case 'chat': { const message = state.chat_messages[source.message_id]; if (message && message.session_id !== source.session_id) return 'mismatched'; const status = own(state.chat_sessions[source.session_id]); return status === 'available' ? own(message) : status; }
    case 'draft': { const draft = state.drafts[source.draft_id]; const status = own(draft); if (status === 'available' && source.history_id && !draft.history.some(h => h.id === source.history_id)) return 'missing'; return status; }
  }
}

/** Complete initial snapshots are checked without a size cap or recursive tree traversal. */
export function validateWorkspaceGraph(state: WorkspaceState, available_blobs?: ReadonlySet<string>): void {
  const w = state.workspace;
  const ref = <T>(value: T | undefined, label: string): T => { if (!value) fail('invalid_reference', `Missing ${label}`); return value; };
  const folder = (id: Id): Entry => { const e = ref(state.entries[id], `folder ${id}`); if (e.kind !== 'folder') fail('invalid_reference', 'Scope or parent is not a folder'); return e; };
  const sourceCheck = (sources: SourceSnapshot[]) => { for (const s of sources) if (sourceAvailability(state, s) === 'mismatched') fail('invalid_reference', 'Source snapshot has mismatched ownership'); };
  const checkBlob = (blob: { id: Id }) => { if (available_blobs && !available_blobs.has(blob.id)) fail('blob_unavailable', 'Imported blob is not verified', { blob_id: blob.id }); };
  const root = folder(w.root_entry_id); if (root.parent_id !== null || root.deleted_at) fail('invalid_tree', 'Workspace root must be a live root folder');
  const siblings = new Set<string>(); const documentEntries = new Set<Id>();
  for (const entry of Object.values(state.entries)) {
    if (entry.id !== root.id) {
      if (!entry.parent_id) fail('invalid_tree', 'Only the workspace root may have no parent');
      const parent = folder(entry.parent_id); if (!entry.deleted_at && parent.deleted_at) fail('invalid_tree', 'Live entry has a deleted parent');
    }
    if (entry.kind === 'file') {
      if (!entry.document_id) fail('invalid_reference', 'File entry must name a document'); ref(state.documents[entry.document_id], 'entry document');
      if (documentEntries.has(entry.document_id)) fail('invalid_reference', 'Document belongs to multiple entries'); documentEntries.add(entry.document_id);
    } else if (entry.document_id !== null) fail('invalid_reference', 'Folder cannot name a document');
    if (!entry.deleted_at && entry.parent_id) { const key = JSON.stringify([entry.parent_id, entry.name]); if (siblings.has(key)) fail('name_conflict', 'Imported siblings have the same name'); siblings.add(key); }
  }
  const acyclic = (records: Record<Id, { id: Id }>, parents: (id: Id) => Id[], label: string): void => {
    const counts = new Map<Id, number>(); const children = new Map<Id, Id[]>(); const queue: Id[] = [];
    for (const key of Object.keys(records)) { const ids = parents(key); counts.set(key, ids.length); if (!ids.length) queue.push(key);
      for (const parent of ids) { if (!records[parent]) fail('invalid_reference', `${label} has a missing parent`); const list = children.get(parent) ?? []; list.push(key); children.set(parent, list); } }
    let seen = 0;
    for (let i = 0; i < queue.length; i++) { const key = queue[i]; seen++; for (const child of children.get(key) ?? []) { const n = counts.get(child)! - 1; counts.set(child, n); if (!n) queue.push(child); } }
    if (seen !== counts.size) fail('invalid_tree', `${label} contains a cycle`);
  };
  acyclic(state.entries, key => state.entries[key].parent_id ? [state.entries[key].parent_id!] : [], 'Entry tree');
  for (const document of Object.values(state.documents)) {
    if (!documentEntries.has(document.id)) fail('invalid_reference', 'Document has no file entry');
    for (const head of [document.content_head_id, document.reference_head_id]) if (head && ref(state.versions[head], 'document head').document_id !== document.id) fail('invalid_reference', 'Head belongs to another document');
    if (!document.reference_pinned && document.reference_head_id !== document.content_head_id) fail('invalid_reference', 'Unpinned reference head must follow content head');
  }
  for (const version of Object.values(state.versions)) {
    ref(state.documents[version.document_id], 'version document'); checkBlob(version.blob); sourceCheck(version.sources);
    for (const parent of version.parent_version_ids) if (ref(state.versions[parent], 'version parent').document_id !== version.document_id) fail('invalid_reference', 'Version parent belongs to another document');
  }
  acyclic(state.versions, key => state.versions[key].parent_version_ids, 'Version history');
  for (const e of Object.values(state.canvas_elements)) { folder(e.scope_id); sourceCheck(e.sources); }
  const relationKeys = new Set<string>();
  for (const r of Object.values(state.relations)) {
    folder(r.scope_id); ref(state.documents[r.source_document_id], 'relation source'); ref(state.documents[r.target_document_id], 'relation target');
    if (r.source_document_id === r.target_document_id) fail('invalid_reference', 'Relation cannot point to itself');
    if (!r.deleted_at) { const key = JSON.stringify([r.scope_id, r.source_document_id, r.target_document_id, r.relation_type]); if (relationKeys.has(key)) fail('already_exists', 'Duplicate scoped relation'); relationKeys.add(key); }
  }
  for (const d of Object.values(state.drafts)) { folder(d.scope_id); sourceCheck(d.sources); for (const h of d.history) sourceCheck(h.sources); }
  for (const p of Object.values(state.proposals)) { ref(state.drafts[p.draft_id], 'proposal draft'); sourceCheck(p.sources); }
  for (const s of Object.values(state.chat_sessions)) folder(s.scope_id);
  const requests = new Set<Id>();
  for (const m of Object.values(state.chat_messages)) { ref(state.chat_sessions[m.session_id], 'message session'); sourceCheck(m.sources); if (m.request_id) { if (requests.has(m.request_id)) fail('already_exists', 'AI request has duplicate messages'); requests.add(m.request_id); } }
  const artifactKeys = new Set<string>();
  for (const a of Object.values(state.artifacts)) { if (ref(state.versions[a.version_id], 'artifact version').document_id !== a.document_id) fail('invalid_reference', 'Artifact document mismatch'); checkBlob(a.blob);
    const key = JSON.stringify([a.version_id, a.kind, a.processor_fingerprint]); if (artifactKeys.has(key)) fail('already_exists', 'Duplicate processor artifact'); artifactKeys.add(key); }
}

/** Pure transaction: rejection returns the original state; changed maps are copied lazily. */
export function applyCommand(state: WorkspaceState, input: unknown, context: ApplyContext): CommandResult {
  const changes: EntityChange[] = []; const conflict_ids: Id[] = []; let next = state;
  try {
    const command = validateCommand(input);
    if (command.workspace_id !== state.workspace.id) fail('workspace_mismatch', 'Command belongs to another workspace');
    if (context.role !== 'OWNER' && context.role !== 'EDITOR') fail('forbidden', 'Workspace is read-only');
    if (state.workspace.deleted_at) fail('workspace_deleted', 'Workspace was deleted; local changes must be recovered separately', { epoch: state.workspace.epoch });
    if (command.workspace_epoch !== state.workspace.epoch) fail('epoch_mismatch', 'Workspace deletion epoch changed', { expected: command.workspace_epoch, actual: state.workspace.epoch });
    if (!Number.isFinite(Date.parse(context.now))) fail('invalid_command', 'Context now must be an ISO timestamp');
    const cloned = new Set<Collection>(); const changeIndexes = new Map<string, number>(); next = { ...state };
    const put = (collection: Collection, value: Entity): void => {
      const fresh = copy(value);
      if (collection === 'workspace') next.workspace = fresh as Workspace;
      else {
        if (!cloned.has(collection)) {
          (next as unknown as Record<string, unknown>)[collection] = { ...next[collection] };
          cloned.add(collection);
        }
        (next[collection] as Record<string, Entity>)[fresh.id] = fresh;
      }
      const changeKey = `${collection}:${fresh.id}`; const prior = changeIndexes.get(changeKey);
      const patch: EntityChange = { collection, id: fresh.id, value: fresh };
      if (prior === undefined) { changeIndexes.set(changeKey, changes.length); changes.push(patch); } else changes[prior] = patch;
    };
    const own = <T extends { workspace_id: Id }>(value: T | undefined, label: string): T => {
      if (!value) fail('not_found', `${label} does not exist`);
      if (value.workspace_id !== state.workspace.id) fail('workspace_mismatch', `${label} belongs to another workspace`);
      return value;
    };
    const active = <T extends { workspace_id: Id; deleted_at: string | null }>(value: T | undefined, label: string): T => {
      const row = own(value, label); if (row.deleted_at) fail('not_found', `${label} was deleted`); return row;
    };
    const scope = (id: Id): Entry => { const e = active(next.entries[id], 'Canvas scope'); if (e.kind !== 'folder') fail('invalid_reference', 'Canvas scope must be a folder'); return e; };
    const expected = (collection: Collection | 'entry_positions', id: Id): number => {
      const key = revisionKey(collection, id); const value = command.base_revisions?.[key];
      if (value === undefined) fail('revision_required', `Missing base revision ${key}`);
      return value;
    };
    const conflict = (collection: EntityCollection, id: Id, base: number | null, actual: number | null, reason = 'revision_conflict'): void => {
      const row: SyncConflict = { id: command.operation_id, workspace_id: state.workspace.id, operation_id: command.operation_id,
        entity_collection: collection, entity_id: id, reason, expected_revision: base, actual_revision: actual,
        candidate: copy({ type: command.type, payload: command.payload }) as unknown as JsonValue,
        status: 'open', resolution: null, created_at: context.now, resolved_at: null, revision: 1 };
      const prior = next.conflicts[row.id];
      if (prior && !equal(prior.candidate, row.candidate)) fail('already_exists', 'Operation ID already belongs to a different conflict');
      if (!prior) put('conflicts', row);
      conflict_ids.push(row.id);
    };
    const cas = (collection: EntityCollection, id: Id, actual: number, keyCollection: Collection | 'entry_positions' = collection): boolean => {
      const base = expected(keyCollection, id);
      if (base === actual) return true;
      conflict(collection, id, base, actual); return false;
    };
    const requireCas = (collection: Collection | 'entry_positions', id: Id, actual: number): void => {
      const base = expected(collection, id); if (base !== actual) fail('revision_conflict', `Stale revision ${collection}:${id}`, { expected: base, actual });
    };
    const checkSources = (sources: SourceSnapshot[]): void => { for (const source of sources) if (sourceAvailability(next, source) === 'mismatched') fail('invalid_reference', 'Source snapshot refers to another entity or workspace', { source_id: source.id }); };
    const checkName = (parent_id: Id, name: string, excluding?: Id): void => {
      for (const e of Object.values(next.entries)) if (!e.deleted_at && e.parent_id === parent_id && e.id !== excluding && e.name === name) fail('name_conflict', 'A sibling has the same name', { entry_id: e.id, parent_id, name });
    };
    const checkParent = (entry: Entry, parent_id: Id): void => {
      scope(parent_id); const visited = new Set<Id>([entry.id]); let p: Id | null = parent_id;
      while (p) { if (visited.has(p)) fail('invalid_tree', 'A folder cannot be moved into its descendants'); visited.add(p); const row: Entry | undefined = next.entries[p]; if (!row) fail('invalid_tree', 'Tree has a missing ancestor'); p = row.parent_id; }
    };
    const versionFor = (document_id: Id, version_id: Id): DocumentVersion => {
      const version = own(next.versions[version_id], 'Document version'); if (version.document_id !== document_id) fail('invalid_reference', 'Version belongs to another document'); return version;
    };
    const blob = (reference: { id: Id }): void => { if (context.available_blobs && !context.available_blobs.has(reference.id)) fail('blob_unavailable', 'Blob upload is not verified', { blob_id: reference.id }); };
    const appendVersion = (version: DocumentVersion, select_head = true): void => {
      own(version, 'Document version'); const document = own(next.documents[version.document_id], 'Document');
      const existing = next.versions[version.id];
      if (existing && !equal(existing, version)) fail('immutable_version', 'Version UUID cannot be reused for different bytes or metadata');
      for (const parent of version.parent_version_ids) versionFor(version.document_id, parent);
      if (version.created_by !== context.actor_id) fail('forbidden', 'Version actor does not match authenticated actor');
      blob(version.blob); checkSources(version.sources);
      if (!existing) put('versions', version);
      if (!select_head) return;
      const base = expected('documents', document.id);
      if (document.deleted_at) { conflict('documents', document.id, base, document.revision, 'delete_vs_edit'); return; }
      if (base !== document.revision) { conflict('documents', document.id, base, document.revision, 'concurrent_versions'); return; }
      if (document.content_head_id && !version.parent_version_ids.includes(document.content_head_id) && version.id !== document.content_head_id) {
        conflict('documents', document.id, base, document.revision, 'divergent_version_parent'); return;
      }
      put('documents', { ...document, content_head_id: version.id, reference_head_id: document.reference_pinned ? document.reference_head_id : version.id, revision: document.revision + 1 });
    };
    const saveDraft = (payload: CommandPayloads['SaveDraft']): void => {
      const draft = active(next.drafts[payload.id], 'Draft'); checkSources(payload.sources);
      if (!cas('drafts', draft.id, draft.revision)) {
        const proposal: Proposal = { id: command.operation_id, workspace_id: state.workspace.id, draft_id: draft.id,
          base_revision: expected('drafts', draft.id), content: payload.content, sources: payload.sources,
          review: payload.review ?? null, status: 'pending', created_at: context.now, created_by: context.actor_id, revision: 1 };
        put('proposals', proposal); return;
      }
      const history = [...draft.history, { id: command.operation_id, content: payload.content, sources: payload.sources, review: payload.review ?? draft.review, created_at: context.now, created_by: context.actor_id }];
      put('drafts', { ...draft, title: payload.title, content: payload.content, sources: payload.sources, review: payload.review ?? draft.review, history, revision: draft.revision + 1 });
    };
    const appendMessage = (message: ChatMessage): void => {
      own(message, 'Chat message'); active(next.chat_sessions[message.session_id], 'Chat session'); checkSources(message.sources);
      if (message.created_by !== context.actor_id) fail('forbidden', 'Message actor does not match authenticated actor');
      const existing = next.chat_messages[message.id]; if (existing) { if (!equal(existing, message)) fail('already_exists', 'Message ID already exists'); return; }
      if (message.request_id && Object.values(next.chat_messages).some(m => m.request_id === message.request_id)) fail('already_exists', 'AI request already has a completed message');
      put('chat_messages', message);
    };
    const updateMessage = (message: ChatMessage): void => {
      own(message, 'Chat message'); active(next.chat_sessions[message.session_id], 'Chat session'); checkSources(message.sources);
      const prior = own(next.chat_messages[message.id], 'Chat message');
      if (message.session_id !== prior.session_id || message.role !== prior.role || message.created_at !== prior.created_at || message.created_by !== prior.created_by) fail('immutable_version', 'Message identity and author cannot change');
      if (message.created_by !== context.actor_id && context.role !== 'OWNER') fail('forbidden', 'Only the author or workspace owner may complete this message');
      if (!cas('chat_messages', message.id, prior.revision ?? 1)) return;
      const before = prior.metadata?.state ?? 'COMPLETED', after = message.metadata?.state ?? 'COMPLETED';
      const transitions: Record<string, string[]> = { QUEUED: ['QUEUED', 'RUNNING', 'FAILED'], RUNNING: ['RUNNING', 'COMPLETED', 'FAILED'], FAILED: ['FAILED', 'RUNNING', 'QUEUED'], COMPLETED: ['COMPLETED'] };
      if (typeof before !== 'string' || typeof after !== 'string' || !transitions[before]?.includes(after)) fail('invalid_command', 'Invalid chat request state transition');
      if (before === 'COMPLETED' && (message.content !== prior.content || !equal(message.sources, prior.sources) || message.request_id !== prior.request_id)) fail('immutable_version', 'Completed chat content cannot be rewritten');
      if (message.request_id && Object.values(next.chat_messages).some(m => m.id !== message.id && m.request_id === message.request_id)) fail('already_exists', 'AI request already belongs to another message');
      put('chat_messages', { ...message, revision: (prior.revision ?? 1) + 1 });
    };
    const createProposal = (payload: CommandPayloads['CreateProposal']): void => {
      const draft = active(next.drafts[payload.draft_id], 'Draft'); checkSources(payload.sources);
      if (next.proposals[payload.id]) fail('already_exists', 'Proposal ID already exists');
      put('proposals', { id: payload.id, workspace_id: state.workspace.id, draft_id: draft.id, base_revision: expected('drafts', draft.id),
        content: payload.content, sources: payload.sources, review: payload.review ?? null, status: 'pending', created_at: context.now, created_by: context.actor_id, revision: 1 });
    };
    const artifact = (value: DerivedArtifact): void => {
      own(value, 'Artifact'); versionFor(value.document_id, value.version_id); blob(value.blob);
      const existing = next.artifacts[value.id]; if (existing) { if (!equal(existing, value)) fail('already_exists', 'Artifact ID is immutable'); return; }
      if (Object.values(next.artifacts).some(a => a.version_id === value.version_id && a.kind === value.kind && a.processor_fingerprint === value.processor_fingerprint && a.id !== value.id)) fail('already_exists', 'Processor artifact already exists for this version');
      put('artifacts', value);
    };

    switch (command.type) {
      case 'ImportWorkspace': {
        if (context.role !== 'OWNER') fail('forbidden', 'Only an owner may import a workspace'); requireCas('workspace', state.workspace.id, state.workspace.revision);
        if (Object.values(state.entries).some(e => e.id !== state.workspace.root_entry_id) || Object.entries(state).some(([key, value]) => key !== 'workspace' && key !== 'entries' && Object.keys(value).length > 0)) fail('already_exists', 'Import is only allowed into an empty workspace');
        const imported = command.payload.state;
        if (imported.workspace.id !== state.workspace.id || imported.workspace.root_entry_id !== state.workspace.root_entry_id) fail('workspace_mismatch', 'Imported workspace and root IDs must match the target');
        if (imported.workspace.deleted_at || imported.workspace.epoch !== state.workspace.epoch) fail('epoch_mismatch', 'Cannot import a deleted workspace or a different deletion epoch');
        validateWorkspaceGraph(imported, context.available_blobs);
        put('workspace', { ...imported.workspace, created_at: state.workspace.created_at, updated_at: context.now, revision: state.workspace.revision + 1 });
        for (const collection of Object.keys(imported) as Collection[]) if (collection !== 'workspace') for (const entity of Object.values(imported[collection])) put(collection, entity);
        break;
      }
      case 'CreateEntry': {
        const p = command.payload; scope(p.parent_id); if (next.entries[p.id]) fail('already_exists', 'Entry ID already exists'); checkName(p.parent_id, p.name);
        if (p.kind === 'file') { const document_id = p.document_id!; if (next.documents[document_id]) fail('already_exists', 'Document ID already exists'); put('documents', { id: document_id, workspace_id: state.workspace.id, content_head_id: null, reference_head_id: null, reference_pinned: false, revision: 0, deleted_at: null }); }
        put('entries', { id: p.id, workspace_id: state.workspace.id, parent_id: p.parent_id, name: p.name, kind: p.kind,
          document_id: p.kind === 'file' ? p.document_id! : null, revision: 1, position_revision: 0, x: p.x ?? null, y: p.y ?? null, area_positioned: p.area_positioned ?? false, deleted_at: null }); break;
      }
      case 'MoveEntry': {
        const p = command.payload; const entry = active(next.entries[p.id], 'Entry'); if (entry.id === state.workspace.root_entry_id) fail('invalid_tree', 'Root cannot be moved');
        if (!cas('entries', entry.id, entry.revision)) break; checkParent(entry, p.parent_id); checkName(p.parent_id, p.name, entry.id);
        put('entries', { ...entry, parent_id: p.parent_id, name: p.name, revision: entry.revision + 1 }); break;
      }
      case 'MoveEntries': {
        const moved = command.payload.moves.map(move => ({ move, entry: active(next.entries[move.id], 'Entry') }));
        if (moved.some(({ entry }) => entry.id === state.workspace.root_entry_id)) fail('invalid_tree', 'Root cannot be moved');
        let okay = true; for (const { entry } of moved) if (!cas('entries', entry.id, entry.revision)) { okay = false; break; }
        if (!okay) break;
        const entries = { ...next.entries };
        for (const { entry, move } of moved) entries[entry.id] = { ...entry, parent_id: move.parent_id, name: move.name, revision: entry.revision + 1 };
        // Validate the final graph, rather than rejecting a safe swap because one intermediate name exists.
        validateWorkspaceGraph({ ...next, entries });
        for (const { entry } of moved) put('entries', entries[entry.id]);
        break;
      }
      case 'ReconcileEntries': {
        const moved = command.payload.moves.map(move => ({ move, entry: active(next.entries[move.id], 'Entry') }));
        if (moved.some(({ entry }) => entry.id === state.workspace.root_entry_id)) fail('invalid_tree', 'Root cannot be moved');
        let okay = true; for (const { entry } of moved) if (!cas('entries', entry.id, entry.revision)) { okay = false; break; }
        if (!okay) break;
        const entries = { ...next.entries }, documents = { ...next.documents }; const created: Entry[] = [];
        for (const payload of command.payload.creates) {
          if (entries[payload.id]) fail('already_exists', 'Entry UUID has already been used, including trash');
          if (payload.kind === 'file') {
            const document_id = payload.document_id!; if (documents[document_id]) fail('already_exists', 'Document UUID has already been used, including trash');
            documents[document_id] = { id: document_id, workspace_id: state.workspace.id, content_head_id: null, reference_head_id: null, reference_pinned: false, revision: 0, deleted_at: null };
          }
          const entry: Entry = { id: payload.id, workspace_id: state.workspace.id, parent_id: payload.parent_id, name: payload.name, kind: payload.kind, document_id: payload.kind === 'file' ? payload.document_id! : null,
            revision: 1, position_revision: 0, x: payload.x ?? null, y: payload.y ?? null, area_positioned: payload.area_positioned ?? false, deleted_at: null };
          entries[entry.id] = entry; created.push(entry);
        }
        for (const { entry, move } of moved) entries[entry.id] = { ...entry, parent_id: move.parent_id, name: move.name, revision: entry.revision + 1 };
        validateWorkspaceGraph({ ...next, entries, documents });
        for (const entry of created) if (entry.document_id) put('documents', documents[entry.document_id]);
        for (const entry of created) put('entries', entry);
        for (const { entry } of moved) put('entries', entries[entry.id]);
        break;
      }
      case 'TrashEntry': {
        const entry = active(next.entries[command.payload.id], 'Entry'); if (entry.id === state.workspace.root_entry_id) fail('invalid_tree', 'Use DeleteWorkspace to delete the root');
        if (!cas('entries', entry.id, entry.revision)) break;
        const children = new Map<Id, Entry[]>(); for (const e of Object.values(next.entries)) if (e.parent_id && !e.deleted_at) { const list = children.get(e.parent_id) ?? []; list.push(e); children.set(e.parent_id, list); }
        const stack = [entry]; const visited = new Set<Id>(); const subtree: Entry[] = [];
        while (stack.length) { const e = stack.pop()!; if (visited.has(e.id)) fail('invalid_tree', 'Tree contains a cycle'); visited.add(e.id); subtree.push(e); stack.push(...(children.get(e.id) ?? [])); }
        // Folder deletion must name revisions for all modified descendants. An offline stale subtree cannot erase newer edits.
        let stale = false;
        for (const e of subtree) { if (!cas('entries', e.id, e.revision)) { stale = true; break; } if (e.document_id) { const d = own(next.documents[e.document_id], 'Document'); if (!cas('documents', d.id, d.revision)) { stale = true; break; } } }
        if (stale) break;
        let unseen = false;
        const subtreeDocuments = new Set(subtree.map(e => e.document_id).filter(Boolean));
        if (command.payload.observed_heads) for (const [documentId, observed] of Object.entries(command.payload.observed_heads)) {
          if (!subtreeDocuments.has(documentId)) fail('invalid_reference', 'Observed head belongs to another deletion subtree');
          const d = next.documents[documentId]; if (observed) versionFor(d.id, observed);
          if (d.content_head_id !== observed) { conflict('documents', d.id, d.revision, d.revision, 'delete_vs_unobserved_version'); unseen = true; break; }
        }
        if (unseen) break;
        for (const e of subtree) { put('entries', { ...e, deleted_at: context.now, revision: e.revision + 1 }); if (e.document_id) { const d = next.documents[e.document_id]; put('documents', { ...d, deleted_at: context.now, revision: d.revision + 1 }); } }
        break;
      }
      case 'RestoreEntry': {
        const p = command.payload; const entry = own(next.entries[p.id], 'Entry'); if (!entry.deleted_at) fail('invalid_tree', 'Entry is not in trash'); if (!cas('entries', entry.id, entry.revision)) break;
        checkParent(entry, p.parent_id); checkName(p.parent_id, p.name ?? entry.name, entry.id);
        put('entries', { ...entry, parent_id: p.parent_id, name: p.name ?? entry.name, deleted_at: null, revision: entry.revision + 1 });
        if (entry.document_id) { const d = own(next.documents[entry.document_id], 'Document'); requireCas('documents', d.id, d.revision); put('documents', { ...d, deleted_at: null, revision: d.revision + 1 }); } break;
      }
      case 'AppendDocumentVersion': appendVersion(command.payload.version, command.payload.select_head ?? true); break;
      case 'SelectContentHead': case 'SelectReferenceHead': {
        const p = command.payload; const document = active(next.documents[p.document_id], 'Document'); versionFor(document.id, p.version_id);
        if (!cas('documents', document.id, document.revision)) break;
        put('documents', command.type === 'SelectReferenceHead'
          ? { ...document, reference_head_id: command.payload.pinned ? p.version_id : document.content_head_id, reference_pinned: command.payload.pinned, revision: document.revision + 1 }
          : { ...document, content_head_id: p.version_id, reference_head_id: document.reference_pinned ? document.reference_head_id : p.version_id, revision: document.revision + 1 }); break;
      }
      case 'SetEntryPositions': {
        const entries = command.payload.positions.map(p => active(next.entries[p.id], 'Entry'));
        let okay = true; for (const e of entries) if (!cas('entries', e.id, e.position_revision, 'entry_positions')) { okay = false; break; }
        if (okay) for (let i = 0; i < entries.length; i++) { const e = entries[i]; const p = command.payload.positions[i]; put('entries', { ...e, x: p.x, y: p.y, area_positioned: p.area_positioned ?? e.area_positioned, position_revision: e.position_revision + 1 }); } break;
      }
      case 'PutCanvasElement': {
        const element = command.payload.element; own(element, 'Canvas element'); scope(element.scope_id); checkSources(element.sources); const existing = next.canvas_elements[element.id];
        if (existing && !cas('canvas_elements', existing.id, own(existing, 'Canvas element').revision)) break;
        if (element.deleted_at) fail('invalid_command', 'Use RemoveCanvasElement for deletion');
        put('canvas_elements', { ...element, revision: (existing?.revision ?? 0) + 1, deleted_at: null }); break;
      }
      case 'RemoveCanvasElement': {
        const element = active(next.canvas_elements[command.payload.id], 'Canvas element'); if (cas('canvas_elements', element.id, element.revision)) put('canvas_elements', { ...element, revision: element.revision + 1, deleted_at: context.now }); break;
      }
      case 'PutRelation': {
        const relation = command.payload.relation; own(relation, 'Relation'); scope(relation.scope_id); active(next.documents[relation.source_document_id], 'Relation source'); active(next.documents[relation.target_document_id], 'Relation target');
        if (relation.source_document_id === relation.target_document_id) fail('invalid_reference', 'A document cannot relate to itself');
        const existing = next.relations[relation.id]; if (existing && !cas('relations', relation.id, own(existing, 'Relation').revision)) break;
        if (relation.deleted_at) fail('invalid_command', 'Use RemoveRelation for deletion');
        if (Object.values(next.relations).some(r => !r.deleted_at && r.id !== relation.id && r.scope_id === relation.scope_id && r.source_document_id === relation.source_document_id && r.target_document_id === relation.target_document_id && r.relation_type === relation.relation_type)) fail('already_exists', 'Relation already exists in this scope');
        put('relations', { ...relation, revision: (existing?.revision ?? 0) + 1, deleted_at: null }); break;
      }
      case 'RemoveRelation': { const r = active(next.relations[command.payload.id], 'Relation'); if (cas('relations', r.id, r.revision)) put('relations', { ...r, revision: r.revision + 1, deleted_at: context.now }); break; }
      case 'CreateDraft': {
        const p = command.payload; scope(p.scope_id); if (next.drafts[p.id]) fail('already_exists', 'Draft ID already exists'); checkSources(p.sources ?? []);
        put('drafts', { id: p.id, workspace_id: state.workspace.id, scope_id: p.scope_id, title: p.title, content: p.content ?? '', sources: p.sources ?? [],
          history: [{ id: command.operation_id, content: p.content ?? '', sources: p.sources ?? [], review: p.review ?? null, created_at: context.now, created_by: context.actor_id }], review: p.review ?? null, revision: 1, deleted_at: null }); break;
      }
      case 'SaveDraft': saveDraft(command.payload); break;
      case 'TrashDraft': { const d = active(next.drafts[command.payload.id], 'Draft'); if (cas('drafts', d.id, d.revision)) put('drafts', { ...d, deleted_at: context.now, revision: d.revision + 1 }); break; }
      case 'CreateProposal': createProposal(command.payload); break;
      case 'ReviewProposal': {
        const p = command.payload; const proposal = own(next.proposals[p.id], 'Proposal'); if (proposal.status !== 'pending') fail('conflict_unresolved', 'Proposal was already reviewed'); if (!cas('proposals', proposal.id, proposal.revision)) break;
        const draft = active(next.drafts[proposal.draft_id], 'Draft');
        if (p.decision === 'accept') { const base = expected('drafts', draft.id); if (base !== draft.revision || proposal.base_revision !== draft.revision) { conflict('drafts', draft.id, proposal.base_revision, draft.revision, 'stale_proposal'); break; }
          checkSources(proposal.sources); put('drafts', { ...draft, content: proposal.content, sources: proposal.sources, review: proposal.review,
            history: [...draft.history, { id: command.operation_id, content: proposal.content, sources: proposal.sources, created_at: context.now, created_by: context.actor_id }], revision: draft.revision + 1 }); }
        put('proposals', { ...proposal, status: p.decision === 'accept' ? 'accepted' : 'rejected', revision: proposal.revision + 1 }); break;
      }
      case 'CreateChatSession': {
        const p = command.payload; scope(p.scope_id); if (next.chat_sessions[p.id]) fail('already_exists', 'Chat session already exists');
        put('chat_sessions', { id: p.id, workspace_id: state.workspace.id, scope_id: p.scope_id, title: p.title, sync: p.sync ?? 'shared', revision: 1, deleted_at: null }); break;
      }
      case 'RenameChatSession': { const p = command.payload; const session = active(next.chat_sessions[p.id], 'Chat session'); if (cas('chat_sessions', session.id, session.revision)) put('chat_sessions', { ...session, title: p.title, revision: session.revision + 1 }); break; }
      case 'TrashChatSession': { const session = active(next.chat_sessions[command.payload.id], 'Chat session'); if (cas('chat_sessions', session.id, session.revision)) put('chat_sessions', { ...session, deleted_at: context.now, revision: session.revision + 1 }); break; }
      case 'AppendChatMessage': appendMessage(command.payload.message); break;
      case 'UpdateChatMessage': updateMessage(command.payload.message); break;
      case 'CompleteAIRequest': {
        const p = command.payload; if (p.message) { if (p.message.request_id !== p.request_id || p.message.role !== 'assistant') fail('invalid_command', 'AI completion requires an assistant message with the same request ID'); const prior = next.chat_messages[p.message.id]; if (prior && !equal(prior, p.message)) updateMessage(p.message); else appendMessage(p.message); }
        if (p.proposal) createProposal(p.proposal); for (const a of p.artifacts ?? []) artifact(a); break;
      }
      case 'PutDerivedArtifact': artifact(command.payload.artifact); break;
      case 'ResolveConflict': {
        const p = command.payload; const row = own(next.conflicts[p.id], 'Conflict'); if (row.status !== 'open') fail('conflict_unresolved', 'Conflict already resolved'); requireCas('conflicts', row.id, row.revision);
        if (p.resolution === 'apply_candidate') {
          const candidate = row.candidate as unknown as { type: string; payload: unknown };
          if (candidate.type === 'AppendDocumentVersion') {
            const version = (candidate.payload as CommandPayloads['AppendDocumentVersion']).version; const d = active(next.documents[version.document_id], 'Document'); requireCas('documents', d.id, d.revision); versionFor(d.id, version.id);
            put('documents', { ...d, content_head_id: version.id, reference_head_id: d.reference_pinned ? d.reference_head_id : version.id, revision: d.revision + 1 });
          } else if (candidate.type === 'SaveDraft') {
            const incoming = candidate.payload as CommandPayloads['SaveDraft']; const d = active(next.drafts[incoming.id], 'Draft'); requireCas('drafts', d.id, d.revision); checkSources(incoming.sources);
            const content = p.merged_content ?? incoming.content; put('drafts', { ...d, title: incoming.title, content, sources: incoming.sources, review: incoming.review ?? d.review,
              history: [...d.history, { id: command.operation_id, content, sources: incoming.sources, created_at: context.now, created_by: context.actor_id }], revision: d.revision + 1 });
            const proposal = next.proposals[row.operation_id]; if (proposal?.status === 'pending') put('proposals', { ...proposal, status: 'accepted', revision: proposal.revision + 1 });
          } else if (candidate.type === 'PutCanvasElement') {
            const incoming = (candidate.payload as CommandPayloads['PutCanvasElement']).element; const current = active(next.canvas_elements[incoming.id], 'Canvas element'); requireCas('canvas_elements', current.id, current.revision); scope(incoming.scope_id); checkSources(incoming.sources);
            put('canvas_elements', { ...incoming, content: p.merged_content ?? incoming.content, revision: current.revision + 1, deleted_at: null });
          } else {
            if (candidate.type === 'ResolveConflict' || candidate.type === 'ImportWorkspace') fail('conflict_unresolved', 'This candidate cannot be replayed');
            let payload = candidate.payload;
            if (candidate.type === 'TrashEntry') payload = { ...(payload as CommandPayloads['TrashEntry']), observed_heads: undefined };
            const replay = validateCommand({ ...command, type: candidate.type, payload });
            const result = applyCommand(next, replay, context);
            if (result.status !== 'applied') fail('conflict_unresolved', result.error?.message ?? 'The candidate changed during review');
            for (const change of result.changes) { if (!change.value) fail('invalid_command', 'Conflict replay cannot erase history'); put(change.collection, change.value); }
          }
        }
        put('conflicts', { ...row, status: 'resolved', resolution: { choice: p.resolution, ...(p.merged_content === undefined ? {} : { merged_content: p.merged_content }) }, resolved_at: context.now, revision: row.revision + 1 }); break;
      }
      case 'RenameWorkspace': {
        requireCas('workspace', state.workspace.id, state.workspace.revision);
        put('workspace', { ...state.workspace, name: command.payload.name, revision: state.workspace.revision + 1, updated_at: context.now });
        const root = own(next.entries[state.workspace.root_entry_id], 'Root'); put('entries', { ...root, name: command.payload.name, revision: root.revision + 1 }); break;
      }
      case 'DeleteWorkspace': {
        if (context.role !== 'OWNER') fail('forbidden', 'Only an owner may delete a workspace'); requireCas('workspace', state.workspace.id, state.workspace.revision);
        put('workspace', { ...state.workspace, epoch: state.workspace.epoch + 1, revision: state.workspace.revision + 1, deleted_at: context.now, updated_at: context.now }); break;
      }
    }
    return { status: conflict_ids.length ? 'conflict' : 'applied', state: changes.length ? next : state, changes, conflict_ids,
      ...(conflict_ids.length ? { error: { code: 'revision_conflict' as const, message: 'Both candidates were preserved for review' } } : {}) };
  } catch (error) {
    if (error instanceof ContractError) return { status: 'rejected', state, changes: [], conflict_ids: [], error: { code: 'invalid_command', message: error.message } };
    if (error instanceof Fault) return { status: 'rejected', state, changes: [], conflict_ids: [], error: error.detail };
    throw error;
  }
}

/** The caller reviews the current read set; replay never silently upgrades its CAS. */
export function conflictResolutionBases(state: WorkspaceState, conflict: SyncConflict): Record<string, number> {
  const bases: Record<string, number> = { [revisionKey('conflicts', conflict.id)]: conflict.revision };
  const current = state[conflict.entity_collection][conflict.entity_id];
  if (current && 'revision' in current && typeof current.revision === 'number') bases[revisionKey(conflict.entity_collection, conflict.entity_id)] = current.revision;
  const candidate = conflict.candidate as unknown as { type: string; payload: Record<string, unknown> };
  const entry = (id: Id) => { const e = state.entries[id]; if (e) bases[revisionKey('entries', id)] = e.revision; return e; };
  if (candidate.type === 'TrashEntry') {
    const children = new Map<Id, Entry[]>(); for (const e of Object.values(state.entries)) if (e.parent_id && !e.deleted_at) { const list = children.get(e.parent_id) ?? []; list.push(e); children.set(e.parent_id, list); }
    const root = state.entries[candidate.payload.id as Id], queue = root ? [root] : [];
    for (let i = 0; i < queue.length; i++) { const e = queue[i]; entry(e.id); if (e.document_id) bases[revisionKey('documents', e.document_id)] = state.documents[e.document_id].revision; queue.push(...children.get(e.id) ?? []); }
  } else if (candidate.type === 'MoveEntry' || candidate.type === 'RestoreEntry') {
    const e = entry(candidate.payload.id as Id); if (candidate.type === 'RestoreEntry' && e?.document_id) bases[revisionKey('documents', e.document_id)] = state.documents[e.document_id].revision;
  } else if (candidate.type === 'MoveEntries' || candidate.type === 'ReconcileEntries') {
    for (const move of candidate.payload.moves as {id:Id}[]) entry(move.id);
  } else if (candidate.type === 'SetEntryPositions') {
    for (const p of candidate.payload.positions as {id:Id}[]) { const e = state.entries[p.id]; if (e) bases[revisionKey('entry_positions', e.id)] = e.position_revision; }
  }
  return bases;
}

/** Replay only server-authoritative changes inside the adapter transaction with its cursor update. */
export function applyChanges(state: WorkspaceState, changes: readonly EntityChange[]): WorkspaceState {
  const next = { ...state }; const copied = new Set<Collection>();
  for (const change of changes) {
    if (change.collection === 'workspace') { if (!change.value || change.value.id !== state.workspace.id) fail('workspace_mismatch', 'Invalid workspace patch'); next.workspace = copy(change.value as Workspace); continue; }
    const collection = change.collection;
    if (!Object.hasOwn(state, collection)) fail('invalid_command', 'Unknown collection');
    if (!copied.has(collection)) { (next as unknown as Record<string, unknown>)[collection] = { ...next[collection] }; copied.add(collection); }
    if (change.value === null) delete next[collection][change.id];
    else { if (change.value.id !== change.id || !('workspace_id' in change.value) || change.value.workspace_id !== state.workspace.id) fail('workspace_mismatch', 'Invalid entity patch'); (next[collection] as Record<Id, Entity>)[change.id] = copy(change.value); }
  }
  return next;
}
