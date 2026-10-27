# Canonical workspace domain v2

`src/index.ts` is pure TypeScript shared by desktop SQLite and the Node/PostgreSQL service. It imports no browser, Node, clock, random, filesystem, SQL or network APIs. `packages/contracts/src/index.ts` defines the exact portable wire fields and validates untrusted commands.

```ts
const result = applyCommand(state, envelope, {
  actor_id: authenticatedUser.id,
  role: membership.role,
  now: transactionTimestamp,
  available_blobs: verifiedBlobIds,
});
```

`applyCommand` never mutates `state` or the supplied command. Its result has `status`, `state`, `changes`, `conflict_ids`, and an optional typed `error`. The adapter must authorize the actor, load a complete relevant state, call the domain inside its storage transaction, persist `changes` together with an operation receipt and ordered change sequence, and ACK only after commit. Client-reported actor IDs and upload metadata are not authority. Verified blob IDs must come from server records whose SHA-256, size and MIME metadata match the supplied `BlobReference`.

Existing entity changes require `base_revisions["collection:uuid"]`. Position changes use `entry_positions:uuid`, separate from entry name/parent revisions. Appending independent immutable versions/messages needs no entity overwrite. A stale content-head append retains the version as a branch and stores a conflict. Stale draft saves retain their incoming content/sources/review as a pending proposal. A missing base is a rejected malformed command, rather than an implicit overwrite. Unchanged collection maps retain their object identity.

`MoveEntries` applies a set of parent/name changes atomically after validating every base revision and the final tree. A safe `A.txt` ↔ `B.txt` swap therefore succeeds without temporary portable filenames; cyclic moves or stale bases preserve the original tree. PostgreSQL adapters must persist the corresponding name-index changes in the same transaction without checking intermediate swapped names as final state.

`ReconcileEntries` additionally creates new entries/documents and moves existing entries against one final tree. It rejects all reused Entry/Document UUIDs, including trash, and requires CAS for existing moves. This supports an external rename of old `C` to `D`, a replacement folder `C`, and an existing file moved into the new folder in one transaction. Incremental bulk scans emit one command and one persistence pass rather than saving the full workspace once per new entry. Native physical paths stay in the local mapping; reconciliation carries portable IDs, parents and names only.

Chat messages retain optional lifecycle metadata and a revision. `UpdateChatMessage` requires CAS and preserves author/session/role/creation identity; it supports queued, running, failed, completed and retry transitions. Completed content remains immutable. Draft history entries retain their review/check snapshots. Native adapters capture their saved rows and common outbox within the same SQLite transaction; filesystem application is separately protected by a durable journal and observed-version mapping.

`ImportWorkspace` is an owner-only initial command into a root-only workspace. It requires the same workspace/root/epoch and the target workspace revision. Strict portable schemas, full tree/version DAG/ownership/source checks and verified blob checks run before one set of patches is emitted. Entity IDs, revisions, document histories, draft histories, pending proposals, quotes and chat messages survive import. The import walks the state in linear passes rather than invoking 25,000 per-entry commands. It is not an arbitrary patch API.

`TrashEntry` soft-deletes the selected subtree and requires every affected entry/document revision. A folder delete based on an old offline subtree therefore cannot silently erase later edits. `RestoreEntry` restores one entry and its linked document; children are restored explicitly. Immutable versions and source quotations remain. `DeleteWorkspace` requires OWNER and workspace revision, increments the deletion epoch and creates a tombstone; stale devices cannot recreate it. Device file deletion and source-file handling remain native adapter responsibilities.

`sourceAvailability` resolves snapshots to `available`, `deleted`, `missing` or `mismatched`. Quotes with missing/deleted originals remain valid saved evidence. A mismatched live document/version, note/scope or chat/session link is rejected.

`applyChanges` replays trusted canonical patches; adapters must combine replay with cursor persistence in one local transaction. Server operation ID receipts implement retry idempotency. The core deliberately does not own receipts, server sequences, blob upload transport, pending overlays, filesystem journals or authentication.

Tests: `node --experimental-strip-types --test packages/contracts/tests/*.test.mjs packages/domain/tests/*.test.mjs` from the repository root.
