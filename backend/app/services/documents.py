from datetime import datetime, timezone
from pathlib import PurePath
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session, selectinload

from app.auth.dependencies import check_workspace_role
from app.core.config import get_settings
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.domain import Role, User, Workspace, WorkspaceMember
from app.models.processing import DocumentProcessing, ProcessingState
from app.schemas.documents import ALLOWED_TYPES, UploadCreate, UploadTicket
from app.storage.s3 import S3Storage

WRITERS = (Role.OWNER, Role.EDITOR)
AVAILABLE = (VersionStatus.UPLOADED, VersionStatus.PROCESSING, VersionStatus.READY)


def document_for_user(db: Session, document_id: UUID, user_id: UUID) -> Document:
    document = db.scalar(
        select(Document)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Document.workspace_id)
        .join(Workspace, Workspace.id == Document.workspace_id)
        .where(
            Document.id == document_id, WorkspaceMember.user_id == user_id,
            Workspace.deleted_at.is_(None), Document.deleted_at.is_(None),
        )
        .options(selectinload(Document.versions))
    )
    if document is None:
        raise HTTPException(404, "Document not found")
    return document


def version_for_user(
    db: Session, version_id: UUID, user_id: UUID, write=False, lock=False
) -> DocumentVersion:
    query = (
        select(DocumentVersion, WorkspaceMember)
        .join(Document, Document.id == DocumentVersion.document_id)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Document.workspace_id)
        .join(Workspace, Workspace.id == Document.workspace_id)
        .where(
            DocumentVersion.id == version_id, WorkspaceMember.user_id == user_id,
            Workspace.deleted_at.is_(None), Document.deleted_at.is_(None),
        )
    )
    if lock:
        query = query.with_for_update(of=DocumentVersion).execution_options(populate_existing=True)
    row = db.execute(query).first()
    if row is None:
        raise HTTPException(404, "Document version not found")
    version, member = row
    if write:
        check_workspace_role(member, WRITERS)
    return version


def ticket(storage: S3Storage, version: DocumentVersion) -> UploadTicket:
    if version.source_version_id is not None or version.status != VersionStatus.UPLOADING:
        raise HTTPException(409, "This version no longer accepts uploads")
    expires = get_settings().s3_presigned_url_ttl
    url, headers = storage.upload_url(version, expires)
    return UploadTicket(
        document_id=version.document_id,
        version_id=version.id,
        upload_url=url,
        headers=headers,
        expires_in=expires,
    )


def create_upload(
    db: Session, user: User, workspace_id: UUID, data: UploadCreate, storage: S3Storage
) -> UploadTicket:
    settings = get_settings()
    if data.size > settings.max_upload_bytes:
        raise HTTPException(413, f"File exceeds the {settings.max_upload_bytes} byte upload limit")
    workspace = db.get(Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(404, "Workspace not found")
    try:
        document_id = db.scalar(
            insert(Document)
            .values(
                id=uuid4(),
                workspace_id=workspace_id,
                title=data.title,
                created_by=user.id,
                upload_request_id=data.request_id,
            )
            .on_conflict_do_nothing(constraint="uq_document_upload_request")
            .returning(Document.id)
        )
        if document_id is None:
            document = db.scalar(
                select(Document).where(
                    Document.workspace_id == workspace_id,
                    Document.created_by == user.id,
                    Document.upload_request_id == data.request_id,
                )
            )
            version = db.scalar(
                select(DocumentVersion).where(
                    DocumentVersion.document_id == document.id,
                    DocumentVersion.version_number == 1,
                )
            )
            if (document.title, version.original_filename, version.size, version.sha256) != (
                data.title,
                data.filename,
                data.size,
                data.sha256,
            ):
                raise HTTPException(409, "Request ID already used with different upload metadata")
        else:
            version_id = uuid4()
            suffix = PurePath(data.filename).suffix.lower()
            key = (
                f"teams/{workspace.team_id}/workspaces/{workspace_id}/documents/{document_id}"
                f"/versions/{version_id}/original{suffix}"
            )
            version = DocumentVersion(
                id=version_id,
                document_id=document_id,
                version_number=1,
                upload_request_id=data.request_id,
                storage_bucket=settings.aws_s3_bucket,
                storage_key=key,
                original_filename=data.filename,
                mime_type=ALLOWED_TYPES[suffix],
                size=data.size,
                sha256=data.sha256,
                created_by=user.id,
                status=VersionStatus.UPLOADING,
            )
            db.add(version)
            db.flush()
        result = ticket(storage, version)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def complete_upload(db: Session, user_id: UUID, version_id: UUID, storage: S3Storage) -> Document:
    try:
        # All version mutations lock the parent first, then the version.
        candidate = version_for_user(db, version_id, user_id, write=True)
        document = db.scalar(
            select(Document).where(Document.id == candidate.document_id).with_for_update()
        )
        version = version_for_user(db, version_id, user_id, write=True, lock=True)
        if version.uploaded_at is not None or version.status in AVAILABLE:
            return document_for_user(db, version.document_id, user_id)
        if version.status != VersionStatus.UPLOADING:
            raise HTTPException(409, "This upload cannot be completed; start a new upload")
        try:
            storage.verify_upload(version)
        except HTTPException as exc:
            if exc.status_code == 422:
                version.status = VersionStatus.FAILED
                db.commit()
            raise
        version.status = VersionStatus.UPLOADED
        version.uploaded_at = datetime.now(timezone.utc)
        db.add(DocumentProcessing(version_id=version.id, state=ProcessingState.QUEUED))
        document = db.get(Document, version.document_id)
        if document.current_version_id is None:
            document.current_version_id = version.id
        document.updated_at = datetime.now(timezone.utc)
        db.commit()
        return document_for_user(db, document.id, user_id)
    except Exception:
        db.rollback()
        raise
