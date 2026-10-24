"""Persist the chosen side of each document connection."""

import sqlalchemy as sa
from alembic import op

revision = "0010_relation_handles"
down_revision = "0009_format_conversion"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "document_relations",
        sa.Column("source_handle", sa.String(8), nullable=False, server_default="right"),
    )
    op.add_column(
        "document_relations",
        sa.Column("target_handle", sa.String(8), nullable=False, server_default="left"),
    )
    for side in ("source", "target"):
        op.create_check_constraint(
            f"ck_relation_{side}_handle",
            "document_relations",
            f"{side}_handle IN ('left', 'right', 'top', 'bottom')",
        )


def downgrade():
    for side in ("source", "target"):
        op.drop_constraint(f"ck_relation_{side}_handle", "document_relations", type_="check")
        op.drop_column("document_relations", f"{side}_handle")
