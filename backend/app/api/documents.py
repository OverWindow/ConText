from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.auth.dependencies import get_current_user, require_workspace_member, require_workspace_role
from app.core.config import get_settings
from app.db.session import get_db
from app.models.documents import Document
from app.models.domain import User, WorkspaceMember
from app.schemas.documents import (
    DocumentCopy,
    DocumentCopyRead,
    DocumentRead,
    DownloadTicket,
    UploadComplete,
    UploadCreate,
    UploadTicket,
)
from app.services.document_copy import copy_document
from app.services.documents import (
    AVAILABLE,
    WRITERS,
    complete_upload,
    create_upload,
    document_for_user,
    ticket,
    version_for_user,
)
from app.storage.s3 import get_storage

router = APIRouter(prefix="/api", tags=["documents"])


@router.get("/workspaces/{workspace_id}/documents", response_model=list[DocumentRead])
def list_documents(
    workspace_id: UUID,
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
    limit: int = Query(100, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    return db.scalars(
        select(Document)
        .where(Document.workspace_id == workspace_id, Document.deleted_at.is_(None))
        .options(selectinload(Document.versions))
        .order_by(Document.created_at.desc(), Document.id)
        .limit(limit)
        .offset(offset)
    ).all()


@router.post(
    "/workspaces/{workspace_id}/documents/upload-url", response_model=UploadTicket, status_code=201
)
def upload_url(
    workspace_id: UUID,
    data: UploadCreate,
    response: Response,
    member: WorkspaceMember = Depends(require_workspace_role(WRITERS)),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    return create_upload(db, user, workspace_id, data, get_storage())


@router.get("/documents/{document_id}", response_model=DocumentRead)
def get_document(
    document_id: UUID, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    return document_for_user(db, document_id, user.id)


@router.post("/versions/{version_id}/upload-url", response_model=UploadTicket)
def retry_upload(
    version_id: UUID,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    version = version_for_user(db, version_id, user.id, write=True)
    response.headers["Cache-Control"] = "no-store"
    return ticket(get_storage(), version)


@router.post("/documents/upload-complete", response_model=DocumentRead)
def upload_complete(
    data: UploadComplete, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    # Authorize before even attempting to construct a storage client.
    version_for_user(db, data.version_id, user.id, write=True)
    return complete_upload(db, user.id, data.version_id, get_storage())


@router.post("/versions/{version_id}/download-url", response_model=DownloadTicket)
def download_url(
    version_id: UUID,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    version = version_for_user(db, version_id, user.id)
    if version.uploaded_at is None and version.status not in AVAILABLE:
        raise HTTPException(409, "File upload has not been verified")
    expires = get_settings().s3_presigned_url_ttl
    response.headers["Cache-Control"] = "no-store"
    return DownloadTicket(
        download_url=get_storage().download_url(version, expires), expires_in=expires
    )


@router.post("/documents/{document_id}/copy", response_model=DocumentCopyRead, status_code=201)
def duplicate_document(
    document_id: UUID,
    data: DocumentCopy,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return copy_document(db, user, document_id, data)
