"""Authenticated compute boundary; canonical workspace writes belong to the v2 server."""

import base64
import hashlib
import hmac
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from fastapi import APIRouter, Depends, Header, HTTPException

from app.conversion import renderers
from app.core.config import get_settings
from app.processing.parsers import normalize
from app.schemas.worker_generated import ProcessInput, WorkerInput, WorkerResult
from app.schemas.writing import WritingContent
from app.writing_export import render_hwpx
from app.writing_format import normalized

router = APIRouter(prefix="/internal/v2", tags=["internal-worker"])



def authorize(authorization: str | None = Header(default=None)):
    token = get_settings().internal_worker_token
    if not token:
        raise HTTPException(503, "Internal processing is not configured")
    if not authorization or not hmac.compare_digest(authorization, f"Bearer {token}"):
        raise HTTPException(401, "Internal worker authentication required")


def processor_fingerprint():
    root = Path(__file__).parents[1]
    digest = hashlib.sha256()
    for name in ["processing/parsers.py", "conversion/renderers.py", "writing_format.py",
                 "writing_export.py", "api/unified_worker.py", "schemas/worker_generated.py"]:
        digest.update(name.encode())
        digest.update((root / name).read_bytes())
    return "context-python-v2:" + digest.hexdigest()


def download_original(data: ProcessInput) -> bytes:
    settings = get_settings()
    parsed = urlsplit(data.download_url)
    bucket, region = settings.aws_s3_bucket, settings.aws_region
    allowed = set(settings.internal_worker_allowed_hosts)
    if bucket:
        allowed.update({f"{bucket}.s3.{region}.amazonaws.com", f"{bucket}.s3.amazonaws.com",
                        f"s3.{region}.amazonaws.com", "s3.amazonaws.com"})
    loopback = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if (parsed.hostname not in allowed or parsed.username or parsed.password or parsed.fragment
            or parsed.scheme != "https" and not (loopback and parsed.scheme == "http")):
        raise ValueError("UNTRUSTED_STORAGE_URL")
    content = bytearray()
    # No redirect can turn an allowlisted private-storage URL into an arbitrary fetch.
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    request = Request(data.download_url, headers={"Accept-Encoding": "identity"})
    with build_opener(NoRedirect()).open(request, timeout=60) as response:
        if response.status != 200:
            raise ValueError("STORAGE_DOWNLOAD_FAILED")
        while chunk := response.read(64 * 1024):
            content.extend(chunk)
            if len(content) > data.version.blob.size or len(content) > settings.max_upload_bytes:
                raise ValueError("ORIGINAL_SIZE_MISMATCH")
    if len(content) != data.version.blob.size:
        raise ValueError("ORIGINAL_SIZE_MISMATCH")
    if hashlib.sha256(content).hexdigest() != data.version.blob.sha256:
        raise ValueError("ORIGINAL_CHECKSUM_MISMATCH")
    return bytes(content)


@router.post("/process", dependencies=[Depends(authorize)], response_model=WorkerResult,
             response_model_exclude_none=True)
def process(data: WorkerInput):
    result = {"schema_version": 2, "job_id": str(data.job_id),
              "processor_fingerprint": processor_fingerprint()}
    try:
        if data.kind == "export":
            editable = WritingContent.model_validate(data.content.model_dump())
            document = normalized(editable.model_dump())
        else:
            original = download_original(data)
            document = normalize(original, data.filename, data.version.blob.sha256)
        if data.kind == "parse":
            return {**result, "status": "complete", "normalized": document,
                    "text": "\n\n".join(block["text"] for block in document["blocks"])}
        if not data.format:
            raise ValueError("CONVERSION_FORMAT_REQUIRED")
        renderers.validate(document)
        if data.format == "hwpx":
            output, warnings = render_hwpx(document["blocks"]), [renderers.FIDELITY]
        else:
            output, warnings = renderers.render(document, data.format)
        if len(output) > get_settings().max_upload_bytes:
            raise ValueError("CONVERSION_TOO_LARGE")
        mimes = {"pdf": "application/pdf", "txt": "text/plain", "md": "text/markdown",
                 "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                 "hwpx": "application/hwp+zip"}
        return {**result, "status": "complete", "warnings": warnings, "output": {
            "content_base64": base64.b64encode(output).decode("ascii"),
            "mime_type": mimes[data.format],
            "filename": Path(data.filename).stem + "." + data.format,
        }}
    except Exception as error:
        safe_codes = {"UNTRUSTED_STORAGE_URL", "STORAGE_DOWNLOAD_FAILED", "ORIGINAL_SIZE_MISMATCH",
                      "ORIGINAL_CHECKSUM_MISMATCH", "CONVERSION_FORMAT_REQUIRED",
                      "CONVERSION_TOO_LARGE"}
        code = (str(error) if str(error) in safe_codes
                else getattr(error, "code", "PROCESSING_FAILED"))
        return {**result, "status": "failed", "error": {
            "code": code,
            "message": "원본을 처리하지 못했습니다. 파일과 처리 상태를 확인해 주세요.",
        }}
