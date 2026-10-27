import io
import json
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4
from zipfile import ZipFile

import pytest
from hwpx import HwpxDocument
from sqlalchemy import func, select

from app.models.canvas import CanvasElement
from app.models.domain import Role, WorkspaceMember
from app.models.rag import ChatMessage, ChatSession
from app.models.writing import WritingDraft
from app.processing.parsers import normalize
from app.services import writing
from tests.test_foundation import headers


class Writer:
    def __init__(self):
        self.calls = []
        self.invalid = False

    def generate(self, messages):
        context = json.loads(messages[1]["content"])
        self.calls.append(context)
        refs = [s["id"] for s in context["sources"]]
        if self.invalid:
            refs = ["invented-source"]
        return json.dumps(
            {
                "title": "수정한 소개서" if context["current"] else "프로젝트 소개서",
                "blocks": [
                    {"id": "heading", "type": "heading", "text": "추진 배경"},
                    {
                        "id": "body",
                        "type": "paragraph",
                        "text": "한글 문서 작성과 자료 검색",
                        "source_ids": refs,
                    },
                    {"id": "items", "type": "list", "items": ["자료 확인", "보고서 작성"]},
                    {
                        "id": "budget",
                        "type": "table",
                        "rows": [["항목", "금액"], ["예산", "[확인 필요]"]],
                    },
                ],
                "checks": ["예산을 확인해 주세요."],
            },
            ensure_ascii=False,
        )


@pytest.fixture
def scene(client, db, monkeypatch):
    auth = headers()
    workspace = client.post("/api/workspaces", headers=auth, json={"name": "작성"}).json()
    user = UUID(client.get("/api/me", headers=auth).json()["id"])
    wid = UUID(workspace["id"])
    db.add(
        CanvasElement(
            workspace_id=wid,
            created_by=user,
            updated_by=user,
            kind="text",
            text="프로젝트의 예산은 아직 미정이다.",
            x=0,
            y=0,
            width=300,
            height=100,
        )
    )
    session = ChatSession(workspace_id=wid, created_by=user, request_id=uuid4(), title="회의")
    db.add(session)
    db.flush()
    db.add(
        ChatMessage(
            session_id=session.id,
            created_by=user,
            request_id=uuid4(),
            sequence=1,
            role="user",
            state="COMPLETED",
            content="문서 검색 개발",
        )
    )
    db.commit()
    writer = Writer()
    monkeypatch.setattr(writing, "AIService", lambda: writer)
    monkeypatch.setattr(writing, "retrieve", lambda *args: {"sources": [], "warnings": []})
    return auth, wid, user, writer


def create(client, scene, **kwargs):
    auth, wid, _, _ = scene
    response = client.post(
        f"/api/workspaces/{wid}/writing",
        headers=auth,
        json={"prompt": "프로젝트 소개서를 작성해줘", "request_id": str(uuid4()), **kwargs},
    )
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def test_blank_draft_requires_no_ai_and_retries_without_duplication(client, scene):
    auth, wid, _, writer = scene
    url = f"/api/workspaces/{wid}/writing/blank"
    payload = {"request_id": str(uuid4())}
    first = client.post(url, headers=auth, json=payload)
    assert first.status_code == 201
    draft = first.json()
    assert draft["title"] == "새 문서" and draft["sources"] == []
    assert draft["content"]["blocks"][0]["type"] == "paragraph"
    assert client.post(url, headers=auth, json=payload).json() == draft
    assert client.post(url, headers=headers(), json=payload).status_code == 404
    assert writer.calls == []


def test_discovery_persistence_retry_and_isolation(client, db, scene):
    auth, wid, user, writer = scene
    other = client.post("/api/workspaces", headers=auth, json={"name": "비공개"}).json()["id"]
    db.add(
        CanvasElement(
            workspace_id=UUID(other),
            created_by=user,
            updated_by=user,
            kind="text",
            text="절대로 유출하면 안 되는 별도 자료",
            x=0,
            y=0,
            width=300,
            height=100,
        )
    )
    db.commit()
    request_id = str(uuid4())
    draft = create(client, scene, request_id=request_id)
    again = create(client, scene, request_id=request_id)
    assert again == draft and len(writer.calls) == 1
    assert {s["kind"] for s in draft["sources"]} == {"note", "chat"}
    assert "절대로" not in json.dumps(writer.calls, ensure_ascii=False)
    base = f"/api/workspaces/{wid}/writing"
    assert client.get(base, headers=auth).json()[0]["id"] == draft["id"]
    assert client.get(f"{base}/{draft['id']}", headers=auth).json() == draft
    assert client.get(f"{base}/{draft['id']}", headers=headers()).status_code == 404
    cross = f"/api/workspaces/{other}/writing/{draft['id']}"
    assert client.get(cross, headers=auth).status_code == 404
    response = client.post(
        base, headers=auth, json={"request_id": request_id, "prompt": "다른 요청"}
    )
    assert response.status_code == 409
    assert db.scalar(select(func.count()).select_from(WritingDraft)) == 1


def test_review_accept_reject_undo_and_conflicts(client, scene):
    auth, wid, _, writer = scene
    draft = create(client, scene)
    url = f"/api/workspaces/{wid}/writing/{draft['id']}"
    request = {"request_id": str(uuid4()), "prompt": "소개서를 수정해줘", "revision": 1}
    proposed = client.post(url + "/propose", headers=auth, json=request).json()
    assert proposed["content"] == draft["content"]
    assert proposed["proposal"]["content"]["title"] == "수정한 소개서"
    assert client.post(url + "/propose", headers=auth, json=request).json() == proposed
    assert len(writer.calls) == 2
    assert (
        client.patch(
            url, headers=auth, json={"revision": 1, "content": draft["content"]}
        ).status_code
        == 409
    )
    accepted = client.post(url + "/accept", headers=auth, json={"revision": 2}).json()
    assert accepted["title"] == "수정한 소개서" and accepted["can_undo"]
    restored = client.post(url + "/undo", headers=auth, json={"revision": 3}).json()
    assert restored["content"] == draft["content"] and not restored["can_undo"]
    request.update(request_id=str(uuid4()), revision=4)
    client.post(url + "/propose", headers=auth, json=request)
    rejected = client.post(url + "/reject", headers=auth, json={"revision": 5}).json()
    assert rejected["content"] == draft["content"] and rejected["proposal"] is None


def test_manual_save_citations_concurrent_edit_and_undo(client, scene):
    auth, wid, _, _ = scene
    draft = create(client, scene)
    url = f"/api/workspaces/{wid}/writing/{draft['id']}"
    draft["content"]["blocks"][1]["source_ids"] = ["fabricated"]
    body = {"revision": 1, "content": draft["content"]}
    assert client.patch(url, headers=auth, json=body).status_code == 422
    body["content"]["blocks"][1]["source_ids"] = []
    body["content"]["blocks"][1]["text"] = "직접 작성한 한글"
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.patch(url, headers=auth, json=body), range(2)))
    assert sorted(r.status_code for r in responses) == [200, 409]
    saved = next(r.json() for r in responses if r.status_code == 200)
    assert saved["checks"][-1].startswith("직접 수정한")
    assert saved["content"]["blocks"][1]["text"] == "직접 작성한 한글"
    restored = client.post(url + "/undo", headers=auth, json={"revision": 2}).json()
    assert restored["content"]["blocks"][1]["text"] == "한글 문서 작성과 자료 검색"


def test_viewer_permissions_and_exports(client, db, scene):
    auth, wid, _, _ = scene
    draft = create(client, scene)
    viewer = headers()
    uid = UUID(client.get("/api/me", headers=viewer).json()["id"])
    db.add(WorkspaceMember(workspace_id=wid, user_id=uid, role=Role.VIEWER))
    db.commit()
    base = f"/api/workspaces/{wid}/writing"
    url = f"{base}/{draft['id']}"
    assert client.get(url, headers=viewer).status_code == 200
    assert (
        client.post(
            base, headers=viewer, json={"request_id": str(uuid4()), "prompt": "작성"}
        ).status_code
        == 403
    )
    assert (
        client.patch(
            url, headers=viewer, json={"revision": 1, "content": draft["content"]}
        ).status_code
        == 403
    )
    for action in ("accept", "reject", "undo"):
        assert (
            client.post(url + "/" + action, headers=viewer, json={"revision": 1}).status_code == 403
        )
    for format in ("hwpx", "docx"):
        response = client.get(url + f"/export/{format}?revision=1", headers=viewer)
        assert response.status_code == 200, response.text
        assert response.headers["x-document-revision"] == "1"
        assert "filename*=UTF-8''" in response.headers["content-disposition"]
        with ZipFile(io.BytesIO(response.content)) as archive:
            assert archive.testzip() is None
        parsed = normalize(response.content, f"문서.{format}", "a" * 64)
        text = " ".join(b["text"] for b in parsed["blocks"])
        for expected in (
            "프로젝트 소개서",
            "추진 배경",
            "한글 문서 작성",
            "자료 확인",
            "예산",
            "확인 필요",
        ):
            assert expected in text
        if format == "hwpx":
            with HwpxDocument.open(response.content) as doc:
                assert not doc.validate().issues
        assert client.get(url + f"/export/{format}?revision=9", headers=auth).status_code == 409
        assert client.get(url + f"/export/{format}", headers=headers()).status_code == 404


def test_bad_ai_citations_leave_no_draft_and_can_retry(client, db, scene):
    auth, wid, _, writer = scene
    writer.invalid = True
    body = {"request_id": str(uuid4()), "prompt": "문서를 작성해줘"}
    url = f"/api/workspaces/{wid}/writing"
    assert client.post(url, headers=auth, json=body).status_code == 503
    assert db.scalar(select(func.count()).select_from(WritingDraft)) == 0
    writer.invalid = False
    assert client.post(url, headers=auth, json=body).status_code == 201


@pytest.mark.parametrize("role", [Role.OWNER, Role.EDITOR])
def test_delete_draft_checks_revision_and_removes_saved_state(client, db, scene, role):
    auth, wid, _, _ = scene
    draft = create(client, scene)
    base = f"/api/workspaces/{wid}/writing"
    url = f"{base}/{draft['id']}"
    if role == Role.EDITOR:
        auth = headers()
        uid = UUID(client.get("/api/me", headers=auth).json()["id"])
        db.add(WorkspaceMember(workspace_id=wid, user_id=uid, role=role))
        db.commit()
    content = draft["content"]
    content["title"] = "직접 수정한 제목"
    client.patch(url, headers=auth, json={"revision": 1, "content": content})
    proposed = client.post(
        url + "/propose",
        headers=auth,
        json={"request_id": str(uuid4()), "prompt": "수정해줘", "revision": 2},
    ).json()
    assert proposed["proposal"] and proposed["can_undo"]
    assert client.delete(url, headers=auth).status_code == 422
    assert client.delete(url + "?revision=1", headers=auth).status_code == 409
    assert client.get(url, headers=auth).status_code == 200
    deleted = client.delete(url + "?revision=3", headers=auth)
    assert deleted.status_code == 204 and deleted.content == b""
    assert client.get(base, headers=auth).json() == []
    assert client.get(url, headers=auth).status_code == 404
    assert client.get(url + "/export/docx", headers=auth).status_code == 404
    assert client.post(url + "/undo", headers=auth, json={"revision": 3}).status_code == 404
    assert db.scalar(select(func.count()).select_from(WritingDraft)) == 0
    assert db.scalar(select(func.count()).select_from(CanvasElement)) == 1
    assert db.scalar(select(func.count()).select_from(ChatMessage)) == 1


def test_delete_draft_permissions_and_workspace_isolation(client, db, scene):
    auth, wid, _, _ = scene
    draft = create(client, scene)
    url = f"/api/workspaces/{wid}/writing/{draft['id']}?revision=1"
    viewer = headers()
    uid = UUID(client.get("/api/me", headers=viewer).json()["id"])
    db.add(WorkspaceMember(workspace_id=wid, user_id=uid, role=Role.VIEWER))
    db.commit()
    assert client.delete(url).status_code == 401
    assert client.delete(url, headers=viewer).status_code == 403
    assert client.delete(url, headers=headers()).status_code == 404
    other = client.post("/api/workspaces", headers=auth, json={"name": "다른 공간"}).json()["id"]
    assert client.delete(url.replace(str(wid), other), headers=auth).status_code == 404
    assert db.scalar(select(func.count()).select_from(WritingDraft)) == 1
