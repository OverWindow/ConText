from cryptography.fernet import Fernet, InvalidToken

from app.ai.mindlogic import MindlogicProvider
from app.ai.provider import AIUnavailable
from app.core.config import get_settings
from app.models.ai_connections import AIConnection


def selected_service(db, user_id):
    """Resolve the requesting user, never a workspace owner or another member."""
    if db.get(AIConnection, user_id) is None:
        return None
    from app.ai.service import AIService

    return AIService(provider_for_user(db, user_id))


def credential_cipher():
    value = get_settings().ai_credentials_key
    if not value:
        raise AIUnavailable("AI_KEY_STORAGE_NOT_CONFIGURED")
    try:
        return Fernet(value.encode())
    except (ValueError, TypeError) as error:
        raise AIUnavailable("AI_KEY_STORAGE_NOT_CONFIGURED") from error


def provider_for_user(db, user_id, force_managed=False):
    connection = db.get(AIConnection, user_id)
    if force_managed:
        return MindlogicProvider()
    if not connection or connection.mode == "managed":
        return MindlogicProvider(model=connection.model or None if connection else None)
    try:
        key = credential_cipher().decrypt(connection.encrypted_key.encode()).decode()
    except (InvalidToken, AttributeError, UnicodeError) as error:
        raise AIUnavailable("AI_KEY_UNAVAILABLE") from error
    return MindlogicProvider(api_key=key, model=connection.model or None, embedding_model="")


def read_connection(connection):
    return {
        "mode": connection.mode if connection else "managed",
        "model": connection.model if connection else get_settings().ai_model,
        "has_personal_key": bool(connection and connection.encrypted_key),
        "personal_key_storage_available": bool(get_settings().ai_credentials_key),
    }


def list_models(provider):
    result = provider.request("/models/")
    models = result.get("data", [])
    if not isinstance(models, list):
        raise AIUnavailable("AI_INVALID_RESPONSE")
    return [
        {"id": item["id"], "name": item.get("name", item["id"])}
        for item in models
        if isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and item.get("type", "llm") == "llm"
        and "codex" not in item["id"].lower()
    ][:300]
