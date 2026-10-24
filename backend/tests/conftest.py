import os
import secrets
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

# Tests only target a deliberately named test database, never the application DB.
TEST_URL = os.environ.get("TEST_DATABASE_URL")
if not TEST_URL or not make_url(TEST_URL).database.endswith("_test"):
    raise RuntimeError("Set TEST_DATABASE_URL to a disposable PostgreSQL database ending in _test")
os.environ["DATABASE_URL"] = TEST_URL
os.environ["SUPABASE_URL"] = "https://auth.example.test"
os.environ["SUPABASE_JWT_SECRET"] = secrets.token_hex(32)

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()

from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def engine():
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    command.upgrade(config, "head")
    engine = create_engine(TEST_URL)
    yield engine
    engine.dispose()


@pytest.fixture(autouse=True)
def clean_database(engine):
    with engine.begin() as connection:
        connection.execute(
            text("TRUNCATE workspace_members, workspaces, team_members, teams, users CASCADE")
        )
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def db(engine):
    with sessionmaker(bind=engine)() as session:
        yield session


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    with TestClient(app) as client:
        yield client
