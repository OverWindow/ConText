from app.core.config import get_settings


def configure(monkeypatch):
    settings = get_settings()
    for key, value in {
        "internal_worker_token": "synthetic-internal-key",
        "legacy_workspace_api_enabled": False,
        "unified_api_url": "https://sync.unit",
        "web_base_url": "https://web.unit",
        "supabase_publishable_key": "synthetic-public-key",
    }.items():
        monkeypatch.setattr(settings, key, value)


def test_private_readiness_authenticates_and_checks_desktop_discovery(client, monkeypatch):
    configure(monkeypatch)
    assert client.get("/internal/v2/health").status_code == 401
    headers = {"Authorization": "Bearer synthetic-internal-key"}
    response = client.get("/internal/v2/health", headers=headers)
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "protocol": 2}
    monkeypatch.setattr(get_settings(), "unified_api_url", "")
    assert client.get("/internal/v2/health", headers=headers).status_code == 503
    monkeypatch.setattr(get_settings(), "unified_api_url", "https://sync.unit")
    monkeypatch.setattr(get_settings(), "legacy_workspace_api_enabled", True)
    assert client.get("/internal/v2/health", headers=headers).status_code == 503


def test_private_readiness_fails_when_no_shared_token_exists(client, monkeypatch):
    configure(monkeypatch)
    monkeypatch.setattr(get_settings(), "internal_worker_token", "")
    assert client.get("/internal/v2/health").status_code == 503
