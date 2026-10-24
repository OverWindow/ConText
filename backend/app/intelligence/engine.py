"""Database outbox and fenced leases independent of file processing."""

import hashlib
import json
from datetime import timedelta
from uuid import uuid4

from sqlalchemy import exists, select
from sqlalchemy.dialects.postgresql import insert

from app.ai.provider import AIUnavailable
from app.ai.service import AIService
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.intelligence.diff import compare_documents
from app.models.documents import DocumentVersion, VersionStatus
from app.models.intelligence import AnalysisJob
from app.models.processing import DocumentProcessing, ProcessingState
from app.processing.engine import now, read_object
from app.storage.s3 import get_storage


def job_key(version_id, base_id=None):
    return f"change:{base_id}:{version_id}" if base_id else f"profile:{version_id}"


def enqueue(db, version_id, base_id=None):
    key = job_key(version_id, base_id)
    db.execute(
        insert(AnalysisJob)
        .values(
            key=key,
            version_id=version_id,
            base_version_id=base_id,
            state="QUEUED",
            attempts=0,
        )
        .on_conflict_do_nothing(index_elements=["key"])
    )
    return key


def load_document(db, version):
    job = db.get(DocumentProcessing, version.id)
    if (
        version.status != VersionStatus.READY
        or not job
        or job.state != ProcessingState.COMPLETED
        or not job.normalized_key
    ):
        raise ValueError("CONTENT_NOT_READY")
    return json.loads(
        read_object(get_storage(), version.storage_bucket, job.normalized_key, 32 * 1024 * 1024)
    )


def embedding_identity():
    settings = get_settings()
    return hashlib.sha256(
        (
            settings.mindlogic_base_url + "|" + settings.ai_embedding_model + "|prefix12000-v1"
        ).encode()
    ).hexdigest()


def compute(db, job):
    version = db.get(DocumentVersion, job.version_id)
    document = load_document(db, version)
    settings = get_settings()
    provenance = {
        "source_sha256": version.sha256,
        "provider": "mindlogic",
        "algorithm": "version-intelligence-v1",
    }
    if job.base_version_id:
        base = db.get(DocumentVersion, job.base_version_id)
        if base.document_id != version.document_id:
            raise ValueError("INVALID_PAIR")
        diff = compare_documents(load_document(db, base), document)
        result = {
            "diff": diff,
            "summary": None,
            "warnings": [],
            "provenance": {
                **provenance,
                "base_sha256": base.sha256,
                "model": settings.ai_model,
                "prompt_version": "changes-v1",
            },
        }
        if not diff["total_changes"]:
            # A truncated prefix cannot establish whole-document equality.
            result["warnings"] = ["PARTIAL_DIFF"] if diff["truncated"] else []
            return result
        try:
            result["summary"] = AIService().summarize(diff)
        except AIUnavailable as exc:
            result["warnings"].append(exc.code)
        return result
    text = "\n\n".join(b["text"] for b in document["blocks"])
    result = {
        "text": text[:12000],
        "text_truncated": len(text) > 12000,
        "embedding": None,
        "embedding_identity": embedding_identity(),
        "embedding_model": settings.ai_embedding_model or None,
        "warnings": [],
        "provenance": provenance,
    }
    if text.strip():
        try:
            result["embedding"] = AIService().embed(result["text"])
        except AIUnavailable as exc:
            result["warnings"].append(exc.code)
    else:
        result["warnings"].append("NO_TEXT_EVIDENCE")
    return result


def run(key):
    token = uuid4()
    with SessionLocal() as db:
        job = db.get(AnalysisJob, key, with_for_update=True)
        if not job or job.state != "QUEUED" or job.queued_at > now():
            return
        job.state, job.run_token = "RUNNING", token
        job.attempts += 1
        job.started_at, job.error_code = now(), None
        db.commit()
        result, error = None, None
        try:
            result = compute(db, job)
        except Exception:
            # Never expose file contents, gateway responses, or storage credentials.
            error = "ANALYSIS_UNAVAILABLE"
        db.rollback()
    with SessionLocal() as db:
        job = db.get(AnalysisJob, key, with_for_update=True)
        if not job or job.state != "RUNNING" or job.run_token != token:
            return
        job.error_code = error
        if error and job.attempts < get_settings().processing_max_attempts:
            job.state, job.queued_at = "QUEUED", now() + timedelta(seconds=30 * job.attempts)
            job.dispatched_at = None
        else:
            job.state = "FAILED" if error else "COMPLETED"
            job.finished_at = now()
            job.result = result
        db.commit()


def dispatch(publish):
    with SessionLocal() as db:
        # Backfill pre-Phase-6 files and recover a parse-success/worker-crash window.
        ready = db.scalars(
            select(DocumentVersion)
            .where(
                DocumentVersion.status == VersionStatus.READY,
                ~exists(
                    select(AnalysisJob.key).where(
                        AnalysisJob.version_id == DocumentVersion.id,
                        AnalysisJob.base_version_id.is_(None),
                    )
                ),
            )
            .order_by(DocumentVersion.created_at, DocumentVersion.id)
            .limit(50)
        ).all()
        for version in ready:
            enqueue(db, version.id)
        # Pick the immediate predecessor by version number, regardless of completion order.
        from sqlalchemy.orm import aliased

        previous = aliased(DocumentVersion)
        predecessor_id = (
            select(previous.id)
            .where(
                previous.document_id == DocumentVersion.document_id,
                previous.version_number < DocumentVersion.version_number,
            )
            .order_by(previous.version_number.desc())
            .limit(1)
            .correlate(DocumentVersion)
            .scalar_subquery()
        )
        pairs = db.execute(
            select(DocumentVersion.id, predecessor_id.label("base_id"))
            .where(
                DocumentVersion.status == VersionStatus.READY,
                predecessor_id.is_not(None),
                exists(
                    select(previous.id).where(
                        previous.id == predecessor_id, previous.status == VersionStatus.READY
                    )
                ),
                ~exists(
                    select(AnalysisJob.key).where(
                        AnalysisJob.version_id == DocumentVersion.id,
                        AnalysisJob.base_version_id == predecessor_id,
                    )
                ),
            )
            .order_by(DocumentVersion.created_at, DocumentVersion.id)
            .limit(50)
        ).all()
        for version_id, base_id in pairs:
            if db.get(DocumentVersion, base_id).status == VersionStatus.READY:
                enqueue(db, version_id, base_id)
        expired = db.scalars(
            select(AnalysisJob)
            .where(
                AnalysisJob.state == "RUNNING",
                AnalysisJob.started_at < now() - timedelta(seconds=180),
            )
            .with_for_update(skip_locked=True)
        ).all()
        for job in expired:
            job.run_token = job.dispatched_at = None
            job.error_code = "WORKER_INTERRUPTED"
            if job.attempts >= get_settings().processing_max_attempts:
                job.state, job.finished_at = "FAILED", now()
            else:
                job.state, job.queued_at = "QUEUED", now()
        db.commit()
        jobs = db.scalars(
            select(AnalysisJob)
            .where(
                AnalysisJob.state == "QUEUED",
                AnalysisJob.queued_at <= now(),
                (AnalysisJob.dispatched_at.is_(None))
                | (AnalysisJob.dispatched_at < now() - timedelta(seconds=60)),
            )
            .order_by(AnalysisJob.queued_at)
            .limit(30)
            .with_for_update(skip_locked=True)
        ).all()
        for job in jobs:
            publish(job.key)
            job.dispatched_at = now()
        db.commit()
