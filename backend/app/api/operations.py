"""Private readiness probe for the unified service, without document processing."""
from fastapi import APIRouter, Depends, HTTPException

from app.api.unified_worker import authorize
from app.core.config import get_settings

router = APIRouter(prefix="/internal/v2", tags=["operations"])


@router.get("/health", dependencies=[Depends(authorize)])
def readiness():
    settings = get_settings()
    configured = (not settings.legacy_workspace_api_enabled
                  and settings.unified_api_url and settings.web_base_url
                  and settings.supabase_url and settings.supabase_publishable_key)
    if not configured:
        raise HTTPException(503, "Unified deployment configuration is incomplete")
    return {"status": "ok", "protocol": 2}
