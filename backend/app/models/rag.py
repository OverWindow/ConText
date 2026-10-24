from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.domain import Base, Identity, Timestamps
from app.rag.vector import Vector


class WorkState:
    state: Mapped[str] = mapped_column(String(16), default="QUEUED", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    run_token: Mapped[UUID | None] = mapped_column(Uuid)
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_code: Mapped[str | None] = mapped_column(String(60))


class RagIndex(WorkState, Base):
    __tablename__ = "rag_indexes"
    version_id: Mapped[UUID] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE"), primary_key=True
    )
    fingerprint: Mapped[str] = mapped_column(String(64))
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    indexed_count: Mapped[int] = mapped_column(Integer, default=0)


class DocumentChunk(Identity, Base):
    __tablename__ = "document_chunks"
    __table_args__ = (UniqueConstraint("version_id", "ordinal", name="uq_chunk_ordinal"),)
    workspace_id: Mapped[UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    version_id: Mapped[UUID] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE"), index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    locations: Mapped[list] = mapped_column(JSONB)
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    embedding: Mapped[list | None] = mapped_column(Vector())


class ChatSession(Identity, Timestamps, Base):
    __tablename__ = "chat_sessions"
    workspace_id: Mapped[UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(String(120))
    request_id: Mapped[UUID] = mapped_column(Uuid)
    __table_args__ = (
        UniqueConstraint(
            "workspace_id", "created_by", "request_id", name="uq_chat_session_request"
        ),
    )


class ChatMessage(Identity, WorkState, Base):
    __tablename__ = "chat_messages"
    __table_args__ = (
        UniqueConstraint("session_id", "sequence", name="uq_chat_sequence"),
        UniqueConstraint("session_id", "request_id", "role", name="uq_chat_message_request"),
    )
    session_id: Mapped[UUID] = mapped_column(
        ForeignKey("chat_sessions.id", ondelete="CASCADE"), index=True
    )
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    request_id: Mapped[UUID] = mapped_column(Uuid)
    sequence: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text, default="")
    options: Mapped[dict] = mapped_column(JSONB, default=dict)
    result: Mapped[dict | None] = mapped_column(JSONB)
