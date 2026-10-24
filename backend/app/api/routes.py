from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user, require_workspace_member, require_workspace_role
from app.db.session import get_db
from app.models.domain import Role, User, Workspace, WorkspaceMember
from app.schemas.domain import MemberAdd, UserRead, WorkspaceCreate, WorkspaceRead
from app.services import workspaces

router = APIRouter(prefix="/api")


@router.get("/me", response_model=UserRead)
def me(user: User = Depends(get_current_user)):
    return user


@router.get("/workspaces", response_model=list[WorkspaceRead])
def list_workspaces(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return workspaces.list_workspaces(db, user.id)


@router.post("/workspaces", response_model=WorkspaceRead, status_code=201)
def create_workspace(
    data: WorkspaceCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return workspaces.create_workspace(db, user, data)


@router.get("/workspaces/{workspace_id}", response_model=WorkspaceRead)
def get_workspace(
    workspace_id: UUID,
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    workspace = db.get(Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(404, "Workspace not found")
    return workspaces.workspace_read(workspace, member.role)


@router.get("/workspaces/{workspace_id}/members")
def members(
    workspace_id: UUID,
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    rows = db.execute(
        select(User, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.user_id == User.id)
        .where(WorkspaceMember.workspace_id == workspace_id)
        .order_by(User.display_name, User.id)
    ).all()
    return [
        {"id": user.id, "display_name": user.display_name or user.email.split("@")[0], "role": role}
        for user, role in rows
    ]


@router.post("/workspaces/{workspace_id}/members", status_code=201)
def add_member(
    workspace_id: UUID,
    data: MemberAdd,
    member: WorkspaceMember = Depends(require_workspace_role((Role.OWNER,))),
    db: Session = Depends(get_db),
):
    users = db.scalars(
        select(User).where(func.lower(User.email) == data.email.lower()).limit(2)
    ).all()
    if not users:
        raise HTTPException(
            404,
            "이 이메일로 가입한 사용자가 없습니다. 먼저 Google로 로그인해 달라고 안내해 주세요.",
        )
    if len(users) != 1:
        raise HTTPException(409, "동일한 이메일의 계정이 여러 개입니다. 관리자에게 문의해 주세요.")
    user = users[0]
    db.execute(
        insert(WorkspaceMember)
        .values(workspace_id=workspace_id, user_id=user.id, role=Role(data.role))
        .on_conflict_do_nothing(constraint="uq_workspace_member")
    )
    db.commit()
    added = db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user.id
        )
    )
    return {
        "id": user.id,
        "display_name": user.display_name or user.email.split("@")[0],
        "role": added.role,
    }
