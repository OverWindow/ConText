import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createWorkspaceState } from '../core/domain/src/index.js';
import { projectLegacyState, sourceToLegacy, writingContent } from './unified-projection.mjs';

export const stableUuid = value => {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16); bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const text = bytes.toString('hex'); return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
};
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const isUuid = value => typeof value === 'string' && new RegExp(`^${UUID}$`, 'i').test(value);
const parse = (value, fallback = null) => { if (value === null || value === undefined) return fallback; try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return fallback; } };
function storedJson(value, label, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch { const error = new Error(`저장된 ${label} 형식을 읽지 못했습니다. 원본은 보존되어 있으며 동기화를 중단했습니다.`); error.code = 'UNIFIED_IMPORT_INVALID_METADATA'; throw error; }
}
const json = value => JSON.parse(JSON.stringify(value));
const iso = value => new Date(typeof value === 'number' ? value : value || 0).toISOString();
const equal = isDeepStrictEqual;
const mime = filename => ({ '.txt': 'text/plain', '.md': 'text/markdown', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.hwpx': 'application/hwp+zip', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' })[path.extname(filename).toLowerCase()] || 'application/octet-stream';
const cleanLocation = locations => (Array.isArray(locations) ? locations : []).map(location => json(location));
const bodyText = normalized => (parse(normalized, {}).blocks || []).map(block => block.text || '').join('\n');
export function legacySourceSnapshot(source, context) {
  if (source && typeof source.quote === 'string' && isUuid(source.id)) return json(source);
  const { workspaceId, rootId, canvas, scopeByLegacy, messages, versions } = context;
  const legacyId = String(source?.id || source?.chunk_id || stableUuid(JSON.stringify(source)));
  const canonical = context.canonicalSources?.get(legacyId);
  if (canonical && canonical.quote === String(source?.text || '')) return json(canonical);
  const kind = source?.kind || 'document';
  const base = { id: stableUuid(`source:${workspaceId}:${legacyId}`), quote: String(source?.text || ''), label: String(source?.document_title || source?.title || '출처'),
    locations: cleanLocation(source?.locations), metadata: { legacy_id: legacyId, legacy_source: json(source || {}) } };
  if (kind === 'note') {
    const element_id = source.element_id || legacyId.match(new RegExp(`^note-(${UUID})(?:-|$)`, 'i'))?.[1] || stableUuid(`missing-note:${workspaceId}:${legacyId}`);
    return { ...base, kind, element_id, scope_id: scopeByLegacy.get(canvas.get(element_id)?.scope_id) || source.scope_id || rootId };
  }
  if (kind === 'chat') {
    const message_id = source.message_id || legacyId.match(new RegExp(`^chat-(${UUID})(?:-|$)`, 'i'))?.[1] || stableUuid(`missing-message:${workspaceId}:${legacyId}`);
    return { ...base, kind, message_id, session_id: source.session_id || messages.get(message_id)?.session_id || stableUuid(`missing-session:${workspaceId}:${message_id}`) };
  }
  if (kind === 'draft') {
    const draft_id = source.draft_id || legacyId.match(new RegExp(`^draft-(${UUID})(?:-|$)`, 'i'))?.[1] || stableUuid(`missing-draft:${workspaceId}:${legacyId}`);
    return { ...base, kind, draft_id };
  }
  const version_id = source.version_id || legacyId.match(new RegExp(`^version-(${UUID})(?:-|$)`, 'i'))?.[1] || stableUuid(`missing-version:${workspaceId}:${legacyId}`);
  const version = versions.get(version_id);
  return { ...base, kind: 'document', document_id: source.document_id || version?.document_id || stableUuid(`missing-document:${workspaceId}:${version_id}`), version_id,
    ...(source.chunk_id ? { chunk_id: String(source.chunk_id) } : {}), ...(Number.isSafeInteger(source.version_number) ? { version_number: source.version_number } : {}) };
}

/** Reads only existing SQLite metadata/BLOB lengths. It never scans or opens the user's folder. */
export function buildLegacyState(engine, store, workspaceId) {
  const db = engine.db, row = store.ensure(workspaceId), prior = store.state(workspaceId), actor = row.actor_id;
  const local = engine.workspace(workspaceId), included = entry => (entry.kind === 'file' || entry.kind === 'directory') && !entry.excluded && !engine.excluded(local.root, path.join(local.root, entry.relative_path), local);
  const state = createWorkspaceState({ ...prior.workspace, name: local.label.normalize('NFC') });
  const rawEntries = db.prepare('SELECT e.*,p.x,p.y FROM entries e LEFT JOIN positions p ON p.entry_id=e.id WHERE e.workspace_id=? ORDER BY length(e.relative_path),e.relative_path').all(workspaceId).filter(included);
  const entryIds = new Set(rawEntries.map(entry => entry.id));
  const documents = new Map(db.prepare('SELECT * FROM local_documents WHERE workspace_id=?').all(workspaceId).filter(document => entryIds.has(document.entry_id)).map(document => [document.entry_id, document]));
  const documentIds = new Set([...documents.values()].map(document => document.id));
  const allVersions = new Map(db.prepare('SELECT v.id,v.document_id,v.version_number,v.filename,v.sha256,v.normalized,v.created_at,v.source_version_id,v.request_id,v.change_note,length(v.bytes) AS byte_size FROM local_versions v JOIN local_documents d ON d.id=v.document_id WHERE d.workspace_id=? ORDER BY v.document_id,v.version_number,v.created_at,v.id').all(workspaceId).map(version => [version.id, version]));
  const versions = new Map([...allVersions].filter(([, version]) => documentIds.has(version.document_id)));
  const canvas = new Map(db.prepare('SELECT * FROM local_canvas WHERE workspace_id=?').all(workspaceId).map(element => [element.id, element]));
  const messages = new Map(db.prepare('SELECT m.* FROM local_chat_messages m JOIN local_chat_sessions s ON s.id=m.session_id WHERE s.workspace_id=? ORDER BY m.session_id,m.sequence,m.id').all(workspaceId).map(message => [message.id, message]));
  const mappings = new Map(db.prepare('SELECT * FROM unified_file_mappings WHERE workspace_id=?').all(workspaceId).map(mapping => [mapping.entry_id, mapping]));
  const documentMappings = new Map();
  const canonicalSources = new Map();
  for (const collection of ['versions', 'canvas_elements', 'drafts', 'proposals', 'chat_messages']) for (const entity of Object.values(prior[collection])) { for (const source of entity.sources || []) canonicalSources.set(source.id, source); for (const h of entity.history || []) for (const source of h.sources) canonicalSources.set(source.id, source); }
  const byPath = new Map([['', state.workspace.root_entry_id]]), scopeByLegacy = new Map();
  for (const entry of rawEntries) if (entry.kind === 'directory') byPath.set(entry.relative_path, entry.id);
  const ensureDirectory = directory => {
    if (byPath.has(directory)) return byPath.get(directory);
    // An old scope may outlive a removed folder. Preserve it as a portable logical folder.
    const parts = directory.split('/').filter(Boolean); let current = '';
    for (const part of parts) { const next = current ? `${current}/${part}` : part; if (!byPath.has(next)) { const id = stableUuid(`legacy-scope-entry:${workspaceId}:${next}`); byPath.set(next, id);
        state.entries[id] = { id, workspace_id: workspaceId, parent_id: byPath.get(current), kind: 'folder', name: part.normalize('NFC'), document_id: null, revision: 1, position_revision: 0, x: null, y: null, area_positioned: false, deleted_at: null }; } current = next; }
    return byPath.get(directory);
  };
  for (const scope of db.prepare('SELECT id,directory FROM local_canvas_scopes WHERE workspace_id=?').all(workspaceId)) if (!scope.directory || !engine.excluded(local.root, path.join(local.root, scope.directory), local)) scopeByLegacy.set(scope.id, ensureDirectory(scope.directory));
  for (const entry of rawEntries) {
    const previous = prior.entries[entry.id], document = documents.get(entry.id), document_id = entry.kind === 'file' ? document?.id || stableUuid(`entry-document:${workspaceId}:${entry.id}`) : null;
    state.entries[entry.id] = { id: entry.id, workspace_id: workspaceId, parent_id: ensureDirectory(entry.parent_path), kind: entry.kind === 'directory' ? 'folder' : 'file', name: entry.name.normalize('NFC'), document_id,
      revision: previous?.revision ?? 1, position_revision: previous?.position_revision ?? 0, x: entry.x ?? null, y: entry.y ?? null,
      area_positioned: db.prepare('SELECT value FROM local_settings WHERE key=?').get(`folder-area:${workspaceId}:${entry.id}`)?.value === '1', deleted_at: previous?.deleted_at ?? null };
    const entryMapping = mappings.get(entry.id);
    if (previous && entryMapping?.relative_path === entry.relative_path) { state.entries[entry.id].parent_id = previous.parent_id; state.entries[entry.id].name = previous.name; }
    if (document_id) state.documents[document_id] = { id: document_id, workspace_id: workspaceId, content_head_id: document?.file_version_id || null,
      reference_head_id: document?.current_is_pinned ? document.current_version_id || null : document?.file_version_id || null, reference_pinned: !!document?.current_is_pinned,
      revision: prior.documents[document_id]?.revision ?? document?.revision ?? 0, deleted_at: prior.documents[document_id]?.deleted_at ?? null };
    if (document_id) {
      const mapping = mappings.get(entry.id); documentMappings.set(document_id, mapping);
      // A remote target waiting to reach disk is not a new local edit and must never echo backwards.
      if (mapping && document?.file_version_id === mapping.observed_version_id && prior.documents[document_id]) state.documents[document_id].content_head_id = prior.documents[document_id].content_head_id;
      if (!document?.current_is_pinned) state.documents[document_id].reference_head_id = state.documents[document_id].content_head_id;
    }
  }
  const context = { workspaceId, rootId: state.workspace.root_entry_id, canvas, scopeByLegacy, messages, versions: allVersions, canonicalSources };
  const sources = input => (input || []).map(source => legacySourceSnapshot(source, context));
  const previousVersion = new Map(), newNativeHead = new Map();
  const register = db.prepare('INSERT INTO unified_blobs(workspace_id,id,sha256,size,mime_type,local_version_id) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,id) DO NOTHING');
  for (const version of versions.values()) {
    const blob = { id: version.id, sha256: version.sha256, size: version.byte_size, mime_type: mime(version.filename) };
    register.run(workspaceId, version.id, blob.sha256, blob.size, blob.mime_type, version.id);
    const provenance = [];
    if (version.source_version_id) {
      const origin = allVersions.get(version.source_version_id);
      provenance.push({ id: stableUuid(`version-source:${workspaceId}:${version.id}:${version.source_version_id}`), kind: 'document',
        document_id: origin?.document_id || stableUuid(`missing-document:${workspaceId}:${version.source_version_id}`), version_id: version.source_version_id,
        quote: origin ? bodyText(origin.normalized) : '', label: origin?.filename || '원본 출처', metadata: { legacy_source_version_id: version.source_version_id } });
    }
    const previous = row.import_complete ? newNativeHead.get(version.document_id) || documentMappings.get(version.document_id)?.observed_version_id || prior.documents[version.document_id]?.content_head_id || previousVersion.get(version.document_id) : previousVersion.get(version.document_id);
    state.versions[version.id] = prior.versions[version.id] || { id: version.id, workspace_id: workspaceId, document_id: version.document_id, blob,
      parent_version_ids: previous ? [previous] : [], sources: provenance, created_at: iso(version.created_at), created_by: actor, display_number: version.version_number, change_note: version.change_note || '' };
    previousVersion.set(version.document_id, version.id);
    if (!prior.versions[version.id]) newNativeHead.set(version.document_id, version.id);
  }
  for (const element of canvas.values()) {
    if (!scopeByLegacy.has(element.scope_id)) continue;
    const payload = storedJson(element.payload, '캔버스'), scope_id = scopeByLegacy.get(element.scope_id) || state.workspace.root_entry_id, deleted_at = element.deleted ? prior.canvas_elements[element.id]?.deleted_at || prior.relations[element.id]?.deleted_at || iso(0) : null;
    if (element.kind === 'element') {
      const previous = prior.canvas_elements[element.id];
      const value = { id: element.id, workspace_id: workspaceId, scope_id, kind: payload.kind,
        x: payload.x, y: payload.y, width: payload.width, height: payload.height, content: payload.text || '', color: payload.color ?? null, font_size: payload.font_size ?? 24, sources: sources(payload.sources), revision: previous?.revision ?? element.revision, deleted_at };
      if (previous && value.kind === (previous.kind === 'note' ? 'text' : previous.kind) && value.scope_id === previous.scope_id && value.content === previous.content && value.x === previous.x && value.y === previous.y && value.width === previous.width && value.height === previous.height && value.color === (previous.color || 'violet') && value.font_size === (previous.font_size || 24) && equal(value.sources, previous.sources)) state.canvas_elements[element.id] = { ...previous, deleted_at };
      else state.canvas_elements[element.id] = value;
    }
    else {
      const source_document_id = documents.get(payload.source_document_id)?.id || payload.source_document_id, target_document_id = documents.get(payload.target_document_id)?.id || payload.target_document_id;
      if (!state.documents[source_document_id] || !state.documents[target_document_id]) continue;
      state.relations[element.id] = { id: element.id, workspace_id: workspaceId, scope_id, source_document_id, target_document_id, relation_type: payload.relation_type || 'reference', label: payload.label || '', source_handle: payload.source_handle || 'right', target_handle: payload.target_handle || 'left', revision: prior.relations[element.id]?.revision ?? element.revision, deleted_at };
      const previous = prior.relations[element.id], value = state.relations[element.id];
      if (previous && equal({ ...previous, source_handle: previous.source_handle || 'right', target_handle: previous.target_handle || 'left', deleted_at }, value)) state.relations[element.id] = { ...previous, deleted_at };
    }
  }
  for (const draft of db.prepare('SELECT * FROM local_drafts WHERE workspace_id=?').all(workspaceId)) {
    const content = storedJson(draft.content, '초안 본문'), history = storedJson(draft.history, '초안 이력', []), canonical = prior.drafts[draft.id];
    const rawSources = storedJson(draft.sources, '초안 출처', []), rawChecks = storedJson(draft.checks, '초안 검사', []);
    const draftSources = sources(rawSources);
    const snapshots = [...history, { content, sources: rawSources, checks: rawChecks }];
    const canonicalHistory = snapshots.map((snapshot, index) => ({ id: stableUuid(`draft-history:${workspaceId}:${draft.id}:${index}:${JSON.stringify(snapshot)}`), content: JSON.stringify(snapshot.content), sources: sources(snapshot.sources), review: snapshot.checks || [], created_at: iso(index === snapshots.length - 1 ? draft.updated_at : draft.created_at), created_by: actor }));
    state.drafts[draft.id] = { id: draft.id, workspace_id: workspaceId, scope_id: canonical?.scope_id || state.workspace.root_entry_id, title: content.title || '새 문서', content: JSON.stringify(content), sources: draftSources, history: canonicalHistory,
      review: { checks: rawChecks }, revision: canonical?.revision ?? draft.revision, deleted_at: draft.deleted ? canonical?.deleted_at || iso(draft.updated_at) : canonical?.deleted_at || null };
    if (canonical) {
      const expectedContent = writingContent(canonical.content, canonical.title), expectedChecks = Array.isArray(canonical.review) ? canonical.review : canonical.review?.checks || [];
      if (equal(expectedContent, content) && equal(canonical.sources.map(sourceToLegacy), rawSources)) {
        state.drafts[draft.id].title = canonical.title; state.drafts[draft.id].content = canonical.content; state.drafts[draft.id].sources = canonical.sources; state.drafts[draft.id].history = canonical.history;
      }
      if (equal(expectedChecks, rawChecks)) state.drafts[draft.id].review = canonical.review;
    }
    const proposal = storedJson(draft.proposal, '초안 제안');
    if (proposal) {
      const proposalSources = sources(proposal.sources), proposalContent = JSON.stringify(proposal.content), review = { checks: proposal.checks || [] };
      const existing = Object.values(prior.proposals).find(p => p.draft_id === draft.id && p.status === 'pending' && p.content === proposalContent && equal(p.sources, proposalSources));
      const proposalId = existing?.id || stableUuid(`draft-proposal:${workspaceId}:${draft.id}:${draft.proposal}`);
      state.proposals[proposalId] = existing || { id: proposalId, workspace_id: workspaceId, draft_id: draft.id, base_revision: state.drafts[draft.id].revision, content: proposalContent, sources: proposalSources, review, status: 'pending', created_at: iso(draft.updated_at), created_by: actor, revision: 1 };
    }
  }
  for (const session of db.prepare('SELECT * FROM local_chat_sessions WHERE workspace_id=?').all(workspaceId)) {
    state.chat_sessions[session.id] = { id: session.id, workspace_id: workspaceId, scope_id: prior.chat_sessions[session.id]?.scope_id || state.workspace.root_entry_id, title: session.title, sync: prior.chat_sessions[session.id]?.sync || 'shared', revision: prior.chat_sessions[session.id]?.revision || 1, deleted_at: prior.chat_sessions[session.id]?.deleted_at || null,
      metadata: { request_id: session.request_id, created_at: session.created_at, updated_at: session.updated_at } };
  }
  for (const message of messages.values()) {
    const result = storedJson(message.result, '대화 결과'), messageSources = sources(result?.sources || []);
    state.chat_messages[message.id] = { id: message.id, workspace_id: workspaceId, session_id: message.session_id, role: message.role, content: message.content, sources: messageSources,
      request_id: message.role === 'assistant' ? message.request_id : null, created_at: iso(message.created_at), created_by: prior.chat_messages[message.id]?.created_by || actor, revision: prior.chat_messages[message.id]?.revision || 1,
      metadata: { state: message.state, result, options: storedJson(message.options, '대화 설정', {}), error_code: message.error_code, sequence: message.sequence, request_id: message.request_id } };
    const previous = prior.chat_messages[message.id];
    if (previous && previous.content === message.content && equal(previous.sources, messageSources) && (previous.metadata?.state || 'COMPLETED') === message.state && (previous.request_id || previous.metadata?.request_id || null) === (message.role === 'assistant' ? message.request_id : previous.request_id || null)) {
      if (!previous.metadata) state.chat_messages[message.id] = previous;
    }
  }
  state.artifacts = prior.artifacts; state.conflicts = prior.conflicts;
  // Tombstoned canonical metadata stays authoritative while native originals remain untouched.
  for (const [id, entry] of Object.entries(prior.entries)) if (entry.deleted_at) state.entries[id] = entry;
  return state;
}

export class UnifiedLegacyBridge {
  constructor(engine, store) { this.engine = engine; this.store = store; this.db = engine.db; this.projecting = new Set(); }
  capture(workspaceId) {
    if (this.projecting.has(workspaceId)) return this.store.state(workspaceId);
    return this.store.transaction(() => {
      const row = this.store.ensure(workspaceId), desired = buildLegacyState(this.engine, this.store, workspaceId);
      if (!row.import_complete) {
        this.store.enqueue(workspaceId, this.store.command(workspaceId, 'ImportWorkspace', { state: desired }, { [`workspace:${workspaceId}`]: this.store.state(workspaceId).workspace.revision }));
        this.db.prepare('UPDATE unified_spaces SET import_complete=1 WHERE workspace_id=?').run(workspaceId);
        for (const entry of Object.values(desired.entries)) if (entry.parent_id) { const native = this.db.prepare('SELECT relative_path FROM entries WHERE id=?').get(entry.id);
          if (native) { const doc = desired.documents[entry.document_id], present = this.db.prepare('SELECT present FROM entries WHERE id=?').get(entry.id)?.present; this.db.prepare('INSERT OR IGNORE INTO unified_file_mappings(workspace_id,entry_id,relative_path,observed_version_id,observed_hash,status) VALUES(?,?,?,?,?,?)')
            .run(workspaceId, entry.id, native.relative_path, doc?.content_head_id || null, desired.versions[doc?.content_head_id]?.blob.sha256 || null, present ? 'ready' : 'missing'); } }
        return this.store.state(workspaceId);
      }
      const emit = (type, payload, bases = {}) => this.store.enqueue(workspaceId, this.store.command(workspaceId, type, payload, bases));
      let view = this.store.state(workspaceId);
      if (desired.workspace.name !== view.workspace.name) emit('RenameWorkspace', { name: desired.workspace.name }, { [`workspace:${workspaceId}`]: view.workspace.revision });
      const health = this.engine.health?.get(workspaceId), localWorkspace = this.engine.workspace(workspaceId);
      if (health?.status === 'ready' && !health.truncated && !health.warnings?.length && localWorkspace.scanned_at) {
        const native = new Map(this.db.prepare('SELECT * FROM entries WHERE workspace_id=?').all(workspaceId).map(entry => [entry.id, entry]));
        const mappings = new Map(this.db.prepare('SELECT * FROM unified_file_mappings WHERE workspace_id=?').all(workspaceId).map(mapping => [mapping.entry_id, mapping]));
        const disconnected = new Set(this.db.prepare("SELECT key FROM local_settings WHERE key LIKE ?").all(`disconnected-file:${workspaceId}:%`).map(row => row.key.slice(`disconnected-file:${workspaceId}:`.length)));
        const confidentlyMissing = entry => {
          const source = native.get(entry.id), mapping = mappings.get(entry.id);
          return !entry.deleted_at && source && !source.present && !source.excluded && !disconnected.has(entry.id) && !this.engine.excluded(localWorkspace.root, path.join(localWorkspace.root, source.relative_path), localWorkspace)
            && mapping?.status === 'ready';
        };
        const children = new Map(); for (const entry of Object.values(view.entries)) { const list = children.get(entry.parent_id) || []; list.push(entry); children.set(entry.parent_id, list); }
        const candidates = [...Object.values(view.entries)].sort((a, b) => (native.get(a.id)?.relative_path.length || 0) - (native.get(b.id)?.relative_path.length || 0));
        const trashed = new Set();
        for (const entry of candidates) {
          if (trashed.has(entry.id) || !entry.parent_id || !confidentlyMissing(entry)) continue;
          if (Object.values(view.conflicts).some(conflict => conflict.status === 'open' && conflict.candidate?.type === 'TrashEntry' && conflict.candidate.payload?.id === entry.id)) continue;
          const subtree = [entry]; for (let i = 0; i < subtree.length; i++) subtree.push(...(children.get(subtree[i].id) || []).filter(child => !child.deleted_at));
          if (!subtree.every(confidentlyMissing)) continue;
          const bases = {}; for (const child of subtree) { bases[`entries:${child.id}`] = view.entries[child.id].revision; if (child.document_id) bases[`documents:${child.document_id}`] = view.documents[child.document_id].revision; }
          const observed_heads = Object.fromEntries(subtree.filter(child => child.document_id).map(child => [child.document_id, mappings.get(child.id)?.observed_version_id || null]));
          const result = emit('TrashEntry', { id: entry.id, observed_heads }, bases);
          if (result.status === 'applied') for (const child of subtree) { trashed.add(child.id); this.db.prepare("UPDATE unified_file_mappings SET status='remote_deleted' WHERE workspace_id=? AND entry_id=?").run(workspaceId, child.id); }
          view = this.store.state(workspaceId);
        }
      }
      const children = new Map(); for (const entry of Object.values(desired.entries)) { const group = children.get(entry.parent_id) || []; group.push(entry); children.set(entry.parent_id, group); }
      const ordered = [desired.entries[desired.workspace.root_entry_id]]; for (let i = 0; i < ordered.length; i++) ordered.push(...(children.get(ordered[i].id) || []));
      const moves = ordered.filter(entry => entry.parent_id && view.entries[entry.id] && !view.entries[entry.id].deleted_at && (entry.parent_id !== view.entries[entry.id].parent_id || entry.name !== view.entries[entry.id].name));
      const creates = ordered.filter(entry => entry.parent_id && !view.entries[entry.id]);
      const createPayload = entry => ({ id: entry.id, parent_id: entry.parent_id, kind: entry.kind, name: entry.name, ...(entry.document_id ? { document_id: entry.document_id } : {}), x: entry.x, y: entry.y, area_positioned: entry.area_positioned });
      if (creates.length) {
        emit('ReconcileEntries', { creates: creates.map(createPayload), moves: moves.map(({ id, parent_id, name }) => ({ id, parent_id, name })) }, Object.fromEntries(moves.map(entry => [`entries:${entry.id}`, view.entries[entry.id].revision])));
        view = this.store.state(workspaceId);
      } else if (moves.length) {
        const bases = Object.fromEntries(moves.map(entry => [`entries:${entry.id}`, view.entries[entry.id].revision]));
        if (moves.length === 1) emit('MoveEntry', { id: moves[0].id, parent_id: moves[0].parent_id, name: moves[0].name }, bases);
        else emit('MoveEntries', { moves: moves.map(({ id, parent_id, name }) => ({ id, parent_id, name })) }, bases);
        view = this.store.state(workspaceId);
      }
      const publishedHeads = new Set();
      for (const version of Object.values(desired.versions)) if (!view.versions[version.id]) {
        const selected = desired.documents[version.document_id]?.content_head_id === version.id;
        emit('AppendDocumentVersion', { version, select_head: selected }, selected ? { [`documents:${version.document_id}`]: view.documents[version.document_id].revision } : {});
        if (selected) publishedHeads.add(version.document_id); view = this.store.state(workspaceId);
      }
      for (const document of Object.values(desired.documents)) {
        let previous = view.documents[document.id]; if (!previous || previous.deleted_at) continue;
        if (!publishedHeads.has(document.id) && document.content_head_id && document.content_head_id !== previous.content_head_id) { emit('SelectContentHead', { document_id: document.id, version_id: document.content_head_id }, { [`documents:${document.id}`]: previous.revision }); view = this.store.state(workspaceId); previous = view.documents[document.id]; }
        if (document.reference_head_id && (document.reference_head_id !== previous.reference_head_id || document.reference_pinned !== previous.reference_pinned)) { emit('SelectReferenceHead', { document_id: document.id, version_id: document.reference_head_id, pinned: document.reference_pinned }, { [`documents:${document.id}`]: previous.revision }); view = this.store.state(workspaceId); }
      }
      const positions = Object.values(desired.entries).filter(e => e.parent_id && !e.deleted_at && view.entries[e.id] && (e.x !== view.entries[e.id].x || e.y !== view.entries[e.id].y || e.area_positioned !== view.entries[e.id].area_positioned));
      if (positions.length) emit('SetEntryPositions', { positions: positions.map(({ id, x, y, area_positioned }) => ({ id, x, y, area_positioned })) }, Object.fromEntries(positions.map(e => [`entry_positions:${e.id}`, view.entries[e.id].position_revision])));
      view = this.store.state(workspaceId);
      for (const [collection, put, remove, field] of [['canvas_elements', 'PutCanvasElement', 'RemoveCanvasElement', 'element'], ['relations', 'PutRelation', 'RemoveRelation', 'relation']]) for (const entity of Object.values(desired[collection])) {
        const previous = view[collection][entity.id];
        if (entity.deleted_at) { if (previous && !previous.deleted_at) emit(remove, { id: entity.id }, { [`${collection}:${entity.id}`]: previous.revision }); }
        else if (!previous || !equal({ ...previous, revision: 0 }, { ...entity, revision: 0 })) emit(put, { [field]: entity }, previous ? { [`${collection}:${entity.id}`]: previous.revision } : {});
      }
      view = this.store.state(workspaceId);
      for (const proposal of Object.values(view.proposals)) if (proposal.status === 'pending' && !desired.proposals[proposal.id]) {
        const candidate = desired.drafts[proposal.draft_id], current = view.drafts[proposal.draft_id];
        const accepted = candidate && candidate.content === proposal.content && equal(candidate.sources, proposal.sources);
        emit('ReviewProposal', { id: proposal.id, decision: accepted ? 'accept' : 'reject' }, { [`proposals:${proposal.id}`]: proposal.revision, ...(accepted ? { [`drafts:${proposal.draft_id}`]: current.revision } : {}) });
        view = this.store.state(workspaceId);
      }
      for (const draft of Object.values(desired.drafts)) {
        const previous = view.drafts[draft.id];
        if (!previous && !draft.deleted_at) emit('CreateDraft', { id: draft.id, scope_id: draft.scope_id, title: draft.title, content: draft.content, sources: draft.sources, review: draft.review });
        else if (previous && !previous.deleted_at && draft.deleted_at) emit('TrashDraft', { id: draft.id }, { [`drafts:${draft.id}`]: previous.revision });
        else if (previous && !previous.deleted_at && (previous.title !== draft.title || previous.content !== draft.content || !equal(previous.sources, draft.sources) || !equal(previous.review, draft.review))) emit('SaveDraft', { id: draft.id, title: draft.title, content: draft.content, sources: draft.sources, review: draft.review }, { [`drafts:${draft.id}`]: previous.revision });
      }
      view = this.store.state(workspaceId);
      for (const proposal of Object.values(desired.proposals)) if (!view.proposals[proposal.id]) emit('CreateProposal', { id: proposal.id, draft_id: proposal.draft_id, content: proposal.content, sources: proposal.sources, review: proposal.review }, { [`drafts:${proposal.draft_id}`]: view.drafts[proposal.draft_id].revision });
      for (const session of Object.values(desired.chat_sessions)) { const previous = view.chat_sessions[session.id]; if (!previous) emit('CreateChatSession', { id: session.id, scope_id: session.scope_id, title: session.title, sync: session.sync }); else if (!previous.deleted_at && previous.title !== session.title) emit('RenameChatSession', { id: session.id, title: session.title }, { [`chat_sessions:${session.id}`]: previous.revision }); }
      view = this.store.state(workspaceId);
      for (const message of Object.values(desired.chat_messages)) { const previous = view.chat_messages[message.id]; if (!previous) emit('AppendChatMessage', { message }); else if (!equal(previous, message)) emit('UpdateChatMessage', { message }, { [`chat_messages:${message.id}`]: previous.revision || 1 }); }
      for (const native of this.db.prepare('SELECT d.id,d.entry_id,d.file_version_id,v.sha256,e.relative_path,e.present FROM local_documents d JOIN entries e ON e.id=d.entry_id LEFT JOIN local_versions v ON v.id=d.file_version_id WHERE d.workspace_id=?').all(workspaceId)) {
        const entry = desired.entries[native.entry_id], old = this.db.prepare('SELECT * FROM unified_file_mappings WHERE workspace_id=? AND entry_id=?').get(workspaceId, native.entry_id);
        if (entry && !entry.deleted_at && old?.status !== 'remote_deleted') {
          if (!old) this.db.prepare('INSERT INTO unified_file_mappings(workspace_id,entry_id,relative_path,observed_version_id,observed_hash,status) VALUES(?,?,?,?,?,?)').run(workspaceId, native.entry_id, native.relative_path, native.file_version_id || null, native.sha256 || null, native.present ? 'ready' : 'missing');
          else if (native.file_version_id !== old.observed_version_id || native.relative_path !== old.relative_path || native.present && old.status === 'missing') this.db.prepare('UPDATE unified_file_mappings SET relative_path=?,observed_version_id=?,observed_hash=?,status=? WHERE workspace_id=? AND entry_id=?').run(native.relative_path, native.file_version_id || null, native.sha256 || null, native.present ? 'ready' : old.status, workspaceId, native.entry_id);
        }
      }
      for (const native of this.db.prepare("SELECT id,relative_path,present FROM entries WHERE workspace_id=? AND kind='directory'").all(workspaceId)) {
        const entry = desired.entries[native.id]; if (!entry || entry.deleted_at) continue;
        this.db.prepare('INSERT INTO unified_file_mappings(workspace_id,entry_id,relative_path,status) VALUES(?,?,?,?) ON CONFLICT(workspace_id,entry_id) DO UPDATE SET relative_path=excluded.relative_path,status=CASE WHEN excluded.status=\'ready\' AND unified_file_mappings.status=\'missing\' THEN \'ready\' ELSE unified_file_mappings.status END WHERE unified_file_mappings.status!=\'remote_deleted\'').run(workspaceId, native.id, native.relative_path, native.present ? 'ready' : 'missing');
      }
      return this.store.state(workspaceId);
    });
  }
  project(workspaceId) {
    this.projecting.add(workspaceId);
    try { return this.store.transaction(() => projectLegacyState(this.engine, this.store, workspaceId)); }
    finally { this.projecting.delete(workspaceId); }
  }
}
