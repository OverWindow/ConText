from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.auth.dependencies import require_workspace_member, require_workspace_role
from app.db.session import get_db
from app.models.domain import WorkspaceMember
from app.schemas.canvas import (
    CanvasRead,
    ElementCreate,
    ElementRead,
    ElementUpdate,
    PositionRead,
    PositionsUpdate,
    RelationCreate,
    RelationRead,
    SummaryCreate,
)
from app.schemas.documents import DocumentCopyRead
from app.services import canvas
from app.services.document_summary import create_summary
from app.services.documents import WRITERS

router = APIRouter(prefix="/api/workspaces/{workspace_id}", tags=["canvas"])


@router.get("/canvas", response_model=CanvasRead)
def get_canvas(
    workspace_id: UUID,
    member: WorkspaceMember = Depends(require_workspace_member),
    db: Session = Depends(get_db),
):
    return canvas.snapshot(db, workspace_id)


@router.patch("/canvas/positions", response_model=list[PositionRead])
def update_positions(
    workspace_id: UUID,
    data: PositionsUpdate,
    member: WorkspaceMember = Depends(require_workspace_role(WRITERS)),
    db: Session = Depends(get_db),
):
    return canvas.save_positions(db, workspace_id, member.user_id, data)


@router.post("/relations", response_model=RelationRead, status_code=201)
def add_relation(
    workspace_id: UUID,
    data: RelationCreate,
    member: WorkspaceMember = Depends(require_workspace_role(WRITERS)),
    db: Session = Depends(get_db),
):
    return canvas.create_relation(db, workspace_id, member.user_id, data)


@router.delete("/relations/{relation_id}", status_code=204)
def remove_relation(
    workspace_id: UUID,
    relation_id: UUID,
    member: WorkspaceMember = Depends(require_workspace_role(WRITERS)),
    db: Session = Depends(get_db),
):
    canvas.delete_relation(db, workspace_id, relation_id)
    return Response(status_code=204)


@router.post("/canvas/elements", response_model=ElementRead, status_code=201)
def add_element(
    workspace_id: UUID,
    data: ElementCreate,
    member: WorkspaceMember = Depends(require_workspace_role(WRITERS)),
    db: Session = Depends(get_db),
):
    return canvas.create_element(db, workspace_id, member.user_id, data)


@router.patch("/canvas/elements/{element_id}", response_model=ElementRead)
def edit_element(
    workspace_id: UUID,
    element_id: UUID,
    data: ElementUpdate,
    member: WorkspaceMember = Depends(require_workspace_role(WRITERS)),
    db: Session = Depends(get_db),
):
    return canvas.update_element(db, workspace_id, element_id, member.user_id, data)


@router.delete("/canvas/elements/{element_id}", status_code=204)
def remove_element(
    workspace_id: UUID,
    element_id: UUID,
    member: WorkspaceMember = Depends(require_workspace_role(WRITERS)),
    db: Session = Depends(get_db),
):
    canvas.delete_element(db, workspace_id, element_id)
    return Response(status_code=204)


@router.post("/canvas/summaries", response_model=DocumentCopyRead, status_code=201)
def summarize_selection(
    workspace_id: UUID,
    data: SummaryCreate,
    member: WorkspaceMember = Depends(require_workspace_role(WRITERS)),
    db: Session = Depends(get_db),
):
    return create_summary(db, workspace_id, member.user_id, data)
