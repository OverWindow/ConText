"""HTTPS OAuth bridge to the desktop app. PKCE secrets remain on the device."""

import html
import json
import secrets
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Path, Query, Request
from fastapi.responses import HTMLResponse

router = APIRouter()
DESKTOP_CALLBACK_PATH = "/api/desktop/auth/callback"


@router.get("/callback/{transaction}", response_class=HTMLResponse)
def desktop_auth_callback(
    request: Request,
    transaction: str = Path(pattern=r"^[a-f0-9]{48}$"),
    code: str | None = Query(default=None, min_length=1, max_length=2048),
    error: str | None = Query(default=None, min_length=1, max_length=200),
):
    if (
        bool(code) == bool(error)
        or len(request.query_params.getlist("code")) > 1
        or len(request.query_params.getlist("error")) > 1
        or (code and any(ord(char) < 32 or ord(char) == 127 for char in code))
    ):
        raise HTTPException(400, "Invalid desktop authentication callback")
    # No caller-controlled destination or session tokens enter the app URI.
    values = {"state": transaction}
    values["code" if code else "error"] = code if code else "access_denied"
    target = "context-desktop://auth/callback?" + urlencode(values)
    nonce = secrets.token_urlsafe(24)
    message = (
        "ConText 앱에서 로그인을 마무리하세요."
        if code
        else "로그인이 취소되었습니다. ConText 앱으로 돌아가세요."
    )
    content = f"""<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>ConText 계정 연결</title>
<style>
body{{margin:0;min-height:100dvh;display:grid;place-items:center;
background:#FAF8F5;color:#2A2526;font:16px/1.7 system-ui,sans-serif}}
main{{margin:24px;padding:38px;max-width:480px;background:white;
border:1px solid #E8DEDD;border-radius:20px;text-align:center}}
h1{{font-size:27px;margin:0 0 16px}}p{{color:#6E6365}}
a{{display:inline-block;margin:14px 0;padding:13px 24px;background:#A40F16;
color:white;border-radius:10px;text-decoration:none;font-weight:600}}
small{{display:block;color:#6E6365}}
</style>
</head><body><main><h1>ConText로 돌아가기</h1><p>{message}</p>
<a id="return-to-app" href="{html.escape(target, quote=True)}">ConText 앱 열기</a>
<small>앱이 열리지 않으면 위 버튼을 눌러주세요.<br>
앱을 종료했다면 앱에서 로그인을 다시 시작하세요.</small>
</main><script nonce="{nonce}">
const target = {json.dumps(target)};
history.replaceState(null, '', location.pathname);
window.location.replace(target);
</script></body></html>"""
    return HTMLResponse(
        content,
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": (
                f"default-src 'none'; script-src 'nonce-{nonce}'; "
                "style-src 'unsafe-inline'; base-uri 'none'; "
                "frame-ancestors 'none'; form-action 'none'"
            ),
        },
    )
