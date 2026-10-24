"""HWPX output using python-hwpx's bundled, schema-valid document template."""

from hwpx import HwpxDocument

from app.conversion.renderers import clean


def render_hwpx(blocks):
    with HwpxDocument.new() as document:
        for block in blocks:
            if block["type"] == "table":
                rows = block["rows"]
                table = document.add_table(rows=len(rows), cols=max(map(len, rows)))
                for r, row in enumerate(rows):
                    for c, value in enumerate(row):
                        table.set_cell_text(r, c, clean(value))
            elif block["type"] == "heading":
                document.add_heading(clean(block["text"]), level=block.get("level", 1))
            else:
                prefix = "• " if block["type"] == "list_item" else ""
                document.add_paragraph(prefix + clean(block["text"]))
        report = document.validate()
        if report.issues:
            raise ValueError("Generated HWPX failed validation")
        return document.to_bytes()
