"""Prepare immutable blobs, validate a complete graph, then publish one transaction."""

import hashlib
import logging
from datetime import datetime, timedelta, timezone
from pathlib import PurePath
from uuid import UUID, uuid4

from botocore.exceptions import ClientError
from fastapi import HTTPException
from sqlalchemy import BigInteger, Text, cast, func, select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.canvas import CanvasElement, DocumentRelation
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.domain import Role, Team, TeamMember, User, Workspace, WorkspaceMember
from app.models.processing import DocumentProcessing, ProcessingState
from app.models.sync import (
    CanvasScope,
    SyncBinding,
    SyncOperation,
    SyncSession,
    SyncSessionItem,
    WorkspaceEntry,
)
from app.models.writing import WritingDraft
from app.schemas.documents import ALLOWED_TYPES
from app.schemas.sync import BindingCreate, ItemsInput, SessionCreate
from app.storage.s3 import S3Storage


def now():
    return datetime.now(timezone.utc)


def origin(db, binding_id, user_id, *, lock=False, active=True):
    stmt = select(SyncBinding).where(SyncBinding.id == binding_id, SyncBinding.user_id == user_id)
    binding = db.scalar(stmt.with_for_update() if lock else stmt)
    if binding is None:
        raise HTTPException(404, "Sync binding not found")
    workspace = db.get(Workspace, binding.workspace_id)
    if binding.state == "DELETED" or workspace is None or workspace.deleted_at is not None:
        raise HTTPException(
            410, "클라우드 워크스페이스가 삭제되었습니다. 로컬 원본은 유지됩니다.",
            headers={"X-Context-Error": "WORKSPACE_DELETED"},
        )
    member = db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == binding.workspace_id, WorkspaceMember.user_id == user_id
        )
    )
    if member is None:
        raise HTTPException(404, "Workspace not found")
    if member.role not in (Role.OWNER, Role.EDITOR):
        raise HTTPException(403, "Insufficient workspace permissions")
    if active and binding.state != "ACTIVE":
        raise HTTPException(409, "동기화 연결이 해제되었습니다.")
    return binding


def binding_read(db, binding):
    workspace = db.get(Workspace, binding.workspace_id)
    web_base = (get_settings().web_base_url or get_settings().cors_origins[0]).rstrip("/")
    return {
        "id": binding.id,
        "workspace_id": binding.workspace_id,
        "generation": binding.generation,
        "state": binding.state,
        "revision": workspace.sync_revision,
        "name": workspace.name,
        "web_url": f"{web_base}/workspaces/{workspace.id}",
    }


def bind(db: Session, user: User, data: BindingCreate):
    # Serialize duplicate first requests without creating orphan workspaces.
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    binding = db.scalar(
        select(SyncBinding).where(
            SyncBinding.user_id == user.id,
            SyncBinding.device_id == data.device_id,
            SyncBinding.local_workspace_id == data.local_workspace_id,
        )
    )
    if binding:
        origin(db, binding.id, user.id, lock=True, active=False)
        binding.state = "ACTIVE"
    else:
        team = Team(name=f"{data.name[:113]} team", created_by=user.id)
        db.add(team)
        db.flush()
        db.add(TeamMember(team_id=team.id, user_id=user.id, role=Role.OWNER))
        workspace = Workspace(
            team_id=team.id, name=data.name, created_by=user.id, sync_mode="desktop"
        )
        db.add(workspace)
        db.flush()
        db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=Role.OWNER))
        binding = SyncBinding(
            workspace_id=workspace.id,
            user_id=user.id,
            device_id=data.device_id,
            local_workspace_id=data.local_workspace_id,
        )
        db.add(binding)
        db.flush()
    db.commit()
    return binding_read(db, binding)


def unbind(db, binding_id, user_id):
    binding = origin(db, binding_id, user_id, lock=True, active=False)
    if binding.state == "ACTIVE":
        binding.state = "DETACHED"
        binding.generation += 1
        db.execute(
            update(SyncSession)
            .where(SyncSession.binding_id == binding.id, SyncSession.state == "PREPARING")
            .values(state="CANCELLED")
        )
    db.commit()
    return binding_read(db, binding)


def session_read(db, row):
    items, verified = db.execute(
        select(func.count(), func.count(SyncSessionItem.verified_at)).where(
            SyncSessionItem.session_id == row.id
        )
    ).one()
    return {
        "id": row.id,
        "state": row.state,
        "item_count": row.item_count,
        "prepared": items,
        "verified": verified,
        "revision": row.committed_revision,
        "source_sequence": row.source_sequence,
        "expires_at": row.expires_at,
    }


def session_for_user(db, session_id, user_id, *, writable=False):
    # A single lock order across commit, prepare, cancellation and cleanup.
    candidate = db.get(SyncSession, session_id)
    if candidate is None:
        raise HTTPException(404, "Sync session not found")
    binding = origin(db, candidate.binding_id, user_id, lock=True)
    row = db.scalar(
        select(SyncSession)
        .where(SyncSession.id == session_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row.generation != binding.generation:
        raise HTTPException(409, "동기화 연결이 변경되었습니다.")
    if writable and row.state != "COMMITTED":
        if row.state != "PREPARING" or row.expires_at <= now():
            raise HTTPException(
                410, "동기화 세션이 만료되었거나 취소되었습니다. 다시 시작해 주세요."
            )
    return binding, row


def start_session(db, workspace_id, user_id, data: SessionCreate):
    binding = origin(db, data.binding_id, user_id, lock=True)
    if binding.workspace_id != workspace_id or binding.generation != data.generation:
        raise HTTPException(409, "동기화 연결이 일치하지 않습니다.")
    previous = db.scalar(
        select(SyncSession).where(
            SyncSession.binding_id == binding.id, SyncSession.request_id == data.request_id
        )
    )
    if previous:
        fields = ("generation", "base_revision", "source_sequence", "item_count", "manifest_hash")
        if any(getattr(previous, field) != getattr(data, field) for field in fields):
            raise HTTPException(409, "같은 요청 ID에 다른 동기화 내용이 사용되었습니다.")
        return session_read(db, previous)
    workspace = db.scalar(select(Workspace).where(Workspace.id == workspace_id).with_for_update())
    if workspace.sync_revision != data.base_revision:
        raise HTTPException(
            409, "클라우드 작업 공간이 변경되었습니다. 동기화 상태를 다시 확인해 주세요."
        )
    last_source_sequence = db.scalar(
        select(func.max(SyncOperation.device_sequence)).where(
            SyncOperation.binding_id == binding.id
        )
    )
    if last_source_sequence is not None and data.source_sequence < last_source_sequence:
        raise HTTPException(
            409,
            "복원된 로컬 자료가 클라우드보다 이전 상태입니다. 클라우드 내용을 먼저 확인해 주세요.",
        )
    db.execute(
        update(SyncSession)
        .where(
            SyncSession.binding_id == binding.id,
            SyncSession.state == "PREPARING",
            SyncSession.expires_at <= now(),
        )
        .values(state="CANCELLED")
    )
    if db.scalar(
        select(SyncSession.id)
        .where(SyncSession.binding_id == binding.id, SyncSession.state == "PREPARING")
        .limit(1)
    ):
        raise HTTPException(409, "진행 중인 동기화를 먼저 재개하거나 취소해 주세요.")
    row = SyncSession(
        **data.model_dump(), expires_at=now() + timedelta(hours=get_settings().sync_session_hours)
    )
    db.add(row)
    db.flush()
    db.commit()
    return session_read(db, row)


def staged_version(item, workspace_id):
    p = item.payload
    return DocumentVersion(
        id=item.entity_id,
        document_id=UUID(p["document_id"]),
        version_number=p["version_number"],
        original_filename=p["filename"],
        size=p["size"],
        sha256=p["sha256"],
        storage_bucket=get_settings().aws_s3_bucket,
        storage_key=item.storage_key,
        mime_type=ALLOWED_TYPES.get(
            PurePath(p["filename"]).suffix.lower(), "application/octet-stream"
        ),
    )


def existing_version(db, item, workspace_id):
    version = db.get(DocumentVersion, item.entity_id)
    if version is None:
        return None
    document = db.get(Document, version.document_id)
    p = item.payload
    if (
        document is None
        or document.workspace_id != workspace_id
        or (
            str(version.document_id),
            version.version_number,
            version.original_filename,
            version.size,
            version.sha256,
            round(version.created_at.timestamp() * 1000),
            str(version.source_version_id) if version.source_version_id else None,
            version.change_note,
        )
        != (
            p["document_id"],
            p["version_number"],
            p["filename"],
            p["size"],
            p["sha256"],
            p["created_at"],
            p["source_version_id"],
            p["change_note"],
        )
    ):
        raise HTTPException(409, "이미 사용 중인 버전 식별자입니다.")
    if version.uploaded_at is None:
        raise HTTPException(409, "기존 버전의 업로드가 완료되지 않았습니다.")
    return version


def prepare(db, session_id, user_id, data: ItemsInput, storage: S3Storage):
    binding, session = session_for_user(db, session_id, user_id, writable=True)
    workspace = db.get(Workspace, binding.workspace_id)
    if session.state == "COMMITTED":
        return {"session": session_read(db, session), "uploads": []}
    uploads = []
    for item in data.items:
        if item.ordinal >= session.item_count:
            raise HTTPException(422, "동기화 항목 순번이 범위를 벗어났습니다.")
        previous = db.get(SyncSessionItem, (session.id, item.ordinal))
        if previous:
            if (previous.entity_type, previous.entity_id, previous.fingerprint) != (
                item.entity_type,
                item.entity_id,
                item.fingerprint,
            ):
                raise HTTPException(409, "같은 동기화 순번에 다른 내용이 사용되었습니다.")
            staged = previous
        else:
            if (
                db.scalar(
                    select(SyncSessionItem.ordinal).where(
                        SyncSessionItem.session_id == session.id,
                        SyncSessionItem.entity_type == item.entity_type,
                        SyncSessionItem.entity_id == item.entity_id,
                    )
                )
                is not None
            ):
                raise HTTPException(422, "동기화 식별자가 중복됩니다.")
            staged = SyncSessionItem(
                session_id=session.id,
                ordinal=item.ordinal,
                entity_type=item.entity_type,
                entity_id=item.entity_id,
                payload=item.payload,
                fingerprint=item.fingerprint,
            )
            if item.entity_type == "version":
                if item.payload["size"] > get_settings().max_upload_bytes:
                    raise HTTPException(413, "동기화 파일의 크기가 업로드 한도를 초과했습니다.")
                version = existing_version(db, staged, binding.workspace_id)
                if version:
                    staged.storage_key = version.storage_key
                    staged.verified_at = now()
                else:
                    staged.storage_key = (
                        f"teams/{workspace.team_id}/workspaces/{workspace.id}/"
                        f"sync-uploads/{session.id}/versions/{item.entity_id}"
                    )
            else:
                staged.verified_at = now()
            db.add(staged)
            db.flush()
        if staged.entity_type == "version" and not staged.verified_at:
            url, headers = storage.upload_url(
                staged_version(staged, binding.workspace_id), get_settings().s3_presigned_url_ttl
            )
            uploads.append(
                {
                    "ordinal": staged.ordinal,
                    "version_id": staged.entity_id,
                    "upload_url": url,
                    "headers": headers,
                }
            )
    committed_bytes = db.scalar(
        select(func.coalesce(func.sum(DocumentVersion.size), 0))
        .join(Document, Document.id == DocumentVersion.document_id)
        .where(Document.workspace_id == binding.workspace_id)
    )
    new_bytes = db.scalar(
        select(func.coalesce(func.sum(cast(SyncSessionItem.payload["size"].astext, BigInteger)), 0))
        .outerjoin(DocumentVersion, DocumentVersion.id == SyncSessionItem.entity_id)
        .where(
            SyncSessionItem.session_id == session.id,
            SyncSessionItem.entity_type == "version",
            DocumentVersion.id.is_(None),
        )
    )
    metadata_bytes = db.scalar(
        select(
            func.coalesce(func.sum(func.octet_length(cast(SyncSessionItem.payload, Text))), 0)
        ).where(SyncSessionItem.session_id == session.id)
    )
    if (
        committed_bytes + new_bytes > get_settings().sync_max_workspace_bytes
        or metadata_bytes > 64 * 1024**2
    ):
        raise HTTPException(413, "작업 공간의 동기화 용량 한도를 초과했습니다.")
    db.commit()
    return {"session": session_read(db, session), "uploads": uploads}


def verify(db, session_id, user_id, ordinals, storage):
    binding, session = session_for_user(db, session_id, user_id, writable=True)
    if session.state == "COMMITTED":
        return session_read(db, session)
    for ordinal in set(ordinals):
        item = db.get(SyncSessionItem, (session.id, ordinal))
        if item is None or item.entity_type != "version":
            raise HTTPException(404, "Upload item not found")
        if not item.verified_at:
            storage.verify_upload(staged_version(item, binding.workspace_id))
            item.verified_at = now()
    db.commit()
    return session_read(db, session)


def graph(items):
    groups = {
        kind: {}
        for kind in ("entry", "scope", "document", "version", "element", "relation", "draft")
    }
    for item in items:
        groups[item.entity_type][str(item.entity_id)] = item.payload
    entries, scopes, documents, versions = (
        groups[k] for k in ("entry", "scope", "document", "version")
    )
    roots = [key for key, p in entries.items() if p["parent_id"] is None]
    if len(roots) != 1 or entries[roots[0]]["kind"] != "directory" or len(entries) > 25001:
        raise HTTPException(422, "작업 공간 루트 또는 항목 수가 올바르지 않습니다.")
    names = set()
    for key, entry in entries.items():
        if entry["parent_id"] is not None:
            parent = entries.get(entry["parent_id"])
            if not parent or parent["kind"] != "directory":
                raise HTTPException(422, "상위 폴더를 찾을 수 없습니다.")
        sibling = (entry["parent_id"], entry["name"])
        if sibling in names:
            raise HTTPException(422, "같은 폴더에 중복 이름이 있습니다.")
        names.add(sibling)
        visited, ancestor = set(), key
        while ancestor is not None:
            if ancestor in visited or len(visited) > 128:
                raise HTTPException(422, "폴더 구조가 순환하거나 너무 깊습니다.")
            visited.add(ancestor)
            ancestor = entries[ancestor]["parent_id"]
        if entry["kind"] == "directory":
            if scopes.get(key, {}).get("folder_entry_id") != key:
                raise HTTPException(422, "폴더 캔버스가 누락되었습니다.")
        elif entry["document_id"] not in documents or key != entry["document_id"]:
            raise HTTPException(422, "파일 문서가 누락되었습니다.")
    if set(scopes) != {key for key, p in entries.items() if p["kind"] == "directory"}:
        raise HTTPException(422, "캔버스가 폴더와 일치하지 않습니다.")
    if set(documents) != {p["document_id"] for p in entries.values() if p["kind"] == "file"}:
        raise HTTPException(422, "문서가 파일 목록과 일치하지 않습니다.")
    numbers = set()
    for key, version in versions.items():
        pair = (version["document_id"], version["version_number"])
        if version["document_id"] not in documents or pair in numbers:
            raise HTTPException(422, "문서 수정 이력이 올바르지 않습니다.")
        numbers.add(pair)
        if version["source_version_id"] and version["source_version_id"] not in versions:
            raise HTTPException(422, "출처 수정 이력이 동기화 범위에 없습니다.")
        if version["source_version_id"] == key:
            raise HTTPException(422, "수정 이력이 자신을 참조합니다.")
    for key, document in documents.items():
        for field in ("current_version_id", "file_version_id"):
            if versions.get(document[field], {}).get("document_id") != key:
                raise HTTPException(422, "현재 문서 수정 이력이 누락되었습니다.")
    for kind in ("element", "relation"):
        for payload in groups[kind].values():
            if payload["scope_id"] not in scopes:
                raise HTTPException(422, "캔버스 범위가 누락되었습니다.")
            if kind == "relation" and any(
                payload[f] not in documents for f in ("source_document_id", "target_document_id")
            ):
                raise HTTPException(422, "연결된 문서를 찾을 수 없습니다.")
    return groups


def commit(db, session_id, user_id):
    binding, session = session_for_user(db, session_id, user_id, writable=True)
    if session.state == "COMMITTED":
        return session_read(db, session)
    workspace = db.scalar(
        select(Workspace).where(Workspace.id == binding.workspace_id).with_for_update()
    )
    if workspace.sync_revision != session.base_revision:
        raise HTTPException(409, "클라우드 버전이 변경되어 동기화를 반영하지 못했습니다.")
    items = db.scalars(
        select(SyncSessionItem)
        .where(SyncSessionItem.session_id == session.id)
        .order_by(SyncSessionItem.ordinal)
    ).all()
    if len(items) != session.item_count or any(
        i.ordinal != index or not i.verified_at for index, i in enumerate(items)
    ):
        raise HTTPException(409, "모든 항목의 업로드와 검증을 먼저 완료해 주세요.")
    digest = hashlib.sha256(
        "".join(f"{i.entity_type}:{i.entity_id}:{i.fingerprint}\n" for i in items).encode()
    ).hexdigest()
    if digest != session.manifest_hash:
        raise HTTPException(422, "동기화 목록의 해시가 일치하지 않습니다.")
    groups = graph(items)
    models = {
        "entry": WorkspaceEntry,
        "scope": CanvasScope,
        "document": Document,
        "element": CanvasElement,
        "relation": DocumentRelation,
        "draft": WritingDraft,
    }
    for kind, model in models.items():
        for key in groups[kind]:
            existing = db.get(model, UUID(key))
            if existing and existing.workspace_id != workspace.id:
                raise HTTPException(409, "다른 작업 공간에서 사용 중인 식별자입니다.")
    for item in items:
        if item.entity_type == "version":
            existing_version(db, item, workspace.id)
    timestamp = now()
    # New document heads are assigned only after all immutable versions exist.
    for key, p in groups["document"].items():
        document = db.get(Document, UUID(key))
        if not document:
            document = Document(
                id=UUID(key),
                workspace_id=workspace.id,
                title=p["title"],
                created_by=user_id,
                upload_request_id=uuid4(),
            )
            db.add(document)
        document.title = p["title"]
        document.revision = p["revision"]
        document.deleted_at = None
    db.flush()
    new_versions = []
    for item in items:
        if item.entity_type != "version" or db.get(DocumentVersion, item.entity_id):
            continue
        version = staged_version(item, workspace.id)
        version.created_by = user_id
        version.created_at = datetime.fromtimestamp(item.payload["created_at"] / 1000, timezone.utc)
        version.uploaded_at = timestamp
        version.status = VersionStatus.UPLOADED
        version.change_note = item.payload["change_note"]
        db.add(version)
        new_versions.append(version)
    db.flush()
    for key, p in groups["version"].items():
        version = db.get(DocumentVersion, UUID(key))
        source = UUID(p["source_version_id"]) if p["source_version_id"] else None
        if version.source_version_id and version.source_version_id != source:
            raise HTTPException(409, "수정 이력의 출처가 변경되었습니다.")
        version.source_version_id = source
    for key, p in groups["document"].items():
        document = db.get(Document, UUID(key))
        document.current_version_id = UUID(p["current_version_id"])
        document.file_version_id = UUID(p["file_version_id"])
        document.current_is_pinned = p["current_is_pinned"]
    for document in db.scalars(select(Document).where(Document.workspace_id == workspace.id)).all():
        if str(document.id) not in groups["document"]:
            document.deleted_at = timestamp
    for entry in db.scalars(
        select(WorkspaceEntry).where(WorkspaceEntry.workspace_id == workspace.id)
    ).all():
        if str(entry.id) not in groups["entry"]:
            entry.deleted_at = timestamp
    for key, p in groups["entry"].items():
        row = db.get(WorkspaceEntry, UUID(key))
        if not row:
            row = WorkspaceEntry(id=UUID(key), workspace_id=workspace.id)
            db.add(row)
        for field in ("parent_id", "document_id"):
            setattr(row, field, UUID(p[field]) if p[field] else None)
        for field in ("name", "kind", "x", "y", "available", "area_positioned"):
            setattr(row, field, p[field])
        row.revision = workspace.sync_revision + 1
        row.deleted_at = None
    db.flush()
    for key, p in groups["scope"].items():
        row = db.get(CanvasScope, UUID(key))
        if not row:
            row = CanvasScope(
                id=UUID(key), workspace_id=workspace.id, folder_entry_id=UUID(p["folder_entry_id"])
            )
            db.add(row)
        row.revision = workspace.sync_revision + 1
    db.flush()
    for kind, model in (("element", CanvasElement), ("relation", DocumentRelation)):
        for row in db.scalars(select(model).where(model.workspace_id == workspace.id)).all():
            row.deleted_at = timestamp
        for key, p in groups[kind].items():
            row = db.get(model, UUID(key))
            if not row:
                row = model(id=UUID(key), workspace_id=workspace.id, created_by=user_id)
                if kind == "element":
                    row.updated_by = user_id
                db.add(row)
            for field, value in p.items():
                if field != "id":
                    setattr(
                        row,
                        field,
                        UUID(value)
                        if field in ("scope_id", "source_document_id", "target_document_id")
                        else value,
                    )
            row.deleted_at = None
    for row in db.scalars(
        select(WritingDraft).where(WritingDraft.workspace_id == workspace.id)
    ).all():
        if str(row.id) not in groups["draft"]:
            db.delete(row)
    for key, p in groups["draft"].items():
        row = db.get(WritingDraft, UUID(key))
        if not row:
            row = WritingDraft(
                id=UUID(key), workspace_id=workspace.id, created_by=user_id, request_id=uuid4()
            )
            db.add(row)
        row.title = p["content"]["title"]
        for field in ("content", "sources", "checks", "revision", "history"):
            setattr(row, field, p[field])
    for version in new_versions:
        if version.size and PurePath(version.original_filename).suffix.lower() in ALLOWED_TYPES:
            db.add(DocumentProcessing(version_id=version.id, state=ProcessingState.QUEUED))
    workspace.sync_revision += 1
    session.state = "COMMITTED"
    session.committed_revision = workspace.sync_revision
    db.add(
        SyncOperation(
            workspace_id=workspace.id,
            server_sequence=workspace.sync_revision,
            binding_id=binding.id,
            request_id=session.request_id,
            device_sequence=session.source_sequence,
            manifest_hash=session.manifest_hash,
            committed_at=timestamp,
        )
    )
    db.commit()
    return session_read(db, session)


def cancel_session(db, session_id, user_id):
    _, session = session_for_user(db, session_id, user_id)
    if session.state == "PREPARING":
        session.state = "CANCELLED"
    db.commit()
    return session_read(db, session)


def view(db, workspace_id, scope_id=None, offset=0, limit=200, revision=None):
    workspace = db.get(Workspace, workspace_id)
    if workspace.sync_mode != "desktop":
        raise HTTPException(404, "Synchronized workspace not found")
    current_revision = workspace.sync_revision
    if revision is not None and revision != current_revision:
        raise HTTPException(409, "작업 공간이 갱신되었습니다. 새로고침해 주세요.")
    folder = db.scalar(
        select(WorkspaceEntry).where(
            WorkspaceEntry.workspace_id == workspace_id,
            WorkspaceEntry.deleted_at.is_(None),
            WorkspaceEntry.kind == "directory",
            WorkspaceEntry.id == scope_id if scope_id else WorkspaceEntry.parent_id.is_(None),
        )
    )
    if not folder:
        if current_revision == 0:
            return {
                "revision": 0,
                "folder": None,
                "breadcrumbs": [],
                "entries": [],
                "elements": [],
                "relations": [],
                "total": 0,
                "drafts": [],
            }
        raise HTTPException(404, "Folder not found")
    where = (
        WorkspaceEntry.workspace_id == workspace_id,
        WorkspaceEntry.parent_id == folder.id,
        WorkspaceEntry.deleted_at.is_(None),
    )
    total = db.scalar(select(func.count()).select_from(WorkspaceEntry).where(*where))
    entries = db.scalars(
        select(WorkspaceEntry)
        .where(*where)
        .order_by(WorkspaceEntry.kind, WorkspaceEntry.name, WorkspaceEntry.id)
        .offset(offset)
        .limit(limit)
    ).all()
    breadcrumbs = [folder]
    while breadcrumbs[0].parent_id:
        parent = db.scalar(
            select(WorkspaceEntry).where(
                WorkspaceEntry.id == breadcrumbs[0].parent_id,
                WorkspaceEntry.workspace_id == workspace_id,
                WorkspaceEntry.deleted_at.is_(None),
            )
        )
        if parent is None or len(breadcrumbs) > 128:
            raise HTTPException(409, "폴더 구조를 다시 불러와 주세요.")
        breadcrumbs.insert(0, parent)

    def entry_read(row):
        return {
            key: getattr(row, key)
            for key in ("id", "parent_id", "kind", "name", "document_id", "x", "y", "available")
        }

    elements = db.scalars(
        select(CanvasElement).where(
            CanvasElement.workspace_id == workspace_id,
            CanvasElement.scope_id == folder.id,
            CanvasElement.deleted_at.is_(None),
        )
    ).all()
    relations = db.scalars(
        select(DocumentRelation).where(
            DocumentRelation.workspace_id == workspace_id,
            DocumentRelation.scope_id == folder.id,
            DocumentRelation.deleted_at.is_(None),
        )
    ).all()
    drafts = db.execute(
        select(WritingDraft.id, WritingDraft.title)
        .where(WritingDraft.workspace_id == workspace_id)
        .order_by(WritingDraft.updated_at.desc())
        .limit(200)
    ).all()
    # Detect commits between the individual SELECTs, rather than mix two snapshots.
    latest_revision = db.scalar(select(Workspace.sync_revision).where(Workspace.id == workspace_id))
    if latest_revision != current_revision:
        raise HTTPException(409, "작업 공간이 갱신되었습니다. 새로고침해 주세요.")
    return {
        "revision": current_revision,
        "folder": entry_read(folder),
        "breadcrumbs": [entry_read(row) for row in breadcrumbs],
        "entries": [entry_read(row) for row in entries],
        "total": total,
        "elements": [
            {
                key: getattr(row, key)
                for key in ("id", "kind", "text", "x", "y", "width", "height", "color", "font_size")
            }
            for row in elements
        ],
        "relations": [
            {
                key: getattr(row, key)
                for key in (
                    "id",
                    "source_document_id",
                    "target_document_id",
                    "relation_type",
                    "source_handle",
                    "target_handle",
                )
            }
            for row in relations
        ],
        "drafts": [{"id": row.id, "title": row.title} for row in drafts],
    }


def cleanup(db, storage):
    """Bounded, restartable cleanup; never remove a key referenced by a version."""
    candidates = db.scalars(
        select(SyncSession.id)
        .where(
            SyncSession.state.in_(("PREPARING", "CANCELLED", "CLEANING", "CLEANUP_BLOCKED")),
            SyncSession.expires_at < now(),
        )
        .limit(10)
    ).all()
    for session_id in candidates:
        candidate = db.get(SyncSession, session_id)
        db.scalar(
            select(SyncBinding).where(SyncBinding.id == candidate.binding_id).with_for_update()
        )
        row = db.scalar(
            select(SyncSession)
            .where(SyncSession.id == session_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if row.state == "COMMITTED":
            db.rollback()
            continue
        row.state = "CLEANING"
        db.commit()
        keys = db.scalars(
            select(SyncSessionItem.storage_key).where(
                SyncSessionItem.session_id == session_id, SyncSessionItem.storage_key.is_not(None)
            )
        ).all()
        try:
            for key in keys:
                if not db.scalar(
                    select(DocumentVersion.id).where(DocumentVersion.storage_key == key).limit(1)
                ):
                    storage.client.delete_object(Bucket=get_settings().aws_s3_bucket, Key=key)
        except ClientError as error:
            if error.response["Error"]["Code"] not in ("AccessDenied", "AllAccessDisabled"):
                raise
            row.state = "CLEANUP_BLOCKED"
            row.expires_at = now() + timedelta(days=1)
            db.commit()
            logging.warning(
                "Sync staging cleanup needs scoped s3:DeleteObject permission; retrying tomorrow."
            )
            continue
        row.state = "EXPIRED"
        db.commit()


def scene(db, workspace_id, scope_id=None, limit=200):
    """Bounded ancestor-first inventory for the shared nested folder projection."""
    workspace = db.get(Workspace, workspace_id)
    revision = workspace.sync_revision
    if workspace.sync_mode != "desktop":
        raise HTTPException(404, "Synchronized workspace not found")
    inventory = db.scalars(
        select(WorkspaceEntry)
        .where(WorkspaceEntry.workspace_id == workspace_id, WorkspaceEntry.deleted_at.is_(None))
        .order_by(WorkspaceEntry.name, WorkspaceEntry.id)
    ).all()
    root = next((row for row in inventory if row.parent_id is None), None)
    if root is None:
        return {
            "revision": revision,
            "entries": [],
            "scopes": [],
            "total": 0,
            "focus": "",
            "drafts": [],
        }
    by_id = {row.id: row for row in inventory}
    folder = by_id.get(scope_id or root.id)
    if folder is None or folder.kind != "directory":
        raise HTTPException(404, "Folder not found")
    children, paths = {}, {root.id: ""}
    for row in inventory:
        children.setdefault(row.parent_id, []).append(row)

    def relative(row):
        if row.id not in paths:
            paths[row.id] = "/".join(filter(None, (relative(by_id[row.parent_id]), row.name)))
        return paths[row.id]

    selected = {}

    def append(row):
        if row.id == root.id or row.id in selected or len(selected) >= limit:
            return
        if row.parent_id and row.parent_id != root.id:
            append(by_id[row.parent_id])
        if len(selected) < limit:
            selected[row.id] = row

    if folder.id != root.id:
        append(folder)
        for child in children.get(folder.id, []):
            append(child)
    queue = list(children.get(root.id, []))
    index = 0
    while index < len(queue) and len(selected) < limit:
        row = queue[index]
        index += 1
        append(row)
        if row.kind == "directory":
            queue.extend(children.get(row.id, []))
    documents = {
        row.id: row
        for row in db.scalars(select(Document).where(Document.workspace_id == workspace_id)).all()
    }
    versions = {
        row.id: row
        for row in db.scalars(
            select(DocumentVersion)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.workspace_id == workspace_id)
        ).all()
    }
    counts = {}
    for row in versions.values():
        counts[row.document_id] = counts.get(row.document_id, 0) + 1
    entries = []
    for row in sorted(selected.values(), key=lambda item: relative(item).count("/")):
        doc = documents.get(row.document_id)
        version = versions.get(doc.file_version_id) if doc else None
        entries.append(
            {
                "id": row.id,
                "workspace_id": workspace_id,
                "name": row.name,
                "kind": row.kind,
                "relative_path": relative(row),
                "parent_path": relative(by_id[row.parent_id]),
                "extension": PurePath(row.name).suffix.lower(),
                "size": version.size if version else 0,
                "mtime": int(version.created_at.timestamp() * 1000) if version else 0,
                "excluded": 0,
                "x": row.x,
                "y": row.y,
                "area_positioned": row.area_positioned,
                "available": row.available,
                "document_id": row.document_id,
                "version_number": version.version_number if version else None,
                "version_count": counts.get(row.document_id, 0),
            }
        )
        entries[-1]["file_version_id"] = doc.file_version_id if doc else None
    scope_ids = {root.id, *(row.id for row in selected.values() if row.kind == "directory")}
    decorations = db.scalars(
        select(CanvasElement)
        .where(
            CanvasElement.workspace_id == workspace_id,
            CanvasElement.scope_id.in_(scope_ids),
            CanvasElement.deleted_at.is_(None),
        )
        .limit(10001)
    ).all()
    relations = db.scalars(
        select(DocumentRelation)
        .where(
            DocumentRelation.workspace_id == workspace_id,
            DocumentRelation.scope_id.in_(scope_ids),
            DocumentRelation.deleted_at.is_(None),
        )
        .limit(10001)
    ).all()
    if len(decorations) > 10000 or len(relations) > 10000:
        raise HTTPException(
            413, "표시할 캔버스 요소가 너무 많습니다. 폴더별 보기로 범위를 줄여 주세요."
        )
    scopes = [
        {
            "id": key,
            "directory": relative(by_id[key]),
            "elements": [
                {
                    field: getattr(row, field)
                    for field in (
                        "id",
                        "kind",
                        "text",
                        "x",
                        "y",
                        "width",
                        "height",
                        "color",
                        "font_size",
                    )
                }
                for row in decorations
                if row.scope_id == key
            ],
            "relations": [
                {
                    field: getattr(row, field)
                    for field in (
                        "id",
                        "source_document_id",
                        "target_document_id",
                        "relation_type",
                        "source_handle",
                        "target_handle",
                    )
                }
                for row in relations
                if row.scope_id == key
            ],
        }
        for key in scope_ids
    ]
    drafts = db.execute(
        select(WritingDraft.id, WritingDraft.title)
        .where(WritingDraft.workspace_id == workspace_id)
        .order_by(WritingDraft.updated_at.desc())
        .limit(200)
    ).all()
    if db.scalar(select(Workspace.sync_revision).where(Workspace.id == workspace_id)) != revision:
        raise HTTPException(409, "작업 공간이 갱신되었습니다. 새로고침해 주세요.")
    return {
        "revision": revision,
        "entries": entries,
        "scopes": scopes,
        "total": len(inventory) - 1,
        "focus": relative(folder),
        "drafts": [{"id": row.id, "title": row.title} for row in drafts],
    }
