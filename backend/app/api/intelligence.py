from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.db.session import get_db
from app.intelligence.candidates import candidates
from app.intelligence.diff import compare_documents
from app.intelligence.engine import enqueue, job_key, load_document
from app.models.documents import VersionStatus
from app.models.domain import User
from app.models.intelligence import AnalysisJob
from app.processing.engine import now
from app.services.documents import version_for_user

router = APIRouter(prefix="/api", tags=["intelligence"])


class Pair(BaseModel):
    left: UUID
    right: UUID


def serialize(job):
    if not job:
        return {"state": "NOT_STARTED", "result": None}
    result = job.result
    if result and not job.base_version_id:
        # Embeddings and sampled source text are internal retrieval data.
        result = {
            key: result[key]
            for key in ("warnings", "text_truncated", "embedding_model", "provenance")
        }
        result["embedding_available"] = bool(job.result.get("embedding"))
    return {
        "state": job.state,
        "version_id": job.version_id,
        "base_version_id": job.base_version_id,
        "attempts": job.attempts,
        "finished_at": job.finished_at,
        "error_code": job.error_code,
        "result": result,
    }


def request_job(db, version_id, base_id=None):
    key = enqueue(db, version_id, base_id)
    job = db.get(AnalysisJob, key, with_for_update=True)
    # Explicit retries also allow a previously unavailable provider to recover.
    if job.state == "FAILED" or (job.state == "COMPLETED" and job.result.get("warnings")):
        if job.finished_at and job.finished_at > now() - timedelta(seconds=30):
            raise HTTPException(429, "분석 재시도는 30초 후에 가능합니다.")
        job.state, job.attempts, job.queued_at = "QUEUED", 0, now()
        job.run_token = job.started_at = job.finished_at = job.dispatched_at = None
        job.error_code = None
    db.commit()
    return serialize(job)


def pair_versions(db, user, document_id, left, right, write=False):
    a = version_for_user(db, left, user.id, write=write)
    b = version_for_user(db, right, user.id, write=write)
    if a.document_id != document_id or b.document_id != document_id:
        raise HTTPException(404, "이 문서에 속한 수정 이력만 비교할 수 있습니다.")
    if left == right:
        raise HTTPException(422, "서로 다른 두 수정 이력을 선택해 주세요.")
    if a.status != VersionStatus.READY or b.status != VersionStatus.READY:
        raise HTTPException(409, "두 수정 이력의 문서 처리가 완료된 후 분석할 수 있습니다.")
    return a, b


@router.get("/documents/{document_id}/diff")
def diff(
    document_id: UUID,
    left: UUID,
    right: UUID,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    a, b = pair_versions(db, user, document_id, left, right)
    response.headers["Cache-Control"] = "no-store"
    try:
        return compare_documents(load_document(db, a), load_document(db, b))
    except Exception as exc:
        raise HTTPException(503, "문서 차이를 불러오지 못했습니다. 다시 시도해 주세요.") from exc


@router.get("/documents/{document_id}/changes")
def change_status(
    document_id: UUID,
    left: UUID,
    right: UUID,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    pair_versions(db, user, document_id, left, right)
    response.headers["Cache-Control"] = "no-store"
    return serialize(db.get(AnalysisJob, job_key(right, left)))


@router.post("/documents/{document_id}/changes", status_code=202)
def change_request(
    document_id: UUID,
    data: Pair,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    pair_versions(db, user, document_id, data.left, data.right, write=True)
    response.headers["Cache-Control"] = "no-store"
    return request_job(db, data.right, data.left)


@router.get("/versions/{version_id}/intelligence")
def intelligence(
    version_id: UUID,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    version = version_for_user(db, version_id, user.id)
    response.headers["Cache-Control"] = "no-store"
    return {
        "analysis": serialize(db.get(AnalysisJob, job_key(version_id))),
        "candidates": candidates(db, version),
    }


@router.post("/versions/{version_id}/analyze", status_code=202)
def analyze(
    version_id: UUID,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    version = version_for_user(db, version_id, user.id, write=True)
    if version.status != VersionStatus.READY:
        raise HTTPException(409, "문서 처리가 완료된 후 분석할 수 있습니다.")
    response.headers["Cache-Control"] = "no-store"
    return request_job(db, version_id)
