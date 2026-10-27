"""Loopback-only integration fixture. Never imported by the application."""

import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

test_url = os.environ["TEST_DATABASE_URL"]
if not test_url.rsplit("/", 1)[-1].endswith("_test"):
    raise RuntimeError("Integration harness requires an isolated _test database")
os.environ["DATABASE_URL"] = test_url
os.environ["SUPABASE_URL"] = "https://auth.example.test"
os.environ["SUPABASE_JWT_SECRET"] = "context-cloud-integration-test-secret"

import boto3  # noqa: E402
import jwt  # noqa: E402
import uvicorn  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from botocore.config import Config as BotoConfig  # noqa: E402
from moto.server import ThreadedMotoServer  # noqa: E402

from app.api import documents, sync, versions  # noqa: E402
from app.core.config import get_settings  # noqa: E402
from app.main import app  # noqa: E402
from app.storage.s3 import S3Storage  # noqa: E402

command.upgrade(Config("alembic.ini"), "head")
server = ThreadedMotoServer(ip_address="0.0.0.0", port=15000, verbose=False)
server.start()
client = boto3.client(
    "s3",
    endpoint_url="http://127.0.0.1:15000",
    region_name="ap-northeast-2",
    aws_access_key_id="testing",
    aws_secret_access_key="testing",
    config=BotoConfig(signature_version="s3v4"),
)
bucket = "cloud-integration-" + str(uuid4())
client.create_bucket(
    Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": "ap-northeast-2"}
)
get_settings().aws_s3_bucket = bucket
store = S3Storage(client)
for module in (documents, sync, versions):
    module.get_storage = lambda: store


def token():
    current = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": str(uuid4()),
            "email": "cloud-fixture@example.test",
            "user_metadata": {"full_name": "통합 테스트"},
            "role": "authenticated",
            "aud": "authenticated",
            "iss": "https://auth.example.test/auth/v1",
            "iat": current,
            "exp": current + timedelta(hours=1),
        },
        os.environ["SUPABASE_JWT_SECRET"],
        algorithm="HS256",
    )


@app.get("/__fixture/config")
def config():
    return {"token": token(), "other_token": token()}


uvicorn.run(app, host="0.0.0.0", port=18000, log_level="warning")
