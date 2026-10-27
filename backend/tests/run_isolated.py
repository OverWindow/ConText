"""Run tests (or the loopback harness) in a newly created disposable database."""

import os
import runpy
import sys
from uuid import uuid4

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

source = make_url(os.environ["TEST_DATABASE_URL"])
if not source.database.endswith("_test"):
    raise RuntimeError("A configured _test database is required")
database = "cloud_sync_" + uuid4().hex + "_test"
admin = create_engine(source, isolation_level="AUTOCOMMIT")
with admin.connect() as connection:
    connection.execute(text(f'CREATE DATABASE "{database}"'))
target = source.set(database=database).render_as_string(hide_password=False)
os.environ["TEST_DATABASE_URL"] = target
os.environ["DATABASE_URL"] = target
try:
    if sys.argv[1:] == ["--harness"]:
        runpy.run_module("tests.cloud_harness", run_name="__main__")
    else:
        import pytest

        raise SystemExit(pytest.main(["-q", *sys.argv[1:]]))
finally:
    with admin.connect() as connection:
        connection.execute(text(f'DROP DATABASE "{database}" WITH (FORCE)'))
    admin.dispose()
