from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session, selectinload

from app.models.canvas import CanvasElement, DocumentPosition, DocumentRelation
from app.models.conversion import DocumentConversion
from app.models.documents import Document, DocumentVersion
from app.models.domain import Workspace
from app.schemas.canvas import PositionsUpdate, RelationCreate


def require_documents(db: Session, workspace_id: UUID, ids: set[UUID]):
    found = set(
        db.scalars(
            select(Document.id).where(Document.workspace_id == workspace_id, Document.id.in_(ids))
        )
    )
    if found != ids:
        raise HTTPException(404, "Document not found in this workspace")


def snapshot(db: Session, workspace_id: UUID):
    documents = db.scalars(
        select(Document)
        .where(Document.workspace_id == workspace_id)
        .options(selectinload(Document.versions))
        .order_by(Document.created_at, Document.id)
        .limit(1001)
    ).all()
    if len(documents) > 1000:
        raise HTTPException(413, "Canvas supports up to 1,000 documents. Use the document list.")
    positions = db.scalars(
        select(DocumentPosition).join(Document).where(Document.workspace_id == workspace_id)
    ).all()
    relations = db.scalars(
        select(DocumentRelation)
        .where(DocumentRelation.workspace_id == workspace_id)
        .order_by(DocumentRelation.created_at, DocumentRelation.id)
    ).all()
    elements = db.scalars(
        select(CanvasElement)
        .where(CanvasElement.workspace_id == workspace_id)
        .order_by(CanvasElement.created_at, CanvasElement.id)
    ).all()
    conversions = db.scalars(
        select(DocumentConversion)
        .join(DocumentVersion, DocumentVersion.id == DocumentConversion.version_id)
        .join(Document, Document.id == DocumentVersion.document_id)
        .where(Document.workspace_id == workspace_id)
        .order_by(DocumentVersion.version_number, DocumentConversion.format)
    ).all()
    return {
        "documents": documents,
        "positions": positions,
        "relations": relations,
        "elements": elements,
        "conversions": conversions,
    }


def save_positions(db: Session, workspace_id: UUID, user_id: UUID, data: PositionsUpdate):
    require_documents(db, workspace_id, {p.document_id for p in data.positions})
    # Sort lock acquisition order for overlapping batches. Write only changed nodes.
    for position in sorted(data.positions, key=lambda p: str(p.document_id)):
        statement = insert(DocumentPosition).values(**position.model_dump(), updated_by=user_id)
        db.execute(
            statement.on_conflict_do_update(
                index_elements=[DocumentPosition.document_id],
                set_={
                    "x": position.x,
                    "y": position.y,
                    "updated_by": user_id,
                    "updated_at": func.now(),
                },
            )
        )
    db.commit()
    return db.scalars(
        select(DocumentPosition)
        .where(DocumentPosition.document_id.in_([p.document_id for p in data.positions]))
        .execution_options(populate_existing=True)
    ).all()


def create_relation(db: Session, workspace_id: UUID, user_id: UUID, data: RelationCreate):
    require_documents(db, workspace_id, {data.source_document_id, data.target_document_id})
    db.execute(
        insert(DocumentRelation)
        .values(id=uuid4(), workspace_id=workspace_id, created_by=user_id, **data.model_dump())
        .on_conflict_do_update(
            constraint="uq_document_relation",
            set_={"source_handle": data.source_handle, "target_handle": data.target_handle},
        )
    )
    db.commit()
    return db.scalar(
        select(DocumentRelation).where(
            DocumentRelation.workspace_id == workspace_id,
            DocumentRelation.source_document_id == data.source_document_id,
            DocumentRelation.target_document_id == data.target_document_id,
            DocumentRelation.relation_type == data.relation_type,
        )
    )


def delete_relation(db: Session, workspace_id: UUID, relation_id: UUID):
    relation = db.scalar(
        select(DocumentRelation).where(
            DocumentRelation.workspace_id == workspace_id, DocumentRelation.id == relation_id
        )
    )
    if relation is None:
        raise HTTPException(404, "Relation not found")
    db.delete(relation)
    db.commit()


def create_element(db: Session, workspace_id: UUID, user_id: UUID, data):
    # Serialize the workspace limit and retried creation requests.
    db.scalar(select(Workspace).where(Workspace.id == workspace_id).with_for_update())
    existing = db.get(CanvasElement, data.id)
    if existing:
        if existing.workspace_id != workspace_id or existing.created_by != user_id:
            raise HTTPException(409, "이미 사용 중인 요소 ID입니다.")
        if any(getattr(existing, key) != value for key, value in data.model_dump().items()):
            raise HTTPException(409, "다른 내용에 사용된 요소 ID입니다.")
        db.commit()
        return existing
    count = db.scalar(
        select(func.count())
        .select_from(CanvasElement)
        .where(CanvasElement.workspace_id == workspace_id)
    )
    if count >= 500:
        raise HTTPException(409, "워크스페이스당 텍스트·도형을 최대 500개까지 추가할 수 있습니다.")
    element = CanvasElement(
        **data.model_dump(), workspace_id=workspace_id, created_by=user_id, updated_by=user_id
    )
    db.add(element)
    db.commit()
    db.refresh(element)
    return element


def element_for_workspace(db: Session, workspace_id: UUID, element_id: UUID):
    element = db.scalar(
        select(CanvasElement)
        .where(CanvasElement.workspace_id == workspace_id, CanvasElement.id == element_id)
        .with_for_update()
    )
    if element is None:
        raise HTTPException(404, "캔버스 요소를 찾을 수 없습니다.")
    return element


def update_element(db: Session, workspace_id: UUID, element_id: UUID, user_id: UUID, data):
    element = element_for_workspace(db, workspace_id, element_id)
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(element, key, value)
    element.updated_by = user_id
    db.commit()
    db.refresh(element)
    return element


def delete_element(db: Session, workspace_id: UUID, element_id: UUID):
    element = element_for_workspace(db, workspace_id, element_id)
    db.delete(element)
    db.commit()
