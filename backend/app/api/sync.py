from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user, require_workspace_member
from app.db.session import get_db
from app.models.domain import User, WorkspaceMember
from app.schemas.sync import BindingCreate, ItemsInput, SessionCreate, UploadsComplete
from app.services import sync
from app.storage.s3 import get_storage

router = APIRouter(prefix="/api", tags=["sync"])


@router.post("/sync/bindings")
def create_binding(
    data: BindingCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    return sync.bind(db, user, data)


@router.get("/sync/bindings/{binding_id}")
def read_binding(
    binding_id: UUID, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    return sync.binding_read(db, sync.origin(db, binding_id, user.id, active=False))


@router.delete("/sync/bindings/{binding_id}")
def delete_binding(
    binding_id: UUID, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    return sync.unbind(db, binding_id, user.id)


@router.post("/workspaces/{workspace_id}/sync-sessions")
def create_session(
    workspace_id: UUID,
    data: SessionCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return sync.start_session(db, workspace_id, user.id, data)


@router.get("/sync-sessions/{session_id}")
def get_session(
    session_id: UUID, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    _, session = sync.session_for_user(db, session_id, user.id)
    return sync.session_read(db, session)


@router.put("/sync-sessions/{session_id}/items")
def put_items(
    session_id: UUID,
    data: ItemsInput,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    return sync.prepare(db, session_id, user.id, data, get_storage())


@router.post("/sync-sessions/{session_id}/uploads/complete")
def complete_uploads(
    session_id: UUID,
    data: UploadsComplete,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return sync.verify(db, session_id, user.id, data.ordinals, get_storage())


@router.post("/sync-sessions/{session_id}/commit")
def commit_session(
    session_id: UUID, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    return sync.commit(db, session_id, user.id)


@router.delete("/sync-sessions/{session_id}")
def cancel_session(
    session_id: UUID, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    return sync.cancel_session(db, session_id, user.id)


@router.get("/workspaces/{workspace_id}/sync-view")
@router.get("/workspaces/{workspace_id}/entries")
def get_view(
    workspace_id: UUID,
    scope_id: UUID | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=500),
    revision: int | None = Query(None, ge=0),
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    return sync.view(db, workspace_id, scope_id, offset, limit, revision)


@router.get("/workspaces/{workspace_id}/sync-scene")
def get_scene(
    workspace_id: UUID,
    scope_id: UUID | None = None,
    limit: int = Query(200, ge=1, le=2000),
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    return sync.scene(db, workspace_id, scope_id, limit)
