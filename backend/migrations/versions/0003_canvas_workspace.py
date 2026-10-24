"""Shared document positions and workspace-scoped relation edges."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003_canvas_workspace"
down_revision = "0002_document_storage"
branch_labels = None
depends_on = None
relation_type = postgresql.ENUM(
    "REFERENCE",
    "DERIVED_FROM",
    "GENERATED_FROM",
    "RELATED_TO",
    name="document_relation_type",
    create_type=False,
)


def upgrade():
    relation_type.create(op.get_bind())
    op.create_unique_constraint(
        "uq_document_workspace_identity", "documents", ["workspace_id", "id"]
    )
    op.create_table(
        "document_positions",
        sa.Column(
            "document_id",
            sa.Uuid(),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("x", sa.Float(), nullable=False),
        sa.Column("y", sa.Float(), nullable=False),
        sa.Column("updated_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("x >= -100000 AND x <= 100000", name="ck_position_x"),
        sa.CheckConstraint("y >= -100000 AND y <= 100000", name="ck_position_y"),
    )
    op.create_table(
        "document_relations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "workspace_id",
            sa.Uuid(),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_document_id", sa.Uuid(), nullable=False),
        sa.Column("target_document_id", sa.Uuid(), nullable=False),
        sa.Column("relation_type", relation_type, nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.ForeignKeyConstraint(
            ["workspace_id", "source_document_id"],
            ["documents.workspace_id", "documents.id"],
            name="fk_relation_source_workspace",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id", "target_document_id"],
            ["documents.workspace_id", "documents.id"],
            name="fk_relation_target_workspace",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint("source_document_id <> target_document_id", name="ck_relation_not_self"),
        sa.UniqueConstraint(
            "source_document_id", "target_document_id", "relation_type", name="uq_document_relation"
        ),
    )
    op.create_index("ix_document_relations_workspace_id", "document_relations", ["workspace_id"])


def downgrade():
    op.drop_table("document_relations")
    op.drop_table("document_positions")
    op.drop_constraint("uq_document_workspace_identity", "documents", type_="unique")
    relation_type.drop(op.get_bind())
