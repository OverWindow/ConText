"""Bake only the fictional sample folder into an offline, read-only workspace."""
import argparse
import base64
import csv
import hashlib
import io
import json
from pathlib import Path
import uuid
import zipfile
import xml.etree.ElementTree as ET
from email import policy
from email.parser import BytesParser

from app.processing.parsers import normalize, ParseError


def workbook(data):
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            for node in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("s:si", ns):
                strings.append("".join(node.itertext()))
        blocks = []
        for name in sorted(archive.namelist()):
            if not name.startswith("xl/worksheets/sheet") or not name.endswith(".xml"):
                continue
            rows = []
            for row in ET.fromstring(archive.read(name)).findall("s:sheetData/s:row", ns):
                values = []
                for cell in row.findall("s:c", ns):
                    ref = cell.attrib.get("r", "A1")
                    column = 0
                    for char in ref:
                        if char.isalpha():
                            column = column * 26 + ord(char.upper()) - 64
                    while len(values) < column:
                        values.append("")
                    value = cell.findtext("s:v", default="", namespaces=ns)
                    if cell.attrib.get("t") == "s":
                        value = strings[int(value)]
                    elif cell.attrib.get("t") == "inlineStr":
                        value = "".join(cell.find("s:is", ns).itertext())
                    if column:
                        values[column - 1] = value
                rows.append(values)
            blocks.append({"id": len(blocks) + 1, "type": "table", "text": name, "source": {}, "rows": rows})
        return blocks


def build(source):
    workspace_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "context:sample:harulab:v1"))
    entries, documents = [], []
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if path.is_symlink() or any(part.startswith(".") for part in relative.parts):
            continue
        directory = path.is_dir()
        if not directory and not path.is_file():
            continue
        raw = b"" if directory else path.read_bytes()
        name, suffix = path.name, path.suffix.lower()
        entry_id = str(uuid.uuid5(uuid.UUID(workspace_id), relative.as_posix()))
        entry = {"id": entry_id, "workspace_id": workspace_id, "relative_path": relative.as_posix(), "parent_path": relative.parent.as_posix() if relative.parent.as_posix() != "." else "", "name": name, "kind": "directory" if directory else "file", "extension": "" if directory else suffix, "size": len(raw), "mtime": 1792886400000, "excluded": 0, "x": None, "y": None}
        entries.append(entry)
        if directory:
            continue
        digest = hashlib.sha256(raw).hexdigest()
        content, image_url = None, None
        if suffix in {".png", ".jpg", ".jpeg", ".svg"}:
            mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml"}[suffix]
            image_url = f"data:{mime};base64," + base64.b64encode(raw).decode()
        elif suffix in {".pdf", ".docx", ".hwpx", ".md", ".txt"}:
            try:
                parsed = normalize(raw, name, digest)
                content = {key: parsed[key] for key in ["schema_version", "title", "blocks", "warnings", "page_count"]}
            except ParseError as error:
                if error.code != "EMPTY_DOCUMENT":
                    raise
        else:
            blocks = []
            if suffix == ".csv":
                blocks = [{"id": 1, "type": "table", "text": name, "source": {}, "rows": list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))}]
            elif suffix == ".xlsx":
                blocks = workbook(raw)
            elif suffix == ".eml":
                message = BytesParser(policy=policy.default).parsebytes(raw)
                body = message.get_body(preferencelist=("plain",)) if message.is_multipart() else message
                text = f"제목: {message['Subject']}\n보낸 사람: {message['From']}\n\n{body.get_content() if body else ''}"
                blocks = [{"id": 1, "type": "paragraph", "text": text, "source": {}}]
            else:
                text = raw.decode("utf-8-sig")
                if suffix == ".json":
                    text = json.dumps(json.loads(text), ensure_ascii=False, indent=2)
                blocks = [{"id": 1, "type": "code", "text": text, "source": {}}]
            content = {"schema_version": 1, "title": name, "blocks": blocks, "warnings": [], "page_count": None}
        documents.append({"entry_id": entry_id, "path": relative.as_posix(), "sha256": digest, "content": content, "image_url": image_url})
    return {"workspace_id": workspace_id, "name": "하루랩 스타트업 샘플", "entries": entries, "documents": documents}


if __name__ == "__main__":
    args = argparse.ArgumentParser()
    args.add_argument("--source", type=Path, required=True)
    args.add_argument("--output", type=Path, required=True)
    options = args.parse_args()
    result = build(options.source)
    source = '// Generated by scripts/build-sample-workspace.py; fictional sample only.\nimport type { SampleWorkspaceData } from "../src/sample-types";\nexport const sampleData: SampleWorkspaceData = ' + json.dumps(result, ensure_ascii=False, separators=(",", ":")) + ';\n'
    options.output.write_text(source, encoding="utf-8")
    print(f"Baked {len(result['documents'])} fictional files, {len(source.encode())} bytes.")
