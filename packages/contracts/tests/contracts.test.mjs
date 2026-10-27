import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand, validateSourceSnapshot, validatePortableName, validateBlob, ContractError } from '../src/index.ts';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const command = () => ({ schema_version: 2, operation_id: id(1), workspace_id: id(2), device_id: id(3), workspace_epoch: 0, type: 'CreateEntry', payload: { id: id(4), parent_id: id(5), kind: 'folder', name: '폴더' } });

test('only named protocol-2 commands with portable UUID identities are accepted', () => {
  assert.equal(validateCommand(command()).type, 'CreateEntry');
  for (const mutate of [c => { c.schema_version = 1; }, c => { c.type = 'PatchTable'; c.payload = { table: 'documents' }; }, c => { c.actor_id = id(9); }, c => { c.payload.root_path = '/private/home'; }, c => { c.payload.id = '../bad'; }, c => { c.workspace_epoch = -1; }, c => { c.base_revisions = { 'entries:not-uuid': 1 }; }]) {
    const candidate = command(); mutate(candidate); assert.throws(() => validateCommand(candidate), ContractError);
  }
});

test('portable names reject traversal and preserve explicit OS conflicts for adapters', () => {
  for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b', 'bad\0name', 'bad\nname', 'e\u0301']) assert.throws(() => validatePortableName(name), ContractError);
  for (const name of ['한글.md', 'CON', 'Case.txt', 'case.txt', '끝.']) assert.equal(validatePortableName(name), name);
});

test('mixed snapshots preserve exact quotes and JSON metadata with strict kind references', () => {
  const base = { id: id(10), quote: '인용\n정확히', label: '출처', metadata: { legacy_id: 'note:abc', content: { marks: ['bold'] } } };
  const sources = [
    { ...base, kind: 'document', document_id: id(11), version_id: id(12), chunk_id: 'chunk-1' },
    { ...base, kind: 'note', element_id: id(13), scope_id: id(14) },
    { ...base, kind: 'chat', session_id: id(15), message_id: id(16) },
    { ...base, kind: 'draft', draft_id: id(17), history_id: id(18) },
  ];
  for (const source of sources) assert.deepEqual(validateSourceSnapshot(source), source);
  assert.throws(() => validateSourceSnapshot({ ...sources[1], document_id: id(11) }), ContractError);
  assert.throws(() => validateSourceSnapshot({ ...sources[0], quote: undefined }), ContractError);
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => validateSourceSnapshot({ ...sources[0], metadata: cyclic }), ContractError);
});

test('empty blobs are valid and SHA/size/MIME constraints reject corrupt upload metadata', () => {
  const blob = { id: id(1), sha256: 'a'.repeat(64), size: 0, mime_type: 'application/octet-stream' }; assert.deepEqual(validateBlob(blob), blob);
  for (const change of [{ size: -1 }, { size: Number.MAX_SAFE_INTEGER + 1 }, { sha256: 'bad' }, { mime_type: 'text/plain\r\nAuthorization:x' }]) assert.throws(() => validateBlob({ ...blob, ...change }), ContractError);
});

test('invalid coordinates, source duplication and prototype JSON cannot cross the wire', () => {
  const pos = { ...command(), type: 'SetEntryPositions', payload: { positions: [{ id: id(1), x: NaN, y: 0 }] } }; assert.throws(() => validateCommand(pos), ContractError);
  const proto = JSON.parse('{"__proto__":{"root":"/private"}}'); const source = { id: id(10), kind: 'draft', draft_id: id(11), label: '', quote: 'q', metadata: proto }; assert.throws(() => validateSourceSnapshot(source), ContractError);
  const snapshot = { id: id(10), kind: 'draft', draft_id: id(11), label: '', quote: 'q' };
  assert.throws(() => validateCommand({ ...command(), type: 'SaveDraft', payload: { id: id(12), title: '', content: '', sources: [snapshot, snapshot] } }), ContractError);
});
