from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.models.canvas import DocumentPosition, DocumentRelation, RelationType
from app.models.conversion import DocumentConversion
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.domain import Role, WorkspaceMember
from tests.test_foundation import headers


@pytest.fixture
def scene(client, db):
    auth = headers()
    workspace = client.post("/api/workspaces", headers=auth, json={"name": "Canvas"}).json()["id"]
    other = client.post("/api/workspaces", headers=auth, json={"name": "Other"}).json()["id"]
    user = UUID(client.get("/api/me", headers=auth).json()["id"])
    docs = [
        Document(
            workspace_id=UUID(w), title=f"Document {i}", created_by=user, upload_request_id=uuid4()
        )
        for i, w in enumerate([workspace, workspace, other])
    ]
    db.add_all(docs)
    db.commit()
    return auth, workspace, other, user, [str(doc.id) for doc in docs]


def position(doc, x=120, y=-45):
    return {"document_id": doc, "x": x, "y": y}


def relation(ids, **overrides):
    return {
        "source_document_id": ids[0],
        "target_document_id": ids[1],
        "relation_type": "REFERENCE",
        **overrides,
    }


def test_canvas_positions_restore_and_partial_update(client, db, scene):
    auth, workspace, _, user, ids = scene
    path = f"/api/workspaces/{workspace}/canvas"
    response = client.get(path, headers=auth)
    assert response.status_code == 200
    assert {doc["id"] for doc in response.json()["documents"]} == set(ids[:2])
    assert response.json()["positions"] == response.json()["relations"] == []
    result = client.patch(
        path + "/positions",
        headers=auth,
        json={"positions": [position(ids[0]), position(ids[1], 300, 200)]},
    )
    assert result.status_code == 200, result.text
    assert all(p["updated_by"] == str(user) for p in result.json())
    assert (
        client.patch(
            path + "/positions", headers=auth, json={"positions": [position(ids[0], 90, 100)]}
        ).status_code
        == 200
    )
    state = {p["document_id"]: p for p in client.get(path, headers=auth).json()["positions"]}
    assert state[ids[0]]["x"] == 90
    assert state[ids[1]]["x"] == 300
    assert db.scalar(select(func.count()).select_from(DocumentPosition)) == 2


def test_canvas_conversion_lineage_is_scoped_and_excludes_storage_keys(client, db, scene):
    auth, workspace, other, user, ids = scene
    versions = []
    for document_id, number in [(ids[0], 1), (ids[0], 2), (ids[2], 1)]:
        version = DocumentVersion(
            document_id=UUID(document_id),
            version_number=number,
            created_by=user,
            original_filename="notes.txt",
            mime_type="text/plain",
            size=20,
            sha256="a" * 64,
            storage_bucket="private",
            storage_key=str(uuid4()),
            status=VersionStatus.READY,
        )
        db.add(version)
        db.flush()
        versions.append(version)
        db.add(
            DocumentConversion(
                version_id=version.id,
                format="pdf",
                state="COMPLETED",
                source_key="private-source",
                output_key="private-output",
                size=100,
            )
        )
    db.commit()
    response = client.get(f"/api/workspaces/{workspace}/canvas", headers=auth)
    assert response.status_code == 200
    jobs = response.json()["conversions"]
    assert {job["version_id"] for job in jobs} == {str(v.id) for v in versions[:2]}
    assert all(job["state"] == "COMPLETED" and job["format"] == "pdf" for job in jobs)
    assert all("source_key" not in job and "output_key" not in job for job in jobs)
    other_jobs = client.get(f"/api/workspaces/{other}/canvas", headers=auth).json()["conversions"]
    assert [job["version_id"] for job in other_jobs] == [str(versions[2].id)]


def test_relation_create_duplicate_delete(client, db, scene):
    auth, workspace, _, _, ids = scene
    path = f"/api/workspaces/{workspace}/relations"
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(
            pool.map(lambda _: client.post(path, headers=auth, json=relation(ids)), range(8))
        )
    assert all(r.status_code == 201 for r in responses)
    assert len({r.json()["id"] for r in responses}) == 1
    assert db.scalar(select(func.count()).select_from(DocumentRelation)) == 1
    edge = responses[0].json()
    assert client.get(f"/api/workspaces/{workspace}/canvas", headers=auth).json()["relations"] == [
        edge
    ]
    assert client.delete(path + "/" + edge["id"], headers=auth).status_code == 204
    assert client.delete(path + "/" + edge["id"], headers=auth).status_code == 404
    assert (
        len(client.get(f"/api/workspaces/{workspace}/canvas", headers=auth).json()["documents"])
        == 2
    )


def test_relation_handles_persist_and_reconnecting_updates_existing_edge(client, scene):
    auth, workspace, _, _, ids = scene
    path = f"/api/workspaces/{workspace}"
    original = client.post(path + "/relations", headers=auth, json=relation(ids)).json()
    assert (original["source_handle"], original["target_handle"]) == ("right", "left")
    for source, target in [("bottom", "top"), ("top", "bottom"), ("left", "right")]:
        response = client.post(
            path + "/relations",
            headers=auth,
            json=relation(ids, source_handle=source, target_handle=target),
        )
        assert response.status_code == 201
        assert response.json()["id"] == original["id"]
        saved = client.get(path + "/canvas", headers=auth).json()["relations"]
        assert len(saved) == 1
        assert (saved[0]["source_handle"], saved[0]["target_handle"]) == (source, target)
    invalid = client.post(
        path + "/relations",
        headers=auth,
        json=relation(ids, source_handle="center"),
    )
    assert invalid.status_code == 422


@pytest.mark.parametrize("role", [Role.EDITOR, Role.VIEWER])
def test_canvas_roles(client, db, scene, role):
    auth, workspace, _, _, ids = scene
    member = headers()
    user = UUID(client.get("/api/me", headers=member).json()["id"])
    db.add(WorkspaceMember(workspace_id=UUID(workspace), user_id=user, role=role))
    db.commit()
    prefix = f"/api/workspaces/{workspace}"
    edge = client.post(prefix + "/relations", headers=auth, json=relation(ids)).json()
    assert client.get(prefix + "/canvas", headers=member).status_code == 200
    assert client.patch(
        prefix + "/canvas/positions", headers=member, json={"positions": [position(ids[0])]}
    ).status_code == (200 if role == Role.EDITOR else 403)
    assert client.post(prefix + "/relations", headers=member, json=relation(ids)).status_code == (
        201 if role == Role.EDITOR else 403
    )
    assert client.delete(prefix + "/relations/" + edge["id"], headers=member).status_code == (
        204 if role == Role.EDITOR else 403
    )


def test_canvas_anonymous_and_nonmembers(client, scene):
    _, workspace, _, _, ids = scene
    prefix = f"/api/workspaces/{workspace}"
    for method, path, body in [
        ("GET", "/canvas", None),
        ("PATCH", "/canvas/positions", {"positions": [position(ids[0])]}),
        ("POST", "/relations", relation(ids)),
        ("DELETE", f"/relations/{uuid4()}", None),
    ]:
        assert client.request(method, prefix + path, json=body).status_code == 401
        assert (
            client.request(method, prefix + path, json=body, headers=headers()).status_code == 404
        )


def test_cross_workspace_batch_rolls_back_and_relations_blocked(client, db, scene):
    auth, workspace, other, _, ids = scene
    prefix = f"/api/workspaces/{workspace}"
    assert (
        client.patch(
            prefix + "/canvas/positions",
            headers=auth,
            json={"positions": [position(ids[0]), position(ids[2])]},
        ).status_code
        == 404
    )
    assert db.scalar(select(func.count()).select_from(DocumentPosition)) == 0
    assert (
        client.post(
            prefix + "/relations", headers=auth, json=relation(ids, target_document_id=ids[2])
        ).status_code
        == 404
    )
    edge = client.post(prefix + "/relations", headers=auth, json=relation(ids)).json()
    assert (
        client.delete(f"/api/workspaces/{other}/relations/" + edge["id"], headers=auth).status_code
        == 404
    )
    assert client.get(f"/api/workspaces/{other}/canvas", headers=auth).json()["relations"] == []


@pytest.mark.parametrize("bad", ["nan", "inf", 100001, -100001, "not-a-number", None])
def test_position_validation(client, scene, bad):
    auth, workspace, _, _, ids = scene
    result = client.patch(
        f"/api/workspaces/{workspace}/canvas/positions",
        headers=auth,
        json={"positions": [position(ids[0], bad)]},
    )
    assert result.status_code == 422


def test_batch_limits_and_duplicates(client, scene):
    auth, workspace, _, _, ids = scene
    for positions in [
        [],
        [position(ids[0]), position(ids[0])],
        [position(str(uuid4())) for _ in range(101)],
    ]:
        assert (
            client.patch(
                f"/api/workspaces/{workspace}/canvas/positions",
                headers=auth,
                json={"positions": positions},
            ).status_code
            == 422
        )


@pytest.mark.parametrize(
    "overrides",
    [{"target_document_id": None}, {"relation_type": "VERSION"}, {"relation_type": "BAD"}],
)
def test_relation_validation(client, scene, overrides):
    auth, workspace, _, _, ids = scene
    assert (
        client.post(
            f"/api/workspaces/{workspace}/relations", headers=auth, json=relation(ids, **overrides)
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/workspaces/{workspace}/relations",
            headers=auth,
            json=relation(ids, target_document_id=ids[0]),
        ).status_code
        == 422
    )


def test_database_rejects_cross_workspace_relation(db, scene):
    _, workspace, _, user, ids = scene
    db.add(
        DocumentRelation(
            workspace_id=UUID(workspace),
            source_document_id=UUID(ids[0]),
            target_document_id=UUID(ids[2]),
            relation_type=RelationType.REFERENCE,
            created_by=user,
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_position_batch_transaction_rollback(client, db, scene, monkeypatch):
    from sqlalchemy.orm import Session

    original = Session.execute
    count = 0

    def fail_second(self, statement, *args, **kwargs):
        nonlocal count
        if getattr(statement, "is_insert", False) and statement.table.name == "document_positions":
            count += 1
            if count == 2:
                raise RuntimeError("simulated write failure")
        return original(self, statement, *args, **kwargs)

    monkeypatch.setattr(Session, "execute", fail_second)
    auth, workspace, _, _, ids = scene
    with pytest.raises(RuntimeError):
        client.patch(
            f"/api/workspaces/{workspace}/canvas/positions",
            headers=auth,
            json={"positions": [position(ids[0]), position(ids[1])]},
        )
    assert db.scalar(select(func.count()).select_from(DocumentPosition)) == 0


@pytest.mark.parametrize("method", ["PATCH", "DELETE"])
def test_canvas_cors(client, method):
    response = client.options(
        "/api/workspaces/test/canvas",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert response.status_code == 200
