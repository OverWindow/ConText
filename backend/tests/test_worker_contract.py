import json
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from app.schemas.worker_generated import WorkerInput, WorkerResult

FIXTURES = json.loads((Path(__file__).parent / "fixtures/worker-v2.json").read_text())


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda fixture: fixture["name"])
def test_shared_worker_contract(fixture):
    adapter = TypeAdapter(WorkerInput if fixture["kind"] == "input" else WorkerResult)
    if fixture["valid"]:
        model = adapter.validate_python(fixture["value"])
        # UUID and optional defaults may normalize, but the result round-trips.
        adapter.validate_json(model.model_dump_json())
    else:
        with pytest.raises(ValidationError):
            adapter.validate_python(fixture["value"])
