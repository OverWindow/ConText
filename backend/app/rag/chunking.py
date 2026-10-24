"""Full-document, bounded chunks with exact locations for every excerpt."""

CHUNK_SIZE = 1600
OVERLAP = 160
MAX_CHUNKS = 2500
ALGORITHM = "blocks-1600-overlap160-v1"


def chunk_document(document):
    chunks, text, locations = [], "", []

    def flush():
        nonlocal text, locations
        if text.strip():
            chunks.append({"ordinal": len(chunks), "text": text, "locations": locations})
        text, locations = "", []
        if len(chunks) > MAX_CHUNKS:
            raise ValueError("CHUNK_LIMIT_EXCEEDED")

    for block in document["blocks"]:
        body = block["text"]
        if not body.strip():
            continue
        if len(body) > CHUNK_SIZE:
            flush()
            for start in range(0, len(body), CHUNK_SIZE - OVERLAP):
                part = body[start : start + CHUNK_SIZE]
                text = part
                locations = [
                    {
                        "block_id": block["id"],
                        "start": start,
                        "end": start + len(part),
                        "type": block["type"],
                        **block.get("source", {}),
                    }
                ]
                flush()
                if start + CHUNK_SIZE >= len(body):
                    break
        else:
            if len(text) + len(body) + 2 > CHUNK_SIZE:
                flush()
            text += ("\n\n" if text else "") + body
            locations.append(
                {
                    "block_id": block["id"],
                    "start": 0,
                    "end": len(body),
                    "type": block["type"],
                    **block.get("source", {}),
                }
            )
    flush()
    return chunks
