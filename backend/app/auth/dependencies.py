from __future__ import annotations

from collections.abc import Callable
from uuid import UUID

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session, object_session

from app.auth.supabase import verify_token
from app.db.session import get_db
from app.models.domain import Role, TeamMember, User, Workspace, WorkspaceMember
from app.services.users import provision_user

bearer = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(401, "Authentication required", headers={"WWW-Authenticate": "Bearer"})
    return provision_user(db, verify_token(credentials.credentials))


def require_workspace_member(
    workspace_id: UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WorkspaceMember:
    member = db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == user.id,
        ).join(Workspace, Workspace.id == WorkspaceMember.workspace_id)
        .where(Workspace.deleted_at.is_(None))
    )
    if member is None:
        # Non-members receive the same response for missing and inaccessible workspaces.
        raise HTTPException(404, "Workspace not found")
    return member


def require_workspace_role(roles: tuple[Role, ...]) -> Callable[..., WorkspaceMember]:
    def dependency(
        member: WorkspaceMember = Depends(require_workspace_member),
    ) -> WorkspaceMember:
        check_workspace_role(member, roles)
        return member

    return dependency


def require_team_role(
    db: Session, team_id: UUID, user_id: UUID, roles: tuple[Role, ...]
) -> TeamMember:
    member = db.scalar(
        select(TeamMember).where(TeamMember.team_id == team_id, TeamMember.user_id == user_id)
    )
    if member is None:
        raise HTTPException(404, "Team not found")
    if member.role not in roles:
        raise HTTPException(403, "Insufficient team permissions")
    return member


def check_workspace_role(member: WorkspaceMember, roles: tuple[Role, ...]) -> None:
    if member.role not in roles:
        raise HTTPException(403, "Insufficient workspace permissions")
    if Role.EDITOR in roles:
        db = object_session(member)
        workspace = db.get(Workspace, member.workspace_id) if db else None
        if workspace and workspace.sync_mode == "desktop":
            raise HTTPException(409, "이 작업 공간은 데스크톱에서 수정한 뒤 동기화해 주세요.")
