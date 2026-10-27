from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://localhost/doc_workspace"
    supabase_url: str = ""
    supabase_jwt_secret: str = ""
    supabase_jwt_audience: str = "authenticated"
    cors_origins: list[str] = ["http://localhost:3000"]

    redis_url: str = "redis://redis:6379/0"
    processing_max_attempts: int = Field(default=3, ge=1, le=5)
    internal_worker_token: str = ""
    internal_worker_allowed_hosts: list[str] = []

    mindlogic_api_key: str = ""
    mindlogic_base_url: str = "https://factchat-cloud.mindlogic.ai/v1/gateway"
    ai_model: str = "gpt-5.6-luna"
    ai_embedding_model: str = "text-embedding-3-small"
    ai_credentials_key: str = ""
    ai_daily_request_limit: int = Field(default=100, ge=1, le=10000)
    supabase_publishable_key: str = ""

    @field_validator("mindlogic_base_url")
    @classmethod
    def validate_ai_url(cls, value: str) -> str:
        from urllib.parse import urlparse

        url = urlparse(value)
        if url.scheme != "https" or not url.hostname or url.username or url.password:
            raise ValueError("MINDLOGIC_BASE_URL must be an HTTPS URL without credentials")
        return value.rstrip("/")

    aws_region: str = "ap-northeast-2"
    aws_s3_bucket: str = ""
    s3_presigned_url_ttl: int = Field(default=600, ge=60, le=900)
    max_upload_bytes: int = Field(default=50 * 1024 * 1024, ge=1, le=100 * 1024 * 1024)
    sync_max_workspace_bytes: int = Field(default=2 * 1024**3, ge=1024, le=100 * 1024**3)
    sync_session_hours: int = Field(default=24, ge=1, le=168)
    web_base_url: str = ""
    unified_api_url: str = ""
    legacy_workspace_api_enabled: bool = True

    @field_validator("web_base_url", "unified_api_url")
    @classmethod
    def validate_web_base_url(cls, value: str) -> str:
        if not value:
            return value
        from urllib.parse import urlparse

        url = urlparse(value)
        if (
            (
                url.scheme != "https"
                and not (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"})
            )
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or url.path not in ("", "/")
        ):
            raise ValueError("WEB_BASE_URL must be an HTTPS origin or loopback HTTP origin")
        return value.rstrip("/")

    @field_validator("database_url")
    @classmethod
    def normalize_database_url(cls, value: str) -> str:
        if value.startswith("postgresql://"):
            return value.replace("postgresql://", "postgresql+psycopg://", 1)
        if not value.startswith("postgresql+psycopg://"):
            raise ValueError("DATABASE_URL must use PostgreSQL with psycopg")
        return value

    @field_validator("supabase_url")
    @classmethod
    def normalize_supabase_url(cls, value: str) -> str:
        return value.rstrip("/")


@lru_cache
def get_settings() -> Settings:
    return Settings()
