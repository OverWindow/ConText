from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependencies import require_team_role
from app.models.domain import Role, Team, TeamMember, User, Workspace, WorkspaceMember
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
        .where(WorkspaceMember.user_id == user_id)
        .order_by(Workspace.created_at.desc(), Workspace.id)
    )
    return [workspace_read(workspace, role) for workspace, role in rows]


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
