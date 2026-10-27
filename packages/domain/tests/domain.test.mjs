import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, applyChanges, createWorkspaceState, sourceAvailability, conflictResolutionBases } from '../src/index.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(1), workspaceId = id(2), rootId = id(3), device = id(4);
const now = '2026-10-27T00:00:00.000Z';
const context = { actor_id: actor, role: 'OWNER', now };
let serial = 100000;
function command(type, payload, base_revisions = {}, overrides = {}) {
  return { schema_version: 2, operation_id: id(serial++), workspace_id: workspaceId, workspace_epoch: 0, device_id: device, type, payload, base_revisions, ...overrides };
}
function fresh() { return createWorkspaceState({ id: workspaceId, name: '연구', root_entry_id: rootId, epoch: 0, revision: 1, created_at: now, updated_at: now, deleted_at: null }); }
function apply(state, type, payload, bases = {}, ctx = context) {
  const result = applyCommand(state, command(type, payload, bases), ctx);
  assert.equal(result.status, 'applied', JSON.stringify(result.error)); return result.state;
}
function file(state, entryId = id(10), documentId = id(11), parentId = rootId, name = '원본.txt') { return apply(state, 'CreateEntry', { id: entryId, document_id: documentId, parent_id: parentId, kind: 'file', name }); }
function version(n, documentId = id(11), parents = []) { return { id: id(n), workspace_id: workspaceId, document_id: documentId,
  blob: { id: id(n + 1000), sha256: String(n % 10).repeat(64), size: 0, mime_type: 'text/plain' }, parent_version_ids: parents,
  sources: [], created_at: now, created_by: actor, display_number: 7, change_note: '' }; }
function note(n, extra = {}) { return { id: id(n), workspace_id: workspaceId, scope_id: rootId, kind: 'note', x: 0, y: 0, width: 240, height: 180,
  content: '기록', color: '#fff', sources: [], revision: 0, deleted_at: null, ...extra }; }

test('delete cannot erase an unobserved version even with a freshly pulled document revision', () => {
  let state = file(fresh()); const a=version(901),b=version(902,id(11),[a.id]);
  state=apply(state,'AppendDocumentVersion',{version:a},{[`documents:${id(11)}`]:0}); state=apply(state,'AppendDocumentVersion',{version:b},{[`documents:${id(11)}`]:1});
  const result=applyCommand(state,command('TrashEntry',{id:id(10),observed_heads:{[id(11)]:a.id}},{[`entries:${id(10)}`]:1,[`documents:${id(11)}`]:2}),context);
  assert.equal(result.status,'conflict');assert.equal(result.state.documents[id(11)].content_head_id,b.id);assert.equal(result.state.entries[id(10)].deleted_at,null);
  const conflict=Object.values(result.state.conflicts)[0];assert.equal(conflict.reason,'delete_vs_unobserved_version');
  const resolved=apply(result.state,'ResolveConflict',{id:conflict.id,resolution:'apply_candidate'},conflictResolutionBases(result.state,conflict));
  assert.ok(resolved.entries[id(10)].deleted_at);assert.equal(Object.keys(resolved.versions).length,2);assert.equal(resolved.conflicts[conflict.id].status,'resolved');
});

test('folder delete resolution requires every current descendant CAS and remains atomic if review becomes stale', () => {
  let state=apply(fresh(),'CreateEntry',{id:id(40),parent_id:rootId,kind:'folder',name:'Folder'});state=file(state,id(10),id(11),id(40));const a=version(903);state=apply(state,'AppendDocumentVersion',{version:a},{[`documents:${id(11)}`]:0});
  const incoming=applyCommand(state,command('TrashEntry',{id:id(40)},{[`entries:${id(40)}`]:1,[`entries:${id(10)}`]:1,[`documents:${id(11)}`]:0}),context);
  assert.equal(incoming.status,'conflict');const conflict=Object.values(incoming.state.conflicts)[0],bases=conflictResolutionBases(incoming.state,conflict);
  const changed=apply(incoming.state,'MoveEntry',{id:id(10),parent_id:id(40),name:'Renamed.txt'},{[`entries:${id(10)}`]:1});
  const result=applyCommand(changed,command('ResolveConflict',{id:conflict.id,resolution:'apply_candidate'},bases),context);
  assert.equal(result.status,'rejected');assert.equal(result.state.conflicts[conflict.id].status,'open');assert.equal(result.state.entries[id(10)].deleted_at,null);
});

test('two offline edits retain UUID branches with one shared parent and resolve explicitly', () => {
  let state = file(fresh()); const a = version(20); state = apply(state, 'AppendDocumentVersion', { version: a }, { [`documents:${id(11)}`]: 0 });
  const b = version(21, id(11), [a.id]), c = version(22, id(11), [a.id]);
  const common = state; state = apply(state, 'AppendDocumentVersion', { version: b }, { [`documents:${id(11)}`]: 1 });
  const cmd = command('AppendDocumentVersion', { version: c }, { [`documents:${id(11)}`]: 1 });
  const incoming = applyCommand(state, cmd, context);
  assert.equal(incoming.status, 'conflict'); assert.equal(incoming.state.documents[id(11)].content_head_id, b.id);
  assert.deepEqual(incoming.state.versions[c.id].parent_version_ids, [a.id]);
  assert.equal(Object.keys(incoming.state.versions).length, 3); assert.equal(common.documents[id(11)].content_head_id, a.id);
  assert.equal(incoming.state.versions[b.id].display_number, incoming.state.versions[c.id].display_number);
  assert.deepEqual(applyChanges(state, incoming.changes), incoming.state);
  const resolved = apply(incoming.state, 'ResolveConflict', { id: cmd.operation_id, resolution: 'apply_candidate' }, { [`conflicts:${cmd.operation_id}`]: 1, [`documents:${id(11)}`]: 2 });
  assert.equal(resolved.documents[id(11)].content_head_id, c.id); assert.equal(resolved.conflicts[cmd.operation_id].status, 'resolved');
  assert.equal(Object.keys(resolved.versions).length, 3);
});

test('immutable versions reject changed bytes, unverified blobs, forged actors and cross-document parents atomically', () => {
  let state = file(fresh()); const a = version(20); state = apply(state, 'AppendDocumentVersion', { version: a }, { [`documents:${id(11)}`]: 0 });
  for (const [candidate, ctx, code] of [
    [{ ...a, change_note: 'rewrite' }, context, 'immutable_version'],
    [version(21, id(11), [a.id]), { ...context, available_blobs: new Set() }, 'blob_unavailable'],
    [{ ...version(22), created_by: id(99) }, context, 'forbidden'],
  ]) {
    const result = applyCommand(state, command('AppendDocumentVersion', { version: candidate }, { [`documents:${id(11)}`]: 1 }), ctx);
    assert.equal(result.error.code, code); assert.strictEqual(result.state, state); assert.deepEqual(result.changes, []);
  }
  state = file(state, id(30), id(31), rootId, '다른 문서.txt');
  const cross = applyCommand(state, command('AppendDocumentVersion', { version: version(32, id(31), [a.id]) }, { [`documents:${id(31)}`]: 0 }), context);
  assert.equal(cross.error.code, 'invalid_reference'); assert.strictEqual(cross.state, state);
});

test('version branch without matching head parent is preserved rather than silently replacing content', () => {
  let state = file(fresh()); state = apply(state, 'AppendDocumentVersion', { version: version(20) }, { [`documents:${id(11)}`]: 0 });
  const result = applyCommand(state, command('AppendDocumentVersion', { version: version(21) }, { [`documents:${id(11)}`]: 1 }), context);
  assert.equal(result.status, 'conflict'); assert.equal(result.state.conflicts[result.conflict_ids[0]].reason, 'divergent_version_parent');
  assert.ok(result.state.versions[id(21)]); assert.equal(result.state.documents[id(11)].content_head_id, id(20));
});

test('reference pin survives incoming content; unpin follows content head', () => {
  let state = file(fresh()); state = apply(state, 'AppendDocumentVersion', { version: version(20) }, { [`documents:${id(11)}`]: 0 });
  state = apply(state, 'SelectReferenceHead', { document_id: id(11), version_id: id(20), pinned: true }, { [`documents:${id(11)}`]: 1 });
  state = apply(state, 'AppendDocumentVersion', { version: version(21, id(11), [id(20)]) }, { [`documents:${id(11)}`]: 2 });
  assert.equal(state.documents[id(11)].reference_head_id, id(20));
  state = apply(state, 'SelectReferenceHead', { document_id: id(11), version_id: id(20), pinned: false }, { [`documents:${id(11)}`]: 3 });
  assert.equal(state.documents[id(11)].reference_head_id, id(21));
});

test('entry position revision and structure revision do not conflict', () => {
  let state = file(fresh());
  state = apply(state, 'SetEntryPositions', { positions: [{ id: id(10), x: 100, y: -5 }] }, { [`entry_positions:${id(10)}`]: 0 });
  state = apply(state, 'MoveEntry', { id: id(10), parent_id: rootId, name: '새 이름.txt' }, { [`entries:${id(10)}`]: 1 });
  assert.equal(state.entries[id(10)].x, 100); assert.equal(state.entries[id(10)].revision, 2); assert.equal(state.entries[id(10)].position_revision, 1);
  const stale = applyCommand(state, command('SetEntryPositions', { positions: [{ id: id(10), x: 999, y: 999 }] }, { [`entry_positions:${id(10)}`]: 0 }), context);
  assert.equal(stale.status, 'conflict'); assert.equal(stale.state.entries[id(10)].x, 100);
});

test('all existing edits require explicit CAS; a partial multi-position update never leaks', () => {
  let state = file(fresh()); state = file(state, id(30), id(31), rootId, '둘.txt');
  const noBase = applyCommand(state, command('MoveEntry', { id: id(10), parent_id: rootId, name: '누락.txt' }), context);
  assert.equal(noBase.error.code, 'revision_required'); assert.strictEqual(noBase.state, state);
  const result = applyCommand(state, command('SetEntryPositions', { positions: [{ id: id(10), x: 8, y: 9 }, { id: id(30), x: 4, y: 5 }] }, { [`entry_positions:${id(10)}`]: 0 }), context);
  assert.equal(result.error.code, 'revision_required'); assert.strictEqual(result.state, state); assert.equal(state.entries[id(10)].x, null);
});

test('tree checks reject cycles, sibling collisions, duplicate document ownership and foreign scopes', () => {
  let state = fresh(); state = apply(state, 'CreateEntry', { id: id(40), parent_id: rootId, kind: 'folder', name: '폴더' });
  state = apply(state, 'CreateEntry', { id: id(41), parent_id: id(40), kind: 'folder', name: '안쪽' }); state = file(state);
  const cases = [
    ['MoveEntry', { id: id(40), parent_id: id(41), name: '순환' }, { [`entries:${id(40)}`]: 1 }, 'invalid_tree'],
    ['CreateEntry', { id: id(42), parent_id: rootId, kind: 'folder', name: '폴더' }, {}, 'name_conflict'],
    ['CreateEntry', { id: id(43), document_id: id(11), parent_id: rootId, kind: 'file', name: '중복.txt' }, {}, 'already_exists'],
    ['PutCanvasElement', { element: note(50, { workspace_id: id(999) }) }, {}, 'workspace_mismatch'],
    ['PutCanvasElement', { element: note(50, { scope_id: id(10) }) }, {}, 'invalid_reference'],
  ];
  for (const [type, payload, bases, code] of cases) { const result = applyCommand(state, command(type, payload, bases), context); assert.equal(result.error.code, code); assert.strictEqual(result.state, state); }
});

test('folder deletion refuses stale descendant edits, retains immutable data and restores explicitly', () => {
  let state = apply(fresh(), 'CreateEntry', { id: id(40), parent_id: rootId, kind: 'folder', name: '폴더' }); state = file(state, id(10), id(11), id(40));
  state = apply(state, 'AppendDocumentVersion', { version: version(20) }, { [`documents:${id(11)}`]: 0 });
  const old = applyCommand(state, command('TrashEntry', { id: id(40) }, { [`entries:${id(40)}`]: 1, [`entries:${id(10)}`]: 1, [`documents:${id(11)}`]: 0 }), context);
  assert.equal(old.error.code, 'revision_conflict'); assert.equal(old.status, 'conflict'); assert.deepEqual(old.state.entries, state.entries); assert.deepEqual(old.state.documents, state.documents);
  state = apply(state, 'TrashEntry', { id: id(40) }, { [`entries:${id(40)}`]: 1, [`entries:${id(10)}`]: 1, [`documents:${id(11)}`]: 1 });
  assert.equal(state.entries[id(10)].deleted_at, now); assert.ok(state.versions[id(20)]);
  state = apply(state, 'RestoreEntry', { id: id(40), parent_id: rootId }, { [`entries:${id(40)}`]: 2 });
  assert.equal(state.entries[id(40)].deleted_at, null); assert.equal(state.entries[id(10)].deleted_at, now);
  state = apply(state, 'RestoreEntry', { id: id(10), parent_id: id(40) }, { [`entries:${id(10)}`]: 2, [`documents:${id(11)}`]: 2 });
  assert.equal(state.documents[id(11)].deleted_at, null); assert.equal(state.documents[id(11)].content_head_id, id(20));
});

test('late version after file deletion is preserved as a recovery conflict', () => {
  let state = file(fresh()); state = apply(state, 'TrashEntry', { id: id(10) }, { [`entries:${id(10)}`]: 1, [`documents:${id(11)}`]: 0 });
  const result = applyCommand(state, command('AppendDocumentVersion', { version: version(20) }, { [`documents:${id(11)}`]: 0 }), context);
  assert.equal(result.status, 'conflict'); assert.ok(result.state.versions[id(20)]); assert.equal(result.state.documents[id(11)].deleted_at, now);
  assert.equal(result.state.conflicts[result.conflict_ids[0]].reason, 'delete_vs_edit');
});

test('stale draft saves retain both contents, sources and review as a recoverable proposal', () => {
  let state = apply(fresh(), 'CreateDraft', { id: id(60), scope_id: rootId, title: '초안', content: '원본' });
  const before = state; state = apply(state, 'SaveDraft', { id: id(60), title: '초안', content: '웹 내용', sources: [], review: { approved: true } }, { [`drafts:${id(60)}`]: 1 });
  const pending = command('SaveDraft', { id: id(60), title: '오프라인 제목', content: '기기 내용', sources: [], review: { questions: ['검토'] } }, { [`drafts:${id(60)}`]: 1 });
  const result = applyCommand(state, pending, context); assert.equal(result.status, 'conflict'); assert.equal(result.state.drafts[id(60)].content, '웹 내용');
  assert.equal(result.state.proposals[pending.operation_id].content, '기기 내용'); assert.deepEqual(result.state.proposals[pending.operation_id].review, { questions: ['검토'] });
  assert.equal(before.drafts[id(60)].history.length, 1); assert.strictEqual(result.state.entries, state.entries);
  const resolved = apply(result.state, 'ResolveConflict', { id: pending.operation_id, resolution: 'apply_candidate', merged_content: '합친 내용' }, { [`conflicts:${pending.operation_id}`]: 1, [`drafts:${id(60)}`]: 2 });
  assert.equal(resolved.drafts[id(60)].content, '합친 내용'); assert.equal(resolved.drafts[id(60)].history.length, 3); assert.equal(resolved.proposals[pending.operation_id].status, 'accepted');
});

test('mixed source snapshots survive removed originals while mismatched live links fail', () => {
  let state = file(fresh()); state = apply(state, 'AppendDocumentVersion', { version: version(20) }, { [`documents:${id(11)}`]: 0 });
  state = apply(state, 'PutCanvasElement', { element: note(50) });
  const src = [
    { id: id(70), kind: 'document', document_id: id(11), version_id: id(20), quote: '문서 인용', label: '원본', metadata: { legacy_id: 'chunk-1', extra: [1, true] } },
    { id: id(71), kind: 'note', element_id: id(50), scope_id: rootId, quote: '메모 인용', label: '메모' },
    { id: id(72), kind: 'chat', session_id: id(80), message_id: id(81), quote: '삭제된 대화 인용', label: '대화' },
    { id: id(73), kind: 'draft', draft_id: id(82), history_id: id(83), quote: '삭제된 초안 인용', label: '초안' },
  ];
  state = apply(state, 'CreateDraft', { id: id(60), scope_id: rootId, title: '혼합 출처', sources: src });
  state = apply(state, 'RemoveCanvasElement', { id: id(50) }, { [`canvas_elements:${id(50)}`]: 1 });
  state = apply(state, 'SaveDraft', { id: id(60), title: '혼합 출처', content: '그대로', sources: src }, { [`drafts:${id(60)}`]: 1 });
  assert.deepEqual(state.drafts[id(60)].sources, src); assert.equal(sourceAvailability(state, src[1]), 'deleted'); assert.equal(sourceAvailability(state, src[2]), 'missing');
  const mismatch = { ...src[0], document_id: id(999) };
  const result = applyCommand(state, command('SaveDraft', { id: id(60), title: '', content: '오류', sources: [mismatch] }, { [`drafts:${id(60)}`]: 2 }), context);
  assert.equal(result.error.code, 'invalid_reference'); assert.strictEqual(result.state, state);
});

test('canvas source text conflicts preserve original and candidate; triangle/font size and handles roundtrip', () => {
  let state = file(fresh()); state = file(state, id(30), id(31), rootId, '다른.txt');
  state = apply(state, 'PutCanvasElement', { element: note(50, { kind: 'triangle', font_size: 32 }) });
  const relation = { id: id(51), workspace_id: workspaceId, scope_id: rootId, source_document_id: id(11), target_document_id: id(31), relation_type: 'derived', label: '', source_handle: 'left', target_handle: 'right', revision: 0, deleted_at: null };
  state = apply(state, 'PutRelation', { relation }); assert.equal(state.relations[id(51)].source_handle, 'left');
  state = apply(state, 'PutCanvasElement', { element: { ...state.canvas_elements[id(50)], content: '서버' } }, { [`canvas_elements:${id(50)}`]: 1 });
  const cmd = command('PutCanvasElement', { element: note(50, { content: '기기' }) }, { [`canvas_elements:${id(50)}`]: 1 }); const result = applyCommand(state, cmd, context);
  assert.equal(result.status, 'conflict'); assert.equal(result.state.canvas_elements[id(50)].content, '서버');
  assert.equal(result.state.conflicts[cmd.operation_id].candidate.payload.element.content, '기기');
});

test('chat appends commute without overwriting history; AI completion outputs publish atomically', () => {
  let state = apply(fresh(), 'CreateChatSession', { id: id(80), scope_id: rootId, title: '대화' });
  const message = n => ({ id: id(n), workspace_id: workspaceId, session_id: id(80), role: 'user', content: String(n), sources: [], request_id: null, created_at: now, created_by: actor });
  state = apply(state, 'AppendChatMessage', { message: message(81) }); state = apply(state, 'AppendChatMessage', { message: message(82) }); assert.equal(Object.keys(state.chat_messages).length, 2);
  const assistant = { ...message(83), role: 'assistant', request_id: id(90) };
  const result = applyCommand(state, command('CompleteAIRequest', { request_id: id(90), message: assistant, artifacts: [{ id: id(91), workspace_id: workspaceId, document_id: id(11), version_id: id(20), kind: 'parse', processor_fingerprint: 'p1', blob: version(20).blob, created_at: now }] }), context);
  assert.equal(result.status, 'rejected'); assert.strictEqual(result.state, state); assert.equal(result.state.chat_messages[id(83)], undefined);
  state = apply(state, 'CompleteAIRequest', { request_id: id(90), message: assistant });
  const duplicate = applyCommand(state, command('AppendChatMessage', { message: { ...assistant, id: id(84) } }), context);
  assert.equal(duplicate.error.code, 'already_exists'); assert.equal(Object.keys(state.chat_messages).length, 3);
});

test('workspace tombstone blocks all stale device mutations without deleting originals or versions', () => {
  let state = file(fresh()); state = apply(state, 'AppendDocumentVersion', { version: version(20) }, { [`documents:${id(11)}`]: 0 });
  const editor = applyCommand(state, command('DeleteWorkspace', {}, { [`workspace:${workspaceId}`]: 1 }), { ...context, role: 'EDITOR' }); assert.equal(editor.error.code, 'forbidden');
  state = apply(state, 'DeleteWorkspace', {}, { [`workspace:${workspaceId}`]: 1 }); assert.equal(state.workspace.epoch, 1); assert.ok(state.versions[id(20)]);
  const stale = applyCommand(state, command('CreateEntry', { id: id(40), parent_id: rootId, kind: 'folder', name: '부활' }), context);
  assert.equal(stale.error.code, 'workspace_deleted'); assert.strictEqual(stale.state, state); assert.deepEqual(stale.changes, []);
  const epoch = applyCommand(fresh(), command('CreateEntry', { id: id(40), parent_id: rootId, kind: 'folder', name: '실패' }, {}, { workspace_epoch: 3 }), context); assert.equal(epoch.error.code, 'epoch_mismatch');
});

test('viewer and workspace identity guards run before mutations', () => {
  const state = fresh(); const create = command('CreateEntry', { id: id(40), parent_id: rootId, kind: 'folder', name: '폴더' });
  assert.equal(applyCommand(state, create, { ...context, role: 'VIEWER' }).error.code, 'forbidden');
  assert.equal(applyCommand(state, { ...create, workspace_id: id(999) }, context).error.code, 'workspace_mismatch');
  assert.strictEqual(applyCommand(state, create, { ...context, role: 'VIEWER' }).state, state);
});

test('more than 25001 entries and 2001 direct siblings have no truncated domain read set', () => {
  const state = fresh();
  for (let n = 0; n < 25001; n++) {
    const entry = { id: id(n + 1000000), workspace_id: workspaceId, parent_id: rootId, kind: 'folder', name: `폴더 ${n}`, document_id: null, revision: 1, position_revision: 0, x: null, y: null, area_positioned: false, deleted_at: null };
    state.entries[entry.id] = entry;
  }
  const duplicate = applyCommand(state, command('CreateEntry', { id: id(9999999), parent_id: rootId, kind: 'folder', name: '폴더 25000' }), context);
  assert.equal(duplicate.error.code, 'name_conflict');
  const added = apply(state, 'CreateEntry', { id: id(9999998), parent_id: rootId, kind: 'folder', name: '25002번째' });
  assert.equal(Object.keys(added.entries).length, 25003); assert.equal(Object.keys(state.entries).length, 25002);
});

test('one-time import preserves complete desktop history, pending proposals and all mixed sources', () => {
  let imported = file(fresh()); imported = apply(imported, 'AppendDocumentVersion', { version: version(20) }, { [`documents:${id(11)}`]: 0 });
  imported = apply(imported, 'CreateDraft', { id: id(60), scope_id: rootId, title: '초안', content: '첫 초안' });
  imported = apply(imported, 'SaveDraft', { id: id(60), title: '초안', content: '저장 이력', sources: [], review: { checks: [{ valid: true }] } }, { [`drafts:${id(60)}`]: 1 });
  imported = apply(imported, 'CreateProposal', { id: id(61), draft_id: id(60), content: '승인 대기', sources: [], review: { reason: 'AI' } }, { [`drafts:${id(60)}`]: 2 });
  imported = apply(imported, 'CreateChatSession', { id: id(80), scope_id: rootId, title: '저장 대화' });
  const message = { id: id(81), workspace_id: workspaceId, session_id: id(80), role: 'user', content: '질문', sources: [], request_id: null, created_at: now, created_by: actor };
  imported = apply(imported, 'AppendChatMessage', { message });
  const state = fresh(), original = JSON.stringify(imported);
  const result = applyCommand(state, command('ImportWorkspace', { state: imported }, { [`workspace:${workspaceId}`]: 1 }), { ...context, available_blobs: new Set([id(1020)]) });
  assert.equal(result.status, 'applied', JSON.stringify(result.error)); assert.equal(result.state.workspace.revision, 2);
  assert.deepEqual(result.state.drafts, imported.drafts); assert.deepEqual(result.state.proposals, imported.proposals); assert.deepEqual(result.state.chat_messages, imported.chat_messages);
  assert.deepEqual(result.state.versions, imported.versions); assert.equal(JSON.stringify(imported), original); assert.deepEqual(applyChanges(state, result.changes), result.state);
  const again = applyCommand(result.state, command('ImportWorkspace', { state: imported }, { [`workspace:${workspaceId}`]: 2 }), context);
  assert.equal(again.error.code, 'already_exists'); assert.strictEqual(again.state, result.state);
});

test('large initial import validates all 25001 entries in one transaction without truncated siblings', () => {
  const imported = fresh();
  for (let n = 0; n < 25001; n++) { const e = { id: id(n + 1000000), workspace_id: workspaceId, parent_id: rootId, kind: 'folder', name: `폴더 ${n}`, document_id: null, revision: n + 1, position_revision: 0, x: null, y: null, area_positioned: false, deleted_at: null }; imported.entries[e.id] = e; }
  const state = fresh(); const result = applyCommand(state, command('ImportWorkspace', { state: imported }, { [`workspace:${workspaceId}`]: 1 }), context);
  assert.equal(result.status, 'applied', JSON.stringify(result.error)); assert.equal(Object.keys(result.state.entries).length, 25002); assert.equal(result.changes.length, 25003);
  assert.equal(result.state.entries[id(1025000)].revision, 25001); assert.equal(Object.keys(state.entries).length, 1);
});

test('initial import rejects device fields, root mismatch, missing bytes, sibling collision and version cycles', () => {
  const state = fresh();
  let imported = file(fresh()); imported = apply(imported, 'AppendDocumentVersion', { version: version(20) }, { [`documents:${id(11)}`]: 0 });
  const cases = [
    [s => { s.entries[id(10)].absolute_path = '/private/original.txt'; }, context, 'invalid_command'],
    [s => { s.workspace.root_entry_id = id(999); }, context, 'workspace_mismatch'],
    [s => {}, { ...context, available_blobs: new Set() }, 'blob_unavailable'],
    [s => { s.entries[id(30)] = { ...s.entries[id(10)], id: id(30), kind: 'folder', document_id: null }; }, context, 'name_conflict'],
    [s => { s.versions[id(21)] = version(21, id(11), [id(20)]); s.versions[id(20)].parent_version_ids = [id(21)]; }, context, 'invalid_tree'],
    [s => { s.documents[id(11)].content_head_id = id(999); s.documents[id(11)].reference_head_id = id(999); }, context, 'invalid_reference'],
  ];
  for (const [mutate, ctx, code] of cases) { const candidate = structuredClone(imported); mutate(candidate); const result = applyCommand(state, command('ImportWorkspace', { state: candidate }, { [`workspace:${workspaceId}`]: 1 }), ctx); assert.equal(result.error.code, code); assert.strictEqual(result.state, state); assert.deepEqual(result.changes, []); }
  const notOwner = applyCommand(state, command('ImportWorkspace', { state: imported }, { [`workspace:${workspaceId}`]: 1 }), { ...context, role: 'EDITOR' }); assert.equal(notOwner.error.code, 'forbidden');
});

test('atomic entry moves allow name swaps while stale or cyclic batches preserve the original tree', () => {
  let state = file(fresh(), id(10), id(11), rootId, 'A.txt'); state = file(state, id(30), id(31), rootId, 'B.txt');
  const swap = { moves: [{ id: id(10), parent_id: rootId, name: 'B.txt' }, { id: id(30), parent_id: rootId, name: 'A.txt' }] };
  const result = applyCommand(state, command('MoveEntries', swap, { [`entries:${id(10)}`]: 1, [`entries:${id(30)}`]: 1 }), context);
  assert.equal(result.status, 'applied'); assert.equal(result.state.entries[id(10)].name, 'B.txt'); assert.equal(result.state.entries[id(30)].name, 'A.txt');
  assert.equal(state.entries[id(10)].name, 'A.txt'); assert.equal(result.changes.length, 2);
  const stale = applyCommand(result.state, command('MoveEntries', swap, { [`entries:${id(10)}`]: 1, [`entries:${id(30)}`]: 2 }), context);
  assert.equal(stale.status, 'conflict'); assert.strictEqual(stale.state.entries, result.state.entries); assert.deepEqual(stale.state.conflicts[stale.conflict_ids[0]].candidate.payload, swap);
  state = apply(state, 'CreateEntry', { id: id(40), parent_id: rootId, kind: 'folder', name: '폴더' }); state = apply(state, 'CreateEntry', { id: id(41), parent_id: id(40), kind: 'folder', name: '안쪽' });
  const cycle = applyCommand(state, command('MoveEntries', { moves: [{ id: id(40), parent_id: id(41), name: '폴더' }, { id: id(10), parent_id: rootId, name: '다른.txt' }] }, { [`entries:${id(40)}`]: 1, [`entries:${id(10)}`]: 1 }), context);
  assert.equal(cycle.status, 'rejected'); assert.equal(cycle.error.code, 'invalid_tree'); assert.strictEqual(cycle.state, state); assert.deepEqual(cycle.changes, []);
});

test('entry reconciliation atomically creates replacement parent and moves old folder/file without intermediate collisions', () => {
  let state = file(fresh(), id(10), id(11), rootId, 'A.txt'); state = apply(state, 'CreateEntry', { id: id(40), parent_id: rootId, kind: 'folder', name: 'C' });
  const payload = { creates: [{ id: id(41), parent_id: rootId, kind: 'folder', name: 'C' }], moves: [{ id: id(40), parent_id: rootId, name: 'D' }, { id: id(10), parent_id: id(41), name: 'A.txt' }] };
  const result = applyCommand(state, command('ReconcileEntries', payload, { [`entries:${id(40)}`]: 1, [`entries:${id(10)}`]: 1 }), context);
  assert.equal(result.status, 'applied'); assert.equal(result.state.entries[id(40)].name, 'D'); assert.equal(result.state.entries[id(41)].name, 'C'); assert.equal(result.state.entries[id(10)].parent_id, id(41));
  assert.equal(result.changes.length, 3); assert.strictEqual(result.state.documents, state.documents); assert.equal(state.entries[id(40)].name, 'C');
  const invalid = applyCommand(state, command('ReconcileEntries', { creates: [{ id: id(42), parent_id: rootId, kind: 'folder', name: 'C' }], moves: [] }), context);
  assert.equal(invalid.error.code, 'name_conflict'); assert.strictEqual(invalid.state, state);
  const reuse = applyCommand(result.state, command('ReconcileEntries', { creates: [{ id: id(41), parent_id: rootId, kind: 'folder', name: 'another' }], moves: [] }), context);
  assert.equal(reuse.error.code, 'already_exists'); assert.strictEqual(reuse.state, result.state);
  const docReuse = applyCommand(state, command('ReconcileEntries', { creates: [{ id: id(43), parent_id: rootId, kind: 'file', document_id: id(11), name: 'another.txt' }], moves: [] }), context);
  assert.equal(docReuse.error.code, 'already_exists'); assert.strictEqual(docReuse.state, state);
});

test('one incremental reconciliation creates 25001 entries in an already populated workspace', () => {
  const state = file(fresh());
  const creates = Array.from({ length: 25001 }, (_, n) => ({ id: id(n + 2000000), parent_id: rootId, kind: 'folder', name: `증가 ${n}`, x: n, y: -n }));
  const result = applyCommand(state, command('ReconcileEntries', { creates, moves: [] }), context);
  assert.equal(result.status, 'applied', JSON.stringify(result.error)); assert.equal(result.changes.length, 25001); assert.equal(Object.keys(result.state.entries).length, 25003);
  assert.equal(result.state.entries[id(2025000)].name, '증가 25000'); assert.equal(result.state.entries[id(2025000)].x, 25000); assert.equal(Object.keys(state.entries).length, 2);
});
