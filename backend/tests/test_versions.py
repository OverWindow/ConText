# Shared pytest fixtures are intentionally shadowed by fixture parameters.
# ruff: noqa: F811
import hashlib
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import func, select

from app.api import processing as processing_api
from app.api import versions as routes
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.domain import Role, WorkspaceMember
from app.models.processing import DocumentProcessing, ProcessingState
from app.processing import engine
from tests.test_documents import (  # noqa: F401
    BODY,
    complete,
    create,
    metadata,
    put,
    s3_server,
    storage,
    upload,
)
from tests.test_foundation import headers


@pytest.fixture
def scene(client, upload, storage, monkeypatch):  # noqa: F811
    monkeypatch.setattr(routes, "get_storage", lambda: storage)
    monkeypatch.setattr(engine, "get_storage", lambda: storage)
    monkeypatch.setattr(processing_api, "get_storage", lambda: storage)
    auth, workspace, first = upload
    assert put(first).status_code == 200
    assert complete(client, auth, first).status_code == 200
    return auth, workspace, first


def version_data(body=b"new version", **extra):
    return {
        "request_id": str(uuid4()),
        "filename": "수정본.txt",
        "size": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "change_note": "가격 정책 수정",
        **extra,
    }


def new_version(client, auth, document_id, body=b"new version", **extra):
    return client.post(
        f"/api/documents/{document_id}/versions/upload-url",
        headers=auth,
        json=version_data(body, **extra),
    )


def upload_body(client, auth, ticket, body):
    assert (
        httpx.put(ticket["upload_url"], headers=ticket["headers"], content=body).status_code == 200
    )
    response = complete(client, auth, ticket)
    assert response.status_code == 200, response.text
    return response.json()


def test_versions_current_comparison_and_late_completion(client, db, scene):
    auth, _, first = scene
    doc = first["document_id"]
    second = new_version(client, auth, doc).json()
    third = new_version(client, auth, doc, b"third version").json()
    assert len(client.get(f"/api/documents/{doc}", headers=auth).json()["versions"]) == 3
    current_url = f"/api/documents/{doc}/current-version"
    assert (
        client.patch(
            current_url, headers=auth, json={"version_id": second["version_id"]}
        ).status_code
        == 409
    )
    result = upload_body(client, auth, third, b"third version")
    assert result["current_version_id"] == first["version_id"]
    assert (
        client.patch(
            current_url, headers=auth, json={"version_id": third["version_id"]}
        ).status_code
        == 200
    )
    result = upload_body(client, auth, second, b"new version")
    assert result["current_version_id"] == third["version_id"]
    assert [v["version_number"] for v in result["versions"]] == [1, 2, 3]
    assert result["versions"][1]["change_note"] == "가격 정책 수정"
    assert result["versions"][1]["author_name"]
    compare_url = (
        f"/api/documents/{doc}/compare?left={first['version_id']}&right={second['version_id']}"
    )
    comparison = client.get(compare_url, headers=auth)
    assert comparison.status_code == 200
    assert comparison.json()["identical"] is False
    assert comparison.headers["cache-control"] == "no-store"
    assert "storage_key" not in comparison.json()["left"]
    assert (
        client.get(
            f"/api/documents/{doc}/compare?left={first['version_id']}&right={first['version_id']}",
            headers=auth,
        ).status_code
        == 422
    )
    assert (
        client.patch(current_url, headers=auth, json={"version_id": first["version_id"]}).json()[
            "current_version_id"
        ]
        == first["version_id"]
    )
    for ticket in [first, second, third]:
        assert (
            db.get(DocumentProcessing, UUID(ticket["version_id"])).state == ProcessingState.QUEUED
        )


def test_concurrent_allocation_request_retry_and_exact_duplicates(client, db, scene):
    auth, workspace, first = scene
    doc = first["document_id"]
    data = version_data()
    path = f"/api/documents/{doc}/versions/upload-url"
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: client.post(path, headers=auth, json=data), range(8)))
    assert all(r.status_code == 201 for r in responses)
    assert len({r.json()["version_id"] for r in responses}) == 1
    assert (
        client.post(path, headers=auth, json={**data, "change_note": "changed"}).status_code == 409
    )
    assert new_version(client, auth, doc).status_code == 409
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(
            pool.map(lambda n: new_version(client, auth, doc, f"body {n}".encode()), range(4))
        )
    assert all(r.status_code == 201 for r in results)
    assert [
        v.version_number
        for v in db.scalars(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == UUID(doc))
            .order_by(DocumentVersion.version_number)
        )
    ] == list(range(1, 7))
    digest = hashlib.sha256(BODY).hexdigest()
    duplicates = client.get(
        f"/api/workspaces/{workspace}/duplicates?sha256={digest}&size={len(BODY)}", headers=auth
    )
    assert len(duplicates.json()) == 1
    assert duplicates.json()[0]["version"]["id"] == first["version_id"]
    assert (
        client.get(
            f"/api/workspaces/{workspace}/duplicates?sha256={digest}&size=1", headers=auth
        ).json()
        == []
    )
    assert (
        client.get(
            f"/api/workspaces/{workspace}/duplicates?sha256=bad&size=1", headers=auth
        ).status_code
        == 422
    )
    assert new_version(client, auth, doc, BODY).status_code == 409


def test_manual_link_keeps_original_and_processes_independently(client, db, scene, storage):  # noqa: F811
    auth, workspace, first = scene
    other = create(
        client,
        auth,
        workspace,
        metadata(
            filename="source.md",
            title="원본 문서",
            size=11,
            sha256=hashlib.sha256(b"source text").hexdigest(),
        ),
    ).json()
    assert (
        client.post(
            f"/api/documents/{first['document_id']}/versions/link",
            headers=auth,
            json={"request_id": str(uuid4()), "source_version_id": other["version_id"]},
        ).status_code
        == 409
    )
    upload_body(client, auth, other, b"source text")
    data = {
        "request_id": str(uuid4()),
        "source_version_id": other["version_id"],
        "change_note": "수동 연결",
    }
    path = f"/api/documents/{first['document_id']}/versions/link"
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: client.post(path, headers=auth, json=data), range(4)))
    assert all(r.status_code == 201 for r in results)
    result = results[0].json()
    linked = result["versions"][-1]
    assert len(result["versions"]) == 2
    assert linked["source_version_id"] == other["version_id"]
    assert result["current_version_id"] == first["version_id"]
    source = db.get(DocumentVersion, UUID(other["version_id"]))
    version = db.get(DocumentVersion, UUID(linked["id"]))
    assert source.storage_key == version.storage_key
    assert (
        client.get(f"/api/documents/{other['document_id']}", headers=auth).json()[
            "current_version_id"
        ]
        == other["version_id"]
    )
    assert client.post(f"/api/versions/{linked['id']}/upload-url", headers=auth).status_code == 409
    url = client.post(f"/api/versions/{linked['id']}/download-url", headers=auth).json()[
        "download_url"
    ]
    assert httpx.get(url).content == b"source text"
    engine.run(linked["id"])
    assert (
        client.get(f"/api/versions/{linked['id']}/content", headers=auth).json()["blocks"][0][
            "text"
        ]
        == "source text"
    )
    db.expire_all()
    assert db.get(DocumentVersion, source.id).status == VersionStatus.UPLOADED
    assert db.get(DocumentVersion, version.id).status == VersionStatus.READY
    assert (
        client.post(path, headers=auth, json={**data, "request_id": str(uuid4())}).status_code
        == 409
    )
    assert (
        client.post(path, headers=auth, json={**data, "change_note": "다른 메모"}).status_code
        == 409
    )
    assert db.scalar(select(func.count()).select_from(Document)) == 2


@pytest.mark.parametrize("role", [Role.VIEWER, Role.EDITOR])
def test_permissions_and_cross_document_workspace_isolation(client, db, scene, role):
    auth, workspace, first = scene
    member, stranger = headers(), headers()
    user = client.get("/api/me", headers=member).json()["id"]
    db.add(WorkspaceMember(workspace_id=UUID(workspace), user_id=UUID(user), role=role))
    db.commit()
    second = new_version(client, auth, first["document_id"]).json()
    upload_body(client, auth, second, b"new version")
    base = f"/api/documents/{first['document_id']}"
    endpoints = [
        ("POST", base + "/versions/upload-url", version_data(b"other")),
        (
            "POST",
            base + "/versions/link",
            {"request_id": str(uuid4()), "source_version_id": second["version_id"]},
        ),
        ("PATCH", base + "/current-version", {"version_id": second["version_id"]}),
    ]
    for method, path, data in endpoints:
        assert client.request(method, path, json=data).status_code == 401
        assert client.request(method, path, json=data, headers=stranger).status_code == 404
        if role == Role.VIEWER:
            assert client.request(method, path, json=data, headers=member).status_code == 403
    if role == Role.EDITOR:
        assert (
            client.patch(
                base + "/current-version", headers=member, json={"version_id": second["version_id"]}
            ).status_code
            == 200
        )
    compare = base + f"/compare?left={first['version_id']}&right={second['version_id']}"
    assert client.get(compare, headers=member).status_code == 200
    assert client.get(compare, headers=stranger).status_code == 404
    digest = hashlib.sha256(BODY).hexdigest()
    duplicates = f"/api/workspaces/{workspace}/duplicates?sha256={digest}&size={len(BODY)}"
    assert client.get(duplicates, headers=member).status_code == 200
    assert client.get(duplicates, headers=stranger).status_code == 404
    other_ws = client.post("/api/workspaces", headers=auth, json={"name": "Other"}).json()["id"]
    source = create(client, auth, other_ws).json()
    assert put(source).status_code == 200
    assert complete(client, auth, source).status_code == 200
    assert (
        client.post(
            base + "/versions/link",
            headers=auth,
            json={"request_id": str(uuid4()), "source_version_id": source["version_id"]},
        ).status_code
        == 404
    )
    assert (
        client.patch(
            base + "/current-version", headers=auth, json={"version_id": source["version_id"]}
        ).status_code
        == 404
    )
    assert (
        client.get(
            base + f"/compare?left={first['version_id']}&right={source['version_id']}", headers=auth
        ).status_code
        == 404
    )


def test_failed_unverified_upload_can_be_replaced_and_first_valid_version_becomes_current(
    client,
    db,
    upload,
    storage,
    monkeypatch,  # noqa: F811
):  # noqa: F811
    monkeypatch.setattr(routes, "get_storage", lambda: storage)
    auth, workspace, first = upload
    original = db.get(DocumentVersion, UUID(first["version_id"]))
    original.status = VersionStatus.FAILED
    db.commit()
    replacement = new_version(client, auth, first["document_id"], BODY).json()
    result = upload_body(client, auth, replacement, BODY)
    assert result["current_version_id"] == replacement["version_id"]
    assert result["versions"][-1]["version_number"] == 2
