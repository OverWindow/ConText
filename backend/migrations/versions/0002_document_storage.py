"""Document metadata and immutable first-version uploads."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002_document_storage"
down_revision = "0001_foundation"
branch_labels = None
depends_on = None

status = postgresql.ENUM(
    "PENDING",
    "UPLOADING",
    "UPLOADED",
    "PROCESSING",
    "READY",
    "FAILED",
    name="document_version_status",
    create_type=False,
)


def upgrade():
    status.create(op.get_bind())
    op.create_table(
        "documents",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
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
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("upload_request_id", sa.Uuid(), nullable=False),
        sa.Column("current_version_id", sa.Uuid(), nullable=True),
        sa.UniqueConstraint(
            "workspace_id", "created_by", "upload_request_id", name="uq_document_upload_request"
        ),
    )
    op.create_index("ix_documents_workspace_id", "documents", ["workspace_id"])
    op.create_table(
        "document_versions",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "document_id",
            sa.Uuid(),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("storage_bucket", sa.String(63), nullable=False),
        sa.Column("storage_key", sa.String(1024), nullable=False, unique=True),
        sa.Column("original_filename", sa.String(255), nullable=False),
        sa.Column("mime_type", sa.String(127), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", status, nullable=False),
        sa.UniqueConstraint("document_id", "version_number", name="uq_document_version_number"),
        sa.UniqueConstraint("document_id", "id", name="uq_document_version_identity"),
        sa.CheckConstraint("size > 0", name="ck_document_version_size"),
        sa.CheckConstraint("version_number > 0", name="ck_document_version_number"),
    )
    op.create_foreign_key(
        "fk_document_current_version",
        "documents",
        "document_versions",
        ["id", "current_version_id"],
        ["document_id", "id"],
        deferrable=True,
        initially="DEFERRED",
        use_alter=True,
    )


def downgrade():
    op.drop_constraint("fk_document_current_version", "documents", type_="foreignkey")
    op.drop_table("document_versions")
    op.drop_table("documents")
    status.drop(op.get_bind())
