"""Incremental embedding outbox; one batch per task, fenced atomic publications."""

import hashlib
from datetime import timedelta
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from app.ai.provider import AIUnavailable
from app.ai.service import AIService
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.intelligence.engine import load_document
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.rag import DocumentChunk, RagIndex
from app.processing.engine import now
from app.rag.chunking import ALGORITHM, chunk_document

BATCH_SIZE = 16


def fingerprint():
    s = get_settings()
    return hashlib.sha256(
        f"{s.mindlogic_base_url}|{s.ai_embedding_model}|{ALGORITHM}".encode()
    ).hexdigest()


def enqueue(db, version_id):
    db.execute(
        insert(RagIndex)
        .values(
            version_id=version_id,
            fingerprint=fingerprint(),
            state="QUEUED",
            attempts=0,
            chunk_count=0,
            indexed_count=0,
        )
        .on_conflict_do_nothing(index_elements=["version_id"])
    )


def reset(job):
    job.state, job.attempts, job.queued_at = "QUEUED", 0, now()
    job.dispatched_at = job.started_at = job.finished_at = job.run_token = None
    job.error_code = None


def fail(job, code):
    job.error_code = code
    job.attempts += 1
    if (
        code in ("AI_NOT_CONFIGURED", "EMBEDDING_NOT_CONFIGURED", "AI_FORBIDDEN")
        or job.attempts >= 3
    ):
        job.state, job.finished_at = "FAILED", now()
    else:
        job.state, job.queued_at = "QUEUED", now() + timedelta(seconds=15 * job.attempts)
        job.dispatched_at = None


def run(version_id):
    version_id, token = UUID(str(version_id)), uuid4()
    with SessionLocal() as db:
        job = db.get(RagIndex, version_id, with_for_update=True)
        if not job or job.state != "QUEUED" or job.queued_at > now():
            return
        job.state, job.run_token, job.started_at = "RUNNING", token, now()
        stamp = job.fingerprint
        db.commit()
        try:
            version = db.get(DocumentVersion, version_id)
            workspace_id = db.get(Document, version.document_id).workspace_id
            if job.chunk_count == 0:
                chunks = chunk_document(load_document(db, version))
                db.rollback()
                job = db.get(RagIndex, version_id, with_for_update=True)
                if not job or job.run_token != token or job.fingerprint != stamp:
                    return
                db.execute(delete(DocumentChunk).where(DocumentChunk.version_id == version_id))
                db.add_all(
                    [
                        DocumentChunk(
                            version_id=version_id,
                            workspace_id=workspace_id,
                            fingerprint=stamp,
                            **chunk,
                        )
                        for chunk in chunks
                    ]
                )
                job.chunk_count = len(chunks)
                db.commit()
            batch = db.scalars(
                select(DocumentChunk)
                .where(
                    DocumentChunk.version_id == version_id,
                    DocumentChunk.fingerprint == stamp,
                    DocumentChunk.embedding.is_(None),
                )
                .order_by(DocumentChunk.ordinal)
                .limit(BATCH_SIZE)
            ).all()
            texts, ids = [c.text for c in batch], [c.id for c in batch]
            db.rollback()
            if stamp != fingerprint():
                raise AIUnavailable("INDEX_MODEL_CHANGED")
            vectors = AIService().embed_many(texts) if texts else []
            if len(vectors) != len(ids) or len({len(v) for v in vectors}) > 1:
                raise AIUnavailable("AI_INVALID_RESPONSE")
            error = None
        except AIUnavailable as exc:
            error = exc.code
        except Exception:
            error = "INDEX_UNAVAILABLE"
        db.rollback()
        job = db.get(RagIndex, version_id, with_for_update=True)
        if not job or job.state != "RUNNING" or job.run_token != token or job.fingerprint != stamp:
            return
        if error:
            fail(job, error)
        else:
            existing_dimension = db.scalar(
                select(func.vector_dims(DocumentChunk.embedding))
                .where(DocumentChunk.version_id == version_id, DocumentChunk.embedding.is_not(None))
                .limit(1)
            )
            if vectors and existing_dimension and len(vectors[0]) != existing_dimension:
                fail(job, "AI_INVALID_RESPONSE")
                db.commit()
                return
            for chunk_id, vector in zip(ids, vectors):
                db.get(DocumentChunk, chunk_id).embedding = vector
            db.flush()
            job.indexed_count = db.scalar(
                select(func.count())
                .select_from(DocumentChunk)
                .where(DocumentChunk.version_id == version_id, DocumentChunk.embedding.is_not(None))
            )
            job.attempts, job.error_code = 0, None
            if job.indexed_count == job.chunk_count:
                job.state, job.finished_at = "COMPLETED", now()
            else:
                job.state, job.queued_at, job.dispatched_at = "QUEUED", now(), None
        db.commit()


def dispatch(publish):
    with SessionLocal() as db:
        missing = db.scalars(
            select(DocumentVersion.id)
            .outerjoin(RagIndex, RagIndex.version_id == DocumentVersion.id)
            .where(
                DocumentVersion.status == VersionStatus.READY,
                (RagIndex.version_id.is_(None)) | (RagIndex.fingerprint != fingerprint()),
            )
            .order_by(DocumentVersion.created_at, DocumentVersion.id)
            .limit(30)
        ).all()
        for version_id in missing:
            enqueue(db, version_id)
            job = db.get(RagIndex, version_id, with_for_update=True)
            if job.fingerprint != fingerprint():
                reset(job)
                job.fingerprint, job.chunk_count, job.indexed_count = fingerprint(), 0, 0
                db.execute(delete(DocumentChunk).where(DocumentChunk.version_id == version_id))
        expired = db.scalars(
            select(RagIndex)
            .where(
                RagIndex.state == "RUNNING", RagIndex.started_at < now() - timedelta(seconds=180)
            )
            .with_for_update(skip_locked=True)
        ).all()
        for job in expired:
            job.run_token = None
            fail(job, "WORKER_INTERRUPTED")
        db.commit()
        jobs = db.scalars(
            select(RagIndex)
            .where(
                RagIndex.state == "QUEUED",
                RagIndex.queued_at <= now(),
                (RagIndex.dispatched_at.is_(None))
                | (RagIndex.dispatched_at < now() - timedelta(seconds=60)),
            )
            .order_by(RagIndex.queued_at, RagIndex.version_id)
            .limit(30)
            .with_for_update(skip_locked=True)
        ).all()
        for job in jobs:
            publish(str(job.version_id))
            job.dispatched_at = now()
        db.commit()
