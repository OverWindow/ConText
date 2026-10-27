"""User-owned AI connections and bounded local-context request metadata."""

import sqlalchemy as sa
from alembic import op

revision = "0012_ai_connections"
down_revision = "0011_ai_writing"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "ai_connections",
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("mode", sa.String(20), nullable=False),
        sa.Column("model", sa.String(200), nullable=False),
        sa.Column("encrypted_key", sa.Text()),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_table(
        "ai_requests",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("state", sa.String(20), nullable=False),
        sa.Column("error_code", sa.String(80)),
        sa.Column("response_ciphertext", sa.Text()),
        sa.Column("expires_at", sa.Integer()),
        sa.UniqueConstraint("user_id", "request_id", name="uq_ai_request"),
    )
    op.create_index("ix_ai_requests_user_id", "ai_requests", ["user_id"])


def downgrade():
    op.drop_table("ai_requests")
    op.drop_table("ai_connections")
