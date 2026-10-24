from __future__ import annotations

from functools import lru_cache
from uuid import UUID

import jwt
from fastapi import HTTPException
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientConnectionError
from pydantic import BaseModel, ValidationError

from app.core.config import get_settings


class Identity(BaseModel):
    auth_user_id: UUID
    email: str
    display_name: str | None = None


@lru_cache
def jwks_client(url: str) -> PyJWKClient:
    return PyJWKClient(f"{url}/auth/v1/.well-known/jwks.json", timeout=5)


def verify_token(token: str) -> Identity:
    settings = get_settings()
    if not settings.supabase_url:
        raise HTTPException(503, "Authentication is not configured")
    try:
        algorithm = jwt.get_unverified_header(token).get("alg")
        if algorithm in ("RS256", "ES256"):
            key = jwks_client(settings.supabase_url).get_signing_key_from_jwt(token).key
        elif algorithm == "HS256" and settings.supabase_jwt_secret:
            key = settings.supabase_jwt_secret
        else:
            raise jwt.InvalidTokenError("Unsupported signing algorithm")
        claims = jwt.decode(
            token,
            key,
            algorithms=[algorithm],
            audience=settings.supabase_jwt_audience,
            issuer=f"{settings.supabase_url}/auth/v1",
            options={"require": ["exp", "iat", "sub", "aud", "iss", "role"]},
        )
        if claims["role"] != "authenticated" or claims.get("is_anonymous", False):
            raise jwt.InvalidTokenError("A signed-in user is required")
        email = claims.get("email")
        if not isinstance(email, str) or not email or len(email) > 320:
            raise jwt.InvalidTokenError("Missing or invalid email")
        metadata = claims.get("user_metadata") or {}
        name = metadata.get("full_name") or metadata.get("name")
        return Identity(
            auth_user_id=claims["sub"],
            email=email,
            display_name=name[:200] if isinstance(name, str) else None,
        )
    except PyJWKClientConnectionError as exc:
        raise HTTPException(503, "Authentication key service is unavailable") from exc
    except (jwt.PyJWTError, ValidationError, TypeError, AttributeError, ValueError) as exc:
        raise HTTPException(
            401, "Invalid or expired access token", headers={"WWW-Authenticate": "Bearer"}
        ) from exc
