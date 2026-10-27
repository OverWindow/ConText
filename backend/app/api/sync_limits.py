"""Bound bulk metadata before JSON decoding, including chunked requests."""

from starlette.responses import JSONResponse


class SyncBodyLimitMiddleware:
    def __init__(self, app, limit=4 * 1024**2):
        self.app = app
        self.limit = limit

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        guarded = path.startswith(("/api/sync/", "/api/sync-sessions/")) or (
            path.startswith("/api/workspaces/") and path.endswith("/sync-sessions")
        )
        if scope["type"] != "http" or scope["method"] not in ("POST", "PUT") or not guarded:
            return await self.app(scope, receive, send)
        response = JSONResponse(
            {"detail": "동기화 요청을 더 작은 페이지로 나눠 전송해 주세요."}, status_code=413
        )
        for key, value in scope.get("headers", []):
            if key.lower() == b"content-length" and value.isdigit() and int(value) > self.limit:
                return await response(scope, receive, send)
        messages, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            size += len(message.get("body", b""))
            if size > self.limit:
                return await response(scope, receive, send)
            messages.append(message)
            if not message.get("more_body", False):
                break
        iterator = iter(messages)

        async def bounded_receive():
            message = next(iterator, None)
            return message if message is not None else await receive()

        await self.app(scope, bounded_receive, send)
