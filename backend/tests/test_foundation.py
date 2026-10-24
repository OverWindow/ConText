from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import jwt
import pytest
from fastapi import Depends
from sqlalchemy import func, select

from app.auth.dependencies import require_workspace_role
from app.core.config import get_settings
from app.main import app
from app.models.domain import Role, Team, TeamMember, User, Workspace, WorkspaceMember


def token(subject=None, **overrides):
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(subject or uuid4()),
        "email": "person@example.test",
        "user_metadata": {"full_name": "Test Person"},
        "role": "authenticated",
        "aud": "authenticated",
        "iss": "https://auth.example.test/auth/v1",
        "iat": now,
        "exp": now + timedelta(minutes=10),
    }
    payload.update(overrides)
    return jwt.encode(payload, get_settings().supabase_jwt_secret, algorithm="HS256")


def headers(subject=None, **overrides):
    return {"Authorization": f"Bearer {token(subject, **overrides)}"}


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/api/me"),
        ("get", "/api/workspaces"),
        ("post", "/api/workspaces"),
        ("get", f"/api/workspaces/{uuid4()}"),
    ],
)
def test_anonymous_blocked(client, method, path):
    response = getattr(client, method)(
        path, **({"json": {"name": "Test"}} if method == "post" else {})
    )
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize(
    "claims",
    [
        {"exp": datetime.now(timezone.utc) - timedelta(seconds=10)},
        {"aud": "wrong"},
        {"iss": "https://wrong.test/auth/v1"},
        {"sub": "not-a-uuid"},
        {"role": "service_role"},
        {"is_anonymous": True},
        {"email": None},
        {"email": ""},
        {"iat": datetime.now(timezone.utc) + timedelta(hours=1)},
    ],
)
def test_invalid_claims_rejected(client, claims):
    assert client.get("/api/me", headers=headers(**claims)).status_code == 401


@pytest.mark.parametrize("value", ["garbage", "a.b.c", "", "Bearer"])
def test_malformed_token_rejected(client, value):
    assert client.get("/api/me", headers={"Authorization": f"Bearer {value}"}).status_code == 401


def test_wrong_signature_and_missing_expiry(client):
    claims = jwt.decode(token(), options={"verify_signature": False})
    wrong = jwt.encode(claims, "a-different-key-that-is-long-enough", algorithm="HS256")
    assert client.get("/api/me", headers={"Authorization": f"Bearer {wrong}"}).status_code == 401
    claims.pop("exp")
    missing = jwt.encode(claims, get_settings().supabase_jwt_secret, algorithm="HS256")
    assert client.get("/api/me", headers={"Authorization": f"Bearer {missing}"}).status_code == 401


def test_first_login_idempotent(client, db):
    auth = headers()
    first = client.get("/api/me", headers=auth)
    second = client.get("/api/me", headers=auth)
    assert first.status_code == 200
    assert first.json() == second.json()
    assert first.json()["display_name"] == "Test Person"
    assert db.scalar(select(func.count()).select_from(User)) == 1


def test_concurrent_first_login(client, db):
    auth = headers()
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: client.get("/api/me", headers=auth), range(12)))
    assert all(result.status_code == 200 for result in results)
    assert len({result.json()["id"] for result in results}) == 1
    assert db.scalar(select(func.count()).select_from(User)) == 1


def test_create_list_detail_and_owner(client, db):
    auth = headers()
    assert client.get("/api/workspaces", headers=auth).json() == []
    response = client.post("/api/workspaces", headers=auth, json={"name": "  Product  "})
    assert response.status_code == 201
    item = response.json()
    assert item["name"] == "Product"
    assert item["role"] == "OWNER"
    assert client.get("/api/workspaces", headers=auth).json() == [item]
    assert client.get(f"/api/workspaces/{item['id']}", headers=auth).json() == item
    assert db.scalar(select(WorkspaceMember)).role == Role.OWNER
    assert db.scalar(select(TeamMember)).role == Role.OWNER
    assert db.scalar(select(Workspace)).created_by == db.scalar(select(User)).id


def test_cross_user_isolation_and_team_creation_blocked(client, db):
    alice, bob = headers(), headers()
    item = client.post("/api/workspaces", headers=alice, json={"name": "Private"}).json()
    assert client.get("/api/workspaces", headers=bob).json() == []
    denied = client.get(f"/api/workspaces/{item['id']}", headers=bob)
    missing = client.get(f"/api/workspaces/{uuid4()}", headers=bob)
    assert denied.status_code == missing.status_code == 404
    assert denied.json() == missing.json()
    assert (
        client.post(
            "/api/workspaces", headers=bob, json={"name": "Intruder", "team_id": item["team_id"]}
        ).status_code
        == 404
    )
    assert db.scalar(select(func.count()).select_from(Workspace)) == 1


@pytest.mark.parametrize("role,status", [(Role.OWNER, 201), (Role.EDITOR, 201), (Role.VIEWER, 403)])
def test_existing_team_roles(client, db, role, status):
    owner, member = headers(), headers()
    workspace = client.post("/api/workspaces", headers=owner, json={"name": "One"}).json()
    user_id = UUID(client.get("/api/me", headers=member).json()["id"])
    db.add(TeamMember(team_id=UUID(workspace["team_id"]), user_id=user_id, role=role))
    db.commit()
    # Team membership alone grants no access to a workspace.
    assert client.get(f"/api/workspaces/{workspace['id']}", headers=member).status_code == 404
    result = client.post(
        "/api/workspaces", headers=member, json={"name": "Two", "team_id": workspace["team_id"]}
    )
    assert result.status_code == status
    assert db.scalar(select(func.count()).select_from(Team)) == 1


@app.get(
    "/_test/workspaces/{workspace_id}/edit",
    dependencies=[Depends(require_workspace_role((Role.OWNER, Role.EDITOR)))],
)
def edit_probe():
    return {"ok": True}


@pytest.mark.parametrize("role,status", [(Role.OWNER, 200), (Role.EDITOR, 200), (Role.VIEWER, 403)])
def test_workspace_role_dependency(client, db, role, status):
    owner, member = headers(), headers()
    workspace = client.post("/api/workspaces", headers=owner, json={"name": "Shared"}).json()
    user_id = UUID(client.get("/api/me", headers=member).json()["id"])
    db.add(WorkspaceMember(workspace_id=UUID(workspace["id"]), user_id=user_id, role=role))
    db.commit()
    assert client.get(f"/api/workspaces/{workspace['id']}", headers=member).status_code == 200
    assert (
        client.get(f"/_test/workspaces/{workspace['id']}/edit", headers=member).status_code
        == status
    )
    assert (
        client.get(f"/_test/workspaces/{workspace['id']}/edit", headers=headers()).status_code
        == 404
    )


@pytest.mark.parametrize(
    "data",
    [
        {"name": ""},
        {"name": " "},
        {"name": "x" * 121},
        {"name": "Hi", "team_id": "bad"},
        {"name": "Hi", "role": "OWNER"},
    ],
)
def test_input_validation(client, db, data):
    assert client.post("/api/workspaces", headers=headers(), json=data).status_code == 422
    assert db.scalar(select(func.count()).select_from(Team)) == 0


def test_transaction_rolls_back_on_member_failure(client, db, monkeypatch):
    from sqlalchemy.orm import Session

    original = Session.add

    def fail_member(self, instance, *args, **kwargs):
        if isinstance(instance, WorkspaceMember):
            raise RuntimeError("Simulated membership failure")
        return original(self, instance, *args, **kwargs)

    monkeypatch.setattr(Session, "add", fail_member)
    with pytest.raises(RuntimeError):
        client.post("/api/workspaces", headers=headers(), json={"name": "Rollback"})
    assert db.scalar(select(func.count()).select_from(Team)) == 0
    assert db.scalar(select(func.count()).select_from(Workspace)) == 0


def test_health_and_cors(client):
    assert client.get("/health").json() == {"status": "ok"}
    request_headers = {
        "Origin": "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
    }
    assert client.options("/api/me", headers=request_headers).status_code == 200
    request_headers["Origin"] = "https://untrusted.test"
    assert client.options("/api/me", headers=request_headers).status_code == 400
