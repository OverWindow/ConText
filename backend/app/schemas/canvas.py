from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.canvas import RelationType
from app.schemas.documents import DocumentRead


class PositionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: UUID
    x: float = Field(ge=-100000, le=100000, allow_inf_nan=False)
    y: float = Field(ge=-100000, le=100000, allow_inf_nan=False)


class PositionsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    positions: list[PositionInput] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_documents(self):
        if len({p.document_id for p in self.positions}) != len(self.positions):
            raise ValueError("Each document can appear only once")
        return self


class PositionRead(PositionInput):
    model_config = ConfigDict(from_attributes=True)
    updated_at: datetime
    updated_by: UUID


class RelationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_document_id: UUID
    target_document_id: UUID
    relation_type: RelationType = RelationType.REFERENCE
    source_handle: Literal["left", "right", "top", "bottom"] = "right"
    target_handle: Literal["left", "right", "top", "bottom"] = "left"

    @model_validator(mode="after")
    def distinct_documents(self):
        if self.source_document_id == self.target_document_id:
            raise ValueError("A document cannot be related to itself")
        return self


class RelationRead(RelationCreate):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    workspace_id: UUID
    created_by: UUID
    created_at: datetime


ElementKind = Literal["text", "rectangle", "ellipse", "triangle"]
ElementColor = Literal["violet", "blue", "green", "amber", "rose", "slate"]


class ElementFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(default="", max_length=5000)
    x: float = Field(ge=-100000, le=100000, allow_inf_nan=False)
    y: float = Field(ge=-100000, le=100000, allow_inf_nan=False)
    width: float = Field(default=320, ge=80, le=2000, allow_inf_nan=False)
    height: float = Field(default=180, ge=60, le=2000, allow_inf_nan=False)
    color: ElementColor = "violet"
    font_size: int = Field(default=24, ge=12, le=96)


class ElementCreate(ElementFields):
    id: UUID
    kind: ElementKind


class ElementUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str | None = Field(default=None, max_length=5000)
    x: float | None = Field(default=None, ge=-100000, le=100000, allow_inf_nan=False)
    y: float | None = Field(default=None, ge=-100000, le=100000, allow_inf_nan=False)
    width: float | None = Field(default=None, ge=80, le=2000, allow_inf_nan=False)
    height: float | None = Field(default=None, ge=60, le=2000, allow_inf_nan=False)
    color: ElementColor | None = None
    font_size: int | None = Field(default=None, ge=12, le=96)

    @model_validator(mode="after")
    def nonempty_values(self):
        if not self.model_fields_set or any(
            getattr(self, name) is None for name in self.model_fields_set
        ):
            raise ValueError("At least one non-null field is required")
        return self


class ElementRead(ElementCreate):
    model_config = ConfigDict(from_attributes=True)
    workspace_id: UUID
    created_by: UUID
    updated_by: UUID
    created_at: datetime
    updated_at: datetime


class CanvasConversionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    version_id: UUID
    format: Literal["pdf", "docx", "txt", "md"]
    state: Literal["QUEUED", "RUNNING", "COMPLETED", "FAILED"]
    attempts: int
    error_message: str | None
    size: int | None
    warnings: list[str] | None


class CanvasRead(BaseModel):
    documents: list[DocumentRead]
    positions: list[PositionRead]
    relations: list[RelationRead]
    elements: list[ElementRead]
    conversions: list[CanvasConversionRead] = Field(default_factory=list)


class SummaryCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    version_ids: list[UUID] = Field(min_length=1, max_length=8)
    x: float = Field(ge=-100000, le=100000, allow_inf_nan=False)
    y: float = Field(ge=-100000, le=100000, allow_inf_nan=False)

    @model_validator(mode="after")
    def unique_versions(self):
        if len(set(self.version_ids)) != len(self.version_ids):
            raise ValueError("같은 파일을 중복 선택할 수 없습니다.")
        return self
