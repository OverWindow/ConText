import { connectedEntrySQL } from './file-connections.mjs';
/** Collect saved excerpts in one workspace; keep every source kind inside a bounded budget. */
export function writingContext(documents, workspaceId, prompt, current) {
  const db = documents.db, terms = [...new Set(prompt.toLocaleLowerCase().split(/\s+/).filter(term => term.length > 1))];
  const score = text => terms.reduce((sum, term) => sum + (text.toLocaleLowerCase().includes(term) ? 1 : 0), 0);
  let candidates = documents.search(workspaceId, prompt);
  if (!candidates.length) candidates = db.prepare(`SELECT s.*,v.version_number FROM local_search s JOIN local_documents d ON d.current_version_id=s.version_id JOIN local_versions v ON v.id=s.version_id JOIN entries e ON e.id=d.entry_id WHERE s.workspace_id=? AND e.present=1 AND ${connectedEntrySQL()} ORDER BY v.created_at DESC LIMIT 12`).all(workspaceId)
    .map(row => ({ id: `version-${row.version_id}-block-${row.block_id}`, kind: 'document', document_id: row.document_id, version_id: row.version_id, version_number: row.version_number, document_title: row.title, text: row.text, locations: [{ block_id: Number(row.block_id) }] }));
  const notes = db.prepare("SELECT id,payload,revision FROM local_canvas WHERE workspace_id=? AND kind='element' AND deleted=0 ORDER BY rowid DESC LIMIT 100").all(workspaceId)
    .flatMap(row => { const note = JSON.parse(row.payload); return note.kind === 'text' && note.text.trim() ? [{ id: `note-${row.id}-${row.revision}`, kind: 'note', document_title: '캔버스 메모', text: note.text, locations: [] }] : []; });
  const chats = db.prepare("SELECT m.id,m.content,s.title FROM local_chat_messages m JOIN local_chat_sessions s ON s.id=m.session_id WHERE s.workspace_id=? AND m.role='assistant' AND m.state='COMPLETED' AND m.content<>'' ORDER BY m.created_at DESC LIMIT 20").all(workspaceId)
    .map(row => ({ id: `chat-${row.id}`, kind: 'chat', document_title: `대화: ${row.title}`.slice(0, 300), text: row.content, locations: [] }));
  const drafts = db.prepare('SELECT id,content,revision FROM local_drafts WHERE workspace_id=? AND deleted=0 AND id<>? ORDER BY updated_at DESC LIMIT 20').all(workspaceId, current?.id || '')
    .map(row => { const content = JSON.parse(row.content); return { id: `draft-${row.id}-${row.revision}`, kind: 'draft', document_title: content.title, text: content.blocks.map(block => block.type === 'list' ? block.items.join('\n') : block.type === 'table' ? block.rows.map(row => row.join(' | ')).join('\n') : block.text).join('\n'), locations: [] }; });
  for (const group of [notes, chats, drafts]) group.sort((a, b) => score(b.text) - score(a.text));
  const sources = [], seen = new Set();
  for (const [group, maximum, allowance] of [[current?.sources || [], 4, 6000], [candidates, 8, 12000], [notes, 2, 2000], [chats, 2, 2000], [drafts, 2, 2000]]) {
    let budget = allowance, count = 0;
    for (const source of group) {
      if (!budget || count >= maximum) break;
      if (seen.has(source.id) || !source.text.trim()) continue;
      const { id, kind, document_title, document_id, version_id, version_number, is_current, locations } = source;
      const text = source.text.slice(0, Math.min(4000, budget)); budget -= text.length; count++; seen.add(id);
      sources.push({ id, kind, document_title, document_id, version_id, version_number, is_current, locations, text });
    }
  }
  return sources;
}
