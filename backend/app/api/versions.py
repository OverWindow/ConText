from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user, require_workspace_member
from app.db.session import get_db
from app.models.documents import Document, DocumentVersion
from app.models.domain import User, WorkspaceMember
from app.schemas.documents import (
    CurrentVersion,
    DocumentRead,
    UploadTicket,
    VersionLink,
    VersionRead,
    VersionUpload,
)
from app.services import versions
from app.services.documents import document_for_user
from app.storage.s3 import get_storage

router = APIRouter(prefix="/api", tags=["versions"])


@router.post(
    "/documents/{document_id}/versions/upload-url", response_model=UploadTicket, status_code=201
)
def upload(
    document_id: UUID,
    data: VersionUpload,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    versions.locked_document(db, document_id, user.id)
    response.headers["Cache-Control"] = "no-store"
    return versions.create_version(db, user, document_id, data, get_storage())


@router.post("/documents/{document_id}/versions/link", response_model=DocumentRead, status_code=201)
def link(
    document_id: UUID,
    data: VersionLink,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return versions.link_version(db, user, document_id, data)


@router.patch("/documents/{document_id}/current-version", response_model=DocumentRead)
def current(
    document_id: UUID,
    data: CurrentVersion,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return versions.set_current(db, user.id, document_id, data.version_id)


@router.get("/workspaces/{workspace_id}/duplicates")
def duplicates(
    workspace_id: UUID,
    response: Response,
    sha256: str = Query(pattern=r"^[a-f0-9]{64}$"),
    size: int = Query(gt=0),
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    rows = db.execute(
        select(DocumentVersion, Document.title)
        .join(Document, Document.id == DocumentVersion.document_id)
        .where(
            Document.workspace_id == workspace_id,
            DocumentVersion.sha256 == sha256,
            DocumentVersion.size == size,
            DocumentVersion.uploaded_at.is_not(None),
        )
        .order_by(DocumentVersion.created_at.desc(), DocumentVersion.id)
        .limit(20)
    ).all()
    response.headers["Cache-Control"] = "no-store"
    return [
        {
            "document_id": version.document_id,
            "document_title": title,
            "version": VersionRead.model_validate(version),
        }
        for version, title in rows
    ]


@router.get("/documents/{document_id}/compare")
def compare(
    document_id: UUID,
    response: Response,
    left: UUID,
    right: UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    document = document_for_user(db, document_id, user.id)
    by_id = {v.id: v for v in document.versions}
    if left not in by_id or right not in by_id:
        raise HTTPException(404, "이 문서에 속한 수정 이력만 비교할 수 있습니다.")
    if left == right:
        raise HTTPException(422, "서로 다른 두 수정 이력을 선택해 주세요.")
    a, b = by_id[left], by_id[right]
    response.headers["Cache-Control"] = "no-store"
    return {
        "left": VersionRead.model_validate(a),
        "right": VersionRead.model_validate(b),
        "identical": bool(
            a.uploaded_at and b.uploaded_at and a.sha256 == b.sha256 and a.size == b.size
        ),
    }
