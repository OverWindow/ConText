"""Bounded, text-only document normalization. Never execute document content."""

import io
import re
import zipfile
from pathlib import PurePosixPath

from defusedxml import ElementTree as SafeXML
from docx import Document as WordDocument
from docx.table import Table
from markdown_it import MarkdownIt
from pypdf import PdfReader

MAX_CHARS = 2_000_000
MAX_BLOCKS = 20_000
MAX_PAGES = 500
MAX_EXPANDED = 64 * 1024 * 1024


class ParseError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def checked_zip(data: bytes) -> zipfile.ZipFile:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        files = archive.infolist()
        if len(files) > 2000 or sum(f.file_size for f in files) > MAX_EXPANDED:
            raise ParseError(
                "LIMIT_EXCEEDED", "압축을 푼 문서 크기 또는 파일 수가 처리 한도를 초과했습니다."
            )
        for item in files:
            path = PurePosixPath(item.filename)
            if path.is_absolute() or ".." in path.parts or item.flag_bits & 1:
                raise ParseError("INVALID_ARCHIVE", "안전하게 읽을 수 없는 압축 문서입니다.")
            if (
                item.file_size > 16 * 1024 * 1024
                or item.file_size > max(item.compress_size, 1) * 300
            ):
                raise ParseError(
                    "LIMIT_EXCEEDED", "압축 문서의 개별 항목이 처리 한도를 초과했습니다."
                )
            if item.filename.lower().endswith((".xml", ".rels", ".hpf")):
                # Reject entities and DTDs before handing DOCX XML to python-docx.
                SafeXML.fromstring(archive.read(item), forbid_dtd=True)
        return archive
    except ParseError:
        raise
    except Exception as exc:
        raise ParseError("INVALID_ARCHIVE", "손상되었거나 지원하지 않는 압축 문서입니다.") from exc


class Builder:
    def __init__(self):
        self.blocks = []
        self.characters = 0
        self.warnings = []
        self.pages = None

    def add(self, kind, text, source=None, **extra):
        text = text.replace("\x00", "").strip()
        if not text:
            return
        self.characters += len(text)
        if self.characters > MAX_CHARS or len(self.blocks) >= MAX_BLOCKS:
            raise ParseError(
                "LIMIT_EXCEEDED", "문서의 텍스트 또는 문단 수가 처리 한도를 초과했습니다."
            )
        self.blocks.append(
            {
                "id": len(self.blocks) + 1,
                "type": kind,
                "text": text,
                "source": source or {},
                **extra,
            }
        )


def decode_text(data):
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        encoding = "utf-16"
    else:
        encoding = "utf-8-sig"
    try:
        text = data.decode(encoding)
    except UnicodeDecodeError:
        try:
            text = data.decode("cp949")
        except UnicodeDecodeError as exc:
            raise ParseError(
                "UNSUPPORTED_ENCODING", "UTF-8, UTF-16 또는 CP949 텍스트 파일을 사용해 주세요."
            ) from exc
    if "\x00" in text or sum(ord(c) < 32 and c not in "\n\r\t" for c in text) > max(
        2, len(text) // 100
    ):
        raise ParseError("INVALID_TEXT", "텍스트 파일로 읽을 수 없는 바이너리 데이터입니다.")
    if len(text) > MAX_CHARS:
        raise ParseError("LIMIT_EXCEEDED", "텍스트가 처리 한도를 초과했습니다.")
    return text.replace("\r\n", "\n").replace("\r", "\n")


def parse_pdf(data, builder):
    if not data.lstrip().startswith(b"%PDF-"):
        raise ParseError("INVALID_FILE", "올바른 PDF 파일이 아닙니다.")
    reader = PdfReader(io.BytesIO(data), strict=False)
    if reader.is_encrypted:
        raise ParseError(
            "ENCRYPTED_PDF",
            "암호가 설정된 PDF는 처리할 수 없습니다. 암호를 해제한 파일을 올려 주세요.",
        )
    if len(reader.pages) > MAX_PAGES:
        raise ParseError("LIMIT_EXCEEDED", "PDF는 최대 500페이지까지 처리할 수 있습니다.")
    builder.pages = len(reader.pages)
    empty = 0
    for number, page in enumerate(reader.pages, 1):
        text = page.extract_text() or ""
        if not text.strip():
            empty += 1
        for paragraph in re.split(r"\n\s*\n", text):
            builder.add("paragraph", paragraph, {"page": number})
    if not builder.blocks:
        raise ParseError(
            "OCR_REQUIRED", "추출할 텍스트가 없습니다. 스캔 PDF는 OCR 처리가 필요합니다."
        )
    if empty:
        builder.warnings.append(
            f"{empty}개 페이지에서 텍스트를 찾지 못했습니다. 이미지 내용은 추출하지 않았습니다."
        )


def parse_docx(data, builder):
    archive = checked_zip(data)
    if "word/document.xml" not in archive.namelist():
        raise ParseError("INVALID_FILE", "올바른 DOCX 파일이 아닙니다.")
    archive.close()
    document = WordDocument(io.BytesIO(data))
    for index, part in enumerate(document.iter_inner_content(), 1):
        if isinstance(part, Table):
            rows = [[cell.text for cell in row.cells] for row in part.rows]
            builder.add(
                "table", "\n".join("\t".join(row) for row in rows), {"element": index}, rows=rows
            )
        else:
            style = part.style.name if part.style else ""
            heading = re.match(r"(?:Heading|제목)\s*(\d+)", style, re.I)
            kind = (
                "heading"
                if heading
                else "list_item"
                if style.startswith("List")
                or (part._p.pPr is not None and part._p.pPr.numPr is not None)
                else "paragraph"
            )
            builder.add(
                kind,
                part.text,
                {"element": index},
                **({"level": min(int(heading[1]), 6)} if heading else {}),
            )


def parse_hwpx(data, builder):
    with checked_zip(data) as archive:
        sections = sorted(
            (n for n in archive.namelist() if re.fullmatch(r"Contents/section\d+\.xml", n)),
            key=lambda n: int(re.search(r"(\d+)\.xml", n)[1]),
        )
        if not sections:
            raise ParseError(
                "INVALID_FILE", "HWPX 본문을 찾을 수 없습니다. HWP 파일은 지원하지 않습니다."
            )
        ns = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
        for section in sections:
            root = SafeXML.fromstring(archive.read(section), forbid_dtd=True)
            index = 0

            def paragraph_text(element):
                if element.tag == ns + "tbl":
                    return ""
                if element.tag == ns + "t":
                    return "".join(element.itertext())
                if element.tag == ns + "lineBreak":
                    return "\n"
                if element.tag == ns + "tab":
                    return "\t"
                return "".join(paragraph_text(child) for child in element)

            def walk(element):
                nonlocal index
                if element.tag == ns + "tbl":
                    rows = []
                    for row in element.findall(ns + "tr"):
                        rows.append(
                            [
                                "\n".join(paragraph_text(p) for p in cell.iter(ns + "p"))
                                for cell in row.findall(ns + "tc")
                            ]
                        )
                    index += 1
                    builder.add(
                        "table",
                        "\n".join("\t".join(row) for row in rows),
                        {"section": section, "element": index},
                        rows=rows,
                    )
                    return
                if element.tag == ns + "p":
                    index += 1
                    builder.add(
                        "paragraph", paragraph_text(element), {"section": section, "element": index}
                    )
                    for table in element.iter(ns + "tbl"):
                        walk(table)
                    return
                for child in element:
                    walk(child)

            walk(root)


def parse_markdown(data, builder):
    text = decode_text(data)
    tokens = MarkdownIt("commonmark", {"html": False}).enable("table").parse(text)
    heading = None
    list_depth = 0
    in_table = False
    rows = []
    row = []
    for token in tokens:
        if token.type == "heading_open":
            heading = int(token.tag[1])
        elif token.type == "heading_close":
            heading = None
        elif token.type == "list_item_open":
            list_depth += 1
        elif token.type == "list_item_close":
            list_depth -= 1
        elif token.type == "table_open":
            in_table = True
            rows = []
        elif token.type == "tr_open":
            row = []
        elif token.type == "tr_close":
            rows.append(row)
        elif token.type == "table_close":
            builder.add("table", "\n".join("\t".join(r) for r in rows), rows=rows)
            in_table = False
        elif token.type == "inline":
            content = "".join(
                "\n"
                if child.type in ("softbreak", "hardbreak")
                else child.content
                if child.type in ("text", "code_inline", "image")
                else ""
                for child in token.children or []
            )
            if in_table:
                row.append(content)
            else:
                builder.add(
                    "heading" if heading else "list_item" if list_depth else "paragraph",
                    content,
                    {"line": token.map[0] + 1} if token.map else {},
                    **({"level": heading} if heading else {}),
                )
        elif token.type in ("fence", "code_block"):
            builder.add(
                "code",
                token.content,
                {"line": token.map[0] + 1} if token.map else {},
                language=token.info.strip()[:80],
            )


def normalize(data: bytes, filename: str, sha256: str):
    builder = Builder()
    suffix = PurePosixPath(filename).suffix.lower()
    try:
        if suffix == ".txt":
            for index, p in enumerate(re.split(r"\n\s*\n", decode_text(data)), 1):
                builder.add("paragraph", p, {"paragraph": index})
        elif suffix == ".md":
            parse_markdown(data, builder)
        elif suffix == ".pdf":
            parse_pdf(data, builder)
        elif suffix == ".docx":
            parse_docx(data, builder)
        elif suffix == ".hwpx":
            parse_hwpx(data, builder)
        else:
            raise ParseError("UNSUPPORTED_FORMAT", "지원하지 않는 파일 형식입니다.")
    except ParseError:
        raise
    except Exception as exc:
        raise ParseError(
            "PARSE_FAILED", "문서를 읽지 못했습니다. 파일이 손상되었거나 지원하지 않는 구조입니다."
        ) from exc
    if not builder.blocks:
        raise ParseError("EMPTY_DOCUMENT", "문서에서 추출할 텍스트를 찾지 못했습니다.")
    title = next(
        (b["text"] for b in builder.blocks if b["type"] == "heading"), PurePosixPath(filename).stem
    )[:200]
    return {
        "schema_version": 1,
        "title": title,
        "source_filename": filename,
        "source_sha256": sha256,
        "blocks": builder.blocks,
        "warnings": builder.warnings,
        "page_count": builder.pages,
    }
