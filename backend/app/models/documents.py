from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.domain import Base, Identity, Timestamps, User


class VersionStatus(str, enum.Enum):
    PENDING = "PENDING"
    UPLOADING = "UPLOADING"
    UPLOADED = "UPLOADED"
    PROCESSING = "PROCESSING"
    READY = "READY"
    FAILED = "FAILED"


class Document(Identity, Timestamps, Base):
    __tablename__ = "documents"
    __table_args__ = (
        UniqueConstraint("workspace_id", "id", name="uq_document_workspace_identity"),
        UniqueConstraint(
            "workspace_id", "created_by", "upload_request_id", name="uq_document_upload_request"
        ),
        ForeignKeyConstraint(
            ["id", "current_version_id"],
            ["document_versions.document_id", "document_versions.id"],
            name="fk_document_current_version",
            use_alter=True,
            deferrable=True,
            initially="DEFERRED",
        ),
        ForeignKeyConstraint(
            ["id", "file_version_id"],
            ["document_versions.document_id", "document_versions.id"],
            name="fk_document_file_version",
            use_alter=True,
            deferrable=True,
            initially="DEFERRED",
        ),
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    upload_request_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    file_version_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    current_is_pinned: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    revision: Mapped[int] = mapped_column(BigInteger, default=1, server_default="1")
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    versions: Mapped[list[DocumentVersion]] = relationship(
        foreign_keys="DocumentVersion.document_id",
        order_by="DocumentVersion.version_number",
        passive_deletes=True,
    )


class DocumentVersion(Identity, Base):
    __tablename__ = "document_versions"
    __table_args__ = (
        UniqueConstraint(
            "document_id", "created_by", "upload_request_id", name="uq_version_upload_request"
        ),
        Index("ix_document_versions_fingerprint", "sha256", "size"),
        UniqueConstraint("document_id", "version_number", name="uq_document_version_number"),
        UniqueConstraint("document_id", "id", name="uq_document_version_identity"),
        CheckConstraint("size >= 0", name="ck_document_version_size"),
        CheckConstraint("version_number > 0", name="ck_document_version_number"),
    )
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    upload_request_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    source_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("document_versions.id", name="fk_version_source", ondelete="RESTRICT")
    )
    change_note: Mapped[str | None] = mapped_column(String(500))
    author: Mapped[User] = relationship(
        "User", foreign_keys="DocumentVersion.created_by", lazy="joined"
    )

    @property
    def author_name(self) -> str:
        return self.author.display_name or self.author.email.split("@")[0]

    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version_number: Mapped[int] = mapped_column(Integer)
    storage_bucket: Mapped[str] = mapped_column(String(63))
    storage_key: Mapped[str] = mapped_column(String(1024), index=True)
    original_filename: Mapped[str] = mapped_column(String(255))
    mime_type: Mapped[str] = mapped_column(String(127))
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    status: Mapped[VersionStatus] = mapped_column(
        Enum(VersionStatus, name="document_version_status")
    )
