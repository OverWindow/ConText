"""Independent documents backed by immutable, verified source objects."""

from copy import deepcopy
from datetime import datetime, timezone
from pathlib import PurePath
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select

from app.models.canvas import DocumentPosition
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.domain import Workspace
from app.models.processing import DocumentProcessing, ProcessingState
from app.services.documents import document_for_user, version_for_user


def copy_document(db, user, document_id, data):
    try:
        source = version_for_user(db, data.version_id, user.id, write=True)
        if source.document_id != document_id:
            raise HTTPException(404, "복사할 문서 수정 이력을 찾을 수 없습니다.")
        original = document_for_user(db, document_id, user.id)
        # Serialize names and repeated requests, including concurrent clicks from other tabs.
        db.scalar(select(Workspace).where(Workspace.id == original.workspace_id).with_for_update())
        existing = db.scalar(
            select(Document).where(
                Document.workspace_id == original.workspace_id,
                Document.created_by == user.id,
                Document.upload_request_id == data.request_id,
            )
        )
        if existing:
            first = db.scalar(
                select(DocumentVersion).where(
                    DocumentVersion.document_id == existing.id,
                    DocumentVersion.version_number == 1,
                )
            )
            if not first or first.source_version_id != source.id:
                raise HTTPException(409, "다른 작업에 사용된 복사 요청입니다.")
            position = db.get(DocumentPosition, existing.id)
            result = {
                "document": document_for_user(db, existing.id, user.id),
                "x": position.x,
                "y": position.y,
            }
            db.commit()
            return result
        if not source.uploaded_at:
            raise HTTPException(409, "업로드가 완료된 파일만 복사할 수 있습니다.")
        names = set(
            db.scalars(
                select(DocumentVersion.original_filename)
                .join(Document, Document.id == DocumentVersion.document_id)
                .where(
                    Document.workspace_id == original.workspace_id,
                )
            )
        )
        suffix = PurePath(source.original_filename).suffix
        stem = source.original_filename[: -len(suffix)] if suffix else source.original_filename
        number = 1
        while True:
            label = " copy" if number == 1 else f" copy {number}"
            filename = stem[: 255 - len(suffix) - len(label)] + label + suffix
            if filename not in names:
                break
            number += 1
        document = Document(
            id=uuid4(),
            workspace_id=original.workspace_id,
            title=original.title[: 200 - len(label)] + label,
            created_by=user.id,
            upload_request_id=data.request_id,
        )
        db.add(document)
        db.flush()
        processing = db.get(DocumentProcessing, source.id)
        ready = (
            source.status == VersionStatus.READY
            and processing
            and processing.state == ProcessingState.COMPLETED
            and processing.normalized_key
        )
        version = DocumentVersion(
            id=uuid4(),
            document_id=document.id,
            version_number=1,
            upload_request_id=data.request_id,
            source_version_id=source.id,
            change_note="복사본 생성",
            storage_bucket=source.storage_bucket,
            storage_key=source.storage_key,
            original_filename=filename,
            mime_type=source.mime_type,
            size=source.size,
            sha256=source.sha256,
            created_by=user.id,
            uploaded_at=datetime.now(timezone.utc),
            status=VersionStatus.READY if ready else VersionStatus.UPLOADED,
        )
        db.add(version)
        db.flush()
        # Original and normalized objects are immutable; each copy owns its version/job state.
        db.add(
            DocumentProcessing(
                version_id=version.id,
                state=ProcessingState.COMPLETED if ready else ProcessingState.QUEUED,
                normalized_key=processing.normalized_key if ready else None,
                text_key=processing.text_key if ready else None,
                summary=deepcopy(processing.summary) if ready else None,
                finished_at=datetime.now(timezone.utc) if ready else None,
            )
        )
        document.current_version_id = version.id
        db.add(DocumentPosition(document_id=document.id, x=data.x, y=data.y, updated_by=user.id))
        db.commit()
        db.expire_all()
        return {"document": document_for_user(db, document.id, user.id), "x": data.x, "y": data.y}
    except Exception:
        db.rollback()
        raise
