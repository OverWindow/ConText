import json
from uuid import UUID, uuid4

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

from app.ai import connections
from app.core.config import get_settings
from app.models.ai_connections import AIConnection, AIRequest
from tests.test_foundation import headers


@pytest.fixture
def gateway(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "ai_credentials_key", Fernet.generate_key().decode())
    monkeypatch.setattr(settings, "ai_daily_request_limit", 100)
    calls = []

    class Provider:
        def __init__(self, api_key=None, model=None, **kwargs):
            self.api_key, self.model = api_key, model or "allowed-model"

        def request(self, path):
            assert path == "/models/"
            return {
                "data": [
                    {"id": "allowed-model", "type": "llm"},
                    {"id": "image-only", "type": "image"},
                ]
            }

        def generate(self, messages):
            calls.append(self.api_key)
            context = json.loads(messages[1]["content"])
            return json.dumps(
                {
                    "title": "로컬 근거 문서",
                    "blocks": [
                        {
                            "id": "body",
                            "type": "paragraph",
                            "text": "자료에 근거한 본문",
                            "source_ids": [source["id"] for source in context["sources"]],
                        }
                    ],
                    "checks": [],
                }
            )

    monkeypatch.setattr(connections, "MindlogicProvider", Provider)
    return calls


def test_personal_keys_are_encrypted_owned_and_never_returned(client, db, gateway):
    auth = headers()
    assert client.get("/api/ai/connection").status_code == 401
    response = client.put(
        "/api/ai/connection",
        headers=auth,
        json={"mode": "personal", "model": "allowed-model", "api_key": "personal-test-secret"},
    )
    assert response.status_code == 200
    assert "personal-test-secret" not in response.text
    uid = UUID(client.get("/api/me", headers=auth).json()["id"])
    row = db.get(AIConnection, uid)
    assert row.encrypted_key != "personal-test-secret"
    assert (
        connections.credential_cipher().decrypt(row.encrypted_key.encode()).decode()
        == "personal-test-secret"
    )
    assert not client.get("/api/ai/connection", headers=headers()).json()["has_personal_key"]
    assert client.get("/api/ai/models", headers=auth).json() == [
        {"id": "allowed-model", "name": "allowed-model"}
    ]
    assert client.delete("/api/ai/connection", headers=auth).json()["has_personal_key"] is False
    db.expire_all()
    assert db.get(AIConnection, uid) is None


def test_local_context_uses_submitter_key_binds_sources_and_replays_without_charge(
    client, db, gateway
):
    auth = headers()
    client.put(
        "/api/ai/connection",
        headers=auth,
        json={"mode": "personal", "model": "allowed-model", "api_key": "private-user-key"},
    )
    request = {
        "request_id": str(uuid4()),
        "prompt": "보고서 작성",
        "sources": [
            {
                "id": "local-version-1",
                "document_title": "비공개 로컬 자료",
                "text": "로컬에만 저장한 예산",
            }
        ],
    }
    first = client.post("/api/ai/context", headers=auth, json=request)
    assert first.status_code == 200, first.text
    assert first.json()["content"]["blocks"][0]["source_ids"] == ["local-version-1"]
    assert client.post("/api/ai/context", headers=auth, json=request).json() == first.json()
    assert gateway == ["private-user-key"]
    record = db.scalar(select(AIRequest))
    assert record.state == "complete" and "로컬" not in record.response_ciphertext
    changed = {**request, "prompt": "다른 요청"}
    assert client.post("/api/ai/context", headers=auth, json=changed).status_code == 409
    assert gateway == ["private-user-key"]


def test_personal_storage_requires_config_and_local_requests_obey_daily_limit(
    client, gateway, monkeypatch
):
    settings = get_settings()
    monkeypatch.setattr(settings, "ai_credentials_key", "")
    auth = headers()
    assert (
        client.put(
            "/api/ai/connection",
            headers=auth,
            json={"mode": "personal", "api_key": "not-stored-key"},
        ).status_code
        == 503
    )
    client.put(
        "/api/ai/connection", headers=auth, json={"mode": "managed", "model": "allowed-model"}
    )
    monkeypatch.setattr(settings, "ai_daily_request_limit", 1)
    data = {"request_id": str(uuid4()), "prompt": "초안"}
    assert client.post("/api/ai/context", headers=auth, json=data).status_code == 200
    assert client.post("/api/ai/context", headers=auth, json=data).status_code == 409
    assert (
        client.post(
            "/api/ai/context", headers=auth, json={**data, "request_id": str(uuid4())}
        ).status_code
        == 429
    )


def test_existing_web_writing_uses_requesting_users_personal_connection(client, gateway):
    auth = headers()
    workspace = client.post("/api/workspaces", headers=auth, json={"name": "개인 AI"}).json()
    client.put(
        "/api/ai/connection",
        headers=auth,
        json={
            "mode": "personal",
            "model": "allowed-model",
            "api_key": "web-personal-key",
        },
    )
    response = client.post(
        f"/api/workspaces/{workspace['id']}/writing",
        headers=auth,
        json={
            "request_id": str(uuid4()),
            "prompt": "자료를 참고해 작성해줘",
        },
    )
    assert response.status_code == 201, response.text
    assert gateway == ["web-personal-key"]


def test_gateway_generation_accepts_models_without_json_mode(monkeypatch):
    from app.ai.mindlogic import MindlogicProvider

    provider = MindlogicProvider(api_key="fake-key", model="provider-without-json-mode")

    def completion(path, payload):
        assert path == "/chat/completions/"
        assert "response_format" not in payload
        assert "reasoning_effort" not in payload
        assert "temperature" not in payload
        assert payload["max_tokens"] >= 16000
        return {"choices": [{"finish_reason": "stop", "message": {"content": '{"ok":true}'}}]}

    monkeypatch.setattr(provider, "request", completion)
    assert provider.generate([{"role": "system", "content": "Return JSON only."}]) == '{"ok":true}'
