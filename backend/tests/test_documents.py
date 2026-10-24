import hashlib
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, urlparse
from uuid import UUID, uuid4

import boto3
import httpx
import pytest
from botocore.config import Config
from botocore.exceptions import EndpointConnectionError
from moto.server import ThreadedMotoServer
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api import documents as routes
from app.core.config import get_settings
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.domain import Role, WorkspaceMember
from app.storage.s3 import S3Storage
from tests.test_foundation import headers

BODY = b"Phase 2 document\n"


@pytest.fixture(scope="session")
def s3_server():
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    yield f"http://{host}:{port}"
    server.stop()


@pytest.fixture
def storage(s3_server, monkeypatch):
    client = boto3.client(
        "s3",
        endpoint_url=s3_server,
        region_name="ap-northeast-2",
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        config=Config(signature_version="s3v4"),
    )
    bucket = f"documents-test-{uuid4()}"
    client.create_bucket(
        Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": "ap-northeast-2"}
    )
    monkeypatch.setattr(get_settings(), "aws_s3_bucket", bucket)
    result = S3Storage(client)
    monkeypatch.setattr(routes, "get_storage", lambda: result)
    return result


def metadata(**overrides):
    return {
        "request_id": str(uuid4()),
        "title": "Notes",
        "filename": "노트.md",
        "size": len(BODY),
        "sha256": hashlib.sha256(BODY).hexdigest(),
        **overrides,
    }


def create(client, auth, workspace, data=None):
    return client.post(
        f"/api/workspaces/{workspace}/documents/upload-url", headers=auth, json=data or metadata()
    )


@pytest.fixture
def upload(client, storage):
    auth = headers()
    workspace = client.post("/api/workspaces", headers=auth, json={"name": "Documents"}).json()[
        "id"
    ]
    response = create(client, auth, workspace)
    assert response.status_code == 201, response.text
    return auth, workspace, response.json()


def put(ticket):
    return httpx.put(ticket["upload_url"], headers=ticket["headers"], content=BODY)


def complete(client, auth, ticket):
    return client.post(
        "/api/documents/upload-complete", headers=auth, json={"version_id": ticket["version_id"]}
    )


def test_upload_complete_download_and_no_overwrite(client, db, upload):
    auth, workspace, ticket = upload
    version = db.get(DocumentVersion, UUID(ticket["version_id"]))
    assert version.storage_key.endswith(f"/versions/{version.id}/original.md")
    signed = parse_qs(urlparse(ticket["upload_url"]).query)["X-Amz-SignedHeaders"][0].split(";")
    assert {"content-length", "content-type", "if-none-match", "x-amz-checksum-sha256"} <= set(
        signed
    )
    assert complete(client, auth, ticket).status_code == 409
    assert client.post(f"/api/versions/{version.id}/download-url", headers=auth).status_code == 409
    assert put(ticket).status_code == 200
    assert put(ticket).status_code == 412
    response = complete(client, auth, ticket)
    assert response.status_code == 200, response.text
    document = response.json()
    assert document["current_version_id"] == ticket["version_id"]
    assert document["versions"][0]["status"] == "UPLOADED"
    assert document["versions"][0]["sha256"] == hashlib.sha256(BODY).hexdigest()
    assert "storage_key" not in document["versions"][0]
    assert complete(client, auth, ticket).json() == document
    assert client.get(f"/api/workspaces/{workspace}/documents", headers=auth).json() == [document]
    assert client.get(f"/api/documents/{document['id']}", headers=auth).json() == document
    response = client.post(f"/api/versions/{version.id}/download-url", headers=auth)
    assert response.headers["cache-control"] == "no-store"
    url = response.json()["download_url"]
    assert "attachment" in parse_qs(urlparse(url).query)["response-content-disposition"][0]
    assert httpx.get(url).content == BODY
    assert client.post(f"/api/versions/{version.id}/upload-url", headers=auth).status_code == 409


@pytest.mark.parametrize("role", [Role.EDITOR, Role.VIEWER])
def test_member_roles_and_isolation(client, db, upload, role):
    auth, workspace, ticket = upload
    member, stranger = headers(), headers()
    user = client.get("/api/me", headers=member).json()["id"]
    db.add(WorkspaceMember(workspace_id=UUID(workspace), user_id=UUID(user), role=role))
    db.commit()
    assert client.get(f"/api/workspaces/{workspace}/documents", headers=member).status_code == 200
    assert create(client, member, workspace).status_code == (201 if role == Role.EDITOR else 403)
    retry = f"/api/versions/{ticket['version_id']}/upload-url"
    assert client.post(retry, headers=member).status_code == (200 if role == Role.EDITOR else 403)
    assert complete(client, member, ticket).status_code == (409 if role == Role.EDITOR else 403)
    assert put(ticket).status_code == 200
    assert complete(client, auth, ticket).status_code == 200
    assert (
        client.post(
            f"/api/versions/{ticket['version_id']}/download-url", headers=member
        ).status_code
        == 200
    )
    endpoints = [
        ("GET", f"/api/workspaces/{workspace}/documents", None),
        ("POST", f"/api/workspaces/{workspace}/documents/upload-url", metadata()),
        ("GET", f"/api/documents/{ticket['document_id']}", None),
        ("POST", retry, None),
        ("POST", "/api/documents/upload-complete", {"version_id": ticket["version_id"]}),
        ("POST", f"/api/versions/{ticket['version_id']}/download-url", None),
    ]
    for method, path, body in endpoints:
        assert client.request(method, path, headers=stranger, json=body).status_code == 404
        assert client.request(method, path, json=body).status_code == 401


def test_concurrent_request_id_retries(client, db, upload):
    auth, workspace, _ = upload
    data = metadata()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: create(client, auth, workspace, data), range(8)))
    assert all(r.status_code == 201 for r in results)
    assert len({r.json()["version_id"] for r in results}) == 1
    assert db.scalar(select(func.count()).select_from(Document)) == 2
    assert create(client, auth, workspace, {**data, "title": "Changed"}).status_code == 409
    ticket = results[0].json()
    assert (
        client.post(f"/api/versions/{ticket['version_id']}/upload-url", headers=auth).status_code
        == 200
    )


@pytest.mark.parametrize(
    "overrides,status",
    [
        ({"filename": "bad.exe"}, 422),
        ({"filename": "../note.txt"}, 422),
        ({"filename": "bad\\note.txt"}, 422),
        ({"size": 0}, 422),
        ({"size": 52428801}, 413),
        ({"sha256": "wrong"}, 422),
        ({"mime_type": "text/html"}, 422),
        ({"title": " "}, 422),
    ],
)
def test_invalid_metadata_has_no_document(client, db, upload, overrides, status):
    auth, workspace, _ = upload
    assert create(client, auth, workspace, metadata(**overrides)).status_code == status
    assert db.scalar(select(func.count()).select_from(Document)) == 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("ContentType", "text/html"),
        ("Body", b"wrong length"),
        ("ChecksumSHA256", "a" * 44),
        ("Metadata", {}),
        ("ServerSideEncryption", None),
    ],
)
def test_mismatched_storage_marked_failed(client, db, storage, upload, field, value):
    auth, _, ticket = upload
    version = db.get(DocumentVersion, UUID(ticket["version_id"]))
    params = {
        "Bucket": version.storage_bucket,
        "Key": version.storage_key,
        "Body": BODY,
        "ContentType": version.mime_type,
        "ChecksumSHA256": storage.checksum(version),
        "ChecksumAlgorithm": "SHA256",
        "Metadata": {"version-id": str(version.id)},
        "ServerSideEncryption": "AES256",
    }
    if value is None:
        params.pop(field)
    else:
        params[field] = value
    storage.client.put_object(**params)
    assert complete(client, auth, ticket).status_code == 422
    db.refresh(version)
    assert version.status == VersionStatus.FAILED
    assert db.get(Document, version.document_id).current_version_id is None
    assert complete(client, auth, ticket).status_code == 409


def test_storage_failure_is_retryable(client, db, storage, upload, monkeypatch):
    auth, workspace, ticket = upload

    def fail(*args, **kwargs):
        raise EndpointConnectionError(endpoint_url="http://unavailable.test")

    with monkeypatch.context() as patch:
        patch.setattr(storage.client, "head_object", fail)
        assert complete(client, auth, ticket).status_code == 503
    assert db.get(DocumentVersion, UUID(ticket["version_id"])).status == VersionStatus.UPLOADING
    with monkeypatch.context() as patch:
        patch.setattr(storage.client, "generate_presigned_url", fail)
        assert create(client, auth, workspace).status_code == 503
    assert db.scalar(select(func.count()).select_from(Document)) == 1
    assert put(ticket).status_code == 200
    assert complete(client, auth, ticket).status_code == 200


def test_current_version_cannot_point_to_another_document(client, db, upload):
    auth, workspace, first = upload
    second = create(client, auth, workspace).json()
    document = db.get(Document, UUID(first["document_id"]))
    document.current_version_id = UUID(second["version_id"])
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_concurrent_completion_is_idempotent(client, upload):
    auth, _, ticket = upload
    assert put(ticket).status_code == 200
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: complete(client, auth, ticket), range(8)))
    assert all(result.status_code == 200 for result in results)
    assert all(result.json() == results[0].json() for result in results)


def test_original_filename_preserves_spaces_for_retries(client, db, upload):
    auth, workspace, _ = upload
    response = create(client, auth, workspace, metadata(filename=" notes.md", title=" Notes "))
    assert response.status_code == 201
    version = db.get(DocumentVersion, UUID(response.json()["version_id"]))
    assert version.original_filename == " notes.md"
    assert db.get(Document, version.document_id).title == "Notes"


def test_unconfigured_storage_does_not_create_metadata(client, db, upload, monkeypatch):
    from app.storage.s3 import get_storage

    auth, workspace, _ = upload
    monkeypatch.setattr(get_settings(), "aws_s3_bucket", "")
    get_storage.cache_clear()
    monkeypatch.setattr(routes, "get_storage", get_storage)
    response = create(client, auth, workspace)
    assert response.status_code == 503
    assert response.json()["detail"] == "Document storage is not configured"
    assert db.scalar(select(func.count()).select_from(Document)) == 1


def test_presigned_urls_use_regional_endpoint(monkeypatch):
    from app.storage.s3 import get_storage

    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    monkeypatch.setattr(get_settings(), "aws_region", "ap-northeast-2")
    monkeypatch.setattr(get_settings(), "aws_s3_bucket", "regional-test-bucket")
    get_storage.cache_clear()
    try:
        storage = get_storage()
        version = DocumentVersion(
            id=uuid4(),
            storage_bucket="regional-test-bucket",
            storage_key="teams/check/original.txt",
            original_filename="original.txt",
            mime_type="text/plain",
            size=len(BODY),
            sha256=hashlib.sha256(BODY).hexdigest(),
        )
        upload_url, _ = storage.upload_url(version, 600)
        download_url = storage.download_url(version, 600)
        for url in [upload_url, download_url]:
            assert urlparse(url).hostname == "regional-test-bucket.s3.ap-northeast-2.amazonaws.com"
            assert "/ap-northeast-2/s3/" in parse_qs(urlparse(url).query)["X-Amz-Credential"][0]
    finally:
        get_storage.cache_clear()
