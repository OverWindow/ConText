import json
import math
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from app.ai.provider import AIUnavailable
from app.core.config import get_settings


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class MindlogicProvider:
    def __init__(self, *, api_key=None, model=None, embedding_model=None):
        self.settings = get_settings()
        self.api_key = self.settings.mindlogic_api_key if api_key is None else api_key
        self.model = self.settings.ai_model if model is None else model
        self.embedding_model = (
            self.settings.ai_embedding_model if embedding_model is None else embedding_model
        )

    def request(self, path, data=None):
        if not self.api_key:
            raise AIUnavailable("AI_NOT_CONFIGURED")
        request = Request(
            self.settings.mindlogic_base_url.rstrip("/") + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "User-Agent": "doc-workspace/0.7",
            },
            method="POST" if data is not None else "GET",
        )
        try:
            with build_opener(NoRedirect).open(request, timeout=30) as response:
                body = response.read(2 * 1024 * 1024 + 1)
                if len(body) > 2 * 1024 * 1024:
                    raise AIUnavailable("AI_INVALID_RESPONSE")
                return json.loads(body)
        except HTTPError as exc:
            code = (
                "AI_FORBIDDEN"
                if exc.code in (401, 403)
                else "AI_RATE_LIMITED"
                if exc.code in (402, 429)
                else "AI_UNSUPPORTED_REQUEST"
                if exc.code in (400, 422)
                else "AI_UNAVAILABLE"
            )
            raise AIUnavailable(code) from exc
        except (URLError, TimeoutError, OSError, ValueError) as exc:
            # Neither gateway bodies nor credentials enter errors or logs.
            raise AIUnavailable() from exc

    def generate(self, messages):
        data = self.request(
            "/chat/completions/",
            {
                "model": self.model,
                "messages": messages,
                "max_tokens": 16000,
            },
        )
        try:
            choice = data["choices"][0]
            if choice.get("finish_reason") != "stop":
                raise ValueError()
            content = choice["message"]["content"]
            if not isinstance(content, str) or len(content) > 30000:
                raise ValueError()
            return content
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise AIUnavailable("AI_INVALID_RESPONSE") from exc

    def embed(self, texts):
        if not self.embedding_model:
            raise AIUnavailable("EMBEDDING_NOT_CONFIGURED")
        data = self.request(
            "/embeddings/",
            {
                "model": self.embedding_model,
                "input": texts,
            },
        )
        try:
            rows = sorted(data["data"], key=lambda row: row["index"])
            if [r["index"] for r in rows] != list(range(len(texts))):
                raise ValueError()
            vectors = [row["embedding"] for row in rows]
            for v in vectors:
                if (
                    not isinstance(v, list)
                    or not 1 <= len(v) <= 8192
                    or any(type(x) not in (int, float) or not math.isfinite(x) for x in v)
                    or not any(v)
                ):
                    raise ValueError()
            if len({len(v) for v in vectors}) != 1:
                raise ValueError()
            return vectors
        except (KeyError, TypeError, ValueError) as exc:
            raise AIUnavailable("AI_INVALID_RESPONSE") from exc
