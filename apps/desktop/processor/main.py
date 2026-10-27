"""Bounded stdin/stdout document processor. No server, database, or network access."""

import base64
import hashlib
import json
import sys
from pathlib import Path

if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "backend"))

from app.processing.parsers import normalize
from app.conversion import renderers
from app.writing_export import render_hwpx
from app.writing_format import normalized


def execute(request):
    operation = request.get("operation")
    if operation == "info":
        return {"schema_version": 1, "parse": ["txt", "md", "pdf", "docx", "hwpx"],
                "export": ["txt", "md", "pdf", "docx", "hwpx"]}
    if operation == "parse":
        data = base64.b64decode(request["data"], validate=True)
        if len(data) > 50 * 1024 * 1024:
            raise ValueError("문서는 최대 50MB까지 처리할 수 있습니다.")
        return normalize(data, request["filename"], hashlib.sha256(data).hexdigest())
    if operation == "candidates":
        from app.intelligence.diff import filename_similarity, text_similarity

        source = request["source"]
        result = []
        for candidate in request["candidates"][:500]:
            exact = source["sha256"] == candidate["sha256"]
            filename = filename_similarity(source["filename"], candidate["filename"])
            text = text_similarity(source["text"], candidate["text"])
            score = 1.0 if exact else 0.85 * text + 0.15 * filename
            if not exact and (text < 0.55 or score < 0.6):
                continue
            result.append({key: value for key, value in candidate.items()
                           if key not in {"text", "sha256", "filename"}} | {
                               "score": round(score, 4), "exact_duplicate": exact,
                               "filename_similarity": filename, "text_similarity": text,
                               "embedding_similarity": None, "sampled": True,
                           })
        return sorted(result, key=lambda item: (-item["score"], item["document_id"]))[:5]
    if operation == "export":
        document = normalized(request["content"]) if "content" in request else request["document"]
        renderers.validate(document)
        if request["format"] == "hwpx":
            data, warnings = render_hwpx(document["blocks"]), [renderers.FIDELITY]
        else:
            data, warnings = renderers.render(document, request["format"])
        return {"data": base64.b64encode(data).decode("ascii"), "warnings": warnings}
    if operation == "compare":
        from app.intelligence.diff import compare_documents
        return compare_documents(request["before"], request["after"])
    raise ValueError("지원하지 않는 문서 처리 요청입니다.")


def main():
    font = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "NanumGothic.ttf"
    if font.exists():
        renderers.FONT_PATH = font
    try:
        raw = sys.stdin.buffer.read(75 * 1024 * 1024 + 1)
        if len(raw) > 75 * 1024 * 1024:
            raise ValueError("문서 처리 요청이 너무 큽니다.")
        request = json.loads(raw)
        result = {"ok": True, "value": execute(request)}
    except Exception as error:
        result = {"ok": False, "code": getattr(error, "code", "PROCESSING_FAILED"),
                  "error": getattr(error, "message", "문서를 처리하지 못했습니다. 파일 형식과 내용을 확인해 주세요.")}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
