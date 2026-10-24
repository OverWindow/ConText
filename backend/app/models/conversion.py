from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.domain import Base


class DocumentConversion(Base):
    __tablename__ = "document_conversions"
    __table_args__ = (
        CheckConstraint("format IN ('pdf', 'docx', 'txt', 'md')", name="ck_conversion_format"),
        CheckConstraint(
            "state IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')", name="ck_conversion_state"
        ),
    )
    version_id: Mapped[UUID] = mapped_column(
        ForeignKey("document_versions.id", ondelete="CASCADE"), primary_key=True
    )
    format: Mapped[str] = mapped_column(String(8), primary_key=True)
    state: Mapped[str] = mapped_column(String(16), default="QUEUED", index=True)
    source_key: Mapped[str] = mapped_column(String(1024))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    run_token: Mapped[UUID | None] = mapped_column(Uuid)
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_code: Mapped[str | None] = mapped_column(String(60))
    error_message: Mapped[str | None] = mapped_column(String(500))
    output_key: Mapped[str | None] = mapped_column(String(1024))
    size: Mapped[int | None] = mapped_column(BigInteger)
    sha256: Mapped[str | None] = mapped_column(String(64))
    warnings: Mapped[list | None] = mapped_column(JSONB)
