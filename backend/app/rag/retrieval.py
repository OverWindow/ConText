import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import Float, case, cast, func, literal, select
from sqlalchemy.orm import aliased

from app.ai.provider import AIUnavailable
from app.ai.service import AIService
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.rag import DocumentChunk, RagIndex
from app.rag.indexing import fingerprint
from app.rag.vector import Vector


def resolve_scope(question, scope):
    if scope != "auto":
        return scope
    if re.search(
        r"지난|과거|이전\s*(버전|정책|내용)|작년|재작년|변경\s*(전|이력)|\d{4}[-년./]", question
    ):
        return "history"
    return "current"


def selected_versions(workspace_id, scope, as_of=None):
    query = (
        select(DocumentVersion.id)
        .join(Document, Document.id == DocumentVersion.document_id)
        .where(Document.workspace_id == workspace_id, DocumentVersion.status == VersionStatus.READY)
    )
    if scope == "current":
        query = query.where(DocumentVersion.id == Document.current_version_id)
    elif scope == "as_of":
        cutoff = datetime.combine(
            date.fromisoformat(as_of) + timedelta(days=1), time.min, tzinfo=ZoneInfo("Asia/Seoul")
        )
        previous = aliased(DocumentVersion)
        latest = (
            select(previous.id)
            .where(
                previous.document_id == Document.id,
                previous.uploaded_at < cutoff,
                previous.created_at < cutoff,
                previous.status == VersionStatus.READY,
            )
            .order_by(previous.version_number.desc())
            .limit(1)
            .correlate(Document)
            .scalar_subquery()
        )
        query = query.where(DocumentVersion.id == latest)
    return query


def index_status(db, workspace_id, scope="current", as_of=None):
    ids = selected_versions(workspace_id, scope, as_of)
    rows = db.execute(
        select(
            DocumentVersion.id,
            RagIndex.state,
            RagIndex.fingerprint,
            RagIndex.chunk_count,
            RagIndex.indexed_count,
        )
        .outerjoin(RagIndex, RagIndex.version_id == DocumentVersion.id)
        .where(DocumentVersion.id.in_(ids))
    ).all()
    return {
        "versions": len(rows),
        "completed": sum(r.state == "COMPLETED" and r.fingerprint == fingerprint() for r in rows),
        "failed": sum(r.state == "FAILED" for r in rows),
        "chunks": sum((r.chunk_count or 0) for r in rows),
        "indexed_chunks": sum((r.indexed_count or 0) for r in rows),
    }


def retrieve(db, workspace_id, question, scope="auto", as_of=None):
    scope = resolve_scope(question, scope)
    status = index_status(db, workspace_id, scope, as_of)
    warnings = []
    if status["completed"] < status["versions"]:
        warnings.append("INDEX_INCOMPLETE")
    base = (
        select(DocumentChunk, Document, DocumentVersion)
        .join(DocumentVersion, DocumentVersion.id == DocumentChunk.version_id)
        .join(Document, Document.id == DocumentVersion.document_id)
        .where(
            Document.workspace_id == workspace_id,
            DocumentChunk.workspace_id == workspace_id,
            DocumentChunk.version_id.in_(selected_versions(workspace_id, scope, as_of)),
        )
    )
    ranked = []
    if status["indexed_chunks"]:
        try:
            vector = AIService().embed(question[:3000])
            # CASE prevents dimension errors even if the optimizer reorders filters.
            distance = case(
                (
                    (DocumentChunk.fingerprint == fingerprint())
                    & (func.vector_dims(DocumentChunk.embedding) == len(vector)),
                    DocumentChunk.embedding.op("<=>", return_type=Float)(
                        cast(literal(vector, type_=Vector()), Vector())
                    ),
                ),
                else_=None,
            )
            rows = db.execute(
                base.add_columns(distance.label("distance"))
                .where(distance.is_not(None))
                .order_by(distance, DocumentChunk.id)
                .limit(24)
            ).all()
            ranked = [
                (row, max(0, 1 - row.distance), "semantic") for row in rows if row.distance <= 0.8
            ]
        except AIUnavailable:
            warnings.append("SEMANTIC_UNAVAILABLE")
    else:
        warnings.append("SEMANTIC_UNAVAILABLE")
    # Korean-friendly token containment is also useful for exact names and amounts.
    terms = list(dict.fromkeys(re.findall(r"[\w가-힣]{2,}", question.casefold())))[:12]
    if terms:
        score = sum(
            case((func.lower(DocumentChunk.text).contains(term, autoescape=True), 1), else_=0)
            for term in terms
        )
        rows = db.execute(
            base.add_columns(score.label("matches"))
            .where(score > 0)
            .order_by(score.desc(), DocumentChunk.id)
            .limit(24)
        ).all()
        ranked += [(row, row.matches / len(terms), "text") for row in rows]
    # Combine ranks instead of pretending lexical and embedding scores are calibrated alike.
    fused = {}
    for mode in ["semantic", "text"]:
        for rank, (row, score, method) in enumerate(item for item in ranked if item[2] == mode):
            item = fused.setdefault(
                row[0].id, {"row": row, "rank": 0, "score": score, "method": method}
            )
            item["rank"] += 1 / (60 + rank + 1)
    ordered = sorted(fused.values(), key=lambda item: (-item["rank"], str(item["row"][0].id)))
    sources, per_version = [], {}
    for item in ordered:
        chunk, doc, version = item["row"][:3]
        if per_version.get(version.id, 0) >= 3:
            continue
        per_version[version.id] = per_version.get(version.id, 0) + 1
        sources.append(
            {
                "id": f"S{len(sources) + 1}",
                "chunk_id": str(chunk.id),
                "document_id": str(doc.id),
                "document_title": doc.title,
                "version_id": str(version.id),
                "version_number": version.version_number,
                "is_current": doc.current_version_id == version.id,
                "source_sha256": version.sha256,
                "text": chunk.text,
                "locations": chunk.locations,
                "method": item["method"],
                "similarity": round(item["score"], 4),
            }
        )
        if len(sources) == 8:
            break
    return {
        "sources": sources,
        "scope": scope,
        "as_of": as_of,
        "warnings": warnings,
        "index": status,
    }
