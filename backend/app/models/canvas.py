import enum
from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.domain import Base, Identity, Timestamps


class RelationType(str, enum.Enum):
    REFERENCE = "REFERENCE"
    DERIVED_FROM = "DERIVED_FROM"
    GENERATED_FROM = "GENERATED_FROM"
    RELATED_TO = "RELATED_TO"


class DocumentPosition(Timestamps, Base):
    __tablename__ = "document_positions"
    __table_args__ = (
        CheckConstraint("x >= -100000 AND x <= 100000", name="ck_position_x"),
        CheckConstraint("y >= -100000 AND y <= 100000", name="ck_position_y"),
    )
    document_id: Mapped[UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True
    )
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    updated_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))


class DocumentRelation(Identity, Base):
    __tablename__ = "document_relations"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "source_document_id"],
            ["documents.workspace_id", "documents.id"],
            name="fk_relation_source_workspace",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "target_document_id"],
            ["documents.workspace_id", "documents.id"],
            name="fk_relation_target_workspace",
            ondelete="CASCADE",
        ),
        CheckConstraint("source_document_id <> target_document_id", name="ck_relation_not_self"),
        CheckConstraint(
            "source_handle IN ('left', 'right', 'top', 'bottom')", name="ck_relation_source_handle"
        ),
        CheckConstraint(
            "target_handle IN ('left', 'right', 'top', 'bottom')", name="ck_relation_target_handle"
        ),
        UniqueConstraint(
            "source_document_id",
            "target_document_id",
            "relation_type",
            "scope_id",
            name="uq_document_relation",
            postgresql_nulls_not_distinct=True,
        ),
    )
    workspace_id: Mapped[UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    source_document_id: Mapped[UUID]
    target_document_id: Mapped[UUID]
    source_handle: Mapped[str] = mapped_column(String(8), default="right", server_default="right")
    target_handle: Mapped[str] = mapped_column(String(8), default="left", server_default="left")
    relation_type: Mapped[RelationType] = mapped_column(
        Enum(RelationType, name="document_relation_type")
    )
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    scope_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("canvas_scopes.id", ondelete="CASCADE")
    )
    revision: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CanvasElement(Identity, Timestamps, Base):
    __tablename__ = "canvas_elements"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('text','rectangle','ellipse','triangle')", name="ck_element_kind"
        ),
        CheckConstraint(
            "color IN ('violet','blue','green','amber','rose','slate')", name="ck_element_color"
        ),
        CheckConstraint(
            "x >= -100000 AND x <= 100000 AND y >= -100000 AND y <= 100000",
            name="ck_element_position",
        ),
        CheckConstraint(
            "width >= 80 AND width <= 2000 AND height >= 60 AND height <= 2000",
            name="ck_element_size",
        ),
        CheckConstraint("font_size >= 12 AND font_size <= 96", name="ck_element_font"),
        CheckConstraint("length(text) <= 5000", name="ck_element_text"),
    )
    workspace_id: Mapped[UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text, default="")
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    width: Mapped[float] = mapped_column(Float)
    height: Mapped[float] = mapped_column(Float)
    color: Mapped[str] = mapped_column(String(16), default="violet")
    font_size: Mapped[int] = mapped_column(Integer, default=24)
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    updated_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    scope_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("canvas_scopes.id", ondelete="CASCADE")
    )
    revision: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
