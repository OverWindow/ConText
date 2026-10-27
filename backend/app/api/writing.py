from typing import Literal
from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.ai.connections import selected_service
from app.ai.provider import AIUnavailable
from app.auth.dependencies import require_workspace_member, require_workspace_role
from app.conversion.renderers import render_docx
from app.db.session import get_db
from app.models.domain import Role, WorkspaceMember
from app.models.writing import WritingDraft
from app.schemas.writing import BlankRequest, GenerateRequest, RevisionRequest, SaveRequest
from app.services import writing


def no_store(response: Response):
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(
    prefix="/api/workspaces/{workspace_id}/writing",
    tags=["writing"],
    dependencies=[Depends(no_store)],
)
edit = require_workspace_role((Role.OWNER, Role.EDITOR))


def read(d):
    return {
        "id": d.id,
        "title": d.title,
        "revision": d.revision,
        "content": d.content,
        "sources": d.sources,
        "checks": d.checks,
        "proposal": d.proposal,
        "can_undo": bool(d.history),
        "updated_at": d.updated_at,
    }


def find(db, workspace_id, draft_id, revision=None):
    query = select(WritingDraft).where(
        WritingDraft.id == draft_id, WritingDraft.workspace_id == workspace_id
    )
    if revision is not None:
        query = query.with_for_update().execution_options(populate_existing=True)
    d = db.scalar(query)
    if not d:
        raise HTTPException(404, "문서를 찾을 수 없습니다.")
    if revision is not None and d.revision != revision:
        raise HTTPException(409, "다른 곳에서 문서가 변경됐습니다. 저장된 문서를 다시 열어 주세요.")
    return d


def generate(db, workspace_id, prompt, current=None, user_id=None):
    try:
        service = selected_service(db, user_id) if user_id else None
        return writing.generate(db, workspace_id, prompt, current, service)
    except AIUnavailable as exc:
        messages = {
            "AI_NOT_CONFIGURED": "서버에 ChatKHU API 키를 설정해 주세요.",
            "AI_FORBIDDEN": "ChatKHU API 키와 모델 사용 권한을 확인해 주세요.",
            "AI_INVALID_RESPONSE": (
                "AI 문서 형식 또는 출처를 검증하지 못했습니다. 다시 요청해 주세요."
            ),
        }
        raise HTTPException(
            503, messages.get(exc.code, "AI 작성에 실패했습니다. 다시 시도해 주세요.")
        ) from exc


@router.get("")
def listing(
    workspace_id: UUID,
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(WritingDraft)
        .where(WritingDraft.workspace_id == workspace_id)
        .order_by(WritingDraft.updated_at.desc())
        .limit(100)
    ).all()
    return [{"id": d.id, "title": d.title, "revision": d.revision} for d in rows]


@router.post("", status_code=201)
def create(
    workspace_id: UUID,
    data: GenerateRequest,
    member: WorkspaceMember = Depends(edit),
    db: Session = Depends(get_db),
):
    query = select(WritingDraft).where(
        WritingDraft.workspace_id == workspace_id,
        WritingDraft.created_by == member.user_id,
        WritingDraft.request_id == data.request_id,
    )
    previous = db.scalar(query)
    if previous:
        if previous.prompt != data.prompt:
            raise HTTPException(409, "다른 작성 요청에 사용된 식별자입니다.")
        return read(previous)
    result = generate(db, workspace_id, data.prompt, user_id=member.user_id)
    draft = WritingDraft(
        workspace_id=workspace_id,
        created_by=member.user_id,
        request_id=data.request_id,
        title=result["content"]["title"],
        prompt=data.prompt,
        **result,
    )
    db.add(draft)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        previous = db.scalar(query)
        if not previous or previous.prompt != data.prompt:
            raise HTTPException(409, "동시에 문서가 생성됐습니다. 목록을 확인해 주세요.")
        return read(previous)
    return read(draft)


@router.post("/blank", status_code=201)
def create_blank(
    workspace_id: UUID,
    data: BlankRequest,
    member: WorkspaceMember = Depends(edit),
    db: Session = Depends(get_db),
):
    query = select(WritingDraft).where(
        WritingDraft.workspace_id == workspace_id,
        WritingDraft.created_by == member.user_id,
        WritingDraft.request_id == data.request_id,
    )
    previous = db.scalar(query)
    if previous:
        if previous.prompt:
            raise HTTPException(409, "다른 작성 요청에 사용된 식별자입니다.")
        return read(previous)
    content = {
        "title": "새 문서",
        "blocks": [
            {
                "id": str(uuid4()),
                "type": "paragraph",
                "text": "",
                "level": 2,
                "items": [],
                "rows": [],
                "source_ids": [],
            }
        ],
    }
    draft = WritingDraft(
        workspace_id=workspace_id,
        created_by=member.user_id,
        request_id=data.request_id,
        title=content["title"],
        content=content,
        sources=[],
        checks=[],
        history=[],
        prompt="",
    )
    db.add(draft)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        draft = db.scalar(query)
        if not draft or draft.prompt:
            raise HTTPException(409, "동시에 문서가 생성됐습니다. 목록을 확인해 주세요.")
    return read(draft)


@router.get("/{draft_id}")
def detail(
    workspace_id: UUID,
    draft_id: UUID,
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    return read(find(db, workspace_id, draft_id))


@router.patch("/{draft_id}")
def save(
    workspace_id: UUID,
    draft_id: UUID,
    data: SaveRequest,
    member: WorkspaceMember = Depends(edit),
    db: Session = Depends(get_db),
):
    draft = find(db, workspace_id, draft_id, data.revision)
    allowed = {s["id"] for s in draft.sources}
    if any(ref not in allowed for b in data.content.blocks for ref in b.source_ids):
        raise HTTPException(422, "문서에 연결되지 않은 출처입니다.")
    content = data.content.model_dump()
    if draft.content != content:
        writing.checkpoint(draft)
        draft.content = content
        draft.title = content["title"]
        warning = "직접 수정한 내용은 연결된 출처와 다시 대조해 주세요."
        draft.checks = list(dict.fromkeys([*draft.checks, warning]))
        draft.revision += 1
        draft.proposal = None
        db.commit()
    return read(draft)


@router.delete("/{draft_id}", status_code=204)
def delete(
    workspace_id: UUID,
    draft_id: UUID,
    revision: int = Query(ge=1),
    member: WorkspaceMember = Depends(edit),
    db: Session = Depends(get_db),
):
    draft = find(db, workspace_id, draft_id, revision)
    db.delete(draft)
    db.commit()
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.post("/{draft_id}/propose")
def propose(
    workspace_id: UUID,
    draft_id: UUID,
    data: GenerateRequest,
    member: WorkspaceMember = Depends(edit),
    db: Session = Depends(get_db),
):
    if data.revision is None:
        raise HTTPException(422, "문서 버전이 필요합니다.")
    draft = find(db, workspace_id, draft_id)
    if draft.proposal and draft.proposal.get("request_id") == str(data.request_id):
        if draft.proposal["prompt"] != data.prompt:
            raise HTTPException(409, "다른 수정 요청에 사용된 식별자입니다.")
        return read(draft)
    draft = find(db, workspace_id, draft_id, data.revision)
    result = generate(db, workspace_id, data.prompt, draft, member.user_id)
    draft.proposal = {**result, "request_id": str(data.request_id), "prompt": data.prompt}
    draft.revision += 1
    db.commit()
    return read(draft)


@router.post("/{draft_id}/{action}")
def action(
    workspace_id: UUID,
    draft_id: UUID,
    action: Literal["accept", "reject", "undo"],
    data: RevisionRequest,
    member: WorkspaceMember = Depends(edit),
    db: Session = Depends(get_db),
):
    draft = find(db, workspace_id, draft_id, data.revision)
    if action == "undo":
        if not draft.history:
            raise HTTPException(409, "되돌릴 저장 이력이 없습니다.")
        snapshot = draft.history[-1]
        draft.history = draft.history[:-1]
        for key in ("content", "sources", "checks"):
            setattr(draft, key, snapshot[key])
        draft.title = draft.content["title"]
    elif action == "accept":
        if not draft.proposal:
            raise HTTPException(409, "적용할 수정안이 없습니다.")
        writing.checkpoint(draft)
        for key in ("content", "sources", "checks"):
            setattr(draft, key, draft.proposal[key])
        draft.title = draft.content["title"]
    draft.proposal = None
    draft.revision += 1
    db.commit()
    return read(draft)


@router.get("/{draft_id}/export/{format}")
def export(
    workspace_id: UUID,
    draft_id: UUID,
    format: Literal["docx", "hwpx"],
    revision: int | None = None,
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    draft = find(db, workspace_id, draft_id)
    if revision is not None and revision != draft.revision:
        raise HTTPException(409, "다른 곳에서 문서가 변경됐습니다. 저장된 문서를 다시 열어 주세요.")
    blocks = writing.normalized(draft.content)["blocks"]
    if format == "docx":
        data = render_docx(blocks)
        mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    else:
        from app.writing_export import render_hwpx

        data = render_hwpx(blocks)
        mime = "application/hwp+zip"
    return Response(
        data,
        media_type=mime,
        headers={
            "Cache-Control": "no-store",
            "X-Document-Revision": str(draft.revision),
            "Content-Disposition": "attachment; filename*=UTF-8''"
            + quote(draft.title, safe="")
            + "."
            + format,
        },
    )
