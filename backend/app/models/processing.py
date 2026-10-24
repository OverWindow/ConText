import enum
from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.domain import Base


class ProcessingState(str, enum.Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class DocumentProcessing(Base):
    __tablename__ = "document_processing"
    version_id: Mapped[UUID] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE"), primary_key=True
    )
    state: Mapped[ProcessingState] = mapped_column(
        Enum(ProcessingState, name="processing_state"), default=ProcessingState.QUEUED, index=True
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    run_token: Mapped[UUID | None] = mapped_column(Uuid)
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_code: Mapped[str | None] = mapped_column(String(60))
    error_message: Mapped[str | None] = mapped_column(String(500))
    normalized_key: Mapped[str | None] = mapped_column(String(1024))
    text_key: Mapped[str | None] = mapped_column(String(1024))
    summary: Mapped[dict | None] = mapped_column(JSONB)
