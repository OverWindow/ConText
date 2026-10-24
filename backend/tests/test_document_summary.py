# ruff: noqa: F401, F811
import json
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import func, select

from app.ai.provider import AIUnavailable
from app.ai.service import AIService
from app.intelligence import engine as intelligence
from app.models.canvas import DocumentRelation
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.domain import Role, WorkspaceMember
from app.processing import engine
from app.rag import answer
from app.services import document_summary
from tests.test_documents import BODY, complete, create, put, s3_server, storage, upload
from tests.test_foundation import headers
from tests.test_versions import scene


@pytest.fixture
def summary_scene(client, scene, storage, monkeypatch):
    auth, workspace, first = scene
    engine.run(first["version_id"])
    copied = client.post(
        f"/api/documents/{first['document_id']}/copy",
        headers=auth,
        json={
            "request_id": str(uuid4()),
            "version_id": first["version_id"],
            "x": 390,
            "y": 0,
        },
    ).json()["document"]
    calls = []

    class Provider:
        def generate(self, messages):
            sources = json.loads(messages[1]["content"])["SOURCES"]
            calls.append(sources)
            return json.dumps(
                {
                    "claims": [
                        {"text": f"요약 내용 {s['document_title']}", "source_ids": [s["id"]]}
                        for s in sources
                    ],
                    "insufficient": False,
                }
            )

    monkeypatch.setattr(intelligence, "get_storage", lambda: storage)
    monkeypatch.setattr(document_summary, "get_storage", lambda: storage)
    monkeypatch.setattr(answer, "AIService", lambda: AIService(Provider()))
    return auth, workspace, first, copied, calls


def payload(first, copied):
    return {
        "request_id": str(uuid4()),
        "version_ids": [first["version_id"], copied["current_version_id"]],
        "x": 750,
        "y": 40,
    }


def test_summary_creates_file_content_sources_positions_and_idempotency(client, db, summary_scene):
    auth, workspace, first, copied, calls = summary_scene
    data = payload(first, copied)
    url = f"/api/workspaces/{workspace}/canvas/summaries"
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: client.post(url, headers=auth, json=data), range(2)))
    assert all(r.status_code == 201 for r in results), [r.text for r in results]
    assert len({r.json()["document"]["id"] for r in results}) == 1
    assert len(calls) == 1 and len(calls[0]) == 2
    doc = results[0].json()["document"]
    version = doc["versions"][0]
    assert version["status"] == "READY" and version["original_filename"].endswith(".md")
    content = client.get(f"/api/versions/{version['id']}/content", headers=auth)
    assert content.status_code == 200 and "요약 내용" in content.text
    link = client.post(f"/api/versions/{version['id']}/download-url", headers=auth).json()
    body = httpx.get(link["download_url"]).text
    assert first["version_id"] in body and copied["current_version_id"] in body
    assert "수정 이력 1" in body
    snapshot = client.get(f"/api/workspaces/{workspace}/canvas", headers=auth).json()
    assert any(p["document_id"] == doc["id"] and p["x"] == 750 for p in snapshot["positions"])
    relations = db.scalars(
        select(DocumentRelation).where(DocumentRelation.source_document_id == UUID(doc["id"]))
    ).all()
    assert {str(r.target_document_id) for r in relations} == {first["document_id"], copied["id"]}
    assert (
        client.post(
            url, headers=auth, json={**data, "version_ids": [first["version_id"]]}
        ).status_code
        == 409
    )
    assert db.scalar(select(func.count()).select_from(Document)) == 3


def test_summary_rejects_foreign_unready_duplicate_and_viewer(client, db, summary_scene):
    auth, workspace, first, copied, calls = summary_scene
    url = f"/api/workspaces/{workspace}/canvas/summaries"
    data = payload(first, copied)
    for versions, status in [
        ([str(uuid4())], 404),
        ([first["version_id"]] * 2, 422),
        ([], 422),
        ([str(uuid4()) for _ in range(9)], 422),
    ]:
        assert (
            client.post(url, headers=auth, json={**data, "version_ids": versions}).status_code
            == status
        )
    other = client.post("/api/workspaces", headers=auth, json={"name": "other"}).json()["id"]
    assert (
        client.post(
            f"/api/workspaces/{other}/canvas/summaries", headers=auth, json=data
        ).status_code
        == 404
    )
    viewer = headers()
    user_id = client.get("/api/me", headers=viewer).json()["id"]
    db.add(WorkspaceMember(workspace_id=UUID(workspace), user_id=UUID(user_id), role=Role.VIEWER))
    db.commit()
    assert client.post(url, headers=viewer, json=data).status_code == 403
    assert client.post(url, headers=headers(), json=data).status_code == 404
    db.get(DocumentVersion, UUID(first["version_id"])).status = VersionStatus.PROCESSING
    db.commit()
    assert client.post(url, headers=auth, json=data).status_code == 409
    assert not calls


def test_summary_ai_failure_does_not_create_empty_file_and_retries(
    client, db, summary_scene, monkeypatch
):
    auth, workspace, first, copied, calls = summary_scene
    url = f"/api/workspaces/{workspace}/canvas/summaries"
    data = payload(first, copied)

    def offline(*args):
        raise AIUnavailable("AI_NOT_CONFIGURED")

    with monkeypatch.context() as patch:
        patch.setattr(document_summary, "grounded_answer", offline)
        assert client.post(url, headers=auth, json=data).status_code == 503
    assert db.scalar(select(func.count()).select_from(Document)) == 2
    assert client.post(url, headers=auth, json=data).status_code == 201


def test_summary_bounds_text_and_rejects_missing_source_coverage(
    client, summary_scene, monkeypatch
):
    auth, workspace, first, copied, calls = summary_scene
    url = f"/api/workspaces/{workspace}/canvas/summaries"
    with monkeypatch.context() as patch:
        patch.setattr(
            document_summary,
            "grounded_answer",
            lambda *args: {
                "claims": [{"text": "partial", "source_ids": ["S1"]}],
                "insufficient": False,
            },
        )
        assert client.post(url, headers=auth, json=payload(first, copied)).status_code == 422
    monkeypatch.setattr(
        document_summary, "load_document", lambda *args: {"blocks": [{"text": "가" * 30000}]}
    )
    response = client.post(url, headers=auth, json=payload(first, copied))
    assert response.status_code == 201, response.text
    assert sum(len(source["text"]) for source in calls[-1]) == 24000
    version = response.json()["document"]["current_version_id"]
    link = client.post(f"/api/versions/{version}/download-url", headers=auth).json()
    assert "앞부분을 바탕으로" in httpx.get(link["download_url"]).text
