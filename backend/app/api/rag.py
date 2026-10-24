from datetime import date, datetime, timedelta
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependencies import require_workspace_member, require_workspace_role
from app.db.session import get_db
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.domain import Role, WorkspaceMember
from app.models.rag import ChatMessage, ChatSession, RagIndex
from app.processing.engine import now
from app.rag import chat
from app.rag.indexing import enqueue, fingerprint, reset
from app.rag.retrieval import index_status, retrieve

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["rag"])


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=2000)
    scope: Literal["auto", "current", "history", "as_of"] = "auto"
    as_of: date | None = None

    @field_validator("question")
    @classmethod
    def strip_question(cls, value):
        if not value.strip():
            raise ValueError("질문을 입력해 주세요.")
        return value.strip()

    @model_validator(mode="after")
    def validate_date(self):
        if (self.scope == "as_of") != (self.as_of is not None):
            raise ValueError("기준일 검색에는 날짜가 필요합니다.")
        if self.as_of and self.as_of > datetime.now(ZoneInfo("Asia/Seoul")).date():
            raise ValueError("미래 날짜로 검색할 수 없습니다.")
        return self


class AskRequest(SearchRequest):
    request_id: UUID


class SessionRequest(BaseModel):
    request_id: UUID
    title: str = Field(default="새 대화", min_length=1, max_length=120)


def session_read(s):
    return {
        "id": s.id,
        "title": s.title,
        "created_by": s.created_by,
        "created_at": s.created_at,
        "updated_at": s.updated_at,
    }


def message_read(m):
    return {
        "id": m.id,
        "role": m.role,
        "sequence": m.sequence,
        "content": m.content,
        "state": m.state,
        "error_code": m.error_code,
        "options": m.options,
        "result": m.result,
        "created_by": m.created_by,
        "created_at": m.created_at,
        "finished_at": m.finished_at,
    }


@router.get("/rag/status")
def status(
    workspace_id: UUID,
    response: Response,
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    return {
        "current": index_status(db, workspace_id),
        "all": index_status(db, workspace_id, "history"),
    }


@router.post("/rag/reindex", status_code=202)
def reindex(
    workspace_id: UUID,
    response: Response,
    member: WorkspaceMember = Depends(require_workspace_role((Role.OWNER, Role.EDITOR))),
    db: Session = Depends(get_db),
):
    versions = db.scalars(
        select(DocumentVersion.id)
        .join(Document, Document.id == DocumentVersion.document_id)
        .where(Document.workspace_id == workspace_id, DocumentVersion.status == VersionStatus.READY)
        .order_by(DocumentVersion.created_at)
        .limit(500)
    ).all()
    count = 0
    for version_id in versions:
        enqueue(db, version_id)
        job = db.get(RagIndex, version_id, with_for_update=True)
        if job.state == "FAILED" and (
            not job.finished_at or job.finished_at < now() - timedelta(seconds=30)
        ):
            reset(job)
            count += 1
        elif job.fingerprint != fingerprint():
            # Dispatcher atomically invalidates old chunks before resuming a new model.
            count += 1
    db.commit()
    response.headers["Cache-Control"] = "no-store"
    return {"retried": count}


@router.post("/search")
def search(
    workspace_id: UUID,
    data: SearchRequest,
    response: Response,
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    return retrieve(
        db, workspace_id, data.question, data.scope, data.as_of.isoformat() if data.as_of else None
    )


@router.get("/chat/sessions")
def sessions(
    workspace_id: UUID,
    response: Response,
    offset: int = Query(0, ge=0, le=10000),
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    rows = db.scalars(
        select(ChatSession)
        .where(ChatSession.workspace_id == workspace_id)
        .order_by(ChatSession.updated_at.desc(), ChatSession.id)
        .offset(offset)
        .limit(50)
    ).all()
    return [session_read(s) for s in rows]


@router.post("/chat/sessions", status_code=201)
def create(
    workspace_id: UUID,
    data: SessionRequest,
    response: Response,
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    return session_read(
        chat.create_session(
            db, workspace_id, member.user_id, data.request_id, data.title.strip() or "새 대화"
        )
    )


@router.get("/chat/sessions/{session_id}/messages")
def messages(
    workspace_id: UUID,
    session_id: UUID,
    response: Response,
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    chat.session_for_workspace(db, workspace_id, session_id)
    response.headers["Cache-Control"] = "no-store"
    return [
        message_read(m)
        for m in db.scalars(
            select(ChatMessage)
            .where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.sequence)
        ).all()
    ]


@router.post("/chat/sessions/{session_id}/messages", status_code=202)
def ask(
    workspace_id: UUID,
    session_id: UUID,
    data: AskRequest,
    response: Response,
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    return message_read(chat.enqueue_turn(db, workspace_id, session_id, member.user_id, data))


@router.post("/chat/sessions/{session_id}/messages/{message_id}/retry", status_code=202)
def retry(
    workspace_id: UUID,
    session_id: UUID,
    message_id: UUID,
    response: Response,
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    return message_read(chat.retry(db, workspace_id, session_id, message_id))
