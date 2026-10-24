# ruff: noqa: F811
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select

from app.ai.mindlogic import MindlogicProvider, NoRedirect
from app.ai.provider import AIUnavailable
from app.ai.service import AIService
from app.core.config import get_settings
from app.intelligence import engine as intelligence
from app.intelligence.candidates import candidates
from app.intelligence.diff import compare_documents, cosine, filename_similarity, text_similarity
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.domain import Role, WorkspaceMember
from app.models.intelligence import AnalysisJob
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
from tests.test_versions import new_version, scene, upload_body  # noqa: F401


class Provider:
    def __init__(self):
        self.messages = None

    def embed(self, texts):
        return [[0.6, 0.8] for text in texts]

    def generate(self, messages):
        self.messages = messages
        evidence = json.loads(messages[1]["content"])["changes"]
        result = {
            "summary": "문서 내용이 변경되었습니다.",
            "added": [],
            "removed": [],
            "modified": [],
        }
        for item in evidence:
            result[item["kind"]].append(
                {"description": "문서 내용 변경", "evidence_ids": [item["id"]]}
            )
        return json.dumps(result)


@pytest.fixture
def ready_pair(client, scene, storage, monkeypatch):
    auth, workspace, first = scene
    second = new_version(client, auth, first["document_id"]).json()
    upload_body(client, auth, second, b"new version")
    for ticket in (first, second):
        engine.run(ticket["version_id"])
    monkeypatch.setattr(intelligence, "get_storage", lambda: storage)
    monkeypatch.setattr(intelligence, "AIService", lambda: AIService(Provider()))
    return auth, workspace, first, second


def block(text, kind="paragraph", **extra):
    return {"id": 1, "type": kind, "text": text, "source": {"page": 2}, **extra}


def test_diff_text_structure_and_source_evidence():
    diff = compare_documents(
        {"blocks": [block("가격 100원"), block("유지")]},
        {"blocks": [block("가격 120원"), block("유지"), block("추가")]},
    )
    assert diff["counts"] == {"added": 1, "removed": 0, "modified": 1, "unchanged": 1}
    assert diff["changes"][0]["before"]["source"]["page"] == 2
    assert {part["kind"] for part in diff["changes"][0]["text_diff"]} == {
        "equal",
        "added",
        "removed",
    }
    diff = compare_documents(
        {"blocks": [block("제목", "heading", level=1)]},
        {"blocks": [block("제목", "heading", level=2)]},
    )
    assert diff["counts"]["modified"] == 1
    assert compare_documents({"blocks": [block("삭제")]}, {"blocks": []})["counts"]["removed"] == 1


def test_diff_limits_do_not_claim_full_equality():
    a = {"blocks": [block("x" * 60000 + "old")]}
    b = {"blocks": [block("x" * 60000 + "new")]}
    diff = compare_documents(a, b)
    assert diff["truncated"] and not diff["changes"]
    diff = compare_documents({"blocks": []}, {"blocks": [block(str(i)) for i in range(150)]})
    assert diff["counts"]["added"] == 150 and len(diff["changes"]) == 120 and diff["truncated"]


def test_similarity_handles_korean_empty_vectors_and_versions():
    assert text_similarity("가격 정책 변경", "가격 정책 변경") == 1
    assert text_similarity("", "") == 0
    assert text_similarity("가격 정책 변경", "오늘의 날씨") < 0.5
    assert filename_similarity("사업계획_v1.md", "사업계획_v2.pdf") == 1
    assert cosine([1, 0], [1, 0]) == 1
    assert cosine([0, 0], [1, 0]) is None
    assert cosine([1, 0], [1]) is None


def test_summary_changed_only_and_evidence_validation():
    provider = Provider()
    diff = compare_documents(
        {"blocks": [block("secret unchanged"), block("old")]},
        {"blocks": [block("secret unchanged"), block("new")]},
    )
    summary = AIService(provider).summarize(diff)
    assert summary["modified"][0]["evidence_ids"] == ["change-1"]
    assert "secret unchanged" not in json.dumps(provider.messages)
    provider.generate = lambda messages: json.dumps(
        {
            "summary": "bad",
            "added": [],
            "removed": [],
            "modified": [{"description": "bad", "evidence_ids": ["invented"]}],
        }
    )
    with pytest.raises(AIUnavailable, match="AI_INVALID_RESPONSE"):
        AIService(provider).summarize(diff)
    provider.generate = lambda messages: "not json"
    with pytest.raises(AIUnavailable):
        AIService(provider).summarize(diff)


@pytest.mark.parametrize(
    "data",
    [
        {"data": [{"index": 0, "embedding": [float("nan")]}]},
        {"data": [{"index": 0, "embedding": [0, 0]}]},
        {"data": [{"index": 2, "embedding": [1]}]},
        {"data": [{"index": 0, "embedding": [True]}]},
        {},
    ],
)
def test_gateway_rejects_invalid_embeddings(monkeypatch, data):
    monkeypatch.setattr(get_settings(), "ai_embedding_model", "test-model")
    provider = MindlogicProvider()
    monkeypatch.setattr(provider, "request", lambda *args: data)
    with pytest.raises(AIUnavailable, match="AI_INVALID_RESPONSE"):
        provider.embed(["text"])


def test_gateway_configuration_and_transport_contract(monkeypatch):
    monkeypatch.setattr(get_settings(), "mindlogic_api_key", "")
    with pytest.raises(AIUnavailable, match="AI_NOT_CONFIGURED"):
        MindlogicProvider().generate([])
    monkeypatch.setattr(get_settings(), "ai_embedding_model", "")
    with pytest.raises(AIUnavailable, match="EMBEDDING_NOT_CONFIGURED"):
        MindlogicProvider().embed(["a"])
    assert NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.test") is None
    provider = MindlogicProvider()
    calls = []

    def request(path, body):
        calls.append((path, body))
        return {"choices": [{"finish_reason": "stop", "message": {"content": "{}"}}]}

    monkeypatch.setattr(provider, "request", request)
    assert provider.generate([{"role": "user", "content": "x"}]) == "{}"
    assert calls[0][0] == "/chat/completions/"
    assert calls[0][1]["model"] == "gpt-5.6-luna"


def test_auto_dispatch_profiles_changes_provenance_and_duplicate_delivery(client, db, ready_pair):
    auth, workspace, first, second = ready_pair
    dispatched = []
    intelligence.dispatch(dispatched.append)
    assert len(dispatched) == 3
    for key in dispatched:
        intelligence.run(key)
        intelligence.run(key)
    db.expire_all()
    assert all(j.attempts == 1 and j.state == "COMPLETED" for j in db.scalars(select(AnalysisJob)))
    path = f"/api/documents/{first['document_id']}"
    query = f"left={first['version_id']}&right={second['version_id']}"
    response = client.get(f"{path}/diff?{query}", headers=auth)
    assert response.status_code == 200 and response.json()["total_changes"] == 1
    assert response.headers["cache-control"] == "no-store"
    change = client.get(f"{path}/changes?{query}", headers=auth).json()
    assert change["result"]["summary"]["modified"][0]["evidence_ids"] == ["change-1"]
    assert change["result"]["provenance"]["model"] == "gpt-5.6-luna"
    public = client.get(f"/api/versions/{second['version_id']}/intelligence", headers=auth).json()
    assert public["analysis"]["result"]["embedding_available"]
    assert "text" not in public["analysis"]["result"]
    assert "embedding" not in public["analysis"]["result"]
    assert db.get(Document, UUID(first["document_id"])).current_version_id == UUID(
        first["version_id"]
    )


def test_degraded_ai_preserves_ready_diff_and_explicit_retry(client, db, ready_pair, monkeypatch):
    auth, _, first, second = ready_pair

    class Offline(Provider):
        def generate(self, messages):
            raise AIUnavailable("AI_NOT_CONFIGURED")

    monkeypatch.setattr(intelligence, "AIService", lambda: AIService(Offline()))
    key = intelligence.enqueue(db, UUID(second["version_id"]), UUID(first["version_id"]))
    db.commit()
    intelligence.run(key)
    db.expire_all()
    job = db.get(AnalysisJob, key)
    assert job.state == "COMPLETED" and job.result["summary"] is None
    assert job.result["warnings"] == ["AI_NOT_CONFIGURED"]
    assert job.result["diff"]["total_changes"] == 1
    assert db.get(DocumentVersion, UUID(second["version_id"])).status == VersionStatus.READY
    path = f"/api/documents/{first['document_id']}/changes"
    data = {"left": first["version_id"], "right": second["version_id"]}
    assert client.post(path, headers=auth, json=data).status_code == 429
    job.finished_at -= timedelta(seconds=40)
    db.commit()
    assert client.post(path, headers=auth, json=data).json()["state"] == "QUEUED"


def test_permissions_pair_validation_and_workspace_isolation(client, db, ready_pair):
    auth, workspace, first, second = ready_pair
    viewer, stranger = headers(), headers()
    user = client.get("/api/me", headers=viewer).json()["id"]
    db.add(WorkspaceMember(workspace_id=UUID(workspace), user_id=UUID(user), role=Role.VIEWER))
    db.commit()
    base = f"/api/documents/{first['document_id']}"
    query = f"left={first['version_id']}&right={second['version_id']}"
    for path in [
        base + "/diff?" + query,
        base + "/changes?" + query,
        f"/api/versions/{first['version_id']}/intelligence",
    ]:
        assert client.get(path, headers=viewer).status_code == 200
        assert client.get(path, headers=stranger).status_code == 404
        assert client.get(path).status_code == 401
    data = {"left": first["version_id"], "right": second["version_id"]}
    assert client.post(base + "/changes", headers=viewer, json=data).status_code == 403
    assert (
        client.post(f"/api/versions/{first['version_id']}/analyze", headers=viewer).status_code
        == 403
    )
    other_workspace = client.post("/api/workspaces", headers=auth, json={"name": "Private"}).json()[
        "id"
    ]
    other = create(client, auth, other_workspace).json()
    upload_body(client, auth, other, BODY)
    engine.run(other["version_id"])
    query = f"left={first['version_id']}&right={other['version_id']}"
    assert client.get(base + "/diff?" + query, headers=auth).status_code == 404
    dispatched = []
    intelligence.dispatch(dispatched.append)
    for key in dispatched:
        intelligence.run(key)
    db.expire_all()
    result = candidates(db, db.get(DocumentVersion, UUID(first["version_id"])))
    assert result["items"] == [] and result["total"] == 0
    assert (
        client.get(
            base + f"/diff?left={first['version_id']}&right={first['version_id']}", headers=auth
        ).status_code
        == 422
    )


def test_candidates_use_current_versions_matching_vectors_and_opt_in_link(client, db, ready_pair):
    auth, workspace, first, second = ready_pair
    # Same workspace, different document with a ready current version.
    other = create(client, auth, workspace).json()
    upload_body(client, auth, other, BODY)
    engine.run(other["version_id"])
    keys = []
    intelligence.dispatch(keys.append)
    for key in keys:
        intelligence.run(key)
    db.expire_all()
    source = db.get(DocumentVersion, UUID(second["version_id"]))
    result = candidates(db, source)
    assert len(result["items"]) == 1 and result["items"][0]["embedding_similarity"] == 1
    target = db.get(Document, UUID(other["document_id"]))
    assert len(target.versions) == 1
    profile = db.get(AnalysisJob, intelligence.job_key(source.id))
    profile.result = {**profile.result, "embedding_identity": "different-model"}
    db.commit()
    assert candidates(db, source)["items"] == []
    profile.result = {**profile.result, "embedding_identity": intelligence.embedding_identity()}
    db.commit()
    linked = client.post(
        f"/api/documents/{target.id}/versions/link",
        headers=auth,
        json={"request_id": str(uuid4()), "source_version_id": str(source.id)},
    )
    assert linked.status_code == 201
    assert linked.json()["versions"][-1]["source_version_id"] == str(source.id)
    assert linked.json()["current_version_id"] == other["version_id"]


def test_concurrent_requests_coalesce_and_fence_stale_results(client, db, ready_pair, monkeypatch):
    auth, _, first, second = ready_pair
    path = f"/api/documents/{first['document_id']}/changes"
    data = {"left": first["version_id"], "right": second["version_id"]}
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: client.post(path, headers=auth, json=data), range(8)))
    assert all(response.status_code == 202 for response in results)
    assert db.scalar(select(func.count()).select_from(AnalysisJob)) == 1
    key = intelligence.job_key(second["version_id"], first["version_id"])

    def supersede(session, old_job):
        with intelligence.SessionLocal() as fresh:
            current = fresh.get(AnalysisJob, key)
            current.run_token = uuid4()
            current.result = {"newer": True}
            fresh.commit()
        return {"stale": True}

    monkeypatch.setattr(intelligence, "compute", supersede)
    intelligence.run(key)
    db.expire_all()
    assert db.get(AnalysisJob, key).result == {"newer": True}


def test_dispatch_recovers_expired_lease_and_exhausts_attempts(db, ready_pair):
    _, _, first, second = ready_pair
    key = intelligence.enqueue(db, UUID(second["version_id"]), UUID(first["version_id"]))
    db.commit()
    job = db.get(AnalysisJob, key)
    job.state, job.run_token, job.attempts = "RUNNING", uuid4(), 1
    job.started_at = intelligence.now() - timedelta(seconds=190)
    db.commit()
    sent = []
    intelligence.dispatch(sent.append)
    db.expire_all()
    assert key in sent and db.get(AnalysisJob, key).run_token is None
    job = db.get(AnalysisJob, key)
    job.state, job.attempts = "RUNNING", 3
    db.commit()
    intelligence.dispatch(sent.append)
    db.expire_all()
    assert db.get(AnalysisJob, key).state == "FAILED"


def test_real_redis_delivers_analysis_tasks(db, ready_pair):
    import time

    from celery.contrib.testing.worker import start_worker

    from app.processing.worker import analyze_document, celery

    _, _, first, second = ready_pair
    celery.control.purge()
    with start_worker(celery, perform_ping_check=False, pool="solo", concurrency=1):
        intelligence.dispatch(lambda key: analyze_document.delay(key))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            db.expire_all()
            jobs = db.scalars(select(AnalysisJob)).all()
            if len(jobs) == 3 and all(job.state == "COMPLETED" for job in jobs):
                break
            db.rollback()
            time.sleep(0.1)
        assert len(jobs) == 3 and all(job.state == "COMPLETED" for job in jobs)


def test_broker_outage_keeps_outbox_and_late_predecessor_is_not_skipped(db, ready_pair):
    _, _, first, second = ready_pair
    prior = db.get(DocumentVersion, UUID(first["version_id"]))
    prior.status = VersionStatus.PROCESSING
    db.commit()

    def unavailable(key):
        raise ConnectionError("test broker outage")

    with pytest.raises(ConnectionError):
        intelligence.dispatch(unavailable)
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(AnalysisJob)) == 1
    assert db.scalar(select(AnalysisJob)).dispatched_at is None
    sent = []
    intelligence.dispatch(sent.append)
    assert sent == [intelligence.job_key(second["version_id"])]
    prior.status = VersionStatus.READY
    db.commit()
    intelligence.dispatch(sent.append)
    assert intelligence.job_key(second["version_id"], first["version_id"]) in sent
