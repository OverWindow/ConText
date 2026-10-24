"""Version/format outbox jobs with bounded retries and fenced immutable S3 outputs."""

import hashlib
import json
from datetime import timedelta
from uuid import UUID, uuid4

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import HTTPException
from sqlalchemy import select

from app.conversion.renderers import MIME, ConversionError, render
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.conversion import DocumentConversion
from app.models.documents import DocumentVersion
from app.processing.engine import now, read_object
from app.processing.parsers import ParseError
from app.storage.s3 import get_storage


def run(version_id, format):
    version_id, token = UUID(str(version_id)), uuid4()
    with SessionLocal() as db:
        job = db.get(DocumentConversion, (version_id, format), with_for_update=True)
        if not job or job.state != "QUEUED" or job.queued_at > now():
            return
        version = db.get(DocumentVersion, version_id)
        source_key = job.source_key
        job.state, job.run_token, job.started_at = "RUNNING", token, now()
        job.attempts += 1
        job.error_code = job.error_message = None
        db.commit()
    error, retryable = None, False
    try:
        storage = get_storage()
        document = json.loads(
            read_object(storage, version.storage_bucket, source_key, 32 * 1024 * 1024)
        )
        if not isinstance(document, dict) or document.get("source_sha256") != version.sha256:
            raise ConversionError(
                "SOURCE_MISMATCH", "원본과 정규화 문서의 식별 정보가 일치하지 않습니다."
            )
        body, warnings = render(document, format)
        checksum = hashlib.sha256(body).hexdigest()
        key = (
            version.storage_key.rsplit("/", 1)[0]
            + f"/converted/{version_id}/{token}/document.{format}"
        )
        storage.client.put_object(
            Bucket=version.storage_bucket,
            Key=key,
            Body=body,
            ContentType=MIME[format],
            ServerSideEncryption="AES256",
            IfNoneMatch="*",
            Metadata={"version-id": str(version_id), "sha256": checksum},
        )
    except (ConversionError, ParseError) as exc:
        error = (exc.code, exc.message)
    except (ValueError, TypeError, KeyError):
        error = ("INVALID_NORMALIZED", "정규화 문서를 읽을 수 없습니다. 문서 처리를 확인해 주세요.")
    except (BotoCoreError, ClientError, HTTPException):
        error = ("STORAGE_UNAVAILABLE", "저장소에 연결하지 못했습니다. 잠시 후 다시 시도합니다.")
        retryable = True
    # Unknown exceptions/worker termination leave RUNNING for the lease recovery dispatcher.
    with SessionLocal() as db:
        job = db.get(DocumentConversion, (version_id, format), with_for_update=True)
        if not job or job.run_token != token or job.state != "RUNNING":
            return
        if error:
            job.error_code, job.error_message = error
            if retryable and job.attempts < get_settings().processing_max_attempts:
                job.state, job.queued_at, job.dispatched_at = (
                    "QUEUED",
                    now() + timedelta(seconds=30 * job.attempts),
                    None,
                )
            else:
                job.state, job.finished_at = "FAILED", now()
        else:
            job.state, job.finished_at = "COMPLETED", now()
            job.output_key, job.size, job.sha256, job.warnings = key, len(body), checksum, warnings
        db.commit()


def dispatch(publish):
    with SessionLocal() as db:
        expired = db.scalars(
            select(DocumentConversion)
            .where(
                DocumentConversion.state == "RUNNING",
                DocumentConversion.started_at < now() - timedelta(seconds=180),
            )
            .with_for_update(skip_locked=True)
        ).all()
        for job in expired:
            job.run_token = job.dispatched_at = None
            job.error_code = "WORKER_INTERRUPTED"
            job.error_message = "변환 시간이 초과되었거나 작업이 중단되었습니다."
            if job.attempts >= get_settings().processing_max_attempts:
                job.state, job.finished_at = "FAILED", now()
            else:
                job.state, job.queued_at = "QUEUED", now()
        db.commit()
        jobs = db.scalars(
            select(DocumentConversion)
            .where(
                DocumentConversion.state == "QUEUED",
                DocumentConversion.queued_at <= now(),
                (DocumentConversion.dispatched_at.is_(None))
                | (DocumentConversion.dispatched_at < now() - timedelta(seconds=60)),
            )
            .order_by(DocumentConversion.queued_at)
            .limit(50)
            .with_for_update(skip_locked=True)
        ).all()
        for job in jobs:
            publish(str(job.version_id), job.format)
            job.dispatched_at = now()
        db.commit()
