from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Integer, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.domain import Base


class AnalysisJob(Base):
    __tablename__ = "analysis_jobs"
    key: Mapped[str] = mapped_column(String(90), primary_key=True)
    version_id: Mapped[UUID] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE"), index=True
    )
    base_version_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE")
    )
    state: Mapped[str] = mapped_column(String(16), default="QUEUED", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    run_token: Mapped[UUID | None] = mapped_column(Uuid)
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_code: Mapped[str | None] = mapped_column(String(60))
    result: Mapped[dict | None] = mapped_column(JSONB)
