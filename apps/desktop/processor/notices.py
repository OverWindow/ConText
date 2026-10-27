"""Preserve available license texts from the build environment in the runtime bundle."""
import importlib.metadata
import sys
from pathlib import Path

parts = ["ConText document processor - third-party notices\n"]
for candidate in [Path(sys.base_prefix) / "LICENSE.txt", Path(sys.base_prefix) / "lib/python3.12/LICENSE.txt"]:
    if candidate.is_file():
        parts.extend(["\n=== Python ===\n", candidate.read_text(errors="replace")])
        break
for line in (Path(__file__).parent / "requirements.lock").read_text().splitlines():
    if "==" not in line:
        continue
    name = line.split("==", 1)[0]
    distribution = importlib.metadata.distribution(name)
    parts.append(f"\n=== {distribution.metadata['Name']} {distribution.version} ===\n")
    expression = distribution.metadata.get("License-Expression") or distribution.metadata.get("License")
    if expression:
        parts.append(expression + "\n")
    for relative in distribution.files or []:
        filename = Path(relative)
        if not any(word in filename.name.lower() for word in ["license", "copying", "copyright", "notice"]):
            continue
        file = distribution.locate_file(relative)
        if file.is_file() and file.stat().st_size <= 2 * 1024 * 1024:
            try:
                parts.extend([f"\n--- {filename.name} ---\n", file.read_text(encoding="utf-8")])
            except (UnicodeError, OSError):
                pass
Path(sys.argv[1]).write_text("\n".join(parts), encoding="utf-8")
