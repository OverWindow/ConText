"""Durable version profiles and evidence-backed change summaries."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0007_version_intelligence"
down_revision = "0006_canvas_elements"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "analysis_jobs",
        sa.Column("key", sa.String(90), primary_key=True),
        sa.Column(
            "version_id",
            sa.Uuid(),
            sa.ForeignKey("document_versions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "base_version_id", sa.Uuid(), sa.ForeignKey("document_versions.id", ondelete="CASCADE")
        ),
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
        sa.Column("result", JSONB),
    )
    op.create_index("ix_analysis_jobs_version_id", "analysis_jobs", ["version_id"])
    op.create_index("ix_analysis_jobs_state", "analysis_jobs", ["state"])


def downgrade():
    op.drop_table("analysis_jobs")
