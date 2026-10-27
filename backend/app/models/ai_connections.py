from uuid import UUID

from sqlalchemy import ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.domain import Base, Identity, Timestamps


class AIConnection(Timestamps, Base):
    __tablename__ = "ai_connections"
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    mode: Mapped[str] = mapped_column(String(20), default="managed")
    model: Mapped[str] = mapped_column(String(200), default="")
    encrypted_key: Mapped[str | None] = mapped_column(Text)


class AIRequest(Identity, Timestamps, Base):
    __tablename__ = "ai_requests"
    __table_args__ = (UniqueConstraint("user_id", "request_id", name="uq_ai_request"),)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    request_id: Mapped[UUID]
    fingerprint: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(20))
    error_code: Mapped[str | None] = mapped_column(String(80))
    response_ciphertext: Mapped[str | None] = mapped_column(Text)
    # Temporary encrypted responses are reusable for 10 minutes and then scrubbed on access.
    expires_at: Mapped[int | None] = mapped_column(Integer)
