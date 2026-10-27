from datetime import datetime, timezone
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.auth.dependencies import require_team_role
from app.models.domain import Role, Team, TeamMember, User, Workspace, WorkspaceMember
from app.models.sync import SyncBinding, SyncSession
from app.schemas.domain import WorkspaceCreate, WorkspaceRead


def workspace_read(workspace: Workspace, role: Role) -> WorkspaceRead:
    return WorkspaceRead(
        **{
            field: getattr(workspace, field)
            for field in WorkspaceRead.model_fields
            if field != "role"
        },
        role=role,
    )


def list_workspaces(db: Session, user_id: UUID) -> list[WorkspaceRead]:
    rows = db.execute(
        select(Workspace, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user_id, Workspace.deleted_at.is_(None))
        .order_by(Workspace.created_at.desc(), Workspace.id)
    )
    return [workspace_read(workspace, role) for workspace, role in rows]


def delete_workspace(db: Session, workspace_id: UUID, user_id: UUID) -> None:
    # Match sync's binding -> session -> workspace order. Tombstones keep delayed
    # clients from creating a new space or committing an already prepared snapshot.
    binding = db.scalar(
        select(SyncBinding).where(SyncBinding.workspace_id == workspace_id).with_for_update()
    )
    member = db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id
        )
    )
    if member is None:
        raise HTTPException(404, "Workspace not found")
    if member.role != Role.OWNER:
        raise HTTPException(403, "워크스페이스 소유자만 삭제할 수 있습니다.")
    timestamp = datetime.now(timezone.utc)
    if binding:
        db.execute(
            update(SyncSession)
            .where(SyncSession.binding_id == binding.id, SyncSession.state == "PREPARING")
            .values(state="CANCELLED", expires_at=timestamp)
        )
    workspace = db.scalar(
        select(Workspace).where(Workspace.id == workspace_id).with_for_update()
    )
    if workspace.deleted_at is None:
        workspace.deleted_at = timestamp
        workspace.sync_revision += 1
        if binding:
            binding.state = "DELETED"
            binding.generation += 1
    db.commit()


def create_workspace(db: Session, user: User, data: WorkspaceCreate) -> WorkspaceRead:
    try:
        team_id = data.team_id
        if team_id is None:
            team = Team(name=f"{data.name[:113]} team", created_by=user.id)
            db.add(team)
            db.flush()
            team_id = team.id
            db.add(TeamMember(team_id=team_id, user_id=user.id, role=Role.OWNER))
        else:
            require_team_role(db, team_id, user.id, (Role.OWNER, Role.EDITOR))
        workspace = Workspace(team_id=team_id, name=data.name, created_by=user.id)
        db.add(workspace)
        db.flush()
        db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=Role.OWNER))
        db.commit()
        db.refresh(workspace)
        return workspace_read(workspace, Role.OWNER)
    except Exception:
        db.rollback()
        raise
