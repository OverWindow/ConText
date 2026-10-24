from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.canvas import router as canvas_router
from app.api.conversion import router as conversion_router
from app.api.documents import router as document_router
from app.api.intelligence import router as intelligence_router
from app.api.processing import router as processing_router
from app.api.rag import router as rag_router
from app.api.routes import router
from app.api.versions import router as version_router
from app.api.writing import router as writing_router
from app.core.config import get_settings
from app.db.session import get_db

app = FastAPI(title="ConText", version="0.8.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
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


@app.get("/health", tags=["operations"])
def health(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        raise HTTPException(503, "Database unavailable") from exc
    return {"status": "ok"}
