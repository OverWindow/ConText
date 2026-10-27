"""Dedicated parser/converter + Moto fixture, never imported by production."""
import os
import sys
import json
import hashlib

sys.path.insert(0, "/app")

if not os.environ.get("TEST_DATABASE_URL", "").endswith("_test"):
    raise RuntimeError("Compute fixture requires a disposable test configuration")
os.environ["INTERNAL_WORKER_TOKEN"] = "test-only-unified-worker-token"
os.environ["INTERNAL_WORKER_ALLOWED_HOSTS"] = '["127.0.0.1"]'
os.environ["LEGACY_WORKSPACE_API_ENABLED"] = "false"
os.environ["WEB_BASE_URL"] = "http://localhost:3100"
os.environ["UNIFIED_API_URL"] = "http://localhost:18003"
os.environ["SUPABASE_URL"] = "https://auth.unit"
os.environ["SUPABASE_PUBLISHABLE_KEY"] = "sb_publishable_synthetic"

from fastapi import FastAPI, Header, HTTPException  # noqa: E402
import jwt  # noqa: E402
from moto.server import ThreadedMotoServer  # noqa: E402
import uvicorn  # noqa: E402
from app.api.unified_worker import router  # noqa: E402
from app.api.operations import router as operations_router  # noqa: E402

app = FastAPI()
app.include_router(router)
app.include_router(operations_router)
ai_receipts = {}
storage = ThreadedMotoServer(ip_address="0.0.0.0", port=15002, verbose=False)
storage.start()

@app.get("/health")
def health():
    return {"status": "ok", "fixture": True}

@app.post("/api/ai/context")
def ai_context(data: dict, authorization: str | None = Header(default=None)):
    """Deterministic provider boundary; the real parse/export routes above are unmodified."""
    try:
        claims = jwt.decode((authorization or "").removeprefix("Bearer "), "test-only-unified-secret-no-user-credential", algorithms=["HS256"], audience="authenticated", issuer="http://127.0.0.1:19999/auth/v1")
    except Exception as error:
        raise HTTPException(401, "Invalid fixture user") from error
    key = (claims["sub"], data["request_id"])
    fingerprint = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    if key in ai_receipts:
        if ai_receipts[key][0] != fingerprint:
            raise HTTPException(409, "Request ID reused")
        return ai_receipts[key][1]
    result = {"claims": [{"text": "Shared result survives retry.", "source_ids": [s["id"] for s in data.get("sources", [])]}], "sources": data.get("sources", []), "insufficient": False}
    if data.get("task") == "write":
        result = {"content": {"title": "Shared draft", "blocks": [{"id": "answer", "type": "paragraph", "text": "Generated draft", "level": 1, "items": [], "rows": [], "source_ids": []}]}, "sources": data.get("sources", []), "checks": []}
    ai_receipts[key] = (fingerprint, result)
    return result

@app.get("/__fixture/ai-count")
def ai_count():
    return {"generations": len(ai_receipts)}

uvicorn.run(app, host="0.0.0.0", port=18002, log_level="warning")
