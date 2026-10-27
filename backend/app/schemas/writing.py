import json
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WritingBlock(StrictModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    type: Literal["paragraph", "heading", "list", "table"]
    text: str = Field(default="", max_length=12000)
    level: int = Field(default=2, ge=1, le=6)
    items: list[str] = Field(default_factory=list, max_length=100)
    rows: list[list[str]] = Field(default_factory=list, max_length=100)
    source_ids: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def limits(self):
        if any(len(s) > 2000 for s in self.items):
            raise ValueError("목록 항목이 너무 깁니다.")
        if any(len(row) > 12 or any(len(cell) > 2000 for cell in row) for row in self.rows):
            raise ValueError("표가 너무 큽니다.")
        if self.type == "table" and (not self.rows or not all(self.rows)):
            raise ValueError("표에 셀이 필요합니다.")
        if self.type == "list" and not self.items:
            raise ValueError("목록 항목이 필요합니다.")
        return self


class WritingContent(StrictModel):
    title: str = Field(min_length=1, max_length=200)
    blocks: list[WritingBlock] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def limits(self):
        if not self.title.strip() or len({b.id for b in self.blocks}) != len(self.blocks):
            raise ValueError("제목 또는 문단 식별자가 올바르지 않습니다.")
        if len(json.dumps(self.model_dump(), ensure_ascii=False)) > 150000:
            raise ValueError("문서가 너무 큽니다.")
        return self


class GeneratedContent(WritingContent):
    checks: list[str] = Field(default_factory=list, max_length=20)


class GenerateRequest(StrictModel):
    request_id: UUID
    prompt: str = Field(min_length=1, max_length=4000)
    revision: int | None = Field(default=None, ge=1)

    @field_validator("prompt")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("작성 요청을 입력해 주세요.")
        return value.strip()


class BlankRequest(StrictModel):
    request_id: UUID


class SaveRequest(StrictModel):
    revision: int = Field(ge=1)
    content: WritingContent


class RevisionRequest(StrictModel):
    revision: int = Field(ge=1)
