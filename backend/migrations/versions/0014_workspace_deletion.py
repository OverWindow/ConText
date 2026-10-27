"""Retain workspace deletion tombstones to reject delayed sync requests."""

import sqlalchemy as sa
from alembic import op

revision = "0014_workspace_deletion"
down_revision = "0013_cloud_sync"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("workspaces", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    # Silently removing tombstones would restore access to deleted workspaces.
    connection = op.get_bind()
    if connection.scalar(
        sa.text("SELECT EXISTS (SELECT 1 FROM workspaces WHERE deleted_at IS NOT NULL)")
    ):
        raise RuntimeError("Resolve deleted workspace tombstones before downgrading")
    op.drop_column("workspaces", "deleted_at")
