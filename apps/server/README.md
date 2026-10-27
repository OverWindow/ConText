# Unified workspace server

The v2 API runs the same `packages/contracts` parser and `packages/domain` commands as the desktop. PostgreSQL is an adapter, not a second implementation of editing rules. Existing Python APIs remain the authenticated compute/provider service; canonical edits go through the v2 command path.

## Run

```sh
cd apps/server
npm ci
# Load the selected environment without printing its credentials.
node --env-file=../../.env.development --import tsx src/main.ts
```

`UNIFIED_DATABASE_URL` (or `DATABASE_URL`) accepts PostgreSQL URLs, including the existing `postgresql+psycopg://` spelling. `UNIFIED_PORT` defaults to 8001. Native local development must use the host-reachable database URL; the Compose override supplies the container URL. Startup applies only additive `unified.*` DDL. It never resets a database or touches legacy workspace tables. The existing `public.users` table, when available, supplies the existing application user UUID; Supabase identities are retained.

The root `docker-compose.unified.yml` adds the Node server, the Python internal-worker settings and the browser v2 API URL. `INTERNAL_WORKER_TOKEN` must be a private random value shared only by Node and Python. Python validates private original downloads against its exact storage-host allowlist. There is no production deployment in this change.

## Authentication and persistence

- All `/v2/*` requests require an authenticated, non-anonymous Supabase JWT. HS256 is accepted only with the configured project secret; RS256/ES256 use that project's JWKS. Issuer, audience, subject, issued/expiry times, role and email are checked.
- Workspace membership is checked on every request. Read responses hide unknown/nonmember IDs behind the same 404. Owners manage membership and delete workspaces. Editors can edit; viewers can read.
- `unified.entities` stores portable typed JSONB with indexed workspace/collection/parent/name columns. A partial live sibling-name constraint supplements shared domain tree validation. NFC names remain case sensitive; incompatible native filesystems defer application rather than rename server data.
- Under a workspace row lock, the server executes named commands, persists only changed entities, inserts the exact operation receipt and publishes the next change sequence in one transaction. Global sequence allocation is deliberately avoided: uncommitted changes cannot be skipped by a committed cursor.
- `MoveEntries` and `ReconcileEntries` validate their final tree through the common domain. The PostgreSQL adapter replaces affected Entry rows inside that same transaction before bulk insertion, so immediate sibling-name uniqueness does not reject a valid A/B name swap or a rename followed by reuse of the old name. Entity UUIDs, references and external snapshot visibility remain stable; no temporary cloud names are published.
- Receipts are keyed by workspace/operation, actor and canonical request fingerprint. A lost response can be retried; reusing an ID for different content is rejected. Conflict results include the preserved candidate and appear in the same change stream.
- A repeatable-read bootstrap returns the complete canonical state plus its committed cursor. Entries and filename search use keyset pagination with no 2,000/25,000 cap. Import is an owner-only, empty-workspace, shared-domain command preserving UUIDs, histories and sources.
- Workspace deletion leaves a tombstone and increments the epoch. Old devices cannot republish or recreate that UUID. Authorized clients may still pull the deletion change. Device detach revokes only that binding. Original native folders are never accessed by this service.

## HTTP contract

Paths are relative to `/v2`; request/response JSON uses snake_case. `CommandEnvelope` and entities are exported by `packages/contracts/src/index.ts`.

| Method/path | Request | Response |
|---|---|---|
| GET `/me` | — | Existing app `{id,auth_user_id,email,display_name}` |
| GET `/workspaces` | — | `{workspaces:[Workspace & {role,cursor}]}` |
| POST `/workspaces` | `{id?,name,root_entry_id?}` | `{workspace}` |
| GET `/workspaces/:id/bootstrap` | — | `{workspace,state,cursor,epoch,role}` |
| POST `/workspaces/:id/devices` | `{device_id,name?,platform?}` | `{binding}` |
| GET `/workspaces/:id/devices` | — | `{devices}` |
| POST `/workspaces/:id/devices/:device/ack` | `{cursor}` | `{cursor,epoch}` |
| DELETE `/workspaces/:id/devices/:device` | — | `{detached:true}` |
| POST `/workspaces/:id/commands` | `{commands:CommandEnvelope[]}` (1–200, 8 MiB) | `{results,cursor,epoch}` |
| POST `/workspaces/:id/import` | One `ImportWorkspace` envelope (128 MiB) | Same command response |
| GET `/workspaces/:id/changes?after=0&limit=500` | — | `{changes:[{sequence,operation_id,changes,epoch}],cursor,has_more,epoch,deleted_at}` |
| GET `/workspaces/:id/entries?parent_id=&cursor=&limit=` | — | `{entries,next_cursor,has_more,workspace_cursor}` |
| GET `/workspaces/:id/search?q=&cursor=&limit=` | — | `{entries,next_cursor,has_more}` |
| GET `/workspaces/:id/conflicts` | — | `{conflicts}` |
| POST `/workspaces/:id/conflicts/:conflict/resolve` | Envelope fields plus `resolution`, optional `merged_content` | Same command response |
| DELETE `/workspaces/:id` | `operation_id,device_id,workspace_epoch,base_revisions` | Same command response |
| PUT `/workspaces/:id/members` | `{email,role:'EDITOR'|'VIEWER'}` | `{user_id,role}`; account signs in first |
| DELETE `/workspaces/:id/members/:user` | — | `{removed:true}` |
| POST `/workspaces/:id/blobs/prepare` | `BlobReference` | `{blob,already_uploaded,upload_url?,headers?}` |
| POST `/workspaces/:id/blobs/complete` | `{id}` | `{blob,verified:true}` |
| GET `/workspaces/:id/blobs/:blob/recovery` | — | Verified unpublished original; uploader or OWNER with current membership only |
| GET `/workspaces/:id/versions/:version/download` | — | `{url,expires_in,version}` |
| GET `/workspaces/:id/versions/:version/normalized` | — | `{state:'ready',normalized,text,artifact}` or pending/failed with job |
| GET `/workspaces/:id/versions/:version/content` | — | Existing `LocalDocument` presentation shape |
| POST `/workspaces/:id/versions/:version/processing` | `{request_id?,kind:'parse'|'convert',format?}` | 202 `{job}` |
| GET `/workspaces/:id/artifacts/:artifact/download` | — | `{artifact,url,expires_in}` |
| POST `/workspaces/:id/drafts/:draft/export` | `{revision,format}` | `{url,filename,expires_in}` |
| GET `/workspaces/:id/jobs/:request_id` | — | Durable `{request_id,status,result,error,...}` |
| POST `/workspaces/:id/ai/context` | `{request_id,task,prompt,sources?,session_id?,draft_id?,model?,connection?}` | Job; completed result includes `message_id` or `proposal_id,draft_id` |
| GET `/workspaces/:id/ai/search?q=&scope=auto&as_of=&limit=` | — | `{results,scope,as_of,warnings}`; current/history/KST date selection with version number and current-reference identity |
| GET `/workspaces/:id/ai/index-status` | — | `{jobs:[{kind,status,count}],ready}` |
| POST `/workspaces/:id/ai/reindex` | — | `{jobs}` |
| GET `/workspaces/:id/events` | Authenticated streaming fetch | SSE cursor hints; cursor pull is authoritative |

Command results are `{operation_id,status:'applied'|'conflict'|'rejected',sequence,changes,conflict_ids,error?}`. ACK does not prove another device applied its disk files. Clients must pull from their own last committed local cursor rather than jump directly to the POST response cursor.

## Private originals and compute

Originals are immutable `teams/unified/workspaces/:workspace/blobs/:blob` objects; derived outputs and exports use the same private `teams/` IAM prefix. Presigned PUTs require exact size, MIME, SHA-256, AES256 encryption, blob metadata and `If-None-Match:*`. Completion performs a storage HEAD and verifies all fields. The server independently matches every version/artifact blob against a verified same-workspace row before domain execution. JWTs are never sent to S3.

New immutable versions enqueue durable parse jobs in the editing transaction. The worker claims jobs with `SKIP LOCKED` and bounded leases/retries, calls Python `/internal/v2/process` with the internal token and a short-lived download URL, then uploads and verifies the derived bytes. It publishes `PutDerivedArtifact` through the same shared command transaction and stores PostgreSQL full-text search data. Python processing changes do not bypass the change stream.

AI requests forward the user's bearer token to existing `/api/ai/context`, retaining the existing per-user provider settings, quotas and request-ID billing deduplication. The Node job never stores the bearer token. A retry provides a fresh token; the same request returns the persisted provider result and deterministic common completion command. A completed chat/proposal travels to other devices through `CompleteAIRequest`.

When an AI request supplies no excerpts, the server captures bounded canonical document evidence. Natural-language instructions without an exact search match fall back to current reference-head excerpts. The captured source snapshots are stored with the request and reused on retry, even if workspace heads change. Draft generation records its starting `base_revision` (or `revision`) so a late proposal cannot overwrite later manual edits. Historical search includes immutable prior versions; `as_of` uses the end of the selected date in Asia/Seoul.

## Verification

Tests create a unique `unified_<uuid>_test` database and drop only that database in `finally`. `UNIFIED_TEST_ADMIN_URL` can select an isolated PostgreSQL admin connection; otherwise the selected development environment supplies host PostgreSQL credentials. Storage overrides are refused outside fixture mode and fixture mode refuses non-`_test` databases. No test writes real AWS resources.

```sh
# From repository root, launch a dedicated test-only Python + Moto service.
docker compose --env-file .env.development -f docker-compose.yml -f docker-compose.test.yml --profile test run -d --no-deps --name context-unified-compute-fixture -p 127.0.0.1:18002:18002 -p 127.0.0.1:15002:15002 -v "$PWD/backend:/app" -v "$PWD/apps/server/tests:/fixture:ro" backend-test python /fixture/compute_fixture.py
cd apps/server
npm run typecheck
UNIFIED_TEST_S3_ENDPOINT=http://127.0.0.1:15002 UNIFIED_TEST_PROCESSOR_URL=http://127.0.0.1:18002 node --env-file=../../.env.development --import tsx --test tests/*.test.ts
```

Coverage includes real PostgreSQL ordering/concurrent conflict preservation, idempotent lost-response replay, membership/role revocation/deletion epoch, private S3 signed HTTP upload/download/checksum validation, 25,001-entry import and complete sibling pagination, and real Python normalization/index/convert/export. Processor tests skip explicitly when no compute fixture URL is configured.

Retention/GC is intentionally conservative: no hard deletion of originals, tombstones, source snapshots or conflicts. Search currently uses PostgreSQL full text and substring matching over canonical parsed text; semantic embeddings can be added behind this same artifact boundary. Browser offline editing is outside the first online browser cutover.

Worker parse/convert/export contracts are generated from `packages/contracts/schema/worker-v2.json`. Run root `npm run contracts:generate` after schema changes and `npm run contracts:check` before verification; TypeScript and Python consume the generated envelopes and the same accepted/rejected fixtures.
