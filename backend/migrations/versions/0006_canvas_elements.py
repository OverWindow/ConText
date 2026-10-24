"""Editable canvas text and background shapes (independent of AI Phase 6)."""

import sqlalchemy as sa
from alembic import op

revision = "0006_canvas_elements"
down_revision = "0005_version_management"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "canvas_elements",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.Uuid(),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        *[sa.Column(name, sa.Float(), nullable=False) for name in ["x", "y", "width", "height"]],
        sa.Column("color", sa.String(16), nullable=False),
        sa.Column("font_size", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("updated_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "kind IN ('text','rectangle','ellipse','triangle')", name="ck_element_kind"
        ),
        sa.CheckConstraint(
            "color IN ('violet','blue','green','amber','rose','slate')", name="ck_element_color"
        ),
        sa.CheckConstraint(
            "x >= -100000 AND x <= 100000 AND y >= -100000 AND y <= 100000",
            name="ck_element_position",
        ),
        sa.CheckConstraint(
            "width >= 80 AND width <= 2000 AND height >= 60 AND height <= 2000",
            name="ck_element_size",
        ),
        sa.CheckConstraint("font_size >= 12 AND font_size <= 96", name="ck_element_font"),
        sa.CheckConstraint("length(text) <= 5000", name="ck_element_text"),
    )
    op.create_index("ix_canvas_elements_workspace_id", "canvas_elements", ["workspace_id"])


def downgrade():
    op.drop_table("canvas_elements")
