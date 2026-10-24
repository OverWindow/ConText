"""Phase 1 users, teams, workspaces and explicit memberships."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001_foundation"
down_revision = None
branch_labels = None
depends_on = None

role = postgresql.ENUM("OWNER", "EDITOR", "VIEWER", name="member_role", create_type=False)


def identity():
    return [
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def updated():
    return sa.Column(
        "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
    )


def upgrade():
    role.create(op.get_bind())
    op.create_table(
        "users",
        *identity(),
        updated(),
        sa.Column("auth_user_id", sa.Uuid(), nullable=False, unique=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("display_name", sa.String(200), nullable=True),
    )
    op.create_table(
        "teams",
        *identity(),
        updated(),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
    )
    op.create_table(
        "team_members",
        *identity(),
        sa.Column(
            "team_id", sa.Uuid(), sa.ForeignKey("teams.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("role", role, nullable=False),
        sa.UniqueConstraint("team_id", "user_id", name="uq_team_member"),
    )
    op.create_index("ix_team_members_user_id", "team_members", ["user_id"])
    op.create_table(
        "workspaces",
        *identity(),
        updated(),
        sa.Column(
            "team_id", sa.Uuid(), sa.ForeignKey("teams.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
    )
    op.create_index("ix_workspaces_team_id", "workspaces", ["team_id"])
    op.create_table(
        "workspace_members",
        *identity(),
        sa.Column(
            "workspace_id",
            sa.Uuid(),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("role", role, nullable=False),
        sa.UniqueConstraint("workspace_id", "user_id", name="uq_workspace_member"),
    )
    op.create_index("ix_workspace_members_user_id", "workspace_members", ["user_id"])


def downgrade():
    for table in ("workspace_members", "workspaces", "team_members", "teams", "users"):
        op.drop_table(table)
    role.drop(op.get_bind())
