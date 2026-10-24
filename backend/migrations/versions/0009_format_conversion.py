"""Durable version-scoped format conversion jobs."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0009_format_conversion"
down_revision = "0008_workspace_rag"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "document_conversions",
        sa.Column(
            "version_id",
            sa.Uuid(),
            sa.ForeignKey("document_versions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("format", sa.String(8), primary_key=True),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("source_key", sa.String(1024), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("run_token", sa.Uuid()),
        sa.Column(
            "queued_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("dispatched_at", sa.DateTime(timezone=True)),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("error_code", sa.String(60)),
        sa.Column("error_message", sa.String(500)),
        sa.Column("output_key", sa.String(1024)),
        sa.Column("size", sa.BigInteger()),
        sa.Column("sha256", sa.String(64)),
        sa.Column("warnings", JSONB),
        sa.CheckConstraint("format IN ('pdf', 'docx', 'txt', 'md')", name="ck_conversion_format"),
        sa.CheckConstraint(
            "state IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')", name="ck_conversion_state"
        ),
    )
    op.create_index("ix_document_conversions_state", "document_conversions", ["state"])


def downgrade():
    op.drop_table("document_conversions")
