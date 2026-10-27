"""Pure conversion between editable blocks and normalized export documents."""

def normalized(content):
    blocks = [{"type": "heading", "text": content["title"], "level": 1}]
    for b in content["blocks"]:
        if b["type"] == "list":
            blocks.extend({"type": "list_item", "text": item} for item in b["items"])
        elif b["type"] == "table":
            blocks.append({"type": "table", "text": "", "rows": b["rows"]})
        else:
            blocks.append({"type": b["type"], "text": b["text"], "level": b["level"]})
    return {"schema_version": 1, "blocks": blocks}
