"""Persistent AI drafts, review proposals and bounded revision history."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0011_ai_writing"
down_revision = "0010_relation_handles"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "writing_drafts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
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
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("content", JSONB(), nullable=False),
        sa.Column("sources", JSONB(), nullable=False),
        sa.Column("checks", JSONB(), nullable=False),
        sa.Column("history", JSONB(), nullable=False),
        sa.Column("prompt", sa.String(4000), nullable=False),
        sa.Column("proposal", JSONB()),
        sa.UniqueConstraint("workspace_id", "created_by", "request_id", name="uq_writing_request"),
    )
    op.create_index("ix_writing_drafts_workspace_id", "writing_drafts", ["workspace_id"])


def downgrade():
    op.drop_table("writing_drafts")
