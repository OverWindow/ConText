from pathlib import PurePosixPath
from typing import Literal
from urllib.parse import quote
from uuid import UUID

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.conversion.renderers import MIME
from app.core.config import get_settings
from app.db.session import get_db
from app.models.conversion import DocumentConversion
from app.models.domain import User
from app.models.processing import DocumentProcessing, ProcessingState
from app.processing.engine import now
from app.services.documents import version_for_user
from app.storage.s3 import get_storage

Format = Literal["pdf", "docx", "txt", "md"]
router = APIRouter(prefix="/api/versions", tags=["conversion"])


def serialize(job):
    return {
        key: getattr(job, key)
        for key in (
            "version_id",
            "format",
            "state",
            "attempts",
            "queued_at",
            "started_at",
            "finished_at",
            "error_code",
            "error_message",
            "size",
            "sha256",
            "warnings",
        )
    }


@router.get("/{version_id}/conversions")
def list_conversions(
    version_id: UUID,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    version_for_user(db, version_id, user.id)
    response.headers["Cache-Control"] = "no-store"
    return [
        serialize(job)
        for job in db.scalars(
            select(DocumentConversion)
            .where(DocumentConversion.version_id == version_id)
            .order_by(DocumentConversion.format)
        )
    ]


@router.post("/{version_id}/conversions/{format}", status_code=202)
def request_conversion(
    version_id: UUID,
    format: Format,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Read-only derivatives are available to VIEWER too. Lock the version to serialize requests.
    version_for_user(db, version_id, user.id, lock=True)
    processing = db.get(DocumentProcessing, version_id)
    if (
        not processing
        or processing.state != ProcessingState.COMPLETED
        or not processing.normalized_key
    ):
        raise HTTPException(409, "문서 처리가 완료된 뒤 내보낼 수 있습니다.")
    job = db.get(DocumentConversion, (version_id, format), with_for_update=True)
    if job is None:
        job = DocumentConversion(
            version_id=version_id, format=format, source_key=processing.normalized_key
        )
        db.add(job)
    elif job.state == "FAILED":
        job.state, job.attempts, job.queued_at = "QUEUED", 0, now()
        job.run_token = job.dispatched_at = job.started_at = job.finished_at = None
        job.error_code = job.error_message = None
        job.source_key = processing.normalized_key
    db.commit()
    response.headers["Cache-Control"] = "no-store"
    return serialize(job)


@router.post("/{version_id}/conversions/{format}/download-url")
def download(
    version_id: UUID,
    format: Format,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    version = version_for_user(db, version_id, user.id)
    job = db.get(DocumentConversion, (version_id, format))
    if not job or job.state != "COMPLETED" or not job.output_key:
        raise HTTPException(409, "변환이 완료된 뒤 다운로드할 수 있습니다.")
    expires = get_settings().s3_presigned_url_ttl
    filename = (
        f"{PurePosixPath(version.original_filename).stem[:180]}-v{version.version_number}.{format}"
    )
    try:
        url = get_storage().client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": version.storage_bucket,
                "Key": job.output_key,
                "ResponseContentDisposition": f'attachment; filename="document.{format}"; '
                "filename*=UTF-8''" + quote(filename, safe=""),
                "ResponseContentType": MIME[format],
            },
            ExpiresIn=expires,
        )
    except (BotoCoreError, ClientError) as exc:
        raise HTTPException(503, "변환 파일 저장소에 연결하지 못했습니다.") from exc
    response.headers["Cache-Control"] = "no-store"
    return {"download_url": url, "expires_in": expires, "filename": filename}
