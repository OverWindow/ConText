from datetime import datetime, timezone
from pathlib import PurePath
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.auth.dependencies import check_workspace_role
from app.core.config import get_settings
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.domain import User, Workspace, WorkspaceMember
from app.models.processing import DocumentProcessing, ProcessingState
from app.schemas.documents import ALLOWED_TYPES, VersionLink, VersionUpload
from app.services.documents import WRITERS, document_for_user, ticket, version_for_user
from app.storage.s3 import S3Storage


def locked_document(db: Session, document_id: UUID, user_id: UUID):
    # Authorize before locking or looking up another user's metadata.
    document_for_user(db, document_id, user_id)
    document = db.scalar(
        select(Document)
        .where(Document.id == document_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    member = db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == document.workspace_id,
            WorkspaceMember.user_id == user_id,
        )
    )
    check_workspace_role(member, WRITERS)
    return document


def previous_request(db, document_id, user_id, request_id):
    return db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == document_id,
            DocumentVersion.created_by == user_id,
            DocumentVersion.upload_request_id == request_id,
        )
    )


def next_number(db, document_id, sha256, size):
    duplicate = db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == document_id,
            DocumentVersion.sha256 == sha256,
            DocumentVersion.size == size,
            or_(
                DocumentVersion.uploaded_at.is_not(None),
                DocumentVersion.status != VersionStatus.FAILED,
            ),
        )
    )
    if duplicate:
        raise HTTPException(
            409,
            f"동일한 파일이 이미 수정 이력 {duplicate.version_number}에 있습니다. "
            "기존 수정 이력을 확인해 주세요.",
        )
    number = (
        db.scalar(
            select(func.max(DocumentVersion.version_number)).where(
                DocumentVersion.document_id == document_id
            )
        )
        or 0
    ) + 1
    if number > 500:
        raise HTTPException(409, "문서당 최대 500개 수정 이력까지 등록할 수 있습니다.")
    return number


def create_version(
    db: Session, user: User, document_id: UUID, data: VersionUpload, storage: S3Storage
):
    try:
        doc = locked_document(db, document_id, user.id)
        settings = get_settings()
        if data.size > settings.max_upload_bytes:
            raise HTTPException(413, "파일 크기가 업로드 한도를 초과했습니다.")
        version = previous_request(db, document_id, user.id, data.request_id)
        if version:
            if (
                version.original_filename,
                version.size,
                version.sha256,
                version.change_note,
                version.source_version_id,
            ) != (data.filename, data.size, data.sha256, data.change_note, None):
                raise HTTPException(
                    409, "다른 내용에 사용된 업로드 요청입니다. 파일을 다시 선택해 주세요."
                )
        else:
            number = next_number(db, document_id, data.sha256, data.size)
            workspace = db.get(Workspace, doc.workspace_id)
            version_id = uuid4()
            suffix = PurePath(data.filename).suffix.lower()
            version = DocumentVersion(
                id=version_id,
                document_id=doc.id,
                version_number=number,
                storage_bucket=settings.aws_s3_bucket,
                storage_key=f"teams/{workspace.team_id}/workspaces/{workspace.id}/documents/{doc.id}/versions/{version_id}/original{suffix}",
                original_filename=data.filename,
                mime_type=ALLOWED_TYPES[suffix],
                size=data.size,
                sha256=data.sha256,
                created_by=user.id,
                status=VersionStatus.UPLOADING,
                upload_request_id=data.request_id,
                change_note=data.change_note,
            )
            db.add(version)
            doc.updated_at = datetime.now(timezone.utc)
            db.flush()
        result = ticket(storage, version)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def link_version(db: Session, user: User, document_id: UUID, data: VersionLink):
    try:
        doc = locked_document(db, document_id, user.id)
        source = version_for_user(db, data.source_version_id, user.id)
        source_doc = db.get(Document, source.document_id)
        if source_doc.workspace_id != doc.workspace_id:
            raise HTTPException(404, "같은 워크스페이스의 원본 수정 이력만 연결할 수 있습니다.")
        if source.document_id == document_id:
            raise HTTPException(409, "이미 이 문서에 속한 수정 이력입니다.")
        if not source.uploaded_at:
            raise HTTPException(409, "업로드가 검증된 수정 이력만 연결할 수 있습니다.")
        existing = previous_request(db, document_id, user.id, data.request_id)
        if existing:
            if existing.source_version_id != source.id or existing.change_note != data.change_note:
                raise HTTPException(409, "다른 연결에 사용된 요청입니다. 다시 시도해 주세요.")
        else:
            version = DocumentVersion(
                id=uuid4(),
                document_id=doc.id,
                version_number=next_number(db, doc.id, source.sha256, source.size),
                # Originals are immutable. Both records reference the same verified object.
                storage_bucket=source.storage_bucket,
                storage_key=source.storage_key,
                original_filename=source.original_filename,
                mime_type=source.mime_type,
                size=source.size,
                sha256=source.sha256,
                created_by=user.id,
                status=VersionStatus.UPLOADED,
                uploaded_at=source.uploaded_at,
                upload_request_id=data.request_id,
                source_version_id=source.id,
                change_note=data.change_note,
            )
            db.add(version)
            db.flush()
            db.add(DocumentProcessing(version_id=version.id, state=ProcessingState.QUEUED))
            if doc.current_version_id is None:
                doc.current_version_id = version.id
            doc.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.expire_all()
        return document_for_user(db, doc.id, user.id)
    except Exception:
        db.rollback()
        raise


def set_current(db: Session, user_id: UUID, document_id: UUID, version_id: UUID):
    try:
        doc = locked_document(db, document_id, user_id)
        version = db.get(DocumentVersion, version_id)
        if not version or version.document_id != doc.id:
            raise HTTPException(404, "문서 수정 이력을 찾을 수 없습니다.")
        if not version.uploaded_at:
            raise HTTPException(
                409, "업로드가 검증된 수정 이력만 현재 수정 이력으로 지정할 수 있습니다."
            )
        doc.current_version_id = version.id
        doc.updated_at = datetime.now(timezone.utc)
        db.commit()
        return document_for_user(db, doc.id, user_id)
    except Exception:
        db.rollback()
        raise
