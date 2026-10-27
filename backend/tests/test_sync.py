import hashlib
import json
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import func, select

from app.api import sync as routes
from app.core.config import get_settings
from app.models.documents import DocumentVersion
from app.models.sync import SyncBinding, SyncOperation, SyncSession, SyncSessionItem
from app.services.sync import cleanup
from tests.test_documents import s3_server, storage  # noqa: F401
from tests.test_foundation import headers


def wire(records):
    items, digest = [], hashlib.sha256()
    for kind, key, payload in records:
        content = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        fingerprint = hashlib.sha256(content.encode()).hexdigest()
        items.append(
            {"ordinal": len(items), "entity_type": kind, "entity_id": key, "content": content}
        )
        digest.update(f"{kind}:{key}:{fingerprint}\n".encode())
    return items, digest.hexdigest()


def test_bulk_body_is_bounded_before_decoding_even_without_content_length(client):
    path = f"/api/sync-sessions/{uuid4()}/items"
    assert client.put(path, content=b"x" * (4 * 1024**2 + 1)).status_code == 413
    assert (
        client.put(path, content=iter([b"x" * (3 * 1024**2), b"x" * (2 * 1024**2)])).status_code
        == 413
    )


def manifest(body=b"# document\n"):
    root, folder, doc, version, other, binary = [str(uuid4()) for _ in range(6)]
    records = [
        ("entry", root, {"parent_id": None, "kind": "directory", "name": "작업 폴더"}),
        ("scope", root, {"folder_entry_id": root}),
        (
            "entry",
            folder,
            {"parent_id": root, "kind": "directory", "name": "기획", "x": 50, "y": 80},
        ),
        ("scope", folder, {"folder_entry_id": folder}),
        (
            "entry",
            doc,
            {
                "parent_id": folder,
                "kind": "file",
                "name": "요구사항.md",
                "document_id": doc,
                "x": 120,
                "y": 240,
            },
        ),
        (
            "document",
            doc,
            {
                "title": "요구사항",
                "current_version_id": version,
                "file_version_id": version,
                "revision": 2,
            },
        ),
        (
            "version",
            version,
            {
                "document_id": doc,
                "version_number": 1,
                "filename": "요구사항.md",
                "size": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
                "created_at": 1700000000000,
            },
        ),
        (
            "entry",
            other,
            {"parent_id": folder, "kind": "file", "name": "빈파일.bin", "document_id": other},
        ),
        (
            "document",
            other,
            {
                "title": "빈파일",
                "current_version_id": binary,
                "file_version_id": binary,
                "revision": 1,
            },
        ),
        (
            "version",
            binary,
            {
                "document_id": other,
                "version_number": 1,
                "filename": "빈파일.bin",
                "size": 0,
                "sha256": hashlib.sha256(b"").hexdigest(),
                "created_at": 1700000000000,
            },
        ),
    ]
    element = str(uuid4())
    records.append(
        (
            "element",
            element,
            {
                "id": element,
                "scope_id": folder,
                "kind": "text",
                "text": "메모",
                "x": 600,
                "y": 0,
                "width": 320,
                "height": 180,
                "revision": 1,
            },
        )
    )
    records.append(
        (
            "relation",
            str(uuid4()),
            {
                "scope_id": folder,
                "source_document_id": doc,
                "target_document_id": other,
                "revision": 1,
            },
        )
    )
    records.append(
        (
            "draft",
            str(uuid4()),
            {
                "content": {
                    "title": "초안",
                    "blocks": [{"id": "p1", "type": "paragraph", "text": "작성 중"}],
                },
                "sources": [],
                "checks": [],
                "revision": 3,
            },
        )
    )
    return records, {version: body, binary: b""}, (root, folder, doc, version)


@pytest.fixture
def cloud(client, storage, monkeypatch):  # noqa: F811 - pytest fixture injection
    monkeypatch.setattr(routes, "get_storage", lambda: storage)
    auth = headers()
    origin = {
        "device_id": str(uuid4()),
        "local_workspace_id": str(uuid4()),
        "name": "클라우드 폴더",
    }
    binding = client.post("/api/sync/bindings", headers=auth, json=origin)
    assert binding.status_code == 200, binding.text
    assert client.post("/api/sync/bindings", headers=auth, json=origin).json() == binding.json()
    return auth, binding.json(), storage


def start(client, cloud, records, revision=0, request=None):
    auth, binding, _ = cloud
    items, digest = wire(records)
    body = {
        "binding_id": binding["id"],
        "generation": binding["generation"],
        "request_id": request or str(uuid4()),
        "base_revision": revision,
        "source_sequence": 12,
        "item_count": len(items),
        "manifest_hash": digest,
    }
    response = client.post(
        f"/api/workspaces/{binding['workspace_id']}/sync-sessions", headers=auth, json=body
    )
    assert response.status_code == 200, response.text
    return response.json(), items, body


def prepare(client, cloud, session, items, blobs):
    auth, _, _ = cloud
    response = client.put(
        f"/api/sync-sessions/{session['id']}/items", headers=auth, json={"items": items}
    )
    assert response.status_code == 200, response.text
    for ticket in response.json()["uploads"]:
        put = httpx.put(
            ticket["upload_url"], headers=ticket["headers"], content=blobs[ticket["version_id"]]
        )
        assert put.status_code in (200, 412), put.text
    ordinals = [ticket["ordinal"] for ticket in response.json()["uploads"]]
    if ordinals:
        result = client.post(
            f"/api/sync-sessions/{session['id']}/uploads/complete",
            headers=auth,
            json={"ordinals": ordinals},
        )
        assert result.status_code == 200, result.text
    return response.json()


def publish(client, cloud, session):
    return client.post(f"/api/sync-sessions/{session['id']}/commit", headers=cloud[0])


def test_workspace_delete_blocks_stale_publish_rebind_and_private_document_reads(client, cloud, db):
    records, blobs, (_, _, doc, version) = manifest()
    session, items, _ = start(client, cloud, records)
    prepare(client, cloud, session, items, blobs)
    assert publish(client, cloud, session).status_code == 200
    auth, binding, _ = cloud
    pending, pending_items, body = start(client, cloud, records, revision=1)
    prepare(client, cloud, pending, pending_items, blobs)
    path = f"/api/workspaces/{binding['workspace_id']}"
    assert client.delete(path, headers=auth).status_code == 204
    db.expire_all()
    deleted = db.get(SyncBinding, UUID(binding["id"]))
    assert deleted.state == "DELETED"
    assert deleted.generation == binding["generation"] + 1
    assert db.get(SyncSession, UUID(pending["id"])).state == "CANCELLED"
    assert publish(client, cloud, pending).status_code == 410
    assert client.post(path + "/sync-sessions", headers=auth, json=body).status_code == 410
    assert client.get(f"/api/sync/bindings/{binding['id']}", headers=auth).status_code == 410
    for method, suffix in [("get", f"/documents/{doc}"), ("get", f"/versions/{version}/content"),
                           ("post", f"/versions/{version}/download-url")]:
        assert getattr(client, method)("/api" + suffix, headers=auth).status_code == 404
    rebound = client.post("/api/sync/bindings", headers=auth, json={
        "device_id": str(deleted.device_id), "local_workspace_id": str(deleted.local_workspace_id),
        "name": "Must not resurrect",
    })
    assert rebound.status_code == 410
    assert client.get("/api/workspaces", headers=auth).json() == []


def test_full_snapshot_is_atomic_idempotent_and_web_readable(client, cloud, db):
    records, blobs, (root, folder, doc, version) = manifest()
    session, items, body = start(client, cloud, records)
    auth, binding, _ = cloud
    workspace = binding["workspace_id"]
    assert (
        client.get(f"/api/workspaces/{workspace}/sync-view", headers=auth).json()["revision"] == 0
    )
    assert publish(client, cloud, session).status_code == 409
    prepare(client, cloud, session, items, blobs)
    staged = db.scalar(
        select(SyncSessionItem).where(
            SyncSessionItem.session_id == UUID(session["id"]),
            SyncSessionItem.storage_key.is_not(None),
        )
    )
    assert staged.storage_key.startswith("teams/") and "/sync-uploads/" in staged.storage_key
    assert client.get(f"/api/workspaces/{workspace}/documents", headers=auth).json() == []
    result = publish(client, cloud, session)
    assert result.status_code == 200, result.text
    assert result.json()["revision"] == 1
    assert publish(client, cloud, session).json() == result.json()
    assert (
        client.post(f"/api/workspaces/{workspace}/sync-sessions", headers=auth, json=body).json()[
            "state"
        ]
        == "COMMITTED"
    )
    assert db.scalar(select(func.count()).select_from(SyncOperation)) == 1
    view = client.get(
        f"/api/workspaces/{workspace}/sync-view?scope_id={folder}", headers=auth
    ).json()
    assert [entry["id"] for entry in view["breadcrumbs"]] == [root, folder]
    assert len(view["entries"]) == 2 and view["elements"][0]["text"] == "메모"
    assert len(view["relations"]) == 1 and view["drafts"][0]["title"] == "초안"
    scene = client.get(f"/api/workspaces/{workspace}/sync-scene", headers=auth)
    assert scene.status_code == 200, scene.text
    assert scene.json()["total"] == 3
    assert any(entry["relative_path"] == "기획/요구사항.md" for entry in scene.json()["entries"])
    assert next(e for e in view["entries"] if e["id"] == doc)["x"] == 120
    document = client.get(f"/api/documents/{doc}", headers=auth).json()
    assert document["current_version_id"] == version
    assert (
        client.patch(
            f"/api/documents/{doc}/current-version", headers=auth, json={"version_id": version}
        ).status_code
        == 409
    )
    ticket = client.post(f"/api/versions/{version}/download-url", headers=auth).json()
    assert httpx.get(ticket["download_url"]).content == blobs[version]
    assert db.get(DocumentVersion, UUID(version)).id == UUID(version)


def test_next_snapshot_reuses_bytes_and_keeps_old_view_until_commit(client, cloud):
    records, blobs, (_, folder, doc, _) = manifest()
    session, items, _ = start(client, cloud, records)
    prepare(client, cloud, session, items, blobs)
    assert publish(client, cloud, session).status_code == 200
    changed = [
        (kind, key, {**p, "name": "바뀐이름.md", "x": 999} if kind == "entry" and key == doc else p)
        for kind, key, p in records
    ]
    session, items, _ = start(client, cloud, changed, revision=1)
    result = prepare(client, cloud, session, items, blobs)
    assert result["uploads"] == []
    path = f"/api/workspaces/{cloud[1]['workspace_id']}/sync-view?scope_id={folder}"
    assert any(
        e["name"] == "요구사항.md" for e in client.get(path, headers=cloud[0]).json()["entries"]
    )
    assert publish(client, cloud, session).status_code == 200
    assert any(
        e["name"] == "바뀐이름.md" for e in client.get(path, headers=cloud[0]).json()["entries"]
    )
    assert client.get(path + "&revision=1", headers=cloud[0]).status_code == 409


def test_isolation_generation_and_cancel(client, cloud):
    records, blobs, _ = manifest()
    session, items, _ = start(client, cloud, records)
    path = f"/api/sync-sessions/{session['id']}"
    assert client.get(path).status_code == 401
    assert client.get(path, headers=headers()).status_code == 404
    assert client.put(path + "/items", headers=headers(), json={"items": items}).status_code == 404
    assert (
        client.delete(f"/api/sync/bindings/{cloud[1]['id']}", headers=cloud[0]).status_code == 200
    )
    assert publish(client, cloud, session).status_code == 409


def test_malformed_manifest_and_immutable_versions_are_rejected(client, cloud):
    records, blobs, (root, folder, _, _) = manifest()
    records[2][2]["parent_id"] = folder
    session, items, _ = start(client, cloud, records)
    prepare(client, cloud, session, items, blobs)
    assert publish(client, cloud, session).status_code == 422
    assert (
        client.get(
            f"/api/workspaces/{cloud[1]['workspace_id']}/sync-view", headers=cloud[0]
        ).json()["revision"]
        == 0
    )
    tampered = {**items[0], "content": items[0]["content"].replace("작업 폴더", "다른 이름")}
    assert (
        client.put(
            f"/api/sync-sessions/{session['id']}/items",
            headers=cloud[0],
            json={"items": [tampered]},
        ).status_code
        == 409
    )


def test_expired_cleanup_preserves_published_objects(client, cloud, db):
    records, blobs, _ = manifest()
    session, items, _ = start(client, cloud, records)
    prepare(client, cloud, session, items, blobs)
    assert publish(client, cloud, session).status_code == 200
    session2, items2, _ = start(client, cloud, records, revision=1)
    prepare(client, cloud, session2, items2, blobs)
    row = db.get(SyncSession, UUID(session2["id"]))
    row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.commit()
    assert publish(client, cloud, session2).status_code == 410
    cleanup(db, cloud[2])
    assert db.get(SyncSession, UUID(session2["id"])).state == "EXPIRED"
    for version in db.scalars(select(DocumentVersion)).all():
        assert (
            cloud[2].client.head_object(Bucket=version.storage_bucket, Key=version.storage_key)[
                "ContentLength"
            ]
            == version.size
        )


def test_missing_delete_permission_defers_cleanup_without_deleting_or_repeating(
    client, cloud, db, monkeypatch
):
    from botocore.exceptions import ClientError

    records, blobs, _ = manifest()
    session, items, _ = start(client, cloud, records)
    prepare(client, cloud, session, items, blobs)
    row = db.get(SyncSession, UUID(session["id"]))
    row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.commit()
    attempts = []

    def denied(**kwargs):
        attempts.append(kwargs["Key"])
        raise ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "test permission denied"}}, "DeleteObject"
        )

    monkeypatch.setattr(cloud[2].client, "delete_object", denied)
    cleanup(db, cloud[2])
    cleanup(db, cloud[2])
    assert db.get(SyncSession, UUID(session["id"])).state == "CLEANUP_BLOCKED"
    assert len(attempts) == 1


def test_unknown_payload_fields_and_quota(client, cloud, monkeypatch):
    records, blobs, _ = manifest()
    session, items, _ = start(client, cloud, records)
    p = json.loads(items[0]["content"])
    p["root"] = "/Users/private"
    invalid = {**items[0], "content": json.dumps(p)}
    assert (
        client.put(
            f"/api/sync-sessions/{session['id']}/items", headers=cloud[0], json={"items": [invalid]}
        ).status_code
        == 422
    )
    monkeypatch.setattr(get_settings(), "sync_max_workspace_bytes", 1)
    assert (
        client.put(
            f"/api/sync-sessions/{session['id']}/items", headers=cloud[0], json={"items": items}
        ).status_code
        == 413
    )
