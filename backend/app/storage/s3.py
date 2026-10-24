import base64
from functools import lru_cache
from urllib.parse import quote

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import HTTPException

from app.core.config import get_settings
from app.models.documents import DocumentVersion


class S3Storage:
    def __init__(self, client):
        self.client = client

    @staticmethod
    def checksum(version: DocumentVersion) -> str:
        return base64.b64encode(bytes.fromhex(version.sha256)).decode("ascii")

    def upload_url(self, version: DocumentVersion, expires: int) -> tuple[str, dict[str, str]]:
        headers = {
            "Content-Type": version.mime_type,
            "If-None-Match": "*",
            "x-amz-checksum-sha256": self.checksum(version),
            "x-amz-sdk-checksum-algorithm": "SHA256",
            "x-amz-server-side-encryption": "AES256",
            "x-amz-meta-version-id": str(version.id),
        }
        try:
            url = self.client.generate_presigned_url(
                "put_object",
                Params={
                    "Bucket": version.storage_bucket,
                    "Key": version.storage_key,
                    "ContentType": version.mime_type,
                    "ContentLength": version.size,
                    "IfNoneMatch": "*",
                    "ChecksumSHA256": self.checksum(version),
                    "ChecksumAlgorithm": "SHA256",
                    "ServerSideEncryption": "AES256",
                    "Metadata": {"version-id": str(version.id)},
                },
                ExpiresIn=expires,
            )
        except (BotoCoreError, ClientError) as exc:
            raise HTTPException(503, "Document storage is unavailable") from exc
        # Content-Length is signed, but browsers set it automatically from the File body.
        return url, headers

    def verify_upload(self, version: DocumentVersion) -> None:
        try:
            obj = self.client.head_object(
                Bucket=version.storage_bucket, Key=version.storage_key, ChecksumMode="ENABLED"
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
                raise HTTPException(409, "File has not reached storage. Upload it first.") from exc
            raise HTTPException(503, "Unable to verify the uploaded file") from exc
        except BotoCoreError as exc:
            raise HTTPException(503, "Document storage is unavailable") from exc
        if (
            obj["ContentLength"] != version.size
            or obj.get("ContentType") != version.mime_type
            or obj.get("ChecksumSHA256") != self.checksum(version)
            or obj.get("Metadata", {}).get("version-id") != str(version.id)
            or obj.get("ServerSideEncryption") != "AES256"
        ):
            raise HTTPException(422, "Stored file does not match the upload metadata")

    def download_url(self, version: DocumentVersion, expires: int) -> str:
        # RFC 5987 preserves non-ASCII filenames while forcing attachment downloads.
        disposition = "attachment; filename=\"document\"; filename*=UTF-8''" + quote(
            version.original_filename, safe=""
        )
        try:
            return self.client.generate_presigned_url(
                "get_object",
                Params={
                    "Bucket": version.storage_bucket,
                    "Key": version.storage_key,
                    "ResponseContentDisposition": disposition,
                    "ResponseContentType": "application/octet-stream",
                },
                ExpiresIn=expires,
            )
        except (BotoCoreError, ClientError) as exc:
            raise HTTPException(503, "Document storage is unavailable") from exc


@lru_cache
def get_storage() -> S3Storage:
    settings = get_settings()
    if not settings.aws_s3_bucket:
        raise HTTPException(503, "Document storage is not configured")
    try:
        # boto3 uses the normal credential chain: environment locally, IAM role on AWS.
        client = boto3.client(
            "s3",
            region_name=settings.aws_region,
            config=Config(
                signature_version="s3v4",
                # Keep presigned requests on the bucket's regional endpoint.
                # The legacy global host can redirect newly created buckets.
                s3={"addressing_style": "virtual"},
                connect_timeout=5,
                read_timeout=10,
                retries={"max_attempts": 2, "mode": "standard"},
            ),
        )
        return S3Storage(client)
    except (BotoCoreError, ClientError) as exc:
        raise HTTPException(503, "Document storage credentials are unavailable") from exc
