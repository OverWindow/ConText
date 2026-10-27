import path from 'node:path';
import { createHash } from 'node:crypto';

const json = JSON.stringify;
const parse = (value, fallback = null) => { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } };
const stamp = value => { const n = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(n) ? n : 0; };
const stable = value => { const b = createHash('sha256').update(value).digest().subarray(0, 16); b[6] = (b[6] & 15) | 80; b[8] = (b[8] & 63) | 128; const s = b.toString('hex'); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`; };
export function sourceToLegacy(source) {
  if (source.metadata?.legacy_source) return parse(json(source.metadata.legacy_source));
  return { id: source.metadata?.legacy_id || source.id, kind: source.kind, text: source.quote, document_title: source.label, locations: source.locations || [],
    ...(source.kind === 'document' ? { document_id: source.document_id, version_id: source.version_id, chunk_id: source.chunk_id || source.id, version_number: source.version_number || 0 } : {}),
    ...(source.kind === 'note' ? { element_id: source.element_id, scope_id: source.scope_id } : {}),
    ...(source.kind === 'chat' ? { session_id: source.session_id, message_id: source.message_id } : {}),
    ...(source.kind === 'draft' ? { draft_id: source.draft_id, ...(source.history_id ? { history_id: source.history_id } : {}) } : {}) };
}
export function writingContent(content, title) {
  const value = parse(content); if (value && typeof value.title === 'string' && Array.isArray(value.blocks)) return value;
  return { title: title || '새 문서', blocks: [{ id: stable(`paragraph:${content}`), type: 'paragraph', text: content || '', level: 2, items: [], rows: [], source_ids: [] }] };
}
const checks = review => Array.isArray(review) ? review : Array.isArray(review?.checks) ? review.checks : [];

/** Projection updates only application metadata. Raw versions and the user's filesystem are untouched. */
export function projectLegacyState(engine, store, workspaceId) {
  const db = engine.db, state = store.state(workspaceId), root = state.workspace.root_entry_id;
  const paths = new Map([[root, '']]), pending = Object.values(state.entries).filter(e => e.id !== root);
  const children = new Map();
  for (const entry of pending) { const list = children.get(entry.parent_id) || []; list.push(entry); children.set(entry.parent_id, list); }
  const queue = [root];
  for (let i = 0; i < queue.length; i++) for (const entry of children.get(queue[i]) || []) { const parent = paths.get(entry.parent_id), filename = parent ? `${parent}/${entry.name}` : entry.name; paths.set(entry.id, filename); queue.push(entry.id); }
  if (paths.size !== Object.keys(state.entries).length) throw new Error('공통 폴더 구조의 부모를 찾지 못했습니다.');
  db.prepare('UPDATE workspaces SET label=? WHERE id=?').run(state.workspace.name, workspaceId);
  const nativeEntries = new Map(db.prepare('SELECT * FROM entries WHERE workspace_id=?').all(workspaceId).map(e => [e.id, e]));
  const nativeDocuments = new Map(db.prepare('SELECT * FROM local_documents WHERE workspace_id=?').all(workspaceId).map(d => [d.id, d]));
  const mappings = new Map(db.prepare('SELECT * FROM unified_file_mappings WHERE workspace_id=?').all(workspaceId).map(m => [m.entry_id, m]));
  const rawVersionIds = new Set(db.prepare('SELECT v.id FROM local_versions v JOIN local_documents d ON d.id=v.document_id WHERE d.workspace_id=?').all(workspaceId).map(v => v.id));
  const documentEntries = new Map();
  const upsertEntry = db.prepare(`INSERT INTO entries(id,workspace_id,relative_path,parent_path,name,kind,extension,size,mtime,identity,present,excluded) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET relative_path=excluded.relative_path,parent_path=excluded.parent_path,name=excluded.name,kind=excluded.kind,extension=excluded.extension,size=excluded.size,present=excluded.present`);
  const position = db.prepare('INSERT INTO positions(entry_id,x,y) VALUES(?,?,?) ON CONFLICT(entry_id) DO UPDATE SET x=excluded.x,y=excluded.y');
  const setting = db.prepare('INSERT INTO local_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  // The domain permits a deleted entry and a new UUID at the same logical path.
  // SQLite's legacy index also covers absent/history rows, so give colliding
  // metadata a private slot without changing its name, mapping or original bytes.
  const privatePath = value => value.startsWith(':unified-') || value.startsWith(':stale:');
  const updates = [];
  for (const entry of pending) {
    const old = nativeEntries.get(entry.id), mapping = mappings.get(entry.id), desired = paths.get(entry.id);
    const physical = mapping?.relative_path || old?.relative_path || desired;
    const relative = entry.deleted_at ? old?.relative_path || physical : mapping?.status === 'ready' ? physical : old?.relative_path || physical;
    const metadataRelative = privatePath(relative) && old ? `${old.parent_path ? old.parent_path + '/' : ''}${old.name}` : relative;
    updates.push({ entry, old, mapping, relative, metadataRelative, staged: privatePath(relative) });
  }
  const projectedIds = new Set(pending.map(entry => entry.id));
  const occupied = new Set([...nativeEntries.values()].filter(entry => !projectedIds.has(entry.id)).map(entry => entry.relative_path));
  const reserved = new Set([...nativeEntries.values()].map(entry => entry.relative_path));
  for (const item of updates) reserved.add(item.relative);
  const reserve = (kind, id) => {
    const base = `:unified-${kind}:${id}`; let value = base, suffix = 0;
    while (reserved.has(value)) value = `${base}:${++suffix}`;
    reserved.add(value); return value;
  };
  const priority = item => item.entry.deleted_at ? 2 : item.old && !privatePath(item.old.relative_path) ? 0 : 1;
  for (const item of [...updates].sort((a, b) => priority(a) - priority(b))) {
    if (occupied.has(item.relative)) { item.relative = reserve(item.entry.deleted_at ? 'history' : 'pending', item.entry.id); item.staged = true; }
    occupied.add(item.relative);
  }
  // Release every changing slot before the first upsert, including rename cycles.
  const moveAside = db.prepare('UPDATE entries SET relative_path=? WHERE id=?');
  for (const item of updates) if (item.old && item.old.relative_path !== item.relative) {
    moveAside.run(reserve('moving', item.entry.id), item.entry.id);
  }
  for (const { entry, old, mapping, relative, metadataRelative, staged } of updates) {
    const head = entry.document_id ? state.versions[state.documents[entry.document_id]?.content_head_id] : null;
    upsertEntry.run(entry.id, workspaceId, relative, path.posix.dirname(metadataRelative) === '.' ? '' : path.posix.dirname(metadataRelative), path.posix.basename(metadataRelative), entry.kind === 'folder' ? 'directory' : 'file', entry.kind === 'file' ? path.posix.extname(metadataRelative).toLowerCase() : '', head?.blob.size ?? old?.size ?? 0,
      old?.mtime || 0, old?.identity || `remote:${entry.id}`, entry.deleted_at || staged ? 0 : old?.present ?? (mapping?.status === 'ready' ? 1 : 0), old?.excluded || 0);
    if (entry.x !== null && entry.y !== null) position.run(entry.id, entry.x, entry.y); else db.prepare('DELETE FROM positions WHERE entry_id=?').run(entry.id);
    setting.run(`folder-area:${workspaceId}:${entry.id}`, entry.area_positioned ? '1' : '0');
    if (entry.document_id) documentEntries.set(entry.document_id, entry.id);
    if (entry.deleted_at) db.prepare("UPDATE unified_file_mappings SET status='remote_deleted' WHERE workspace_id=? AND entry_id=?").run(workspaceId, entry.id);
  }
  for (const document of Object.values(state.documents)) {
    const entry_id = documentEntries.get(document.id); if (!entry_id) continue;
    const previous = nativeDocuments.get(document.id), mapping = mappings.get(entry_id);
    const observed = mapping?.observed_version_id || previous?.file_version_id || null;
    const fileHead = rawVersionIds.has(observed) ? observed : previous?.file_version_id || null;
    const reference = rawVersionIds.has(document.reference_head_id) ? document.reference_head_id : previous?.current_version_id || null;
    db.prepare(`INSERT INTO local_documents(id,workspace_id,entry_id,current_version_id,file_version_id,revision,current_is_pinned) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET current_version_id=excluded.current_version_id,file_version_id=excluded.file_version_id,revision=excluded.revision,current_is_pinned=excluded.current_is_pinned`)
      .run(document.id, workspaceId, entry_id, reference, fileHead, document.revision, document.reference_pinned ? 1 : 0);
  }
  const rootScope = engine.canvas.scope(workspaceId, '');
  const scopeRows = db.prepare('SELECT id,directory FROM local_canvas_scopes WHERE workspace_id=?').all(workspaceId);
  const scopes = new Map(scopeRows.map(s => [s.directory, s.id])), scopesById = new Map(scopeRows.map(s => [s.id, s.directory]));
  const projectedPaths = new Map(updates.map(item => [item.entry.id, item.relative]));
  const scopeIds = new Map(), assignedScopes = new Set(), scopeUpdates = [];
  // Match existing canvas identity before the destination path. A recreated
  // folder must not inherit the deleted folder's notes, and swaps keep scopes.
  const folders = Object.values(state.entries).filter(entry => entry.kind === 'folder')
    .sort((a, b) => Number(!nativeEntries.has(a.id) && a.id !== root) - Number(!nativeEntries.has(b.id) && b.id !== root));
  for (const entry of folders) {
    const projected = projectedPaths.get(entry.id), directory = projected && privatePath(projected) ? projected : paths.get(entry.id);
    const previous = entry.id === root ? rootScope : scopes.get(nativeEntries.get(entry.id)?.relative_path) || (scopesById.has(entry.id) ? entry.id : null) || scopes.get(directory);
    const scopeId = previous && !assignedScopes.has(previous) ? previous : entry.id;
    assignedScopes.add(scopeId); scopeIds.set(entry.id, scopeId); scopeUpdates.push({ scopeId, directory });
  }
  for (const scope of scopeRows) reserved.add(scope.directory);
  for (const scope of scopeUpdates) reserved.add(scope.directory);
  for (const { scopeId, directory } of scopeUpdates) if (scopesById.has(scopeId) && scopesById.get(scopeId) !== directory) {
    db.prepare('UPDATE local_canvas_scopes SET directory=? WHERE id=?').run(reserve('scope-moving', scopeId), scopeId);
  }
  for (const { scopeId, directory } of scopeUpdates) {
    if (!scopesById.has(scopeId)) db.prepare('INSERT INTO local_canvas_scopes(id,workspace_id,directory) VALUES(?,?,?)').run(scopeId, workspaceId, directory);
    else if (scopesById.get(scopeId) !== directory) db.prepare('UPDATE local_canvas_scopes SET directory=? WHERE id=?').run(directory, scopeId);
  }
  const putCanvas = db.prepare(`INSERT INTO local_canvas(id,workspace_id,scope_id,kind,payload,revision,deleted) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET scope_id=excluded.scope_id,kind=excluded.kind,payload=excluded.payload,revision=excluded.revision,deleted=excluded.deleted`);
  for (const element of Object.values(state.canvas_elements)) putCanvas.run(element.id, workspaceId, scopeIds.get(element.scope_id), 'element', json({ id: element.id, kind: element.kind === 'note' ? 'text' : element.kind, text: element.content, x: element.x, y: element.y, width: element.width, height: element.height, color: element.color || 'violet', font_size: element.font_size || 24, ...(element.sources.length ? { sources: element.sources.map(sourceToLegacy) } : {}) }), element.revision, element.deleted_at ? 1 : 0);
  for (const relation of Object.values(state.relations)) putCanvas.run(relation.id, workspaceId, scopeIds.get(relation.scope_id), 'relation', json({ id: relation.id, source_document_id: documentEntries.get(relation.source_document_id), target_document_id: documentEntries.get(relation.target_document_id), relation_type: relation.relation_type, source_handle: relation.source_handle || 'right', target_handle: relation.target_handle || 'left', ...(relation.label ? { label: relation.label } : {}) }), relation.revision, relation.deleted_at ? 1 : 0);
  const proposals = new Map(); for (const proposal of Object.values(state.proposals)) if (proposal.status === 'pending') { const previous = proposals.get(proposal.draft_id); if (!previous || proposal.created_at >= previous.created_at) proposals.set(proposal.draft_id, proposal); }
  const putDraft = db.prepare(`INSERT INTO local_drafts(id,workspace_id,request_id,content,sources,checks,history,proposal,revision,deleted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET content=excluded.content,sources=excluded.sources,checks=excluded.checks,history=excluded.history,proposal=excluded.proposal,revision=excluded.revision,deleted=excluded.deleted,updated_at=excluded.updated_at`);
  for (const draft of Object.values(state.drafts)) {
    const previous = db.prepare('SELECT request_id,created_at,updated_at FROM local_drafts WHERE id=?').get(draft.id), proposal = proposals.get(draft.id);
    const content = writingContent(draft.content, draft.title), snapshots = draft.history.map(history => ({ content: writingContent(history.content, draft.title), sources: history.sources.map(sourceToLegacy), checks: checks(history.review) }));
    const history = snapshots.length && json(snapshots.at(-1).content) === json(content) ? snapshots.slice(0, -1) : snapshots;
    const pending = proposal ? { content: writingContent(proposal.content, draft.title), sources: proposal.sources.map(sourceToLegacy), checks: checks(proposal.review) } : null;
    putDraft.run(draft.id, workspaceId, previous?.request_id || stable(`draft-request:${draft.id}`), json(content), json(draft.sources.map(sourceToLegacy)), json(checks(draft.review)), json(history), pending ? json(pending) : null, draft.revision, draft.deleted_at ? 1 : 0,
      previous?.created_at || stamp(draft.history[0]?.created_at), previous?.updated_at || stamp(draft.history.at(-1)?.created_at));
  }
  for (const session of Object.values(state.chat_sessions)) {
    const old = db.prepare('SELECT * FROM local_chat_sessions WHERE id=?').get(session.id);
    db.prepare(`INSERT INTO local_chat_sessions(id,workspace_id,request_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at`)
      .run(session.id, workspaceId, old?.request_id || session.metadata?.request_id || stable(`chat-request:${session.id}`), session.title, old?.created_at ?? stamp(session.metadata?.created_at), stamp(session.metadata?.updated_at) || old?.updated_at || 0);
  }
  const nextSequences = new Map();
  for (const message of Object.values(state.chat_messages).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    const old = db.prepare('SELECT * FROM local_chat_messages WHERE id=?').get(message.id), metadata = message.metadata || {};
    const sequence = Number(metadata.sequence) || old?.sequence || (nextSequences.get(message.session_id) || 0) + 1; nextSequences.set(message.session_id, Math.max(nextSequences.get(message.session_id) || 0, sequence));
    const result = metadata.result || (message.sources.length ? { sources: message.sources.map(sourceToLegacy), claims: [{ text: message.content, source_ids: message.sources.map(s => s.metadata?.legacy_id || s.id) }], insufficient: false } : null);
    db.prepare(`INSERT INTO local_chat_messages(id,session_id,request_id,sequence,role,state,content,result,options,error_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET request_id=excluded.request_id,sequence=excluded.sequence,state=excluded.state,content=excluded.content,result=excluded.result,options=excluded.options,error_code=excluded.error_code`)
      .run(message.id, message.session_id, metadata.request_id || message.request_id || stable(`message-request:${message.id}`), sequence, message.role, metadata.state || 'COMPLETED', message.content, result ? json(result) : null, json(metadata.options || {}), metadata.error_code || null, stamp(message.created_at));
  }
  return state;
}
