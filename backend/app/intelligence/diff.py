"""Bounded, deterministic text/block comparisons with source evidence."""

import json
import math
import re
from collections import Counter
from difflib import SequenceMatcher

MAX_BLOCKS = 1200
MAX_CHARS = 60000
MAX_CHANGES = 120


def bounded_blocks(document):
    result, remaining = [], MAX_CHARS
    for block in document["blocks"][:MAX_BLOCKS]:
        if remaining <= 0:
            break
        result.append({**block, "text": block["text"][:remaining]})
        remaining -= len(result[-1]["text"])
    truncated = (
        len(result) < len(document["blocks"])
        or sum(len(b["text"]) for b in document["blocks"]) > MAX_CHARS
    )
    return result, truncated


def block_key(block):
    # Include structure, but not format-specific location/IDs.
    return json.dumps(
        [block["type"], block.get("level"), block.get("rows"), block["text"]],
        ensure_ascii=False,
        sort_keys=True,
    )


def excerpt(block):
    if block is None:
        return None
    return {
        "id": block["id"],
        "type": block["type"],
        "level": block.get("level"),
        "source": block.get("source", {}),
        "text": block["text"][:1500],
        "truncated": len(block["text"]) > 1500,
    }


def compare_documents(old, new):
    a, ta = bounded_blocks(old)
    b, tb = bounded_blocks(new)
    matcher = SequenceMatcher(
        None, [block_key(x) for x in a], [block_key(x) for x in b], autojunk=False
    )
    changes, counts = [], {"added": 0, "removed": 0, "modified": 0, "unchanged": 0}
    for tag, i, j, k, end in matcher.get_opcodes():
        if tag == "equal":
            counts["unchanged"] += j - i
            continue
        for n in range(max(j - i, end - k)):
            before = a[i + n] if i + n < j else None
            after = b[k + n] if k + n < end else None
            kind = "modified" if before and after else "added" if after else "removed"
            counts[kind] += 1
            if len(changes) >= MAX_CHANGES:
                continue
            left, right = excerpt(before), excerpt(after)
            # Whitespace remains visible and Korean words do not require a tokenizer.
            aa = re.findall(r"\s+|[^\s]+", left["text"] if left else "")
            bb = re.findall(r"\s+|[^\s]+", right["text"] if right else "")
            parts = []
            for op, x, y, u, v in SequenceMatcher(None, aa, bb, autojunk=False).get_opcodes():
                if op == "equal":
                    parts.append({"kind": "equal", "text": "".join(aa[x:y])})
                else:
                    if x < y:
                        parts.append({"kind": "removed", "text": "".join(aa[x:y])})
                    if u < v:
                        parts.append({"kind": "added", "text": "".join(bb[u:v])})
            changes.append(
                {
                    "id": f"change-{len(changes) + 1}",
                    "kind": kind,
                    "before": left,
                    "after": right,
                    "text_diff": parts,
                }
            )
    total = sum(counts[k] for k in ("added", "removed", "modified"))
    return {
        "counts": counts,
        "changes": changes,
        "total_changes": total,
        "truncated": ta
        or tb
        or total > len(changes)
        or any(
            (c["before"] and c["before"]["truncated"]) or (c["after"] and c["after"]["truncated"])
            for c in changes
        ),
        "algorithm": "block-word-v1",
    }


def cosine(a, b):
    if not a or not b or len(a) != len(b):
        return None
    denominator = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(x * x for x in b))
    if not denominator or not math.isfinite(denominator):
        return None
    result = sum(x * y for x, y in zip(a, b)) / denominator
    return round(max(-1, min(1, result)), 5) if math.isfinite(result) else None


def text_similarity(a, b):
    def grams(text):
        text = re.sub(r"\s+", " ", text.casefold()).strip()[:12000]
        return Counter(text[i : i + 3] for i in range(max(0, len(text) - 2)))

    x, y = grams(a), grams(b)
    if not x or not y:
        return 1.0 if a.strip() and a.strip() == b.strip() else 0.0
    dot = sum(v * y.get(k, 0) for k, v in x.items())
    return round(
        dot / math.sqrt(sum(v * v for v in x.values()) * sum(v * v for v in y.values())), 5
    )


def filename_similarity(a, b):
    def clean(value):
        value = value.rsplit(".", 1)[0].casefold()
        value = re.sub(r"(?:version|ver|v)[ _-]*\d+|최종|수정|final|copy", "", value)
        return re.sub(r"[\W_]", "", value)

    a, b = clean(a), clean(b)
    return round(SequenceMatcher(None, a, b).ratio(), 5) if a and b else 0.0
