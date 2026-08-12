"""Lossless KiCad <-> Specctra bridge for the Freerouting backend.

The workflow keeps the user's board immutable.  Export operates on a staged
copy, assigns excluded nets to dedicated temporary net classes, and locks all
pre-existing copper.  Import applies the SES to another staged copy so zones,
footprints, graphics, project sidecars, and existing fixed copper stay native
KiCad objects.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Iterable

import pcbnew


ROLE_PREFIX = "WORKFLOW_"


def _net_names(board) -> list[str]:
    return sorted(str(name) for name in board.GetNetsByName().keys() if str(name))


def _copy_netclass(name: str, properties: tuple[int, ...]) -> object:
    (
        track_width,
        clearance,
        via_diameter,
        via_drill,
        diff_pair_width,
        diff_pair_gap,
        diff_pair_via_gap,
    ) = properties
    result = pcbnew.NETCLASS(name, True)
    result.SetTrackWidth(track_width)
    result.SetClearance(clearance)
    result.SetViaDiameter(via_diameter)
    result.SetViaDrill(via_drill)
    result.SetDiffPairWidth(diff_pair_width)
    result.SetDiffPairGap(diff_pair_gap)
    result.SetDiffPairViaGap(diff_pair_via_gap)
    return result


def _assign_class(settings, net_name: str, class_name: str) -> None:
    assigned = pcbnew.STRINGSET()
    assigned.add(class_name)
    settings.SetNetclassLabelAssignment(net_name, assigned)


def _configure_export_classes(
    board,
    excluded: set[str],
    routed: set[str],
) -> dict[str, list[str]]:
    settings = board.GetDesignSettings().m_NetSettings
    names = _net_names(board)
    name_set = set(names)
    unknown = sorted((excluded | routed).difference(name_set))
    if unknown:
        raise ValueError(f"Unknown workflow net(s): {', '.join(unknown)}")
    overlap = sorted(excluded & routed)
    if overlap:
        raise ValueError(f"Nets assigned to both route and ignore scopes: {', '.join(overlap)}")
    uncovered = sorted(name_set.difference(excluded | routed))
    if uncovered:
        raise ValueError(f"Nets missing from the exact workflow scope: {', '.join(uncovered)}")

    # Capture effective geometry before clearing assignments.  Every generated
    # class is keyed by role plus the complete geometry tuple, so assigning an
    # ignore role never flattens a native track/clearance/via rule.
    properties: dict[str, tuple[int, ...]] = {}
    for name in names:
        netclass = settings.GetEffectiveNetClass(name)
        properties[name] = (
            netclass.GetTrackWidth(),
            netclass.GetClearance(),
            netclass.GetViaDiameter(),
            netclass.GetViaDrill(),
            netclass.GetDiffPairWidth(),
            netclass.GetDiffPairGap(),
            netclass.GetDiffPairViaGap(),
        )

    settings.ClearNetclassLabelAssignments()
    settings.ClearNetclassPatternAssignments()
    generated: dict[tuple[object, ...], str] = {}
    members: dict[str, list[str]] = {}
    counters = {"IGNORE": 0, "ROUTE": 0}

    for name in names:
        role = "ROUTE" if name in routed else "IGNORE"
        key: tuple[object, ...] = (role, *properties[name])
        class_name = generated.get(key)
        if class_name is None:
            class_name = f"{ROLE_PREFIX}{role}_{counters[role]}"
            counters[role] += 1
            generated[key] = class_name
            settings.SetNetclass(class_name, _copy_netclass(class_name, properties[name]))
            members[class_name] = []
        _assign_class(settings, name, class_name)
        members[class_name].append(name)

    settings.RecomputeEffectiveNetclasses()
    return members


def _lock_existing_copper(board) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in board.Tracks():
        item.SetLocked(True)
        name = item.GetNetname()
        counts[name] = counts.get(name, 0) + 1
    return counts


def _count_board(board) -> dict[str, int]:
    tracks = list(board.Tracks())
    return {
        "tracks_and_vias": len(tracks),
        "vias": sum(isinstance(item, pcbnew.PCB_VIA) for item in tracks),
        "zones": len(list(board.Zones())),
    }


def _write_manifest(path: Path | None, payload: dict) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def export_dsn(args) -> None:
    input_path = Path(args.input).resolve()
    output_board = Path(args.output_board).resolve()
    dsn_path = Path(args.dsn).resolve()
    manifest_path = Path(args.manifest).resolve() if args.manifest else None
    excluded = set(args.exclude_net)
    routed = set(args.route_net)

    board = pcbnew.LoadBoard(str(input_path))
    if board is None:
        raise RuntimeError(f"Could not load board: {input_path}")
    classes = _configure_export_classes(board, excluded, routed)
    locked = _lock_existing_copper(board)
    output_board.parent.mkdir(parents=True, exist_ok=True)
    dsn_path.parent.mkdir(parents=True, exist_ok=True)
    pcbnew.SaveBoard(str(output_board), board)
    if not pcbnew.ExportSpecctraDSN(board, str(dsn_path)):
        raise RuntimeError("KiCad ExportSpecctraDSN returned false")

    payload = {
        "mode": "export",
        "kicad_version": pcbnew.Version(),
        "input": str(input_path),
        "output_board": str(output_board),
        "dsn": str(dsn_path),
        "excluded_nets": sorted(excluded),
        "routed_nets": sorted(routed),
        "ignored_classes": sorted(name for name in classes if name.startswith(f"{ROLE_PREFIX}IGNORE_")),
        "classes": classes,
        "locked_copper_by_net": locked,
        "board": _count_board(board),
    }
    _write_manifest(manifest_path, payload)
    print(json.dumps(payload))


def import_ses(args) -> None:
    input_path = Path(args.input).resolve()
    output_board = Path(args.output_board).resolve()
    ses_path = Path(args.ses).resolve()
    manifest_path = Path(args.manifest).resolve() if args.manifest else None

    board = pcbnew.LoadBoard(str(input_path))
    if board is None:
        raise RuntimeError(f"Could not load board: {input_path}")
    before = _count_board(board)
    if not pcbnew.ImportSpecctraSES(board, str(ses_path)):
        raise RuntimeError("KiCad ImportSpecctraSES returned false")
    output_board.parent.mkdir(parents=True, exist_ok=True)
    pcbnew.SaveBoard(str(output_board), board)
    payload = {
        "mode": "import",
        "kicad_version": pcbnew.Version(),
        "input": str(input_path),
        "ses": str(ses_path),
        "output_board": str(output_board),
        "before": before,
        "after": _count_board(board),
    }
    _write_manifest(manifest_path, payload)
    print(json.dumps(payload))


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-board", required=True)
    parser.add_argument("--manifest")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    export_parser = subparsers.add_parser("export")
    _add_common(export_parser)
    export_parser.add_argument("--dsn", required=True)
    export_parser.add_argument("--exclude-net", action="append", default=[])
    export_parser.add_argument("--route-net", action="append", default=[])
    export_parser.set_defaults(func=export_dsn)

    import_parser = subparsers.add_parser("import")
    _add_common(import_parser)
    import_parser.add_argument("--ses", required=True)
    import_parser.set_defaults(func=import_ses)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
