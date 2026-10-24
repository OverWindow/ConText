"""Create a grounded summary as an independent, immutable Markdown document."""

import hashlib
import json
from uuid import uuid4

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import HTTPException
from sqlalchemy import func, select

from app.ai.provider import AIUnavailable
from app.core.config import get_settings
from app.intelligence.engine import load_document
from app.models.canvas import DocumentPosition, DocumentRelation, RelationType
from app.models.documents import Document, DocumentVersion, VersionStatus
from app.models.domain import Workspace, WorkspaceMember
from app.models.processing import DocumentProcessing, ProcessingState
from app.processing.engine import now
from app.processing.parsers import normalize
from app.rag.answer import grounded_answer
from app.services.documents import WRITERS, document_for_user
from app.storage.s3 import get_storage


def create_summary(db, workspace_id, user_id, data):
    try:
        # Serialize only the same request, without locking the workspace during AI generation.
        lock = int.from_bytes(
            hashlib.sha256(f"{workspace_id}:{user_id}:{data.request_id}".encode()).digest()[:8],
            "big",
            signed=True,
        )
        db.execute(select(func.pg_advisory_xact_lock(lock)))
        signature = sorted(str(v) for v in data.version_ids)
        existing = db.scalar(
            select(Document).where(
                Document.workspace_id == workspace_id,
                Document.created_by == user_id,
                Document.upload_request_id == data.request_id,
            )
        )
        if existing:
            first = db.scalar(
                select(DocumentVersion).where(
                    DocumentVersion.document_id == existing.id, DocumentVersion.version_number == 1
                )
            )
            job = db.get(DocumentProcessing, first.id) if first else None
            if not job or (job.summary or {}).get("summary_sources") != signature:
                raise HTTPException(409, "다른 작업에 사용된 요청입니다.")
            position = db.get(DocumentPosition, existing.id)
            result = {
                "document": document_for_user(db, existing.id, user_id),
                "x": position.x,
                "y": position.y,
            }
            db.commit()
            return result
        rows = db.execute(
            select(DocumentVersion, Document)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(
                Document.workspace_id == workspace_id,
                DocumentVersion.id.in_(data.version_ids),
            )
        ).all()
        if len(rows) != len(data.version_ids):
            raise HTTPException(404, "이 워크스페이스의 문서만 요약할 수 있습니다.")
        if len({doc.id for _, doc in rows}) != len(rows):
            raise HTTPException(422, "파일마다 하나의 수정 이력만 선택해 주세요.")
        rows.sort(key=lambda row: signature.index(str(row[0].id)))
        sources, partial = [], []
        budget = 24000 // len(rows)
        for version, doc in rows:
            if version.status != VersionStatus.READY:
                raise HTTPException(409, "선택한 파일의 본문 처리가 끝난 뒤 요약해 주세요.")
            normalized = load_document(db, version)
            text = "\n\n".join(block["text"] for block in normalized["blocks"])
            if not text.strip():
                raise HTTPException(409, "본문이 없는 파일은 요약할 수 없습니다.")
            if len(text) > budget:
                partial.append(doc.title)
            sources.append(
                {
                    "id": f"S{len(sources) + 1}",
                    "document_title": doc.title,
                    "version_number": version.version_number,
                    "text": text[:budget],
                }
            )
        answer = grounded_answer(
            (
                "선택된 모든 문서의 핵심 내용을 문서별로 요약하고, "
                "공통 주제가 있으면 함께 정리해 주세요. "
                "각 문서의 출처를 인용하고, 제공된 부분만 설명하세요."
            ),
            {"sources": sources, "scope": "current", "as_of": None},
            [],
        )
        used = {ref for claim in answer["claims"] for ref in claim["source_ids"]}
        if not answer["claims"] or used != {source["id"] for source in sources}:
            raise HTTPException(
                422,
                "선택한 모든 파일의 근거를 포함한 요약을 만들지 못했습니다. 다시 시도해 주세요.",
            )
        # Recheck write access after the provider call, then serialize only naming/publication.
        role = db.scalar(
            select(WorkspaceMember.role).where(
                WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id
            )
        )
        if role not in WRITERS:
            raise HTTPException(403, "요약 파일을 만들 권한이 없습니다.")
        db.scalar(select(Workspace.id).where(Workspace.id == workspace_id).with_for_update())
        titles = set(
            db.scalars(select(Document.title).where(Document.workspace_id == workspace_id))
        )
        base = f"{rows[0][1].title[:100]} 요약" if len(rows) == 1 else f"문서 {len(rows)}개 요약"
        title, number = base, 2
        while title in titles:
            title = f"{base} {number}"
            number += 1
        lines = [f"# {title}", "", "AI가 생성한 요약입니다. 출처 원문과 함께 확인해 주세요.", ""]
        if partial:
            lines += ["일부 긴 문서는 앞부분을 바탕으로 요약했습니다: " + ", ".join(partial), ""]
        if answer["insufficient"]:
            lines += ["제공된 내용만으로 충분히 설명하기 어려운 부분이 있습니다.", ""]
        lines += [
            claim["text"] + " (" + ", ".join(claim["source_ids"]) + ")\n"
            for claim in answer["claims"]
        ]
        lines += ["## 출처", ""]
        lines += [
            f"- {source['id']}: {doc.title} · 수정 이력 {version.version_number}"
            f" · 문서 {doc.id} · 이력 {version.id}"
            for source, (version, doc) in zip(sources, rows)
        ]
        body = "\n".join(lines).encode()
        digest = hashlib.sha256(body).hexdigest()
        document_id, version_id = uuid4(), uuid4()
        bucket = get_settings().aws_s3_bucket
        prefix = f"workspaces/{workspace_id}/documents/{document_id}/versions/{version_id}"
        source_key, normalized_key, text_key = (
            prefix + "/original.md",
            prefix + "/normalized.json",
            prefix + "/extracted.txt",
        )
        normalized = normalize(body, title + ".md", digest)
        storage = get_storage()
        for key, content, mime in [
            (source_key, body, "text/markdown"),
            (
                normalized_key,
                json.dumps(normalized, ensure_ascii=False).encode(),
                "application/json; charset=utf-8",
            ),
            (
                text_key,
                "\n\n".join(b["text"] for b in normalized["blocks"]).encode(),
                "text/plain; charset=utf-8",
            ),
        ]:
            storage.client.put_object(
                Bucket=bucket,
                Key=key,
                Body=content,
                ContentType=mime,
                ServerSideEncryption="AES256",
                IfNoneMatch="*",
                Metadata={"version-id": str(version_id)},
            )
        document = Document(
            id=document_id,
            workspace_id=workspace_id,
            title=title,
            created_by=user_id,
            upload_request_id=data.request_id,
        )
        db.add(document)
        db.flush()
        version = DocumentVersion(
            id=version_id,
            document_id=document_id,
            version_number=1,
            upload_request_id=data.request_id,
            change_note="선택한 문서 AI 요약",
            storage_bucket=bucket,
            storage_key=source_key,
            original_filename=title + ".md",
            mime_type="text/markdown",
            size=len(body),
            sha256=digest,
            created_by=user_id,
            uploaded_at=now(),
            status=VersionStatus.READY,
        )
        db.add(version)
        db.flush()
        document.current_version_id = version_id
        summary = {k: v for k, v in normalized.items() if k not in ("blocks", "source_sha256")}
        summary.update(
            block_count=len(normalized["blocks"]),
            character_count=sum(len(b["text"]) for b in normalized["blocks"]),
            summary_sources=signature,
        )
        db.add(
            DocumentProcessing(
                version_id=version_id,
                state=ProcessingState.COMPLETED,
                normalized_key=normalized_key,
                text_key=text_key,
                summary=summary,
                finished_at=now(),
            )
        )
        db.add(DocumentPosition(document_id=document_id, x=data.x, y=data.y, updated_by=user_id))
        for _, doc in rows:
            db.add(
                DocumentRelation(
                    workspace_id=workspace_id,
                    source_document_id=document_id,
                    target_document_id=doc.id,
                    relation_type=RelationType.GENERATED_FROM,
                    source_handle="left",
                    target_handle="right",
                    created_by=user_id,
                )
            )
        db.commit()
        return {"document": document_for_user(db, document_id, user_id), "x": data.x, "y": data.y}
    except AIUnavailable as exc:
        db.rollback()
        detail = (
            "AI 연결 설정이 필요합니다."
            if exc.code == "AI_NOT_CONFIGURED"
            else "AI 요약을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요."
        )
        raise HTTPException(503, detail) from exc
    except (BotoCoreError, ClientError) as exc:
        db.rollback()
        raise HTTPException(503, "요약 파일을 저장하지 못했습니다. 다시 시도해 주세요.") from exc
    except Exception:
        db.rollback()
        raise
