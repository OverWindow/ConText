"""Staged, user-bound desktop snapshots. Bytes remain in private object storage."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.domain import Base, Identity, Timestamps


class SyncBinding(Identity, Timestamps, Base):
    __tablename__ = "sync_bindings"
    __table_args__ = (
        UniqueConstraint("user_id", "device_id", "local_workspace_id", name="uq_sync_origin"),
    )
    workspace_id: Mapped[UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), unique=True
    )
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    device_id: Mapped[UUID] = mapped_column(Uuid)
    local_workspace_id: Mapped[UUID] = mapped_column(Uuid)
    generation: Mapped[int] = mapped_column(Integer, default=1)
    state: Mapped[str] = mapped_column(String(20), default="ACTIVE")


class WorkspaceEntry(Identity, Timestamps, Base):
    __tablename__ = "workspace_entries"
    __table_args__ = (
        UniqueConstraint("workspace_id", "id", name="uq_entry_workspace"),
        ForeignKeyConstraint(
            ["workspace_id", "parent_id"],
            ["workspace_entries.workspace_id", "workspace_entries.id"],
            name="fk_entry_parent_workspace",
            deferrable=True,
            initially="DEFERRED",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "document_id"],
            ["documents.workspace_id", "documents.id"],
            name="fk_entry_document_workspace",
        ),
    )
    workspace_id: Mapped[UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    parent_id: Mapped[UUID | None] = mapped_column(Uuid, index=True)
    kind: Mapped[str] = mapped_column(String(12))
    name: Mapped[str] = mapped_column(String(255))
    document_id: Mapped[UUID | None] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    x: Mapped[float] = mapped_column(Float, default=0)
    y: Mapped[float] = mapped_column(Float, default=0)
    available: Mapped[bool] = mapped_column(Boolean, default=True)
    area_positioned: Mapped[bool] = mapped_column(Boolean, default=False)
    revision: Mapped[int] = mapped_column(BigInteger, default=1)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CanvasScope(Identity, Timestamps, Base):
    __tablename__ = "canvas_scopes"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "folder_entry_id"],
            ["workspace_entries.workspace_id", "workspace_entries.id"],
            name="fk_scope_folder_workspace",
        ),
    )
    workspace_id: Mapped[UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    folder_entry_id: Mapped[UUID] = mapped_column(
        ForeignKey("workspace_entries.id", ondelete="CASCADE"), unique=True
    )
    revision: Mapped[int] = mapped_column(BigInteger, default=1)


class SyncSession(Identity, Timestamps, Base):
    __tablename__ = "sync_sessions"
    __table_args__ = (UniqueConstraint("binding_id", "request_id", name="uq_sync_session_request"),)
    binding_id: Mapped[UUID] = mapped_column(
        ForeignKey("sync_bindings.id", ondelete="CASCADE"), index=True
    )
    request_id: Mapped[UUID] = mapped_column(Uuid)
    generation: Mapped[int] = mapped_column(Integer)
    base_revision: Mapped[int] = mapped_column(BigInteger)
    source_sequence: Mapped[int] = mapped_column(BigInteger)
    item_count: Mapped[int] = mapped_column(Integer)
    manifest_hash: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(20), default="PREPARING", index=True)
    committed_revision: Mapped[int | None] = mapped_column(BigInteger)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class SyncSessionItem(Base):
    __tablename__ = "sync_session_items"
    __table_args__ = (
        UniqueConstraint("session_id", "entity_type", "entity_id", name="uq_sync_item_identity"),
    )
    session_id: Mapped[UUID] = mapped_column(
        ForeignKey("sync_sessions.id", ondelete="CASCADE"), primary_key=True
    )
    ordinal: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(20))
    entity_id: Mapped[UUID] = mapped_column(Uuid)
    payload: Mapped[dict] = mapped_column(JSONB)
    fingerprint: Mapped[str] = mapped_column(String(64))
    storage_key: Mapped[str | None] = mapped_column(String(1024))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SyncOperation(Base):
    __tablename__ = "sync_operations"
    __table_args__ = (
        UniqueConstraint("binding_id", "request_id", name="uq_sync_operation_request"),
    )
    workspace_id: Mapped[UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    server_sequence: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    binding_id: Mapped[UUID] = mapped_column(ForeignKey("sync_bindings.id", ondelete="CASCADE"))
    request_id: Mapped[UUID] = mapped_column(Uuid)
    device_sequence: Mapped[int] = mapped_column(BigInteger)
    manifest_hash: Mapped[str] = mapped_column(String(64))
    committed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
