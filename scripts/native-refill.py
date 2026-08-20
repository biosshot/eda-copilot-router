"""Refill KiCad zones for optional native E2E verification."""

from __future__ import annotations

import sys

import pcbnew


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: native-refill.py BOARD.kicad_pcb")
    path = sys.argv[1]
    board = pcbnew.LoadBoard(path)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(path, board)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
