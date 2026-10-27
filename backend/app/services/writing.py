"""Workspace-scoped evidence gathering and validated document generation."""

import json
import re

from sqlalchemy import select

from app.ai.service import AIService
from app.models.canvas import CanvasElement
from app.models.rag import ChatMessage, ChatSession
from app.models.writing import WritingDraft
from app.rag.retrieval import retrieve
from app.writing_format import normalized as normalized


def collect_sources(db, workspace_id, prompt, current=None, ai=None):
    query = prompt + (" " + current.title if current else "")
    result = (
        retrieve(db, workspace_id, query[:2000], "auto", None, ai)
        if ai
        else retrieve(db, workspace_id, query[:2000])
    )
    sources = [{**s, "id": "chunk-" + s["chunk_id"], "kind": "document"} for s in result["sources"]]
    # Canvas notes and conversations are scoped before any ranking or model access.
    notes = db.scalars(
        select(CanvasElement)
        .where(CanvasElement.workspace_id == workspace_id, CanvasElement.text != "")
        .order_by(CanvasElement.updated_at.desc())
        .limit(50)
    ).all()
    messages = db.execute(
        select(ChatMessage, ChatSession.title)
        .join(ChatSession, ChatSession.id == ChatMessage.session_id)
        .where(ChatSession.workspace_id == workspace_id, ChatMessage.state == "COMPLETED")
        .order_by(ChatMessage.created_at.desc())
        .limit(40)
    ).all()
    drafts = db.scalars(
        select(WritingDraft)
        .where(
            WritingDraft.workspace_id == workspace_id,
            *([WritingDraft.id != current.id] if current else []),
        )
        .order_by(WritingDraft.updated_at.desc())
        .limit(20)
    ).all()
    candidates = (
        [
            {
                "id": "note-" + str(n.id),
                "kind": "note",
                "document_title": "캔버스 메모",
                "text": n.text,
                "updated_at": n.updated_at.isoformat(),
            }
            for n in notes
        ]
        + [
            {
                "id": "chat-" + str(m.id),
                "kind": "chat",
                "document_title": title,
                "text": ("사용자: " if m.role == "user" else "AI 답변(검증 필요): ") + m.content,
                "updated_at": m.created_at.isoformat(),
            }
            for m, title in messages
        ]
        + [
            {
                "id": "draft-" + str(d.id),
                "kind": "draft",
                "document_title": d.title,
                "text": json.dumps(d.content, ensure_ascii=False)[:6000],
                "revision": d.revision,
                "updated_at": d.updated_at.isoformat(),
            }
            for d in drafts
        ]
    )
    terms = set(re.findall(r"[\w가-힣]{2,}", query.casefold()))
    candidates.sort(
        key=lambda s: sum(t in (s["text"] + s["document_title"]).casefold() for t in terms),
        reverse=True,
    )
    sources.extend(candidates[:6])
    if current:
        known = {s["id"] for s in sources}
        sources.extend(s for s in current.sources if s["id"] not in known)
    # Bound the context; preserve exact excerpts shown to the writer and reader.
    bounded, budget = [], 24000
    for source in sources[:20]:
        excerpt = source["text"][: min(4000, budget)]
        if not excerpt:
            continue
        bounded.append({**source, "text": excerpt})
        budget -= len(excerpt)
        if budget <= 0:
            break
    return bounded, result["warnings"]


def generate(db, workspace_id, prompt, current=None, ai=None):
    sources, warnings = collect_sources(db, workspace_id, prompt, current, ai)
    from app.ai.generation import generate_from_sources

    return generate_from_sources(
        prompt, sources, current.content if current else None, ai or AIService(), warnings
    )


def checkpoint(draft):
    draft.history = (
        draft.history
        + [
            {
                "content": draft.content,
                "sources": draft.sources,
                "checks": draft.checks,
            }
        ]
    )[-20:]
