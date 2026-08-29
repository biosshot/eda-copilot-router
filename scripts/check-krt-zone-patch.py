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
# Exercise the legacy developer form of the same opaque-token mapping the host
# supplies through its exact-selector sidecar.
os.environ.pop("COPILOT_ROUTER_EXACT_SELECTORS_FILE", None)
os.environ["COPILOT_ROUTER_EXACT_NET_SELECTION"] = '[["POWER_TOKEN", "PWR"]]'

import copilot_router_krt_patch as patch  # noqa: E402
import cleanup_pipeline  # noqa: E402
import net_queries  # noqa: E402
import obstacle_cache  # noqa: E402
import obstacle_map  # noqa: E402
import output_writer  # noqa: E402
import pcb_modification  # noqa: E402
import kicad_oracle  # noqa: E402
import single_ended_routing  # noqa: E402
from kicad_parser import Pad, Segment, Via  # noqa: E402


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
assert pcb_modification.prune_redundant_cycles.__module__ == "copilot_router_krt_patch"
assert cleanup_pipeline.prune_redundant_cycles.__module__ == "copilot_router_krt_patch"
assert cleanup_pipeline.run_post_route_cleanup.__module__ == "copilot_router_krt_patch"
assert output_writer.write_routed_output.__module__ == "copilot_router_krt_patch"
assert kicad_oracle.oracle_reconnect.__module__ == "copilot_router_krt_patch"
power_map = net_queries.identify_power_nets(
    SimpleNamespace(nets={1: SimpleNamespace(name="PWR")}),
    ["POWER_TOKEN"],
    [0.42],
)
assert power_map == {1: 0.42}, "opaque --power-nets token lost its exact net mapping"


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


class StackCleanupConfig:
    layers = ["F.Cu", "B.Cu", "In1.Cu"]
    layer_costs = [1.0, 1.0, -1.0]
    power_net_widths = {1: 0.2}
    via_cost = 50


scope_board = SimpleNamespace(zones=[
    SimpleNamespace(net_id=1, layer="In1.Cu"),
    SimpleNamespace(net_id=2, layer="In1.Cu"),
    SimpleNamespace(net_id=3, layer="In1.Cu"),
])
assert patch._stack_plane_scope(scope_board, StackCleanupConfig(), {1, 2, 3}) == {
    1: {"In1.Cu"},
}, "GND/ordinary plane zones leaked into explicit Stack power cleanup scope"


def cleanup_pad(x, reference):
    return Pad(
        component_ref=reference,
        pad_number="1",
        global_x=x,
        global_y=0.0,
        local_x=0.0,
        local_y=0.0,
        size_x=0.6,
        size_y=0.6,
        shape="circle",
        layers=["F.Cu"],
        net_id=1,
        net_name="PWR",
    )


def cleanup_segment(first, second):
    return Segment(first, 0.0, second, 0.0, 0.2, "F.Cu", 1)


def cleanup_via(x):
    return Via(x, 0.0, 0.4, 0.2, ["F.Cu", "B.Cu"], 1)


def cleanup_case(distance, fill_polygons, *, third_pad=False,
                 input_parallel=False):
    routed_segment = cleanup_segment(0.0, distance)
    input_segment = cleanup_segment(0.0, distance) if input_parallel else None
    segments = ([input_segment] if input_segment is not None else []) + [routed_segment]
    vias = [] if input_parallel or third_pad else [cleanup_via(0.0), cleanup_via(distance)]
    pads = [cleanup_pad(0.0, "U1"), cleanup_pad(distance, "U2")]
    if third_pad:
        pads.append(cleanup_pad(distance + 5.0, "U3"))
    board = SimpleNamespace(
        nets={1: SimpleNamespace(name="PWR")},
        net_id_to_name={1: "PWR"},
        zones=[SimpleNamespace(net_id=1, layer="In1.Cu", polygon=fill_polygons[0])],
        segments=segments,
        vias=vias,
        pads_by_net={1: pads},
        exact_fill_provider=lambda: {("PWR", "In1.Cu"): fill_polygons},
    )
    results = [{"new_segments": [routed_segment], "new_vias": list(vias)}]
    stats = patch._prune_stack_plane_redundancy(
        results, board, {1}, StackCleanupConfig(),
    )
    return board, results, stats, input_segment


near_fill = [[(-1.0, -1.0), (2.0, -1.0), (2.0, 1.0), (-1.0, 1.0)]]
near_board, _, near_stats, _ = cleanup_case(1.0, near_fill)
assert near_stats["segments"] == 0 and near_stats["vias"] == 1
assert len(near_board.segments) == 1 and len(near_board.vias) == 1, (
    "short pad-to-pad connection should retain only one useful plane tap"
)

far_fill = [[(-1.0, -1.0), (11.0, -1.0), (11.0, 1.0), (-1.0, 1.0)]]
far_board, _, far_stats, _ = cleanup_case(10.0, far_fill)
assert far_stats["segments"] == 1 and far_stats["vias"] == 0
assert len(far_board.segments) == 0 and len(far_board.vias) == 2, (
    "long connection should prefer two plane taps over the parallel track"
)

split_fill = [
    [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)],
    [(9.0, -1.0), (11.0, -1.0), (11.0, 1.0), (9.0, 1.0)],
]
split_board, _, split_stats, _ = cleanup_case(10.0, split_fill)
assert split_stats["segments"] == 0 and split_stats["vias"] == 0
assert len(split_board.segments) == 1 and len(split_board.vias) == 2, (
    "separate split-plane islands must retain their inter-island track and taps"
)

partial_board, _, partial_stats, _ = cleanup_case(
    1.0, near_fill, third_pad=True,
)
assert partial_stats["segments"] == 0 and len(partial_board.segments) == 1, (
    "cleanup must preserve pad pairs already connected in a partial net"
)

authority_board, _, authority_stats, input_segment = cleanup_case(
    1.0, near_fill, input_parallel=True,
)
assert authority_stats["segments"] == 1 and authority_stats["vias"] == 0
assert authority_board.segments == [input_segment], (
    "input copper must participate in connectivity but remain read-only"
)

print(
    f"KRT exact-filled-zone patch: {len(cells)} track cells, {len(vias)} via cells; "
    f"neckdown taper {taper_length:.3f} mm in {len(taper)} steps; "
    "stack-plane cleanup synthetic cases passed"
)
