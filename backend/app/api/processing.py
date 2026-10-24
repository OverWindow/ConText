import json
from uuid import UUID

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.db.session import get_db
from app.models.documents import VersionStatus
from app.models.domain import User
from app.models.processing import DocumentProcessing, ProcessingState
from app.processing.engine import now, read_object
from app.processing.parsers import ParseError
from app.services.documents import version_for_user
from app.storage.s3 import get_storage

router = APIRouter(prefix="/api/versions")


def serialize(job):
    return {
        "version_id": job.version_id,
        "state": job.state,
        "attempts": job.attempts,
        "queued_at": job.queued_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "summary": job.summary,
    }


@router.get("/{version_id}/processing")
def status(
    version_id: UUID,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    version_for_user(db, version_id, user.id)
    job = db.get(DocumentProcessing, version_id)
    if not job:
        raise HTTPException(409, "원본 업로드를 먼저 완료해 주세요.")
    response.headers["Cache-Control"] = "no-store"
    return serialize(job)


@router.post("/{version_id}/process", status_code=202)
def retry(version_id: UUID, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    version = version_for_user(db, version_id, user.id, write=True)
    if not version.uploaded_at:
        raise HTTPException(409, "원본 업로드를 먼저 완료해 주세요.")
    job = db.get(DocumentProcessing, version_id, with_for_update=True)
    if job and job.state != ProcessingState.FAILED:
        return serialize(job)
    if not job:
        job = DocumentProcessing(version_id=version_id)
        db.add(job)
    job.state, job.attempts = ProcessingState.QUEUED, 0
    job.queued_at = now()
    job.dispatched_at = job.started_at = job.finished_at = job.run_token = None
    job.error_code = job.error_message = None
    version.status = VersionStatus.UPLOADED
    db.commit()
    return serialize(job)


@router.get("/{version_id}/content")
def content(
    version_id: UUID,
    response: Response,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    version = version_for_user(db, version_id, user.id)
    job = db.get(DocumentProcessing, version_id)
    if not job or job.state != ProcessingState.COMPLETED or not job.normalized_key:
        raise HTTPException(409, "아직 문서 처리가 완료되지 않았습니다.")
    try:
        result = json.loads(
            read_object(get_storage(), version.storage_bucket, job.normalized_key, 32 * 1024 * 1024)
        )
    except (BotoCoreError, ClientError, ParseError, ValueError) as exc:
        raise HTTPException(503, "처리된 문서를 불러오지 못했습니다. 다시 시도해 주세요.") from exc
    blocks = result.pop("blocks")
    response.headers["Cache-Control"] = "no-store"
    return {
        **result,
        "blocks": blocks[offset : offset + limit],
        "total": len(blocks),
        "offset": offset,
        "next_offset": offset + limit if offset + limit < len(blocks) else None,
    }
