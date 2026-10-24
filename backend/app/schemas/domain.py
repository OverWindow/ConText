from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models.domain import Role


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    email: str
    display_name: str | None
    created_at: datetime
    updated_at: datetime


class WorkspaceCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    team_id: UUID | None = None


class WorkspaceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    team_id: UUID
    name: str
    created_by: UUID
    created_at: datetime
    updated_at: datetime
    role: Role


class MemberAdd(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    email: str = Field(min_length=3, max_length=320, pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
    role: str = Field(default="VIEWER", pattern=r"^(EDITOR|VIEWER)$")
