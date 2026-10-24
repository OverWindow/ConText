"""Durable jobs with a fenced lease: broker redeliveries cannot replace newer results."""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import HTTPException
from sqlalchemy import select

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.documents import DocumentVersion, VersionStatus
from app.models.processing import DocumentProcessing, ProcessingState
from app.processing.parsers import ParseError, normalize
from app.storage.s3 import get_storage


def now():
    return datetime.now(timezone.utc)


def read_object(storage, bucket, key, limit):
    response = storage.client.get_object(Bucket=bucket, Key=key)
    stream = response["Body"]
    try:
        if response["ContentLength"] > limit:
            raise ParseError("LIMIT_EXCEEDED", "문서 크기가 처리 한도를 초과했습니다.")
        body = stream.read(limit + 1)
        if len(body) > limit:
            raise ParseError("LIMIT_EXCEEDED", "문서 크기가 처리 한도를 초과했습니다.")
        return body
    finally:
        stream.close()


def run(version_id: str):
    version_id = UUID(version_id)
    token = uuid4()
    with SessionLocal() as db:
        job = db.scalar(
            select(DocumentProcessing)
            .where(DocumentProcessing.version_id == version_id)
            .with_for_update()
        )
        if not job or job.state != ProcessingState.QUEUED:
            return
        version = db.get(DocumentVersion, version_id)
        if not version.uploaded_at:
            return
        job.state = ProcessingState.RUNNING
        job.run_token = token
        job.attempts += 1
        job.started_at = now()
        job.error_code = job.error_message = None
        version.status = VersionStatus.PROCESSING
        db.commit()
        # expire_on_commit=False keeps source metadata available after commit.
    result = None
    error = None
    retryable = False
    try:
        storage = get_storage()
        body = read_object(
            storage, version.storage_bucket, version.storage_key, get_settings().max_upload_bytes
        )
        if len(body) != version.size or hashlib.sha256(body).hexdigest() != version.sha256:
            raise ParseError("SOURCE_MISMATCH", "원본 무결성 검증에 실패했습니다.")
        result = normalize(body, version.original_filename, version.sha256)
        prefix = version.storage_key.rsplit("/", 1)[0] + f"/processed/{token}"
        normalized_key, text_key = prefix + "/normalized.json", prefix + "/extracted.txt"
        for key, content, content_type in [
            (
                normalized_key,
                json.dumps(result, ensure_ascii=False).encode(),
                "application/json; charset=utf-8",
            ),
            (
                text_key,
                "\n\n".join(b["text"] for b in result["blocks"]).encode(),
                "text/plain; charset=utf-8",
            ),
        ]:
            storage.client.put_object(
                Bucket=version.storage_bucket,
                Key=key,
                Body=content,
                ContentType=content_type,
                ServerSideEncryption="AES256",
                IfNoneMatch="*",
            )
    except ParseError as exc:
        error = (exc.code, exc.message)
    except (BotoCoreError, ClientError, HTTPException):
        error = (
            "STORAGE_UNAVAILABLE",
            "문서 저장소에 연결하지 못했습니다. 잠시 후 다시 처리합니다.",
        )
        retryable = True
    # Unexpected failures leave RUNNING; the dispatcher recovers the expired lease.
    with SessionLocal() as db:
        job = db.scalar(
            select(DocumentProcessing)
            .where(DocumentProcessing.version_id == version_id)
            .with_for_update()
        )
        if not job or job.run_token != token or job.state != ProcessingState.RUNNING:
            return
        version = db.get(DocumentVersion, version_id)
        if error:
            job.error_code, job.error_message = error
            if retryable and job.attempts < get_settings().processing_max_attempts:
                job.state = ProcessingState.QUEUED
                job.queued_at = now() + timedelta(seconds=30 * job.attempts)
                job.dispatched_at = None
                version.status = VersionStatus.UPLOADED
            else:
                job.state = ProcessingState.FAILED
                job.finished_at = now()
                version.status = VersionStatus.FAILED
        else:
            job.state = ProcessingState.COMPLETED
            job.finished_at = now()
            job.normalized_key, job.text_key = normalized_key, text_key
            job.summary = {k: v for k, v in result.items() if k not in ("blocks", "source_sha256")}
            job.summary.update(
                block_count=len(result["blocks"]),
                character_count=sum(len(b["text"]) for b in result["blocks"]),
            )
            version.status = VersionStatus.READY
        db.commit()


def dispatch(publish):
    """DB is the outbox. Failed or lost broker delivery is safely republished."""
    with SessionLocal() as db:
        expired = db.scalars(
            select(DocumentProcessing)
            .where(
                DocumentProcessing.state == ProcessingState.RUNNING,
                DocumentProcessing.started_at < now() - timedelta(seconds=180),
            )
            .with_for_update(skip_locked=True)
        ).all()
        for job in expired:
            job.run_token = None
            job.dispatched_at = None
            job.error_code, job.error_message = (
                "WORKER_INTERRUPTED",
                "문서 처리 시간이 초과되었거나 작업이 중단되었습니다.",
            )
            version = db.get(DocumentVersion, job.version_id)
            if job.attempts >= get_settings().processing_max_attempts:
                job.state = ProcessingState.FAILED
                job.finished_at = now()
                version.status = VersionStatus.FAILED
            else:
                job.state = ProcessingState.QUEUED
                job.queued_at = now()
                version.status = VersionStatus.UPLOADED
        db.commit()
        jobs = db.scalars(
            select(DocumentProcessing)
            .where(
                DocumentProcessing.state == ProcessingState.QUEUED,
                DocumentProcessing.queued_at <= now(),
                (DocumentProcessing.dispatched_at.is_(None))
                | (DocumentProcessing.dispatched_at < now() - timedelta(seconds=60)),
            )
            .order_by(DocumentProcessing.queued_at)
            .limit(50)
            .with_for_update(skip_locked=True)
        ).all()
        for job in jobs:
            publish(str(job.version_id))
            job.dispatched_at = now()
        db.commit()
