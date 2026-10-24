from datetime import timedelta
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from app.ai.provider import AIUnavailable
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.domain import WorkspaceMember
from app.models.rag import ChatMessage, ChatSession
from app.processing.engine import now
from app.rag.answer import grounded_answer
from app.rag.indexing import fail, reset
from app.rag.retrieval import resolve_scope, retrieve


def session_for_workspace(db, workspace_id, session_id, lock=False):
    session = db.scalar(
        select(ChatSession)
        .where(ChatSession.id == session_id, ChatSession.workspace_id == workspace_id)
        .with_for_update()
        if lock
        else select(ChatSession).where(
            ChatSession.id == session_id, ChatSession.workspace_id == workspace_id
        )
    )
    if not session:
        raise HTTPException(404, "대화를 찾을 수 없습니다.")
    return session


def create_session(db, workspace_id, user_id, request_id, title):
    db.execute(
        insert(ChatSession)
        .values(
            id=uuid4(),
            workspace_id=workspace_id,
            created_by=user_id,
            request_id=request_id,
            title=title,
        )
        .on_conflict_do_nothing(constraint="uq_chat_session_request")
    )
    session = db.scalar(
        select(ChatSession).where(
            ChatSession.workspace_id == workspace_id,
            ChatSession.created_by == user_id,
            ChatSession.request_id == request_id,
        )
    )
    if session.title != title:
        raise HTTPException(409, "다른 대화 제목에 사용된 요청입니다.")
    db.commit()
    return session


def enqueue_turn(db, workspace_id, session_id, user_id, data):
    session = session_for_workspace(db, workspace_id, session_id, lock=True)
    previous = db.scalar(
        select(ChatMessage).where(
            ChatMessage.session_id == session_id,
            ChatMessage.request_id == data.request_id,
            ChatMessage.role == "user",
        )
    )
    requested = {"scope": data.scope, "as_of": data.as_of.isoformat() if data.as_of else None}
    if previous:
        if (
            previous.content != data.question
            or previous.options != requested
            or previous.created_by != user_id
        ):
            raise HTTPException(409, "다른 질문에 사용된 요청입니다.")
        return db.scalar(
            select(ChatMessage).where(
                ChatMessage.session_id == session_id,
                ChatMessage.request_id == data.request_id,
                ChatMessage.role == "assistant",
            )
        )
    active = db.scalar(
        select(ChatMessage.id)
        .where(ChatMessage.session_id == session_id, ChatMessage.state.in_(["QUEUED", "RUNNING"]))
        .limit(1)
    )
    if active:
        raise HTTPException(409, "이 대화의 답변을 기다린 뒤 다음 질문을 보내 주세요.")
    last = (
        db.scalar(
            select(func.max(ChatMessage.sequence)).where(ChatMessage.session_id == session_id)
        )
        or 0
    )
    if last >= 100:
        raise HTTPException(409, "대화가 길어졌습니다. 새 대화를 시작해 주세요.")
    db.add(
        ChatMessage(
            session_id=session_id,
            created_by=user_id,
            request_id=data.request_id,
            sequence=last + 1,
            role="user",
            content=data.question,
            options=requested,
            state="COMPLETED",
            finished_at=now(),
        )
    )
    answer = ChatMessage(
        session_id=session_id,
        created_by=user_id,
        request_id=data.request_id,
        sequence=last + 2,
        role="assistant",
        content="",
        options=requested,
        state="QUEUED",
    )
    db.add(answer)
    session.updated_at = now()
    db.commit()
    return answer


def retry(db, workspace_id, session_id, message_id):
    session_for_workspace(db, workspace_id, session_id, lock=True)
    message = db.get(ChatMessage, message_id, with_for_update=True)
    if not message or message.session_id != session_id or message.role != "assistant":
        raise HTTPException(404, "답변을 찾을 수 없습니다.")
    last = db.scalar(
        select(func.max(ChatMessage.sequence)).where(ChatMessage.session_id == session_id)
    )
    if message.sequence != last:
        raise HTTPException(409, "마지막 답변만 재시도할 수 있습니다. 새 질문으로 보내 주세요.")
    if message.state == "FAILED":
        if message.finished_at and message.finished_at > now() - timedelta(seconds=5):
            raise HTTPException(429, "잠시 후 다시 요청해 주세요.")
        reset(message)
    db.commit()
    return message


def run(message_id):
    message_id, token = UUID(str(message_id)), uuid4()
    with SessionLocal() as db:
        message = db.get(ChatMessage, message_id, with_for_update=True)
        if (
            not message
            or message.role != "assistant"
            or message.state != "QUEUED"
            or message.queued_at > now()
        ):
            return
        message.state, message.run_token, message.started_at = "RUNNING", token, now()
        db.commit()
        try:
            session = db.get(ChatSession, message.session_id)
            member = db.scalar(
                select(WorkspaceMember.id).where(
                    WorkspaceMember.workspace_id == session.workspace_id,
                    WorkspaceMember.user_id == message.created_by,
                )
            )
            if not member:
                raise AIUnavailable("ACCESS_REVOKED")
            question = db.scalar(
                select(ChatMessage).where(
                    ChatMessage.session_id == session.id,
                    ChatMessage.request_id == message.request_id,
                    ChatMessage.role == "user",
                )
            )
            history_rows = db.scalars(
                select(ChatMessage)
                .where(
                    ChatMessage.session_id == session.id,
                    ChatMessage.sequence < question.sequence,
                    ChatMessage.state == "COMPLETED",
                )
                .order_by(ChatMessage.sequence.desc())
                .limit(6)
            ).all()
            history = [
                {"role": row.role, "content": row.content[:1500]} for row in reversed(history_rows)
            ]
            search_text = question.content
            # Short follow-ups retain the previous question's topic, not fabricated model facts.
            prior_question = next((r.content for r in history_rows if r.role == "user"), "")
            if len(search_text) < 60 and prior_question:
                search_text = prior_question[:500] + "\n" + search_text
            scope = resolve_scope(question.content, question.options["scope"])
            evidence = retrieve(
                db, session.workspace_id, search_text, scope, question.options["as_of"]
            )
            answer = grounded_answer(question.content, evidence, history)
            used = {ref for claim in answer["claims"] for ref in claim["source_ids"]}
            result = {
                **evidence,
                **answer,
                "sources": [s for s in evidence["sources"] if s["id"] in used],
                "provenance": {"model": get_settings().ai_model, "prompt_version": "rag-v1"},
            }
            content = "\n\n".join(c["text"] for c in answer["claims"])
            if not content:
                content = (
                    "선택한 문서 범위에서 답변할 근거를 찾지 못했습니다. "
                    "검색 범위와 문서 색인 상태를 확인해 주세요."
                )
            error = None
        except AIUnavailable as exc:
            error = exc.code
        except Exception:
            error = "CHAT_UNAVAILABLE"
        db.rollback()
        message = db.get(ChatMessage, message_id, with_for_update=True)
        if not message or message.run_token != token or message.state != "RUNNING":
            return
        if error:
            fail(message, error)
            if error == "ACCESS_REVOKED":
                message.state, message.finished_at = "FAILED", now()
        else:
            message.content, message.result = content, result
            message.state, message.finished_at, message.error_code = "COMPLETED", now(), None
        db.commit()


def dispatch(publish):
    with SessionLocal() as db:
        expired = db.scalars(
            select(ChatMessage)
            .where(
                ChatMessage.role == "assistant",
                ChatMessage.state == "RUNNING",
                ChatMessage.started_at < now() - timedelta(seconds=180),
            )
            .with_for_update(skip_locked=True)
        ).all()
        for message in expired:
            message.run_token = None
            fail(message, "WORKER_INTERRUPTED")
        db.commit()
        messages = db.scalars(
            select(ChatMessage)
            .where(
                ChatMessage.role == "assistant",
                ChatMessage.state == "QUEUED",
                ChatMessage.queued_at <= now(),
                (ChatMessage.dispatched_at.is_(None))
                | (ChatMessage.dispatched_at < now() - timedelta(seconds=60)),
            )
            .order_by(ChatMessage.queued_at, ChatMessage.id)
            .limit(30)
            .with_for_update(skip_locked=True)
        ).all()
        for message in messages:
            publish(str(message.id))
            message.dispatched_at = now()
        db.commit()
