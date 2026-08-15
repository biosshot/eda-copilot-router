"""Fast synthetic regression for the managed KRT filled-zone patch."""

from __future__ import annotations

import os
import sys
from types import SimpleNamespace


if len(sys.argv) != 2:
    raise SystemExit("usage: check-krt-zone-patch.py <KiCadRoutingTools-directory>")

root = os.path.abspath(sys.argv[1])
repository = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.dont_write_bytecode = True
sys.path[:0] = [
    os.path.join(repository, "assets", "krt-patches"),
    os.path.join(root, "py_router"),
    os.path.join(root, "rust_router"),
]

import copilot_router_krt_patch as patch  # noqa: E402
import obstacle_cache  # noqa: E402
import obstacle_map  # noqa: E402
import single_ended_routing  # noqa: E402


class Config:
    grid_step = 0.1
    layers = ["F.Cu", "B.Cu"]
    via_size = 0.6

    @staticmethod
    def obstacle_clearance(_net_id):
        return 0.2

    @staticmethod
    def route_reserve_width(_layer):
        return 0.2

    @staticmethod
    def layer_clearance(_layer, fallback):
        return fallback


pcb = SimpleNamespace(
    net_id_to_name={1: "VCC", 2: "SIG"},
    nets={},
    exact_fill_provider=lambda: {
        ("VCC", "F.Cu"): [[(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)]],
    },
    board_info=SimpleNamespace(board_bounds=(-1.0, -1.0, 3.0, 3.0)),
)

cells, vias = patch._zone_obstacles(pcb, 1, Config())
assert cells.ndim == 2 and cells.shape[1] == 3 and len(cells) > 0
assert vias.ndim == 2 and vias.shape[1] == 2 and len(vias) > 0
assert set(cells[:, 2]) == {0}, "F.Cu fill leaked onto another routing layer"
assert any((row[:2] == [10, 10]).all() for row in cells), "filled-copper interior was not blocked"
assert not len(patch._zone_obstacles(pcb, 2, Config())[0]), "wrong net inherited the zone cache"
assert obstacle_map.build_base_obstacle_map.__module__ == "copilot_router_krt_patch"
assert obstacle_cache.precompute_net_obstacles.__module__ == "copilot_router_krt_patch"


class NeckdownConfig:
    grid_step = 0.1
    layers = ["F.Cu"]
    track_width = 0.127
    neckdown_length = 0.5
    neckdown_taper_length = 0.5

    @staticmethod
    def get_track_width(_layer):
        return 0.127

    @staticmethod
    def get_net_track_width(_net_id, _layer):
        return 3.0


class EmptyObstacles:
    @staticmethod
    def segment_blocked(*_args):
        return False

    @staticmethod
    def is_blocked(*_args):
        return False


def neckdown_signature():
    routed = patch._apply_local_neckdown_widths(
        [single_ended_routing.Segment(
            start_x=0.0,
            start_y=0.0,
            end_x=4.0,
            end_y=0.0,
            width=3.0,
            layer="F.Cu",
            net_id=1,
        )],
        NeckdownConfig(),
        1,
        EmptyObstacles(),
        patch.GridCoord(0.1),
        ["F.Cu"],
        0.0,
    )
    return routed, [(
        round(item.start_x, 9), round(item.start_y, 9),
        round(item.end_x, 9), round(item.end_y, 9), round(item.width, 9),
    ) for item in routed]


neckdown, first_signature = neckdown_signature()
_, second_signature = neckdown_signature()
assert first_signature == second_signature, "neckdown taper is not deterministic"
narrow = NeckdownConfig.track_width
wide = NeckdownConfig.get_net_track_width(1, "F.Cu")
taper = [item for item in neckdown if narrow + 1e-9 < item.width < wide - 1e-9]
taper_length = sum(single_ended_routing._seg_length(item) for item in taper)
assert abs(taper_length - NeckdownConfig.neckdown_taper_length) <= 1e-9, (
    f"0.5 mm taper collapsed to {taper_length:.6f} mm"
)
assert 4 <= len(taper) <= 16, f"unexpected taper step count: {len(taper)}"
assert all(narrow <= item.width <= wide for item in neckdown), "taper width overshoot"
assert any(abs(item.width - wide) <= 1e-9 for item in neckdown), "wide run was not restored"

parsed = patch._parse_obstacle_fills("""
(kicad_pcb (version 20260206)
  (net 1 \"VCC\")
  (zone (net 1) (net_name \"VCC\") (layer \"F.Cu\")
    (name \"copilot-router:compact:0:VCC:F.Cu\")
    (filled_polygon (layer \"F.Cu\") (pts (xy 0 0) (xy 1 0) (xy 1 1) (xy 0 1))))
  (zone (net 1) (net_name \"VCC\") (layer \"B.Cu\")
    (name \"copilot-router:plane:0:VCC:B.Cu\")
    (filled_polygon (layer \"B.Cu\") (pts (xy 0 0) (xy 2 0) (xy 2 2) (xy 0 2)))))
""")
assert ("VCC", "F.Cu") in parsed
assert ("VCC", "B.Cu") not in parsed, "cuttable DSL plane became a fixed obstacle"

print(
    f"KRT exact-filled-zone patch: {len(cells)} track cells, {len(vias)} via cells; "
    f"neckdown taper {taper_length:.3f} mm in {len(taper)} steps"
)
