from __future__ import annotations

import json
import sys
from pathlib import Path

SKILL_SCRIPTS = Path(r"C:\Users\kiril\.codex\skills\kicad\scripts")
sys.path.insert(0, str(SKILL_SCRIPTS))

from sexp_parser import find_all, find_first, get_property, get_value, parse_file  # noqa: E402


def placement(path: Path) -> dict[str, dict[str, object]]:
    root = parse_file(str(path))
    output: dict[str, dict[str, object]] = {}
    for index, footprint in enumerate(find_all(root, "footprint")):
        reference = get_property(footprint, "Reference")
        if not reference:
            for text in find_all(footprint, "fp_text"):
                if len(text) >= 3 and text[1] == "reference":
                    reference = str(text[2])
                    break
        at = find_first(footprint, "at") or ["at", "0", "0"]
        output[reference or f"#{index}"] = {
            "at": [float(value) for value in at[1:]],
            "layer": get_value(footprint, "layer") or "F.Cu",
        }
    return output


if len(sys.argv) < 3:
    raise SystemExit("Usage: check_placement.py source.kicad_pcb result1.kicad_pcb [...]")

source_path = Path(sys.argv[1]).resolve()
source = placement(source_path)
results = []
for raw_path in sys.argv[2:]:
    path = Path(raw_path).resolve()
    candidate = placement(path)
    mismatches = sorted(reference for reference in source.keys() | candidate.keys() if source.get(reference) != candidate.get(reference))
    results.append({
        "path": str(path),
        "footprints": len(candidate),
        "placement_changed": bool(mismatches),
        "mismatches": mismatches,
    })

print(json.dumps({"source": str(source_path), "source_footprints": len(source), "results": results}, indent=2))
