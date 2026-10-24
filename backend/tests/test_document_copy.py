# ruff: noqa: F401, F811
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import func, select

from app.models.canvas import DocumentPosition
from app.models.documents import Document, DocumentVersion
from app.models.domain import Role, WorkspaceMember
from app.models.processing import DocumentProcessing, ProcessingState
from app.processing import engine
from tests.test_documents import BODY, complete, create, put, s3_server, storage, upload
from tests.test_foundation import headers
from tests.test_versions import scene


def payload(ticket, **changes):
    return {
        "request_id": str(uuid4()),
        "version_id": ticket["version_id"],
        "x": 300,
        "y": 40,
        **changes,
    }


def copy(client, auth, ticket, data=None):
    return client.post(
        f"/api/documents/{ticket['document_id']}/copy", headers=auth, json=data or payload(ticket)
    )


def test_copy_preserves_bytes_content_and_independent_identity(client, db, scene):
    auth, workspace, first = scene
    engine.run(first["version_id"])
    response = copy(client, auth, first)
    assert response.status_code == 201, response.text
    result = response.json()
    doc = result["document"]
    version = doc["versions"][0]
    assert doc["id"] != first["document_id"]
    assert doc["title"] == "Notes copy"
    assert version["original_filename"] == "노트 copy.md"
    assert version["version_number"] == 1
    assert version["status"] == "READY"
    assert version["source_version_id"] == first["version_id"]
    assert doc["current_version_id"] == version["id"]
    original_content = client.get(f"/api/versions/{first['version_id']}/content", headers=auth)
    copied_content = client.get(f"/api/versions/{version['id']}/content", headers=auth)
    assert copied_content.status_code == 200
    assert copied_content.json() == original_content.json()
    download = client.post(f"/api/versions/{version['id']}/download-url", headers=auth).json()
    assert httpx.get(download["download_url"]).content == BODY
    position = db.get(DocumentPosition, UUID(doc["id"]))
    assert (position.x, position.y) == (300, 40)
    snapshot = client.get(f"/api/workspaces/{workspace}/canvas", headers=auth).json()
    assert len(snapshot["documents"]) == 2
    assert any(item["document_id"] == doc["id"] for item in snapshot["positions"])
    original = client.get(f"/api/documents/{first['document_id']}", headers=auth).json()
    assert original["current_version_id"] == first["version_id"]
    assert len(original["versions"]) == 1


def test_copy_idempotency_concurrent_names_and_unready_processing(client, db, scene):
    auth, _, first = scene
    data = payload(first)
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: copy(client, auth, first, data), range(4)))
    assert all(response.status_code == 201 for response in responses)
    assert len({response.json()["document"]["id"] for response in responses}) == 1
    copied = responses[0].json()["document"]
    assert (
        db.get(DocumentProcessing, UUID(copied["current_version_id"])).state
        == ProcessingState.QUEUED
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: copy(client, auth, first), range(2)))
    assert all(response.status_code == 201 for response in responses)
    assert {
        response.json()["document"]["versions"][0]["original_filename"] for response in responses
    } == {"노트 copy 2.md", "노트 copy 3.md"}
    assert db.scalar(select(func.count()).select_from(Document)) == 4
    collision = {**data, "version_id": copied["current_version_id"]}
    assert copy(client, auth, {"document_id": copied["id"]}, collision).status_code == 409


@pytest.mark.parametrize("role,expected", [(Role.VIEWER, 403), (Role.EDITOR, 201)])
def test_copy_permissions_and_wrong_document(client, db, scene, role, expected):
    auth, workspace, first = scene
    member = headers()
    user_id = client.get("/api/me", headers=member).json()["id"]
    db.add(WorkspaceMember(workspace_id=UUID(workspace), user_id=UUID(user_id), role=role))
    db.commit()
    assert copy(client, member, first).status_code == expected
    assert copy(client, headers(), first).status_code == 404
    assert copy(client, {}, first).status_code == 401
    assert copy(client, auth, {"document_id": str(uuid4())}, payload(first)).status_code == 404


def test_copy_rejects_unverified_upload_and_invalid_coordinates(client, db, upload):
    auth, _, first = upload
    assert copy(client, auth, first).status_code == 409
    assert copy(client, auth, first, payload(first, x=100001)).status_code == 422
    assert db.scalar(select(func.count()).select_from(Document)) == 1
