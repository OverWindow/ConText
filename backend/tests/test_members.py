from concurrent.futures import ThreadPoolExecutor
from uuid import UUID

import pytest
from sqlalchemy import func, select

from app.models.domain import Role, TeamMember, WorkspaceMember
from tests.test_foundation import headers


def setup(client):
    owner = headers(email="owner@example.test")
    workspace = client.post("/api/workspaces", headers=owner, json={"name": "Team"}).json()
    target = headers(email="member@example.test")
    user = client.get("/api/me", headers=target).json()
    return owner, workspace, target, user


def test_owner_adds_existing_account_only_to_this_workspace(client, db):
    owner, workspace, target, user = setup(client)
    second = client.post("/api/workspaces", headers=owner, json={"name": "Private"}).json()
    path = f"/api/workspaces/{workspace['id']}/members"
    assert client.get(f"/api/workspaces/{workspace['id']}", headers=target).status_code == 404
    response = client.post(
        path, headers=owner, json={"email": " Member@Example.Test ", "role": "EDITOR"}
    )
    assert response.status_code == 201, response.text
    assert response.json()["id"] == user["id"]
    assert response.json()["role"] == "EDITOR"
    assert (
        client.get(f"/api/workspaces/{workspace['id']}", headers=target).json()["role"] == "EDITOR"
    )
    assert client.get(f"/api/workspaces/{second['id']}", headers=target).status_code == 404
    assert (
        db.scalar(
            select(func.count())
            .select_from(TeamMember)
            .where(TeamMember.user_id == UUID(user["id"]))
        )
        == 0
    )
    # Adding an existing member is idempotent; never silently change permissions.
    assert (
        client.post(
            path, headers=owner, json={"email": "member@example.test", "role": "VIEWER"}
        ).json()["role"]
        == "EDITOR"
    )
    assert len(client.get(path, headers=owner).json()) == 2


@pytest.mark.parametrize("role", [Role.VIEWER, Role.EDITOR])
def test_only_owner_can_add_members(client, db, role):
    owner, workspace, target, user = setup(client)
    path = f"/api/workspaces/{workspace['id']}/members"
    data = {"email": "member@example.test", "role": "VIEWER"}
    assert client.post(path, json=data).status_code == 401
    assert client.post(path, headers=target, json=data).status_code == 404
    db.add(WorkspaceMember(workspace_id=UUID(workspace["id"]), user_id=UUID(user["id"]), role=role))
    db.commit()
    assert client.post(path, headers=target, json=data).status_code == 403
    assert client.post(path, headers=owner, json={**data, "role": "OWNER"}).status_code == 422
    assert client.post(path, headers=owner, json={**data, "email": "bad"}).status_code == 422


def test_missing_or_ambiguous_email_and_duplicate_requests(client, db):
    owner, workspace, target, user = setup(client)
    path = f"/api/workspaces/{workspace['id']}/members"
    assert (
        client.post(path, headers=owner, json={"email": "missing@example.test"}).status_code == 404
    )
    data = {"email": "member@example.test"}
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: client.post(path, headers=owner, json=data), range(6)))
    assert all(r.status_code == 201 for r in results)
    assert (
        db.scalar(
            select(func.count())
            .select_from(WorkspaceMember)
            .where(WorkspaceMember.workspace_id == UUID(workspace["id"]))
        )
        == 2
    )
    assert client.get("/api/me", headers=headers(email="member@example.test")).status_code == 200
    assert client.post(path, headers=owner, json=data).status_code == 409
