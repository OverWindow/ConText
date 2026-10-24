"""Durable document processing jobs and verified originals."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004_document_processing"
down_revision = "0003_canvas_workspace"
branch_labels = None
depends_on = None
state = postgresql.ENUM(
    "QUEUED", "RUNNING", "COMPLETED", "FAILED", name="processing_state", create_type=False
)


def upgrade():
    op.add_column(
        "document_versions", sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.execute(
        "UPDATE document_versions SET uploaded_at = created_at "
        "WHERE status IN ('UPLOADED','PROCESSING','READY')"
    )
    state.create(op.get_bind())
    op.create_table(
        "document_processing",
        sa.Column(
            "version_id",
            sa.Uuid(),
            sa.ForeignKey("document_versions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("state", state, nullable=False),
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
        sa.Column("normalized_key", sa.String(1024)),
        sa.Column("text_key", sa.String(1024)),
        sa.Column("summary", postgresql.JSONB()),
    )
    op.create_index("ix_document_processing_state", "document_processing", ["state"])
    op.execute(
        "INSERT INTO document_processing (version_id,state,attempts) "
        "SELECT id,'QUEUED',0 FROM document_versions WHERE uploaded_at IS NOT NULL"
    )
    op.execute("UPDATE document_versions SET status='UPLOADED' WHERE uploaded_at IS NOT NULL")


def downgrade():
    op.drop_table("document_processing")
    state.drop(op.get_bind())
    op.drop_column("document_versions", "uploaded_at")
