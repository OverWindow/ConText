import hashlib
import json
from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator, model_validator

from app.schemas.canvas import ElementCreate, RelationCreate
from app.schemas.writing import StrictModel, WritingContent


class BindingCreate(StrictModel):
    device_id: UUID
    local_workspace_id: UUID
    name: str = Field(min_length=1, max_length=120)


class SessionCreate(StrictModel):
    binding_id: UUID
    generation: int = Field(ge=1)
    request_id: UUID
    base_revision: int = Field(ge=0)
    source_sequence: int = Field(ge=0)
    item_count: int = Field(ge=1, le=150000)
    manifest_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


def safe_name(value: str) -> str:
    if (
        value in (".", "..")
        or not value.strip()
        or any(c in value for c in ("/", "\\"))
        or any(ord(c) < 32 or ord(c) == 127 for c in value)
    ):
        raise ValueError("파일·폴더 이름에 경로를 사용할 수 없습니다.")
    return value


class EntryPayload(StrictModel):
    parent_id: UUID | None
    kind: Literal["file", "directory"]
    name: str = Field(min_length=1, max_length=255)
    document_id: UUID | None = None
    x: float = Field(default=0, ge=-1000000, le=1000000, allow_inf_nan=False)
    y: float = Field(default=0, ge=-1000000, le=1000000, allow_inf_nan=False)
    available: bool = True
    area_positioned: bool = False
    _name = field_validator("name")(safe_name)

    @model_validator(mode="after")
    def identity(self):
        if (self.kind == "file") != (self.document_id is not None):
            raise ValueError("파일에는 문서 식별자가 필요합니다.")
        return self


class ScopePayload(StrictModel):
    folder_entry_id: UUID


class DocumentPayload(StrictModel):
    title: str = Field(min_length=1, max_length=200)
    current_version_id: UUID
    file_version_id: UUID
    current_is_pinned: bool = False
    revision: int = Field(ge=1)


class VersionPayload(StrictModel):
    document_id: UUID
    version_number: int = Field(ge=1)
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    created_at: int = Field(ge=0, le=32503680000000)
    source_version_id: UUID | None = None
    change_note: str | None = Field(default=None, max_length=500)
    _filename = field_validator("filename")(safe_name)


class ElementPayload(ElementCreate):
    scope_id: UUID
    revision: int = Field(ge=1)


class RelationPayload(RelationCreate):
    scope_id: UUID
    revision: int = Field(ge=1)


class SourceLocation(StrictModel):
    block_id: int = Field(ge=0)
    page: int | None = Field(default=None, ge=0)
    line: int | None = Field(default=None, ge=0)


class DraftSource(StrictModel):
    id: str = Field(max_length=200)
    chunk_id: str = Field(max_length=200)
    document_id: UUID
    document_title: str = Field(max_length=255)
    version_id: UUID
    version_number: int = Field(ge=1)
    is_current: bool
    text: str = Field(max_length=12000)
    locations: list[SourceLocation] = Field(max_length=100)


class DraftHistory(StrictModel):
    content: WritingContent
    sources: list[DraftSource] = Field(max_length=100)
    checks: list[str] = Field(max_length=100)


class DraftPayload(DraftHistory):
    revision: int = Field(ge=1)
    history: list[DraftHistory] = Field(default_factory=list, max_length=20)


PAYLOADS = {
    "entry": EntryPayload,
    "scope": ScopePayload,
    "document": DocumentPayload,
    "version": VersionPayload,
    "element": ElementPayload,
    "relation": RelationPayload,
    "draft": DraftPayload,
}


class ItemInput(StrictModel):
    ordinal: int = Field(ge=0, lt=150000)
    entity_type: Literal["entry", "scope", "document", "version", "element", "relation", "draft"]
    entity_id: UUID
    # Hash the exact UTF-8 JSON string: identical across JS/Python number encoders.
    content: str = Field(max_length=1000000)

    @model_validator(mode="after")
    def validate_payload(self):
        PAYLOADS[self.entity_type].model_validate_json(self.content)
        if self.entity_type == "element" and json.loads(self.content)["id"] != str(self.entity_id):
            raise ValueError("요소 식별자가 일치하지 않습니다.")
        return self

    @property
    def payload(self):
        return PAYLOADS[self.entity_type].model_validate_json(self.content).model_dump(mode="json")

    @property
    def fingerprint(self):
        return hashlib.sha256(self.content.encode()).hexdigest()


class ItemsInput(StrictModel):
    items: list[ItemInput] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def limits(self):
        if (
            len({i.ordinal for i in self.items}) != len(self.items)
            or sum(len(i.content.encode()) for i in self.items) > 2000000
        ):
            raise ValueError("동기화 페이지가 너무 크거나 순번이 중복됩니다.")
        return self


class UploadsComplete(StrictModel):
    ordinals: list[int] = Field(min_length=1, max_length=100)
