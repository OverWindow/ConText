from sqlalchemy import func, select

from app.intelligence.diff import cosine, filename_similarity, text_similarity
from app.intelligence.engine import job_key
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.intelligence import AnalysisJob


def candidates(db, version):
    if version.status != VersionStatus.READY or not version.uploaded_at:
        return {
            "items": [],
            "scanned": 0,
            "total": 0,
            "pending": 0,
            "limited": False,
            "algorithm": "sha256+filename+trigram+embedding-v1",
        }
    workspace_id = db.get(Document, version.document_id).workspace_id
    profile = db.get(AnalysisJob, job_key(version.id))
    source = profile.result if profile and profile.result else {}
    # Workspace filtering happens in SQL, before any text/vector scoring.
    query = (
        select(Document, DocumentVersion, AnalysisJob)
        .join(DocumentVersion, DocumentVersion.id == Document.current_version_id)
        .outerjoin(
            AnalysisJob,
            (AnalysisJob.version_id == DocumentVersion.id) & AnalysisJob.base_version_id.is_(None),
        )
        .where(
            Document.workspace_id == workspace_id,
            Document.id != version.document_id,
            DocumentVersion.status == VersionStatus.READY,
        )
    )
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.execute(query.order_by(Document.updated_at.desc(), Document.id).limit(500)).all()
    results, pending = [], 0
    for document, other, job in rows:
        data = job.result if job and job.result else {}
        if not data:
            pending += 1
        exact = version.sha256 == other.sha256 and version.size == other.size
        filename = filename_similarity(version.original_filename, other.original_filename)
        text = text_similarity(source.get("text", ""), data.get("text", ""))
        semantic = None
        if source.get("embedding_identity") == data.get("embedding_identity"):
            semantic = cosine(source.get("embedding"), data.get("embedding"))
        score = 1.0 if exact else 0.85 * max(text, semantic or 0) + 0.15 * filename
        # A filename by itself is insufficient evidence to suggest a version relationship.
        if not exact and (max(text, semantic or 0) < 0.55 or score < 0.6):
            continue
        results.append(
            {
                "document_id": document.id,
                "document_title": document.title,
                "version_id": other.id,
                "version_number": other.version_number,
                "score": round(score, 4),
                "exact_duplicate": exact,
                "filename_similarity": filename,
                "text_similarity": text,
                "embedding_similarity": semantic,
                "sampled": bool(source.get("text_truncated") or data.get("text_truncated")),
            }
        )
    results.sort(key=lambda row: (-row["score"], str(row["document_id"])))
    return {
        "items": results[:5],
        "scanned": len(rows),
        "total": total,
        "pending": pending,
        "limited": total > len(rows),
        "algorithm": "sha256+filename+trigram+embedding-v1",
    }
