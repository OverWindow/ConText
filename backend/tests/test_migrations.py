from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect


def test_migration_roundtrip_and_model_match(engine):
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    command.check(config)
    command.downgrade(config, "base")
    assert set(inspect(engine).get_table_names()) == {"alembic_version"}
    command.upgrade(config, "head")
    assert set(inspect(engine).get_table_names()) == {
        "alembic_version",
        "users",
        "teams",
        "team_members",
        "workspaces",
        "workspace_members",
        "documents",
        "document_versions",
        "document_positions",
        "canvas_elements",
        "document_relations",
        "document_processing",
        "analysis_jobs",
        "rag_indexes",
        "document_chunks",
        "chat_sessions",
        "chat_messages",
        "document_conversions",
        "writing_drafts",
        "ai_connections",
        "ai_requests",
        "sync_bindings",
        "workspace_entries",
        "canvas_scopes",
        "sync_sessions",
        "sync_session_items",
        "sync_operations",
    }
    command.check(config)
