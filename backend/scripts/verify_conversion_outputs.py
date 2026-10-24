"""Synthetic offline renderer QA; no credentials or application data required."""

import hashlib
import io
import sys
import zipfile
from pathlib import Path

from docx import Document
from pypdf import PdfReader

from app.conversion.renderers import render
from app.processing.parsers import normalize

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
xml = """<sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
<hp:p>
<hp:run>
<hp:t>ConText 한글 문서 변환 검증</hp:t>
</hp:run>
</hp:p>
<hp:p>
<hp:run>
<hp:t>HWPX에서 PDF·DOCX·TXT·Markdown으로 변환하는 합성 예제입니다.</hp:t>
</hp:run>
</hp:p>
<hp:p>
<hp:run>
<hp:tbl>
<hp:tr>
<hp:tc>
<hp:subList>
<hp:p>
<hp:run>
<hp:t>입력 형식</hp:t>
</hp:run>
</hp:p>
</hp:subList>
</hp:tc>
<hp:tc>
<hp:subList>
<hp:p>
<hp:run>
<hp:t>출력 형식</hp:t>
</hp:run>
</hp:p>
</hp:subList>
</hp:tc>
</hp:tr>
<hp:tr>
<hp:tc>
<hp:subList>
<hp:p>
<hp:run>
<hp:t>한글 HWPX</hp:t>
</hp:run>
</hp:p>
</hp:subList>
</hp:tc>
<hp:tc>
<hp:subList>
<hp:p>
<hp:run>
<hp:t>한글 PDF</hp:t>
</hp:run>
</hp:p>
</hp:subList>
</hp:tc>
</hp:tr>
</hp:tbl>
</hp:run>
</hp:p>
</sec>"""
archive = io.BytesIO()
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("Contents/section0.xml", xml)
source = archive.getvalue()
(out / "source.hwpx").write_bytes(source)
normalized = normalize(source, "한글 검증.hwpx", hashlib.sha256(source).hexdigest())
normalized["blocks"] += [
    {"type": "heading", "text": "구조와 긴 표 검증", "level": 1},
    {"type": "list_item", "text": "첫 번째 항목: 한글, 숫자 123, English"},
    {"type": "code", "text": "def hello():\n    print('안녕하세요')\n    return 123"},
    {
        "type": "paragraph",
        "text": "<script>태그처럼 보이는 내용도 문서 텍스트로 표시합니다.</script>",
    },
    {
        "type": "table",
        "text": "긴 표",
        "rows": [["번호", "검증 내용"]]
        + [[str(i + 1), "한글 표 내용과 자동 줄바꿈을 확인합니다. " * 3] for i in range(35)],
    },
    {"type": "paragraph", "text": "마지막 문단까지 보존되었습니다."},
]
for format in ("pdf", "docx", "txt", "md"):
    body, warnings = render(normalized, format)
    (out / f"context-conversion.{format}").write_bytes(body)
    print(format, len(body), "bytes", len(warnings), "warnings")
reader = PdfReader(out / "context-conversion.pdf")
assert "마지막 문단까지 보존되었습니다." in reader.pages[-1].extract_text()
assert len(Document(out / "context-conversion.docx").tables) == 2
print("PDF pages:", len(reader.pages))
