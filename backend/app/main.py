from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.ai import auth_router as desktop_auth_router
from app.api.ai import router as ai_router
from app.api.canvas import router as canvas_router
from app.api.conversion import router as conversion_router
from app.api.documents import router as document_router
from app.api.intelligence import router as intelligence_router
from app.api.operations import router as operations_router
from app.api.processing import router as processing_router
from app.api.rag import router as rag_router
from app.api.routes import router
from app.api.sync import router as sync_router
from app.api.sync_limits import SyncBodyLimitMiddleware
from app.api.unified_worker import router as unified_worker_router
from app.api.versions import router as version_router
from app.api.writing import router as writing_router
from app.core.config import get_settings
from app.db.session import get_db

app = FastAPI(title="ConText", version="0.8.0")
app.add_middleware(SyncBodyLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)
app.include_router(router)
app.include_router(document_router)
app.include_router(canvas_router)
app.include_router(processing_router)
app.include_router(version_router)
app.include_router(intelligence_router)
app.include_router(rag_router)
app.include_router(conversion_router)
app.include_router(writing_router)
app.include_router(ai_router)
app.include_router(desktop_auth_router)
app.include_router(sync_router)
app.include_router(unified_worker_router)
app.include_router(operations_router)


@app.middleware("http")
async def single_workspace_authority(request: Request, call_next):
    settings = get_settings()
    retired = ("/api/workspaces", "/api/documents", "/api/versions", "/api/sync",
               "/api/conversions", "/api/processing-jobs")
    if (not settings.legacy_workspace_api_enabled
            and any(request.url.path == p or request.url.path.startswith(p + "/")
                    for p in retired)):
        return JSONResponse(status_code=410, content={
            "error": {"code": "WORKSPACE_API_RETIRED",
                      "message": "Use the unified workspace API", "schema_version": 2},
        })
    return await call_next(request)


@app.get("/health", tags=["operations"])
def health(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        raise HTTPException(503, "Database unavailable") from exc
    return {"status": "ok"}
