"""Workspace scoped vector chunks and durable shared chat."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

from app.rag.vector import Vector

revision = "0008_workspace_rag"
down_revision = "0007_version_intelligence"
branch_labels = None
depends_on = None


def work_columns():
    return [
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("run_token", sa.Uuid()),
        sa.Column(
            "queued_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("dispatched_at", sa.DateTime(timezone=True)),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("error_code", sa.String(60)),
    ]


def identity_columns():
    return [
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.create_table(
        "rag_indexes",
        sa.Column(
            "version_id",
            sa.Uuid(),
            sa.ForeignKey("document_versions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("chunk_count", sa.Integer(), nullable=False),
        sa.Column("indexed_count", sa.Integer(), nullable=False),
        *work_columns(),
    )
    op.create_index("ix_rag_indexes_state", "rag_indexes", ["state"])
    op.create_table(
        "document_chunks",
        *identity_columns(),
        sa.Column(
            "workspace_id",
            sa.Uuid(),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "version_id",
            sa.Uuid(),
            sa.ForeignKey("document_versions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("locations", JSONB, nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("embedding", Vector()),
        sa.UniqueConstraint("version_id", "ordinal", name="uq_chunk_ordinal"),
    )
    for field in ["workspace_id", "version_id", "fingerprint"]:
        op.create_index(f"ix_document_chunks_{field}", "document_chunks", [field])
    op.create_table(
        "chat_sessions",
        *identity_columns(),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "workspace_id",
            sa.Uuid(),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.UniqueConstraint(
            "workspace_id", "created_by", "request_id", name="uq_chat_session_request"
        ),
    )
    op.create_index("ix_chat_sessions_workspace_id", "chat_sessions", ["workspace_id"])
    op.create_table(
        "chat_messages",
        *identity_columns(),
        *work_columns(),
        sa.Column(
            "session_id",
            sa.Uuid(),
            sa.ForeignKey("chat_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("options", JSONB, nullable=False),
        sa.Column("result", JSONB),
        sa.UniqueConstraint("session_id", "sequence", name="uq_chat_sequence"),
        sa.UniqueConstraint("session_id", "request_id", "role", name="uq_chat_message_request"),
    )
    op.create_index("ix_chat_messages_session_id", "chat_messages", ["session_id"])
    op.create_index("ix_chat_messages_state", "chat_messages", ["state"])


def downgrade():
    for table in ["chat_messages", "chat_sessions", "document_chunks", "rag_indexes"]:
        op.drop_table(table)
    # Keep the extension: unrelated vector users may exist in the same database.
