import hashlib
from uuid import uuid4

from app.api import unified_worker
from app.core.config import get_settings


def request(body=b"# Shared document\n\nPreserved bytes"):
    return {"schema_version": 2, "job_id": str(uuid4()), "workspace_id": str(uuid4()),
            "actor_id": str(uuid4()), "kind": "parse", "filename": "notes.md",
            "download_url": "https://private.example.test/signed",
            "version": {"id": str(uuid4()), "document_id": str(uuid4()), "blob": {
                "id": str(uuid4()), "sha256": hashlib.sha256(body).hexdigest(),
                "size": len(body), "mime_type": "text/markdown"}}}


def test_internal_processing_requires_explicit_service_auth(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "internal_worker_token", "")
    assert client.post("/internal/v2/process", json=request()).status_code == 503
    monkeypatch.setattr(get_settings(), "internal_worker_token", "synthetic-internal-key")
    assert client.post("/internal/v2/process", json=request()).status_code == 401


def test_parse_and_convert_reuse_existing_python_implementation(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "internal_worker_token", "synthetic-internal-key")
    monkeypatch.setattr(unified_worker, "download_original", lambda data: b"# Shared document")
    auth = {"Authorization": "Bearer synthetic-internal-key"}
    payload = request()
    parsed = client.post("/internal/v2/process", json=payload, headers=auth).json()
    assert parsed["status"] == "complete"
    assert parsed["job_id"] == payload["job_id"]
    assert parsed["normalized"]["blocks"][0]["text"] == "Shared document"
    converted = client.post("/internal/v2/process", json={**payload, "kind": "convert",
                            "format": "docx"}, headers=auth).json()
    assert converted["status"] == "complete"
    assert converted["output"]["filename"] == "notes.docx"
    assert parsed["processor_fingerprint"] == converted["processor_fingerprint"]


def test_untrusted_urls_preserve_structured_failure(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "internal_worker_token", "synthetic-internal-key")
    auth = {"Authorization": "Bearer synthetic-internal-key"}
    payload = request()
    response = client.post("/internal/v2/process", json=payload, headers=auth).json()
    assert response["status"] == "failed"
    assert response["error"]["code"] == "UNTRUSTED_STORAGE_URL"
    assert "download_url" not in response


def test_unified_cutover_disables_parallel_workspace_writes(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "legacy_workspace_api_enabled", False)
    response = client.post("/api/workspaces", json={"name": "old API"})
    assert response.status_code == 410
    assert response.json()["error"]["code"] == "WORKSPACE_API_RETIRED"
    assert client.get("/health").status_code == 200
