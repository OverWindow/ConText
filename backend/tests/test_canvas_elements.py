from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import pytest

from app.models.domain import Role, WorkspaceMember
from tests.test_foundation import headers


@pytest.fixture
def scene(client):
    auth = headers()
    workspace = client.post("/api/workspaces", headers=auth, json={"name": "Canvas"}).json()["id"]
    other = client.post("/api/workspaces", headers=auth, json={"name": "Other"}).json()["id"]
    return auth, workspace, other


def payload(**values):
    return {
        "id": str(uuid4()),
        "kind": "text",
        "text": "팀의 생각\n다음 주 계획",
        "x": 100,
        "y": -50,
        **values,
    }


def test_element_crud_retry_partial_update_and_workspace_isolation(client, scene):
    auth, workspace, other = scene
    path = f"/api/workspaces/{workspace}/canvas/elements"
    body = payload()
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: client.post(path, headers=auth, json=body), range(4)))
    assert all(r.status_code == 201 for r in responses)
    original = responses[0].json()
    assert {r.json()["id"] for r in responses} == {body["id"]}
    assert client.post(path, headers=auth, json={**body, "text": "different"}).status_code == 409
    item_path = path + "/" + body["id"]
    changed = client.patch(
        item_path,
        headers=auth,
        json={"width": 650, "height": 420, "color": "green", "font_size": 48},
    )
    assert changed.status_code == 200
    assert changed.json()["text"] == body["text"]
    assert changed.json()["created_by"] == original["created_by"]
    assert client.patch(item_path, headers=auth, json={"x": -120, "y": 250}).status_code == 200
    snapshot = client.get(f"/api/workspaces/{workspace}/canvas", headers=auth).json()["elements"]
    assert len(snapshot) == 1
    assert (snapshot[0]["width"], snapshot[0]["x"], snapshot[0]["font_size"]) == (650, -120, 48)
    other_path = f"/api/workspaces/{other}/canvas/elements"
    assert client.post(other_path, headers=auth, json=body).status_code == 409
    assert (
        client.patch(other_path + "/" + body["id"], headers=auth, json={"text": "no"}).status_code
        == 404
    )
    assert client.delete(other_path + "/" + body["id"], headers=auth).status_code == 404
    assert client.get(f"/api/workspaces/{other}/canvas", headers=auth).json()["elements"] == []
    assert client.delete(item_path, headers=auth).status_code == 204
    assert client.delete(item_path, headers=auth).status_code == 404
    assert client.get(f"/api/workspaces/{workspace}/canvas", headers=auth).json()["elements"] == []


@pytest.mark.parametrize("kind", ["rectangle", "ellipse", "triangle"])
def test_basic_shapes(client, scene, kind):
    auth, workspace, _ = scene
    result = client.post(
        f"/api/workspaces/{workspace}/canvas/elements",
        headers=auth,
        json=payload(kind=kind, text=""),
    )
    assert result.status_code == 201
    assert result.json()["kind"] == kind


@pytest.mark.parametrize("role", [Role.VIEWER, Role.EDITOR])
def test_element_roles_and_anonymous(client, db, scene, role):
    auth, workspace, _ = scene
    member = headers()
    user_id = client.get("/api/me", headers=member).json()["id"]
    db.add(WorkspaceMember(workspace_id=UUID(workspace), user_id=UUID(user_id), role=role))
    db.commit()
    path = f"/api/workspaces/{workspace}/canvas/elements"
    created = client.post(path, headers=auth, json=payload()).json()
    assert client.get(f"/api/workspaces/{workspace}/canvas", headers=member).json()["elements"]
    calls = [
        ("POST", path, payload()),
        ("PATCH", path + "/" + created["id"], {"text": "편집"}),
        ("DELETE", path + "/" + created["id"], None),
    ]
    for method, endpoint, body in calls:
        assert client.request(method, endpoint, json=body).status_code == 401
        assert client.request(method, endpoint, json=body, headers=headers()).status_code == 404
        result = client.request(method, endpoint, json=body, headers=member)
        assert result.status_code == (
            403 if role == Role.VIEWER else {"POST": 201, "PATCH": 200, "DELETE": 204}[method]
        )
        if method == "PATCH" and role == Role.EDITOR:
            assert result.json()["updated_by"] == user_id


@pytest.mark.parametrize(
    "bad",
    [
        {"width": 79},
        {"height": 2001},
        {"x": "nan"},
        {"y": 100001},
        {"color": "url(evil)"},
        {"font_size": 97},
        {"text": "a" * 5001},
        {"kind": "script"},
        {"workspace_id": str(uuid4())},
    ],
)
def test_element_validation(client, scene, bad):
    auth, workspace, _ = scene
    path = f"/api/workspaces/{workspace}/canvas/elements"
    assert client.post(path, headers=auth, json=payload(**bad)).status_code == 422
    created = client.post(path, headers=auth, json=payload()).json()
    assert client.patch(path + "/" + created["id"], headers=auth, json=bad).status_code == 422


def test_element_patch_rejects_empty_null_and_accepts_plain_text(client, scene):
    auth, workspace, _ = scene
    path = f"/api/workspaces/{workspace}/canvas/elements"
    created = client.post(path, headers=auth, json=payload()).json()
    for bad in [{}, {"text": None}, {"width": None}]:
        assert client.patch(path + "/" + created["id"], headers=auth, json=bad).status_code == 422
    plain = '<img src=x onerror="alert(1)">'
    assert (
        client.patch(path + "/" + created["id"], headers=auth, json={"text": plain}).json()["text"]
        == plain
    )
