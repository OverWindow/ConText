from datetime import datetime
from pathlib import PurePath
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.documents import VersionStatus

ALLOWED_TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".hwpx": "application/hwp+zip",
    ".txt": "text/plain",
    ".md": "text/markdown",
}


class UploadCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    title: str = Field(min_length=1, max_length=200)
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0, strict=True)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")

    @field_validator("title", mode="before")
    @classmethod
    def trim_title(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("filename")
    @classmethod
    def valid_filename(cls, value: str) -> str:
        if (
            any(ord(char) < 32 or ord(char) == 127 for char in value)
            or "/" in value
            or "\\" in value
        ):
            raise ValueError("Filename must not contain paths or control characters")
        if PurePath(value).suffix.lower() not in ALLOWED_TYPES:
            raise ValueError("Supported files: PDF, DOCX, HWPX, TXT, MD")
        return value


class VersionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    document_id: UUID
    version_number: int
    original_filename: str
    mime_type: str
    size: int
    sha256: str
    created_by: UUID
    created_at: datetime
    uploaded_at: datetime | None = None
    source_version_id: UUID | None = None
    change_note: str | None = None
    author_name: str
    status: VersionStatus


class DocumentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    workspace_id: UUID
    title: str
    current_version_id: UUID | None
    created_by: UUID
    created_at: datetime
    updated_at: datetime
    versions: list[VersionRead]


class UploadTicket(BaseModel):
    document_id: UUID
    version_id: UUID
    upload_url: str
    method: str = "PUT"
    headers: dict[str, str]
    expires_in: int


class UploadComplete(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version_id: UUID


class DownloadTicket(BaseModel):
    download_url: str
    expires_in: int


class VersionUpload(UploadCreate):
    title: str = Field(default="버전", min_length=1, max_length=200)
    change_note: str | None = Field(default=None, max_length=500)


class VersionLink(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    source_version_id: UUID
    change_note: str | None = Field(default=None, max_length=500)


class CurrentVersion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version_id: UUID


class DocumentCopy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    version_id: UUID
    x: float = Field(ge=-100000, le=100000, allow_inf_nan=False)
    y: float = Field(ge=-100000, le=100000, allow_inf_nan=False)


class DocumentCopyRead(BaseModel):
    document: DocumentRead
    x: float
    y: float
