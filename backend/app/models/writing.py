from uuid import UUID

from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.domain import Base, Identity, Timestamps


class WritingDraft(Identity, Timestamps, Base):
    __tablename__ = "writing_drafts"
    __table_args__ = (
        UniqueConstraint("workspace_id", "created_by", "request_id", name="uq_writing_request"),
    )
    workspace_id: Mapped[UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    request_id: Mapped[UUID]
    title: Mapped[str] = mapped_column(String(200))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    content: Mapped[dict] = mapped_column(JSONB)
    sources: Mapped[list] = mapped_column(JSONB, default=list)
    checks: Mapped[list] = mapped_column(JSONB, default=list)
    history: Mapped[list] = mapped_column(JSONB, default=list)
    prompt: Mapped[str] = mapped_column(String(4000), default="")
    proposal: Mapped[dict | None] = mapped_column(JSONB)
