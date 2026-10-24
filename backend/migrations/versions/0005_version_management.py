"""Version requests, provenance and shared immutable objects for manual linking."""

import sqlalchemy as sa
from alembic import op

revision = "0005_version_management"
down_revision = "0004_document_processing"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("document_versions", sa.Column("upload_request_id", sa.Uuid()))
    op.add_column("document_versions", sa.Column("source_version_id", sa.Uuid()))
    op.add_column("document_versions", sa.Column("change_note", sa.String(500)))
    op.create_foreign_key(
        "fk_version_source",
        "document_versions",
        "document_versions",
        ["source_version_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_unique_constraint(
        "uq_version_upload_request",
        "document_versions",
        ["document_id", "created_by", "upload_request_id"],
    )
    op.create_index("ix_document_versions_fingerprint", "document_versions", ["sha256", "size"])
    op.drop_constraint("document_versions_storage_key_key", "document_versions", type_="unique")
    op.create_index("ix_document_versions_storage_key", "document_versions", ["storage_key"])
    op.execute(
        "UPDATE document_versions v SET upload_request_id=d.upload_request_id "
        "FROM documents d WHERE d.id=v.document_id AND v.version_number=1"
    )


def downgrade():
    # PostgreSQL refuses to recreate uniqueness if shared objects exist. Never delete user versions.
    op.create_unique_constraint(
        "document_versions_storage_key_key", "document_versions", ["storage_key"]
    )
    op.drop_index("ix_document_versions_storage_key", table_name="document_versions")
    op.drop_index("ix_document_versions_fingerprint", table_name="document_versions")
    op.drop_constraint("uq_version_upload_request", "document_versions", type_="unique")
    op.drop_constraint("fk_version_source", "document_versions", type_="foreignkey")
    for name in ["change_note", "source_version_id", "upload_request_id"]:
        op.drop_column("document_versions", name)
