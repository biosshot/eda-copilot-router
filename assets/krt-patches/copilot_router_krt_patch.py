"""Make native KiCad filled copper a net-aware KRT obstacle.

KRT parses zone outlines for connectivity, but its ordinary maze map
does not stamp the actual ``filled_polygon`` copper.  This packaged patch uses
the already-refilled board written by the host and augments KRT's existing
per-net obstacle caches.  The cache for the net currently being routed is
removed by KRT in the normal way, so a zone remains conductive for its owner
without becoming hundreds of fake track terminals.
"""

from __future__ import annotations

import os
import re
import sys
import math
import copy
import json
import tempfile
import time
from collections import Counter
from typing import Dict, List, Tuple

import numpy as np

import kicad_exact_fill
import obstacle_cache
import obstacle_map
import single_ended_routing
from routing_config import DiffPairNet, GridCoord
from routing_utils import build_layer_map


_ORIGINAL_BUILD_BASE = obstacle_map.build_base_obstacle_map
_ORIGINAL_PRECOMPUTE = obstacle_cache.precompute_net_obstacles
_CACHE_ATTRIBUTE = "_copilot_router_exact_filled_copper"
_ROUTER_PLANE_PREFIX = "copilot-router:plane:"
_ZONE_NAME_RE = re.compile(r'\(name\s+"((?:[^"\\]|\\.)*)"\)')

# Copilot Router policy: neck-down is always allowed, including short routes.
# Upstream KRT otherwise treats <=10 mm power/impedance connections as one
# uniformly narrowed segment, so a legal wide middle can never recover its
# requested width.  Sending every connection through the normal two-ended
# neck-down pass keeps dense pad escapes narrow and restores the requested
# width everywhere the wide swept-copper check succeeds.
single_ended_routing.SHORT_POWER_EDGE_MM = 0.0

_ORIGINAL_APPLY_NECKDOWN = single_ended_routing._apply_neckdown_widths
_NECKDOWN_CHECK_INTERVAL_MM = 0.5
_TAPER_MIN_STEPS = 4
_TAPER_MAX_STEPS = 16
_TAPER_LENGTH_STEP_TARGET_MM = 0.1
_TAPER_WIDTH_STEP_TARGET_MM = 0.25


def _without_neckdown_taper(config):
    """Return an isolated config clone for the binary wide-fit pass."""
    clone = copy.copy(config)
    clone.neckdown_taper_length = 0.0
    return clone


def _is_wide(segment, config, net_id):
    narrow = single_ended_routing._neck_width_for_net(config, net_id, segment.layer)
    return segment.width > narrow + 1e-9


def _suppress_short_wide_islands(segments, config, net_id):
    """Preserve upstream's noise filter while delaying taper construction."""
    minimum = 2.0 * config.neckdown_taper_length
    if minimum <= 0:
        return segments
    wide = [_is_wide(segment, config, net_id) for segment in segments]
    index = 0
    while index < len(segments):
        if not wide[index]:
            index += 1
            continue
        end = index
        length = 0.0
        while end < len(segments) and wide[end]:
            length += single_ended_routing._seg_length(segments[end])
            end += 1
        if index > 0 and end < len(segments) and length <= minimum + 1e-9:
            for item in range(index, end):
                segments[item].width = single_ended_routing._neck_width_for_net(
                    config, net_id, segments[item].layer,
                )
                wide[item] = False
        index = end
    return segments


def _collinear_forward(first, second):
    ax = first.end_x - first.start_x
    ay = first.end_y - first.start_y
    bx = second.end_x - second.start_x
    by = second.end_y - second.start_y
    scale = max(1.0, math.hypot(ax, ay) * math.hypot(bx, by))
    return abs(ax * by - ay * bx) <= 1e-9 * scale and ax * bx + ay * by > 0


def _merge_collinear_same_width(segments):
    """Undo sampling splits without crossing a corner, layer, net or width."""
    merged = []
    for segment in segments:
        if merged:
            previous = merged[-1]
            connected = (
                abs(previous.end_x - segment.start_x) <= 1e-9
                and abs(previous.end_y - segment.start_y) <= 1e-9
            )
            compatible = (
                previous.layer == segment.layer
                and previous.net_id == segment.net_id
                and abs(previous.width - segment.width) <= 1e-9
            )
            if connected and compatible and _collinear_forward(previous, segment):
                merged[-1] = single_ended_routing.Segment(
                    start_x=previous.start_x,
                    start_y=previous.start_y,
                    end_x=segment.end_x,
                    end_y=segment.end_y,
                    width=previous.width,
                    layer=previous.layer,
                    net_id=previous.net_id,
                )
                continue
        merged.append(segment)
    return merged


def _segment_piece(segment, start_fraction, end_fraction, width):
    dx = segment.end_x - segment.start_x
    dy = segment.end_y - segment.start_y
    return single_ended_routing.Segment(
        start_x=segment.start_x + dx * start_fraction,
        start_y=segment.start_y + dy * start_fraction,
        end_x=segment.start_x + dx * end_fraction,
        end_y=segment.start_y + dy * end_fraction,
        width=width,
        layer=segment.layer,
        net_id=segment.net_id,
    )


def _taper_step_count(length, width_delta):
    return max(_TAPER_MIN_STEPS, min(
        _TAPER_MAX_STEPS,
        int(math.ceil(max(
            length / _TAPER_LENGTH_STEP_TARGET_MM,
            width_delta / _TAPER_WIDTH_STEP_TARGET_MM,
        ))),
    ))


def _taper_wide_segment(segment, narrow_width, taper_length,
                        narrow_before=False, narrow_after=False):
    """Carve bounded width steps from the already-proven wide envelope."""
    length = single_ended_routing._seg_length(segment)
    if length <= 1e-12 or taper_length <= 0 or not (narrow_before or narrow_after):
        return [segment]

    sides = int(narrow_before) + int(narrow_after)
    available_per_side = length / sides
    used = min(taper_length, available_per_side)
    if used <= 1e-12:
        return [segment]

    wide_width = segment.width
    delta = max(0.0, wide_width - narrow_width)
    if delta <= 1e-12:
        return [segment]
    steps = _taper_step_count(used, delta)
    start_length = used if narrow_before else 0.0
    end_length = used if narrow_after else 0.0
    output = []

    if narrow_before:
        for index in range(steps):
            start = (start_length * index / steps) / length
            end = (start_length * (index + 1) / steps) / length
            width = narrow_width + delta * (index + 1) / (steps + 1)
            output.append(_segment_piece(segment, start, end, width))

    body_start = start_length / length
    body_end = 1.0 - end_length / length
    if body_end - body_start > 1e-12:
        output.append(_segment_piece(segment, body_start, body_end, wide_width))

    if narrow_after:
        for index in range(steps):
            start = body_end + (end_length * index / steps) / length
            end = body_end + (end_length * (index + 1) / steps) / length
            width = wide_width - delta * (index + 1) / (steps + 1)
            output.append(_segment_piece(segment, start, end, width))
    return output


def _apply_full_run_tapers(segments, config, net_id):
    if config.neckdown_taper_length <= 0:
        return segments
    wide = [_is_wide(segment, config, net_id) for segment in segments]
    output = []
    for index, segment in enumerate(segments):
        if not wide[index]:
            output.append(segment)
            continue
        narrow_before = (
            index > 0 and not wide[index - 1]
            and segments[index - 1].layer == segment.layer
        )
        narrow_after = (
            index + 1 < len(segments) and not wide[index + 1]
            and segments[index + 1].layer == segment.layer
        )
        narrow_width = single_ended_routing._neck_width_for_net(
            config, net_id, segment.layer,
        )
        output.extend(_taper_wide_segment(
            segment,
            narrow_width,
            config.neckdown_taper_length,
            narrow_before=narrow_before,
            narrow_after=narrow_after,
        ))
    return output


def _apply_local_neckdown_widths(segments, config, net_id, obstacles, coord,
                                 layer_names, track_margin, neck_start=False):
    """Make KRT's wide-fit decision local instead of segment-wide.

    KRT simplifies a straight route into very long segments.  Its native
    neck-down pass then narrows a whole segment when only a few millimetres at
    one end collide with a dense pad bank.  Re-segmenting only this fallback
    path gives the existing swept-copper check enough resolution to restore
    the requested width in free space.  The later authoritative terminal-graze
    pass still narrows the pieces touching pads.
    """
    pieces = []
    for segment in segments:
        length = math.hypot(segment.end_x - segment.start_x,
                            segment.end_y - segment.start_y)
        count = max(1, int(math.ceil(length / _NECKDOWN_CHECK_INTERVAL_MM)))
        width = config.get_net_track_width(net_id, segment.layer)
        for index in range(count):
            t0 = index / count
            t1 = (index + 1) / count
            pieces.append(single_ended_routing.Segment(
                start_x=segment.start_x + (segment.end_x - segment.start_x) * t0,
                start_y=segment.start_y + (segment.end_y - segment.start_y) * t0,
                end_x=segment.start_x + (segment.end_x - segment.start_x) * t1,
                end_y=segment.start_y + (segment.end_y - segment.start_y) * t1,
                width=width,
                layer=segment.layer,
                net_id=segment.net_id,
            ))
    # Upstream constructs its taper immediately. Since every sampling piece is
    # <=0.5 mm and upstream caps a taper to one third of its host segment, the
    # nominal 0.5 mm taper collapsed to <=0.1667 mm. First ask upstream only for
    # its proven binary wide/narrow classification, then restore its short-wide-
    # island filter, merge sampling cuts, and finally build the taper over the
    # full available collinear run. Every emitted taper width stays inside the
    # already-clear wide envelope.
    classified = _ORIGINAL_APPLY_NECKDOWN(
        pieces, _without_neckdown_taper(config), net_id, obstacles, coord,
        layer_names, track_margin,
        neck_start=neck_start,
    )
    classified = _suppress_short_wide_islands(classified, config, net_id)
    merged = _merge_collinear_same_width(classified)
    return _apply_full_run_tapers(merged, config, net_id)


single_ended_routing._apply_neckdown_widths = _apply_local_neckdown_widths


def _parse_obstacle_fills(text: str):
    """Parse actual fills, excluding intentionally cuttable DSL planes."""
    id_to_name = {
        int(match.group(1)): match.group(2)
        for match in re.finditer(r'\(net\s+(\d+)\s+"((?:[^"\\]|\\.)*)"\)', text)
    }
    output = {}
    position = 0
    while True:
        zone_start = text.find("(zone", position)
        if zone_start < 0:
            break
        block, position = kicad_exact_fill._balanced_block(text, zone_start)
        filled_at = block.find("(filled_polygon")
        head = block[:filled_at] if filled_at >= 0 else block
        zone_name = _ZONE_NAME_RE.search(head)
        if zone_name and zone_name.group(1).startswith(_ROUTER_PLANE_PREFIX):
            continue
        name_match = kicad_exact_fill._NET_NAME_RE.search(head) \
            or kicad_exact_fill._NET_STR_RE.search(head)
        net_name = name_match.group(1) if name_match else None
        if net_name is None:
            net_match = kicad_exact_fill._NET_ID_RE.search(head)
            if net_match:
                net_name = id_to_name.get(int(net_match.group(1)))
        if not net_name:
            continue
        filled_position = 0
        while True:
            polygon_start = block.find("(filled_polygon", filled_position)
            if polygon_start < 0:
                break
            polygon_block, filled_position = kicad_exact_fill._balanced_block(block, polygon_start)
            layer_match = kicad_exact_fill._LAYER_RE.search(polygon_block)
            if not layer_match:
                continue
            polygon = [
                (float(x), float(y))
                for x, y in kicad_exact_fill._XY_RE.findall(polygon_block)
            ]
            if len(polygon) >= 3:
                output.setdefault((net_name, layer_match.group(1)), []).append(polygon)
    return output


def _net_names(pcb_data) -> Tuple[Dict[int, str], Dict[str, int]]:
    by_id = dict(getattr(pcb_data, "net_id_to_name", None) or {})
    for net_id, net in (getattr(pcb_data, "nets", None) or {}).items():
        name = getattr(net, "name", None)
        if name:
            by_id.setdefault(int(net_id), str(name))
    return by_id, {name: net_id for net_id, name in by_id.items()}


def _filled_copper(pcb_data):
    cached = getattr(pcb_data, _CACHE_ATTRIBUTE, None)
    if cached is not None:
        return cached
    provider = getattr(pcb_data, "exact_fill_provider", None)
    if callable(provider):
        fills = provider()
    else:
        path = getattr(pcb_data, "source_path", "") or ""
        if not path or not os.path.isfile(path):
            fills = {}
        else:
            with open(path, "r", encoding="utf-8") as source:
                fills = _parse_obstacle_fills(source.read())
    by_id, by_name = _net_names(pcb_data)
    indexed = {
        (by_name[name], layer): polygons
        for (name, layer), polygons in (fills or {}).items()
        if name in by_name and polygons
    }
    setattr(pcb_data, _CACHE_ATTRIBUTE, indexed)
    return indexed


def _unique(chunks: List[np.ndarray], columns: int) -> np.ndarray:
    nonempty = [chunk for chunk in chunks if len(chunk)]
    if not nonempty:
        return np.empty((0, columns), dtype=np.int32)
    return obstacle_cache._unique_rows(np.concatenate(nonempty).astype(np.int32, copy=False))


def _zone_obstacles(pcb_data, net_id: int, config, extra_clearance: float = 0.0):
    coord = GridCoord(config.grid_step)
    layer_map = build_layer_map(config.layers)
    clearance = config.obstacle_clearance(net_id)
    track_chunks: List[np.ndarray] = []
    via_chunks: List[np.ndarray] = []
    for (zone_net_id, layer), polygons in _filled_copper(pcb_data).items():
        if zone_net_id != net_id or layer not in layer_map:
            continue
        layer_index = layer_map[layer]
        track_margin = (
            config.route_reserve_width(layer) / 2
            + config.layer_clearance(layer, clearance)
            + extra_clearance
        )
        via_margin = (
            config.via_size / 2
            + config.layer_clearance(layer, clearance)
            + extra_clearance
        )
        for polygon in polygons:
            margin = max(track_margin, via_margin, config.grid_step)
            gx, gy, inside, edge_distance = obstacle_map._rasterize_polygon(
                polygon, coord, margin,
                clip_bounds=getattr(pcb_data.board_info, "board_bounds", None),
            )
            if gx is None:
                continue
            track_mask = inside | (edge_distance < track_margin)
            if track_mask.any():
                layer_column = np.full((int(track_mask.sum()), 1), layer_index, dtype=np.int32)
                track_chunks.append(np.hstack([
                    np.column_stack([gx[track_mask], gy[track_mask]]).astype(np.int32),
                    layer_column,
                ]))
            via_mask = inside | (edge_distance < via_margin)
            if via_mask.any():
                via_chunks.append(np.column_stack([gx[via_mask], gy[via_mask]]).astype(np.int32))
    return _unique(track_chunks, 3), _unique(via_chunks, 2)


def _append_rows(current: np.ndarray, extra: np.ndarray, columns: int) -> np.ndarray:
    if not len(extra):
        return current
    if not len(current):
        return extra
    return _unique([current, extra], columns)


def _precompute_net_obstacles(
    pcb_data,
    net_id: int,
    config,
    extra_clearance: float = 0.0,
    diagonal_margin: float = obstacle_cache.defaults.DIAGONAL_MARGIN,
    _small_pass: bool = False,
):
    data = _ORIGINAL_PRECOMPUTE(
        pcb_data, net_id, config, extra_clearance, diagonal_margin, _small_pass,
    )
    cells, vias = _zone_obstacles(pcb_data, net_id, config, extra_clearance)
    data.blocked_cells = _append_rows(data.blocked_cells, cells, 3)
    data.blocked_vias = _append_rows(data.blocked_vias, vias, 2)
    return data


def _build_base_obstacle_map(
    pcb_data,
    config,
    nets_to_route,
    extra_clearance: float = 0.0,
    net_clearances=None,
    static_base: bool = False,
    progress_callback=None,
):
    result = _ORIGINAL_BUILD_BASE(
        pcb_data,
        config,
        nets_to_route,
        extra_clearance,
        net_clearances,
        static_base,
        progress_callback,
    )
    routed = set(nets_to_route or [])
    net_ids = sorted({net_id for net_id, _layer in _filled_copper(pcb_data) if net_id not in routed})
    add_cells = (
        result.add_static_blocked_cells_batch
        if static_base and hasattr(result, "add_static_blocked_cells_batch")
        else result.add_blocked_cells_batch
    )
    add_vias = (
        result.add_static_blocked_vias_batch
        if static_base and hasattr(result, "add_static_blocked_vias_batch")
        else result.add_blocked_vias_batch
    )
    for net_id in net_ids:
        cells, vias = _zone_obstacles(pcb_data, net_id, config, extra_clearance)
        if len(cells):
            add_cells(cells)
        if len(vias):
            add_vias(vias)
    return result


obstacle_cache.precompute_net_obstacles = _precompute_net_obstacles
obstacle_map.build_base_obstacle_map = _build_base_obstacle_map


_CLEANUP_CONTEXT = []
_STACK_PLANE_POLICY = None


def _stack_plane_scope(pcb_data, config, scope_net_ids=None):
    """Return power-net -> forbidden zone layers for Stack power planes.

    A negative KRT layer cost is the native, already-enforced meaning of a
    dedicated plane layer: vias can see/reach its copper, while routed tracks
    may not occupy it.  Intersecting that with explicit ``--power-nets`` and
    real zones keeps this cleanup away from GND and ordinary DSL ``plane()``
    geometry without adding another host/KRT side channel.
    """
    layers = list(getattr(config, "layers", None) or [])
    costs = list(getattr(config, "layer_costs", None) or [])
    forbidden = {
        layer for index, layer in enumerate(layers)
        if index < len(costs) and float(costs[index]) < 0.0
    }
    power_nets = set((getattr(config, "power_net_widths", None) or {}).keys())
    if scope_net_ids is not None:
        power_nets &= set(scope_net_ids)
    output = {}
    for zone in (getattr(pcb_data, "zones", None) or []):
        if zone.net_id in power_nets and zone.layer in forbidden:
            output.setdefault(zone.net_id, set()).add(zone.layer)
    return output


def _capture_stack_plane_policy(pcb_data, config, scope_net_ids=None,
                                results=None):
    """Remember the route command's Stack-plane contract for its file gate.

    The ordinary cleanup owns the complete GridRouteConfig.  KRT's later
    plane-finalize cleanup deliberately constructs a tiny config containing
    only clearance/grid, so the dedicated-layer and power-net facts would be
    lost by the time the final, fully routed board exists on disk.  Capture
    only those facts here; no board copper is retained.
    """
    global _STACK_PLANE_POLICY

    net_layers = _stack_plane_scope(pcb_data, config, scope_net_ids)
    if not net_layers:
        return
    by_id, _by_name = _net_names(pcb_data)
    named_layers = {
        by_id[net_id]: tuple(sorted(layers))
        for net_id, layers in net_layers.items()
        if by_id.get(net_id)
    }
    if not named_layers:
        return

    expected_output = None
    if len(sys.argv) > 2:
        candidate = str(sys.argv[2])
        if candidate.lower().endswith(".kicad_pcb"):
            expected_output = os.path.abspath(candidate)
    source_path = getattr(pcb_data, "source_path", "") or ""
    _STACK_PLANE_POLICY = {
        "input_file": os.path.abspath(source_path) if source_path else None,
        "output_file": expected_output,
        "net_layers": named_layers,
        "layers": tuple(getattr(config, "layers", None) or ()),
        "layer_costs": tuple(getattr(config, "layer_costs", None) or ()),
        "via_cost": float(getattr(config, "via_cost", 50)),
        "last_fingerprint": None,
        # Non-owning in spirit: batch_route already owns both objects for the
        # duration of this process.  Keeping the references lets a file-level
        # removal stay ledger-identical with KRT's board/write-list model.
        "pcb_data": pcb_data,
        "results": results,
    }


def _exact_stack_plane_fills(pcb_data, net_layers, *, allow_source_file=False,
                             project_from=None):
    """Get KiCad's actual fill islands once for all Stack-plane candidates.

    Host-generated intermediate boards normally omit cached ``filled_polygon``
    blocks.  KRT already ships an exact, memoized pcbnew refiller for that case;
    using it here avoids deleting copper on the strength of a zone outline or
    raster approximation.  Failure is deliberately fail-closed: routing stays
    untouched and the partial result remains applicable.
    """
    stored = _filled_copper(pcb_data)
    needed = {(net_id, layer) for net_id, layers in net_layers.items()
              for layer in layers}
    if needed and all(stored.get(key) for key in needed):
        return {key: stored[key] for key in needed}

    provider = getattr(pcb_data, "exact_fill_provider", None)
    try:
        if callable(provider):
            raw = provider()
        elif allow_source_file:
            source_path = getattr(pcb_data, "source_path", "") or ""
            if not source_path or not os.path.isfile(source_path):
                return {}
            raw = kicad_exact_fill.refill_islands(
                source_path, verbose=False,
                project_from=project_from or source_path,
            )
        else:
            # A text-parsed route board's source_path is the INPUT file and
            # does not contain copper added in memory by this run.  Refilling
            # it would be precise geometry for the wrong board.  The final
            # file gate below is the exact path for CLI runs; live pcbnew
            # callers instead supply exact_fill_provider.
            return {}
    except Exception:
        return {}
    if not raw:
        return {}
    _by_id, by_name = _net_names(pcb_data)
    indexed = {
        (by_name[name], layer): polygons
        for (name, layer), polygons in raw.items()
        if name in by_name and polygons
    }
    return {key: indexed[key] for key in needed if indexed.get(key)}


def _exact_zone_objects(net_id, net_name, fills, layers):
    """Represent each real filled island as an independent zero-cost zone."""
    from types import SimpleNamespace

    zones = []
    for layer in sorted(layers):
        for polygon in fills.get((net_id, layer), ()):
            if len(polygon) < 3:
                continue
            zones.append(SimpleNamespace(
                net_id=net_id,
                net_name=net_name,
                layer=layer,
                polygon=polygon,
                clearance=None,
                min_thickness=None,
            ))
    return zones


def _via_spans_layer(via, layer):
    layers = list(getattr(via, "layers", None) or [])
    return (not layers or ("F.Cu" in layers and "B.Cu" in layers)
            or layer in layers)


def _plane_contact_custody(zones, vias, pads):
    """Return permanent pad contacts and candidate vias for each fill island."""
    permanent = set()
    contacts = [set() for _zone in zones]
    for zone_index, zone in enumerate(zones):
        for pad in pads:
            pad_layers = set(getattr(pad, "layers", None) or [])
            if not (getattr(pad, "drill", 0.0) > 0.0
                    or "*.Cu" in pad_layers or zone.layer in pad_layers):
                continue
            if kicad_exact_fill.point_in_poly(
                    pad.global_x, pad.global_y, zone.polygon):
                permanent.add(zone_index)
                break
        for via in vias:
            if (_via_spans_layer(via, zone.layer)
                    and kicad_exact_fill.point_in_poly(
                        via.x, via.y, zone.polygon)):
                contacts[zone_index].add(id(via))
    return permanent, contacts


def _graph_via_reaches_pad(graph, via_index):
    """Whether this via currently carries a physical pad into its plane."""
    from check_connected import UnionFind

    via_point = (graph.get("via_index_repr") or {}).get(via_index)
    if via_point is None:
        return False
    union_find = UnionFind()
    for first, second in graph.get("edges", ()):
        union_find.union(first, second)
    via_root = union_find.find(via_point)
    return any(
        union_find.find(point_id) == via_root
        for point_id in (graph.get("pad_index_repr") or {}).values()
    )


def _must_keep_last_plane_tap(net_id, via, segments, vias, pads,
                              permanent_contacts, via_contacts,
                              removed_via_ids):
    """Keep a fill island's last tap only while it carries a physical pad."""
    last_contact = any(
        id(via) in contact_ids
        and zone_index not in permanent_contacts
        and not (contact_ids - removed_via_ids - {id(via)})
        for zone_index, contact_ids in enumerate(via_contacts)
    )
    if not last_contact:
        return False

    from check_connected import check_net_connectivity

    # Deliberately omit zones: the question is whether copper on the *other*
    # side of this tap reaches a pad. Counting the plane would make every via
    # on one island appear useful through some other pad's tap.
    graph = check_net_connectivity(
        net_id, segments, vias, pads, [], return_graph=True,
    ).get("graph")
    if not graph:
        return False
    try:
        via_index = next(index for index, item in enumerate(vias) if item is via)
    except StopIteration:
        return False
    return _graph_via_reaches_pad(graph, via_index)


def _partition_from_graph(graph, excluded_segment_indices=()):
    """Pad partition from KRT's prebuilt graph with selected tracks absent."""
    from check_connected import UnionFind

    excluded_points = set()
    for index in excluded_segment_indices:
        excluded_points.add(2 * index)
        excluded_points.add(2 * index + 1)
    union_find = UnionFind()
    for first, second in graph.get("edges", ()):
        if first not in excluded_points and second not in excluded_points:
            union_find.union(first, second)

    groups = {}
    for pad_index, point_id in sorted((graph.get("pad_index_repr") or {}).items()):
        groups.setdefault(union_find.find(point_id), set()).add(pad_index)
    return tuple(frozenset(group) for group in groups.values())


def _preserves_pad_partition(baseline, trial):
    """True when no pair of pads connected before becomes disconnected."""
    trial_group = {
        pad_index: group_index
        for group_index, group in enumerate(trial)
        for pad_index in group
    }
    for group in baseline:
        roots = {trial_group.get(pad_index) for pad_index in group}
        if None in roots or len(roots) > 1:
            return False
    return True


def _segment_node(segment, start):
    x = segment.start_x if start else segment.end_x
    y = segment.start_y if start else segment.end_y
    return (round(x, 6), round(y, 6), segment.layer)


def _routed_track_bundles(segments, all_vias, config):
    """Collapse KRT's taper/smoothing pieces into weighted route chains.

    Comparing a via with each emitted micro-segment separately biases the
    cleanup toward tracks: a 12 mm route split into twenty pieces looks like
    twenty sub-via-cost choices.  Maximal degree-two chains restore the cost of
    the physical alternative while junctions and via sites remain boundaries.
    """
    from collections import defaultdict

    if not segments:
        return []
    adjacency = defaultdict(list)
    endpoints = []
    for index, segment in enumerate(segments):
        pair = (_segment_node(segment, True), _segment_node(segment, False))
        endpoints.append(pair)
        adjacency[pair[0]].append(index)
        adjacency[pair[1]].append(index)

    via_points = {(round(via.x, 6), round(via.y, 6)) for via in all_vias}
    boundaries = {
        node for node, edge_indices in adjacency.items()
        if len(edge_indices) != 2 or node[:2] in via_points
    }
    visited = set()
    bundles = []
    for seed in range(len(segments)):
        if seed in visited:
            continue
        first, second = endpoints[seed]
        current_node = first if first in boundaries else (
            second if second in boundaries else first
        )
        current_edge = seed
        bundle = []
        while current_edge not in visited:
            visited.add(current_edge)
            bundle.append(current_edge)
            edge_first, edge_second = endpoints[current_edge]
            next_node = edge_second if current_node == edge_first else edge_first
            if next_node in boundaries:
                break
            remaining = [index for index in adjacency[next_node]
                         if index not in visited]
            if len(remaining) != 1:
                break
            current_node = next_node
            current_edge = remaining[0]
        bundles.append([segments[index] for index in bundle])

    layer_costs = {
        layer: float(cost)
        for layer, cost in zip(
            list(getattr(config, "layers", None) or []),
            list(getattr(config, "layer_costs", None) or []),
        )
    }
    output = []
    for bundle in bundles:
        cost = 0.0
        length = 0.0
        for segment in bundle:
            segment_length = math.hypot(
                segment.end_x - segment.start_x,
                segment.end_y - segment.start_y,
            )
            length += segment_length
            multiplier = layer_costs.get(segment.layer, 1.0)
            cost += segment_length * (multiplier if multiplier > 0.0 else 1.0)
        output.append((cost, length, bundle))
    return output


def _remove_routed_items(results, pcb_data, segment_ids, via_ids):
    """Synchronize verified removals across KRT's board and write-list."""
    if segment_ids:
        pcb_data.segments = [segment for segment in pcb_data.segments
                             if id(segment) not in segment_ids]
    if via_ids:
        pcb_data.vias = [via for via in pcb_data.vias if id(via) not in via_ids]
    for result in results:
        if segment_ids and result.get("new_segments"):
            result["new_segments"] = [
                segment for segment in result["new_segments"]
                if id(segment) not in segment_ids
            ]
        if via_ids and result.get("new_vias"):
            result["new_vias"] = [
                via for via in result["new_vias"] if id(via) not in via_ids
            ]


def _prune_stack_plane_redundancy(results, pcb_data, scope_net_ids, config, *,
                                  allow_source_file=False,
                                  project_from=None,
                                  exact_fills=None):
    """Remove only this run's power copper made redundant by exact plane fill."""
    from collections import defaultdict
    from check_connected import check_net_connectivity
    from routing_config import REFERENCE_GRID_STEP

    net_layers = _stack_plane_scope(pcb_data, config, scope_net_ids)
    if not net_layers:
        return {"segments": 0, "vias": 0, "nets": 0, "length_mm": 0.0}

    routed_segment_ids = {
        id(segment)
        for result in results for segment in (result.get("new_segments") or [])
        if not getattr(segment, "locked", False)
        and not getattr(segment, "graphic", False)
    }
    routed_via_ids = {
        id(via)
        for result in results for via in (result.get("new_vias") or [])
        if not getattr(via, "locked", False)
    }
    if not routed_segment_ids and not routed_via_ids:
        return {"segments": 0, "vias": 0, "nets": 0, "length_mm": 0.0}

    refill_started = time.monotonic()
    fills = exact_fills
    if fills is None:
        fills = _exact_stack_plane_fills(
            pcb_data, net_layers,
            allow_source_file=allow_source_file,
            project_from=project_from,
        )
    refill_elapsed = time.monotonic() - refill_started
    missing = [
        (net_id, layer)
        for net_id, layers in net_layers.items() for layer in layers
        if not fills.get((net_id, layer))
    ]
    if missing:
        print("Stack-plane cleanup: exact KiCad fill unavailable/incomplete; "
              "leaving routed copper unchanged")
        return {"segments": 0, "vias": 0, "nets": 0, "length_mm": 0.0,
                "refill_seconds": refill_elapsed, "skipped": len(missing)}

    segments_by_net = defaultdict(list)
    vias_by_net = defaultdict(list)
    for segment in pcb_data.segments:
        if not getattr(segment, "graphic", False):
            segments_by_net[segment.net_id].append(segment)
    for via in pcb_data.vias:
        vias_by_net[via.net_id].append(via)

    total_segment_ids = set()
    total_via_ids = set()
    total_length = 0.0
    nets_pruned = 0
    via_cost_mm = float(getattr(config, "via_cost", 50)) * REFERENCE_GRID_STEP

    for net_id in sorted(net_layers):
        net_segments = list(segments_by_net.get(net_id, ()))
        net_vias = list(vias_by_net.get(net_id, ()))
        candidate_segments = [segment for segment in net_segments
                              if id(segment) in routed_segment_ids]
        candidate_vias = [via for via in net_vias if id(via) in routed_via_ids]
        if not candidate_segments and not candidate_vias:
            continue
        net = (getattr(pcb_data, "nets", None) or {}).get(net_id)
        net_name = getattr(net, "name", None) or _net_names(pcb_data)[0].get(
            net_id, f"Net {net_id}"
        )
        zones = _exact_zone_objects(
            net_id, net_name, fills, net_layers[net_id],
        )
        pads = (getattr(pcb_data, "pads_by_net", None) or {}).get(net_id, [])
        baseline_result = check_net_connectivity(
            net_id, net_segments, net_vias, pads, zones,
            return_graph=True,
        )
        baseline_graph = baseline_result.get("graph")
        # Partial result is first-class: preserve every pad pair that is
        # connected now, but do not require the whole net to be complete.
        # Thus cleanup can retire a duplicate inside a completed island while
        # leaving every unfinished island and landing site intact.
        if not baseline_graph:
            continue
        baseline_partition = _partition_from_graph(baseline_graph)
        permanent_plane_contacts, via_plane_contacts = _plane_contact_custody(
            zones, net_vias, pads,
        )
        items = []
        for bundle_index, (cost, length, bundle) in enumerate(
                _routed_track_bundles(candidate_segments, net_vias, config)):
            items.append((cost, 0, bundle_index, "segments", length, bundle))
        for via_index, via in enumerate(candidate_vias):
            # At equal cost prefer retiring a via and retaining a track.
            items.append((via_cost_mm, 1, via_index, "via", 0.0, [via]))
        items.sort(key=lambda item: (item[0], item[1], -item[2]), reverse=True)

        current_segments = list(net_segments)
        current_vias = list(net_vias)
        current_graph = baseline_graph
        pending_segment_ids = set()
        removed_segment_ids = set()
        removed_via_ids = set()
        removed_length_by_id = {}

        for _cost, _kind_order, _index, kind, length, objects in items:
            if kind == "segments":
                object_ids = {id(segment) for segment in objects}
                index_by_id = {id(segment): index
                               for index, segment in enumerate(current_segments)}
                trial_indices = {
                    index_by_id[segment_id]
                    for segment_id in pending_segment_ids | object_ids
                    if segment_id in index_by_id
                }
                if not object_ids.issubset(index_by_id):
                    continue
                trial_partition = _partition_from_graph(
                    current_graph, trial_indices,
                )
                if _preserves_pad_partition(
                        baseline_partition, trial_partition):
                    pending_segment_ids |= object_ids
                    removed_segment_ids |= object_ids
                    for segment in objects:
                        removed_length_by_id[id(segment)] = math.hypot(
                            segment.end_x - segment.start_x,
                            segment.end_y - segment.start_y,
                        )
                continue

            via = objects[0]
            if id(via) not in {id(item) for item in current_vias}:
                continue
            trial_segments = [segment for segment in current_segments
                              if id(segment) not in pending_segment_ids]
            # Keep the last useful tap into a declared fill island, but not a
            # via that reaches only the plane itself. The latter is exactly the
            # meaningless dangling-via exposed when a duplicate surface branch
            # is retired. A split-plane island whose tap still carries any pad
            # remains in service.
            if _must_keep_last_plane_tap(
                    net_id, via, trial_segments, current_vias, pads,
                    permanent_plane_contacts, via_plane_contacts,
                    removed_via_ids):
                continue
            trial_vias = [item for item in current_vias if item is not via]
            trial_result = check_net_connectivity(
                net_id, trial_segments, trial_vias, pads, zones,
                return_graph=True,
            )
            trial_graph = trial_result.get("graph")
            if not trial_graph:
                continue
            trial_partition = _partition_from_graph(trial_graph)
            if not _preserves_pad_partition(
                    baseline_partition, trial_partition):
                continue
            removed_via_ids.add(id(via))
            current_segments = trial_segments
            current_vias = trial_vias
            current_graph = trial_graph
            pending_segment_ids.clear()

        # Commit only complete degree-two route chains.  Cutting individual
        # smoothed/tapered pieces can preserve KRT's tolerant connectivity
        # graph while exposing a fragile cap-only joint or a dead-end stub in
        # the serialized KiCad board.  Whole-chain removal is deliberately
        # conservative: if a chain mixes a useful branch with a redundant
        # subsection, it stays.
        current_segments = [
            segment for segment in current_segments
            if id(segment) not in pending_segment_ids
        ]
        pending_segment_ids.clear()

        # A short chain removed after the cost-ordered via decision can expose
        # a tap that now reaches only the plane itself. Revisit vias once after
        # all whole-chain choices; this pass never cuts tracks and therefore
        # cannot create the soft joints that the rejected segment-level pass
        # did.
        for via in candidate_vias:
            if id(via) in removed_via_ids or not any(
                    item is via for item in current_vias):
                continue
            if _must_keep_last_plane_tap(
                    net_id, via, current_segments, current_vias, pads,
                    permanent_plane_contacts, via_plane_contacts,
                    removed_via_ids):
                continue
            trial_vias = [item for item in current_vias if item is not via]
            trial_graph = check_net_connectivity(
                net_id, current_segments, trial_vias, pads, zones,
                return_graph=True,
            ).get("graph")
            if (trial_graph and _preserves_pad_partition(
                    baseline_partition, _partition_from_graph(trial_graph))):
                removed_via_ids.add(id(via))
                current_vias = trial_vias

        final_segments = [segment for segment in current_segments
                          if id(segment) not in pending_segment_ids]
        final_result = check_net_connectivity(
            net_id, final_segments, current_vias, pads, zones,
            return_graph=True,
        )
        final_graph = final_result.get("graph")
        if not final_graph or not _preserves_pad_partition(
                baseline_partition, _partition_from_graph(final_graph)):
            print(f"Stack-plane cleanup: {net_name} verification rejected; "
                  "leaving this net unchanged")
            continue

        # A candidate may have disappeared from a local trial only after its
        # whole chain was accepted; intersect once more with routing authority.
        removed_segment_ids &= routed_segment_ids
        removed_via_ids &= routed_via_ids
        if not removed_segment_ids and not removed_via_ids:
            continue
        removed_length = sum(removed_length_by_id.get(segment_id, 0.0)
                             for segment_id in removed_segment_ids)
        _remove_routed_items(
            results, pcb_data, removed_segment_ids, removed_via_ids,
        )
        total_segment_ids |= removed_segment_ids
        total_via_ids |= removed_via_ids
        total_length += removed_length
        nets_pruned += 1
        print(
            f"Stack-plane cleanup: {net_name} removed "
            f"{len(removed_segment_ids)} routed segment(s) / "
            f"{removed_length:.2f} mm and {len(removed_via_ids)} via(s); "
            "exact fill connectivity preserved"
        )

    return {
        "segments": len(total_segment_ids),
        "vias": len(total_via_ids),
        "nets": nets_pruned,
        "length_mm": total_length,
        "refill_seconds": refill_elapsed,
    }


def _segment_strip_key(segment, names):
    first = (round(segment.start_x, 4), round(segment.start_y, 4))
    second = (round(segment.end_x, 4), round(segment.end_y, 4))
    return (names.get(segment.net_id, str(segment.net_id)), segment.layer,
            min(first, second), max(first, second))


def _via_strip_key(via, names):
    return (names.get(via.net_id, str(via.net_id)),
            round(via.x, 4), round(via.y, 4))


def _new_file_copper(input_pcb, output_pcb, allowed_names):
    """Return safely addressable output copper absent from the input file.

    UUID identity protects moved input copper.  For legacy/UUID-less blocks a
    counted geometry match protects the input occurrence.  A fresh duplicate
    at exactly an input block's strip key is intentionally not a candidate:
    KRT's text writer can remove the right *count* but cannot select which of
    two coincident blocks keeps input-only attributes such as ``locked``.
    """
    input_names = _net_names(input_pcb)[0]
    output_names = _net_names(output_pcb)[0]

    input_segment_uuids = {
        segment.uuid for segment in input_pcb.segments
        if getattr(segment, "uuid", "")
    }
    input_via_uuids = {
        via.uuid for via in input_pcb.vias if getattr(via, "uuid", "")
    }
    input_segment_keys = Counter(
        _segment_strip_key(segment, input_names)
        for segment in input_pcb.segments
    )
    input_via_keys = Counter(
        _via_strip_key(via, input_names) for via in input_pcb.vias
    )
    ambiguous_segment_keys = set(input_segment_keys)
    ambiguous_via_keys = set(input_via_keys)

    new_segments = []
    for segment in output_pcb.segments:
        if getattr(segment, "graphic", False) or getattr(segment, "locked", False):
            continue
        name = output_names.get(segment.net_id)
        if name not in allowed_names:
            continue
        key = _segment_strip_key(segment, output_names)
        if getattr(segment, "uuid", "") in input_segment_uuids:
            if input_segment_keys[key] > 0:
                input_segment_keys[key] -= 1
            continue
        if input_segment_keys[key] > 0:
            input_segment_keys[key] -= 1
            continue
        if key not in ambiguous_segment_keys:
            new_segments.append(segment)

    new_vias = []
    for via in output_pcb.vias:
        if getattr(via, "locked", False):
            continue
        name = output_names.get(via.net_id)
        if name not in allowed_names:
            continue
        key = _via_strip_key(via, output_names)
        if getattr(via, "uuid", "") in input_via_uuids:
            if input_via_keys[key] > 0:
                input_via_keys[key] -= 1
            continue
        if input_via_keys[key] > 0:
            input_via_keys[key] -= 1
            continue
        if key not in ambiguous_via_keys:
            new_vias.append(via)
    return new_segments, new_vias


def _partition_snapshot(pcb_data, net_layers, fills):
    """Exact-fill pad partitions keyed by stable net name."""
    from check_connected import check_net_connectivity

    names = _net_names(pcb_data)[0]
    output = {}
    for net_id, layers in net_layers.items():
        name = names.get(net_id)
        if not name:
            continue
        segments = [
            segment for segment in pcb_data.segments
            if segment.net_id == net_id and not getattr(segment, "graphic", False)
        ]
        vias = [via for via in pcb_data.vias if via.net_id == net_id]
        pads = (getattr(pcb_data, "pads_by_net", None) or {}).get(net_id, [])
        zones = _exact_zone_objects(net_id, name, fills, layers)
        result = check_net_connectivity(
            net_id, segments, vias, pads, zones, return_graph=True,
        )
        graph = result.get("graph")
        if graph:
            output[name] = _partition_from_graph(graph)
    return output


_UNSAFE_CLEANUP_FINDINGS = {
    "dangling-end",
    "soft-joint",
    "unsupported-via",
    "dangling-via",
    "orphan-island",
    "narrow_pad_joint",
}


def _cleanup_hygiene_snapshot(pcb_data, net_names):
    """Fingerprint unsafe copper findings without modifying the board."""
    from check_connected import UnionFind, check_net_connectivity
    from check_weird import check_weird

    # check_weird deliberately uses the stricter removal-pass rule for a via
    # touching a pad: the via centre must be inside the pad.  That is useful
    # while deciding whether copper may be removed, but it can report a
    # physically connected edge-overlap as ``dangling-via``.  The H743 R1.2
    # plane tap is one such case and KiCad DRC agrees that it is connected.
    # Do not let that conservative diagnostic veto an otherwise safe cleanup;
    # use KRT's physical connectivity graph (without zone credit) to recognize
    # vias whose non-plane side really reaches a pad.
    names_by_id = _net_names(pcb_data)[0]
    pad_reachable_vias = set()
    via_positions = set()
    for net_id, name in names_by_id.items():
        if name not in net_names:
            continue
        segments = [
            segment for segment in pcb_data.segments
            if segment.net_id == net_id and not getattr(segment, "graphic", False)
        ]
        vias = [via for via in pcb_data.vias if via.net_id == net_id]
        via_positions.update(
            (name, round(via.x, 4), round(via.y, 4)) for via in vias
        )
        pads = (getattr(pcb_data, "pads_by_net", None) or {}).get(net_id, [])
        graph = check_net_connectivity(
            net_id, segments, vias, pads, [], return_graph=True,
        ).get("graph")
        if not graph:
            continue
        union_find = UnionFind()
        for first, second in graph.get("edges", ()):
            union_find.union(first, second)
        pad_roots = {
            union_find.find(point_id)
            for point_id in (graph.get("pad_index_repr") or {}).values()
        }
        for via_index, point_id in (
                graph.get("via_index_repr") or {}).items():
            if via_index < len(vias) and union_find.find(point_id) in pad_roots:
                via = vias[via_index]
                pad_reachable_vias.add(
                    (name, round(via.x, 4), round(via.y, 4))
                )

    findings, _skipped = check_weird(
        pcb_data,
        net_patterns=sorted(name for name in net_names if name),
        thorough=False,
        quiet=True,
        tolerance=0.0,
    )
    snapshot = Counter()
    for finding in findings:
        category = finding.get("category")
        if category not in _UNSAFE_CLEANUP_FINDINGS:
            continue
        x = round(float(finding["x"]), 4)
        y = round(float(finding["y"]), 4)
        if (category in {"dangling-via", "unsupported-via"}
                and (finding["net"], x, y) in pad_reachable_vias):
            continue
        # A plane tap intentionally leaves a pad's surface connection through
        # the via annulus.  check_weird labels that annular web as a narrow pad
        # joint, while KiCad owns its real safety rule (annular_width) and the
        # cleanup neither creates nor resizes the via.  Keep the structural
        # narrow-joint veto everywhere except at an existing via centre.
        if (category == "narrow_pad_joint"
                and (finding["net"], x, y) in via_positions):
            continue
        snapshot[(category, finding["net"], finding["layer"], x, y)] += 1
    return snapshot


def _policy_for_file_board(pcb_data, policy):
    """Rebind the captured name-based policy to this parsed file's net IDs."""
    from types import SimpleNamespace

    _by_id, by_name = _net_names(pcb_data)
    power_widths = {
        by_name[name]: 1.0
        for name in policy["net_layers"]
        if name in by_name
    }
    config = SimpleNamespace(
        layers=list(policy["layers"]),
        layer_costs=list(policy["layer_costs"]),
        power_net_widths=power_widths,
        via_cost=policy["via_cost"],
    )
    net_layers = {
        by_name[name]: set(layers)
        for name, layers in policy["net_layers"].items()
        if name in by_name
    }
    return config, net_layers


def _file_fingerprint(path):
    stat = os.stat(path)
    return (os.path.normcase(os.path.realpath(path)), stat.st_size,
            stat.st_mtime_ns)


def _prune_stack_planes_in_file(board_file, policy):
    """Transactional exact-fill cleanup on KRT's fully written CLI board."""
    from kicad_parser import parse_kicad_pcb
    from kicad_writer import (remove_segments_from_content,
                              remove_vias_from_content)

    input_file = policy.get("input_file")
    if not input_file or not os.path.isfile(input_file):
        return None
    board = parse_kicad_pcb(board_file)
    input_board = parse_kicad_pcb(input_file)
    config, net_layers = _policy_for_file_board(board, policy)
    if not net_layers:
        return None

    allowed_names = set(policy["net_layers"])
    candidate_segments, candidate_vias = _new_file_copper(
        input_board, board, allowed_names,
    )
    if not candidate_segments and not candidate_vias:
        return None

    exact_fills = _exact_stack_plane_fills(
        board, net_layers, allow_source_file=True, project_from=input_file,
    )
    if any(not exact_fills.get((net_id, layer))
           for net_id, layers in net_layers.items() for layer in layers):
        print("Stack-plane file cleanup: exact fill incomplete; unchanged")
        return None
    baseline = _partition_snapshot(board, net_layers, exact_fills)
    baseline_hygiene = _cleanup_hygiene_snapshot(board, allowed_names)

    result = {
        "new_segments": list(candidate_segments),
        "new_vias": list(candidate_vias),
    }
    stats = _prune_stack_plane_redundancy(
        [result], board, set(net_layers), config,
        project_from=input_file, exact_fills=exact_fills,
    )
    kept_segment_ids = {id(segment) for segment in result["new_segments"]}
    kept_via_ids = {id(via) for via in result["new_vias"]}
    removed_segments = [
        segment for segment in candidate_segments
        if id(segment) not in kept_segment_ids
    ]
    removed_vias = [
        via for via in candidate_vias if id(via) not in kept_via_ids
    ]
    if not removed_segments and not removed_vias:
        return {"stats": stats, "segment_keys": [], "via_keys": []}

    with open(board_file, "r", encoding="utf-8") as handle:
        content = handle.read()
    names = getattr(board, "net_id_to_name", None) or _net_names(board)[0]
    content, segment_count = remove_segments_from_content(
        content, removed_segments, names,
    )
    content, via_count = remove_vias_from_content(
        content, removed_vias, names,
    )
    if segment_count != len(removed_segments) or via_count != len(removed_vias):
        print("Stack-plane file cleanup: writer could not address every "
              "candidate; unchanged")
        return None

    descriptor, staged = tempfile.mkstemp(
        prefix=".copilot-stack-plane-", suffix=".kicad_pcb",
        dir=os.path.dirname(os.path.abspath(board_file)),
    )
    os.close(descriptor)
    try:
        with open(staged, "w", encoding="utf-8") as handle:
            handle.write(content)
        staged_board = parse_kicad_pcb(staged)
        _staged_config, staged_layers = _policy_for_file_board(
            staged_board, policy,
        )
        staged_fills = _exact_stack_plane_fills(
            staged_board, staged_layers, allow_source_file=True,
            project_from=input_file,
        )
        touched_names = {
            _net_names(board)[0].get(item.net_id)
            for item in removed_segments + removed_vias
        }
        if any(not staged_fills.get((net_id, layer))
               for net_id, layers in staged_layers.items()
               for layer in layers):
            print("Stack-plane file cleanup: post-removal fill incomplete; "
                  "unchanged")
            return None
        final = _partition_snapshot(staged_board, staged_layers, staged_fills)
        for name in touched_names:
            if (not name or name not in baseline or name not in final
                    or not _preserves_pad_partition(
                        baseline[name], final[name])):
                print(f"Stack-plane file cleanup: exact post-refill check "
                      f"rejected {name or 'unknown net'}; unchanged")
                return None
        final_hygiene = _cleanup_hygiene_snapshot(staged_board, touched_names)
        new_hygiene = final_hygiene - baseline_hygiene
        if new_hygiene:
            finding = next(iter(new_hygiene))
            print(
                "Stack-plane file cleanup: copper-hygiene check rejected "
                f"new {finding[0]} on {finding[1]}; unchanged"
            )
            return None
        os.replace(staged, board_file)
        staged = None
    finally:
        if staged and os.path.exists(staged):
            os.unlink(staged)

    print(
        "Stack-plane file cleanup committed: "
        f"-{len(removed_segments)} segment(s), "
        f"-{len(removed_vias)} via(s), exact post-refill connectivity preserved"
    )
    board_names = _net_names(board)[0]
    return {
        "stats": stats,
        "segment_keys": [
            _segment_strip_key(segment, board_names)
            for segment in removed_segments
        ],
        "via_keys": [
            _via_strip_key(via, board_names) for via in removed_vias
        ],
    }


def _sync_file_cleanup(policy, cleanup):
    """Mirror a committed file cleanup into KRT's in-process copper ledger."""
    if not cleanup:
        return
    pcb_data = policy.get("pcb_data")
    if pcb_data is None:
        return
    names = _net_names(pcb_data)[0]
    segment_targets = Counter(cleanup.get("segment_keys") or ())
    via_targets = Counter(cleanup.get("via_keys") or ())
    if not segment_targets and not via_targets:
        return

    removed_segment_ids = set()
    for segment in pcb_data.segments:
        key = _segment_strip_key(segment, names)
        if segment_targets[key] > 0:
            segment_targets[key] -= 1
            removed_segment_ids.add(id(segment))
    removed_via_ids = set()
    for via in pcb_data.vias:
        key = _via_strip_key(via, names)
        if via_targets[key] > 0:
            via_targets[key] -= 1
            removed_via_ids.add(id(via))

    if removed_segment_ids:
        pcb_data.segments = [
            segment for segment in pcb_data.segments
            if id(segment) not in removed_segment_ids
        ]
    if removed_via_ids:
        pcb_data.vias = [
            via for via in pcb_data.vias if id(via) not in removed_via_ids
        ]
    for result in policy.get("results") or ():
        if removed_segment_ids and result.get("new_segments"):
            result["new_segments"] = [
                segment for segment in result["new_segments"]
                if id(segment) not in removed_segment_ids
            ]
        if removed_via_ids and result.get("new_vias"):
            result["new_vias"] = [
                via for via in result["new_vias"]
                if id(via) not in removed_via_ids
            ]


def _install_stack_plane_cleanup():
    """Extend KRT's native cycle-prune slot without adding a routing stage."""
    import cleanup_pipeline
    import pcb_modification

    original_prune = pcb_modification.prune_redundant_cycles
    original_cleanup = cleanup_pipeline.run_post_route_cleanup

    def prune_redundant_cycles(results, pcb_data, scope_net_ids=None,
                               clearance=0.1, keep_input_copper=False):
        removed, nets, original_segments = original_prune(
            results, pcb_data, scope_net_ids,
            clearance=clearance,
            keep_input_copper=keep_input_copper,
        )
        if not _CLEANUP_CONTEXT:
            return removed, nets, original_segments
        config, stats, routing_scope = _CLEANUP_CONTEXT[-1]
        try:
            stack_stats = _prune_stack_plane_redundancy(
                results, pcb_data, routing_scope, config,
            )
        except Exception as error:
            # Fail closed.  The custom pass commits only after a per-net final
            # check, so an unexpected failure cannot make routing less useful.
            print(f"Stack-plane cleanup skipped after internal error: {error}")
            stack_stats = {"segments": 0, "vias": 0, "nets": 0,
                           "length_mm": 0.0, "errors": 1}
        stats.update(stack_stats)
        return (removed + stack_stats.get("segments", 0),
                nets + stack_stats.get("nets", 0),
                original_segments)

    def run_post_route_cleanup(results, pcb_data, scope_net_ids, config,
                               *args, **kwargs):
        stats = {}
        _capture_stack_plane_policy(pcb_data, config, scope_net_ids, results)
        _CLEANUP_CONTEXT.append((config, stats, scope_net_ids))
        try:
            outcome = original_cleanup(
                results, pcb_data, scope_net_ids, config, *args, **kwargs,
            )
        finally:
            _CLEANUP_CONTEXT.pop()
        if stats:
            outcome.counts["stack_plane_segments_pruned"] = stats.get(
                "segments", 0,
            )
            outcome.counts["stack_plane_vias_pruned"] = stats.get("vias", 0)
            outcome.counts["stack_plane_length_pruned_mm"] = round(
                stats.get("length_mm", 0.0), 6,
            )
            outcome.counts["stack_plane_refill_seconds"] = round(
                stats.get("refill_seconds", 0.0), 6,
            )
        return outcome

    pcb_modification.prune_redundant_cycles = prune_redundant_cycles
    cleanup_pipeline.prune_redundant_cycles = prune_redundant_cycles
    cleanup_pipeline.run_post_route_cleanup = run_post_route_cleanup


_install_stack_plane_cleanup()


def _install_stack_plane_output_gate():
    """Clean each ordinary CLI route after its canonical output write."""
    import output_writer

    original_write = output_writer.write_routed_output

    def write_routed_output(*args, **kwargs):
        wrote = original_write(*args, **kwargs)
        policy = _STACK_PLANE_POLICY
        board_file = kwargs.get("output_file")
        if board_file is None and len(args) > 1:
            board_file = args[1]
        expected = policy.get("output_file") if policy else None
        eligible = bool(
            wrote and policy and expected and board_file
            and os.path.normcase(os.path.realpath(board_file))
            == os.path.normcase(os.path.realpath(expected))
            and os.path.isfile(board_file)
        )
        if eligible:
            try:
                fingerprint = _file_fingerprint(board_file)
                if fingerprint != policy.get("last_fingerprint"):
                    cleanup = _prune_stack_planes_in_file(board_file, policy)
                    _sync_file_cleanup(policy, cleanup)
                    policy["last_fingerprint"] = _file_fingerprint(board_file)
            except Exception as error:
                print(f"Stack-plane output cleanup skipped after internal "
                      f"error: {error}")
        return wrote

    output_writer.write_routed_output = write_routed_output


_install_stack_plane_output_gate()


def _install_stack_plane_file_gate():
    """Run the exact cleanup immediately before KRT's own final oracle.

    At this point the CLI board contains main routing *and* plane-finalize
    additions.  The following native oracle is already the authoritative
    exact-fill repair gate, so this hook neither adds a process nor changes
    partial-result acceptance.  GUI staging is intentionally excluded: a
    staged-file removal would need a separate live-board delta channel.
    """
    import kicad_oracle

    original_oracle = kicad_oracle.oracle_reconnect

    def oracle_reconnect(board_file, net_names, config, *args, **kwargs):
        policy = _STACK_PLANE_POLICY
        expected = policy.get("output_file") if policy else None
        names = set(net_names or ())
        eligible = bool(
            policy and expected and board_file
            and os.path.normcase(os.path.realpath(board_file))
            == os.path.normcase(os.path.realpath(expected))
            and names.intersection(policy["net_layers"])
            and os.path.isfile(board_file)
        )
        if eligible:
            try:
                fingerprint = _file_fingerprint(board_file)
                if fingerprint != policy.get("last_fingerprint"):
                    cleanup = _prune_stack_planes_in_file(board_file, policy)
                    _sync_file_cleanup(policy, cleanup)
                    policy["last_fingerprint"] = _file_fingerprint(board_file)
            except Exception as error:
                # The oracle still runs on the untouched/current board.  File
                # cleanup is transactional, so an exception before os.replace
                # cannot degrade the route or suppress a partial result.
                print(f"Stack-plane file cleanup skipped after internal "
                      f"error: {error}")
        return original_oracle(board_file, net_names, config, *args, **kwargs)

    kicad_oracle.oracle_reconnect = oracle_reconnect


_install_stack_plane_file_gate()


_EXPLICIT_DIFF_PAIRS_ENV = "COPILOT_ROUTER_DIFF_PAIRS"


def _parse_explicit_diff_pairs(raw: str):
    """Validate the host-owned exact P/N mapping passed to route_diff.py."""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"{_EXPLICIT_DIFF_PAIRS_ENV} must contain valid JSON: {error}"
        ) from error
    if not isinstance(parsed, list) or not parsed:
        raise RuntimeError(
            f"{_EXPLICIT_DIFF_PAIRS_ENV} must be a non-empty array of [P, N] pairs"
        )

    pairs = []
    owned = set()
    for index, item in enumerate(parsed):
        if not isinstance(item, list) or len(item) != 2:
            raise RuntimeError(
                f"{_EXPLICIT_DIFF_PAIRS_ENV}[{index}] must be [positive, negative]"
            )
        positive, negative = item
        if not isinstance(positive, str) or not positive.strip():
            raise RuntimeError(
                f"{_EXPLICIT_DIFF_PAIRS_ENV}[{index}][0] must be a non-empty string"
            )
        if not isinstance(negative, str) or not negative.strip():
            raise RuntimeError(
                f"{_EXPLICIT_DIFF_PAIRS_ENV}[{index}][1] must be a non-empty string"
            )
        if positive == negative:
            raise RuntimeError(
                f"{_EXPLICIT_DIFF_PAIRS_ENV}[{index}] must contain distinct nets"
            )
        duplicate = next((name for name in (positive, negative) if name in owned), None)
        if duplicate is not None:
            raise RuntimeError(
                f"{_EXPLICIT_DIFF_PAIRS_ENV} assigns net {duplicate!r} more than once"
            )
        owned.update((positive, negative))
        pairs.append((positive, negative))
    return pairs


def _install_explicit_diff_pairs():
    """Make the router DSL's exact pairs authoritative over KRT name inference.

    route_diff.py imports ``find_differential_pairs`` after this packaged patch
    is loaded.  The wrapper activates only for a call whose selected net names
    contain every explicit member, leaving secondary pattern queries and all
    ordinary KRT invocations on their upstream behavior.
    """
    explicit_pairs = list(_EXACT_SELECTOR_SCOPE.get("diffPairs", ()))
    source = _EXACT_SELECTORS_FILE_ENV
    if not explicit_pairs:
        raw = os.environ.get(_EXPLICIT_DIFF_PAIRS_ENV)
        if not raw:
            return
        explicit_pairs = _parse_explicit_diff_pairs(raw)
        source = _EXPLICIT_DIFF_PAIRS_ENV
    explicit_members = {name for pair in explicit_pairs for name in pair}
    import net_queries

    original = net_queries.find_differential_pairs

    def find_differential_pairs(pcb_data, patterns):
        selected = {str(pattern) for pattern in (patterns or [])}
        if not explicit_members.issubset(selected):
            return original(pcb_data, patterns)

        ids_by_name = {
            str(net.name): int(net_id)
            for net_id, net in pcb_data.nets.items()
            if net_id != 0 and getattr(net, "name", None)
        }
        missing = sorted(explicit_members.difference(ids_by_name))
        if missing:
            raise RuntimeError(
                "Explicit differential-pair nets are missing from the PCB: "
                + ", ".join(missing)
            )

        output = {}
        for index, (positive, negative) in enumerate(explicit_pairs, start=1):
            pair_name = f"COPILOT_EXPLICIT_{index}"
            output[pair_name] = DiffPairNet(
                base_name=pair_name,
                p_net_id=ids_by_name[positive],
                n_net_id=ids_by_name[negative],
                p_net_name=positive,
                n_net_name=negative,
            )
        print(
            f"Using {len(output)} explicit differential pair(s) from "
            f"{source}"
        )
        return output

    net_queries.find_differential_pairs = find_differential_pairs


def _install_qfn_pad_allowlist():
    """Keep QFN geometry intact while suppressing explicitly excluded pads.

    KRT's CLI can filter nets but not individual logical pads.  The router DSL
    needs both component- and pad-level fanout opt-outs, so the adapter passes a
    JSON allowlist.  Disabled pads retain their physical geometry for layout
    analysis and collision checks; only their copied net identity is cleared.
    """
    raw = os.environ.get("COPILOT_ROUTER_QFN_PAD_ALLOWLIST")
    if not raw:
        return
    import qfn_fanout

    parsed = json.loads(raw)
    allowlists = {
        str(component): {str(number) for number in numbers}
        for component, numbers in parsed.items()
        if isinstance(numbers, list)
    }
    original = qfn_fanout.generate_qfn_fanout

    def filtered(footprint, pcb_data, *args, **kwargs):
        allowed = allowlists.get(str(getattr(footprint, "reference", "")))
        if allowed is None:
            return original(footprint, pcb_data, *args, **kwargs)
        filtered_footprint = copy.copy(footprint)
        filtered_footprint.pads = []
        for source_pad in footprint.pads:
            pad = copy.copy(source_pad)
            if str(getattr(pad, "pad_number", "")) not in allowed:
                pad.net_id = 0
                pad.net_name = ""
            filtered_footprint.pads.append(pad)
        return original(filtered_footprint, pcb_data, *args, **kwargs)

    qfn_fanout.generate_qfn_fanout = filtered


_EXACT_SELECTORS_FILE_ENV = "COPILOT_ROUTER_EXACT_SELECTORS_FILE"
_EXACT_NET_SENTINEL = "__COPILOT_ROUTER_EXACT_NET_SCOPE_V1__"
_EXACT_RIP_SENTINEL = "__COPILOT_ROUTER_EXACT_RIP_SCOPE_V1__"


def _load_exact_selector_scope():
    path = os.environ.get(_EXACT_SELECTORS_FILE_ENV)
    if not path:
        return {}
    with open(path, "r", encoding="utf-8") as source:
        parsed = json.load(source)
    if not isinstance(parsed, dict) or parsed.get("schemaVersion") != 1:
        raise RuntimeError(
            f"{_EXACT_SELECTORS_FILE_ENV} must reference a version-1 JSON object"
        )
    output = {}
    for key in ("netSelection", "ripSelection", "ripAuthorization"):
        values = parsed.get(key, [])
        if not isinstance(values, list) or any(
                not isinstance(name, str) or not name.strip() for name in values):
            raise RuntimeError(
                f"{_EXACT_SELECTORS_FILE_ENV}.{key} must be an array of non-empty strings"
            )
        output[key] = tuple(dict.fromkeys(name.strip() for name in values))
    selected_names = set(output["netSelection"]) | set(output["ripSelection"])
    sentinels = {}
    for key, default in (("netSentinel", _EXACT_NET_SENTINEL),
                         ("ripSentinel", _EXACT_RIP_SENTINEL)):
        value = parsed.get(key, default)
        if not isinstance(value, str) or not value:
            raise RuntimeError(
                f"{_EXACT_SELECTORS_FILE_ENV}.{key} must be a non-empty string"
            )
        if value in selected_names:
            raise RuntimeError(
                f"{_EXACT_SELECTORS_FILE_ENV}.{key} collides with an exact raw net name"
            )
        sentinels[key] = value
    if sentinels["netSentinel"] == sentinels["ripSentinel"]:
        raise RuntimeError(
            f"{_EXACT_SELECTORS_FILE_ENV} must use distinct net and rip sentinels"
        )
    output.update(sentinels)
    selector_tokens = parsed.get("selectorTokens", [])
    if not isinstance(selector_tokens, list):
        raise RuntimeError(
            f"{_EXACT_SELECTORS_FILE_ENV}.selectorTokens must be an array of [token, name] pairs"
        )
    normalized_tokens = []
    owned_tokens = set()
    owned_token_names = set()
    for index, item in enumerate(selector_tokens):
        if (not isinstance(item, list) or len(item) != 2
                or not all(isinstance(value, str) and value for value in item)):
            raise RuntimeError(
                f"{_EXACT_SELECTORS_FILE_ENV}.selectorTokens[{index}] must be [non-empty token, non-empty name]"
            )
        token, name = item
        if name not in selected_names:
            raise RuntimeError(
                f"{_EXACT_SELECTORS_FILE_ENV}.selectorTokens[{index}] names a net outside the exact selection"
            )
        if token in selected_names:
            raise RuntimeError(
                f"{_EXACT_SELECTORS_FILE_ENV}.selectorTokens[{index}] collides with an exact raw net name"
            )
        if token in owned_tokens or name in owned_token_names:
            raise RuntimeError(
                f"{_EXACT_SELECTORS_FILE_ENV}.selectorTokens must assign one unique token per net"
            )
        owned_tokens.add(token)
        owned_token_names.add(name)
        normalized_tokens.append((token, name))
    if selected_names and owned_token_names != selected_names:
        missing = sorted(selected_names.difference(owned_token_names))
        raise RuntimeError(
            f"{_EXACT_SELECTORS_FILE_ENV}.selectorTokens is missing exact nets: "
            + ", ".join(missing)
        )
    output["selectorTokens"] = tuple(normalized_tokens)
    diff_pairs = parsed.get("diffPairs", [])
    if not isinstance(diff_pairs, list):
        raise RuntimeError(
            f"{_EXACT_SELECTORS_FILE_ENV}.diffPairs must be an array of [P, N] pairs"
        )
    normalized_pairs = []
    owned = set()
    for index, item in enumerate(diff_pairs):
        if not isinstance(item, list) or len(item) != 2:
            raise RuntimeError(
                f"{_EXACT_SELECTORS_FILE_ENV}.diffPairs[{index}] must be [positive, negative]"
            )
        positive, negative = item
        if not isinstance(positive, str) or not positive.strip():
            raise RuntimeError(
                f"{_EXACT_SELECTORS_FILE_ENV}.diffPairs[{index}][0] must be a non-empty string"
            )
        if not isinstance(negative, str) or not negative.strip():
            raise RuntimeError(
                f"{_EXACT_SELECTORS_FILE_ENV}.diffPairs[{index}][1] must be a non-empty string"
            )
        positive = positive.strip()
        negative = negative.strip()
        if positive == negative:
            raise RuntimeError(
                f"{_EXACT_SELECTORS_FILE_ENV}.diffPairs[{index}] must contain distinct nets"
            )
        duplicate = next((name for name in (positive, negative) if name in owned), None)
        if duplicate is not None:
            raise RuntimeError(
                f"{_EXACT_SELECTORS_FILE_ENV}.diffPairs assigns net {duplicate!r} more than once"
            )
        owned.update((positive, negative))
        normalized_pairs.append((positive, negative))
    output["diffPairs"] = tuple(normalized_pairs)
    return output


_EXACT_SELECTOR_SCOPE = _load_exact_selector_scope()


def _install_exact_rip_overrides():
    """Preserve exact override authority after host-side fnmatch escaping.

    KRT correctly treats CLI selectors as globs, while protected_nets uses a
    raw token without glob metacharacters as the deliberate permission to rip
    protected copper.  A literal KiCad name such as ``DATA[0]`` therefore must
    travel in two forms: escaped through the CLI selector and raw through this
    private, validated authorization channel.  KiCad-locked copper remains
    non-overridable in upstream filter_rippable_names.
    """
    authorized = set(_EXACT_SELECTOR_SCOPE.get("ripAuthorization", ()))
    # Keep developer-override compatibility without making normal invocations
    # pay Windows' environment-block cost for a JSON array of every net.
    raw = os.environ.get("COPILOT_ROUTER_EXACT_RIP_NETS")
    if raw:
        parsed = json.loads(raw)
        if not isinstance(parsed, list) or any(
                not isinstance(name, str) or not name.strip() for name in parsed):
            raise RuntimeError(
                "COPILOT_ROUTER_EXACT_RIP_NETS must be a JSON array of non-empty strings"
            )
        authorized.update(name.strip() for name in parsed)
    if not authorized:
        return
    import protected_nets
    original = protected_nets.exact_names

    def exact_names(patterns):
        return set(original(patterns)) | authorized

    protected_nets.exact_names = exact_names


def _exact_selector_pairs(key: str):
    raw = os.environ.get(key)
    if not raw:
        return []
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise RuntimeError(f"{key} must be a JSON array of [pattern, name] pairs")
    output = []
    for index, item in enumerate(parsed):
        if (not isinstance(item, list) or len(item) != 2
                or not all(isinstance(value, str) and value for value in item)):
            raise RuntimeError(f"{key}[{index}] must be [non-empty pattern, non-empty name]")
        output.append((item[0], item[1]))
    return output


def _literal_net_filter_pattern(name: str):
    pattern = name.replace("[", "[[]").replace("*", "[*]").replace("?", "[?]")
    if pattern.startswith("-"):
        pattern = "[-]" + pattern[1:]
    return "\\" + pattern if name.startswith("!") else pattern


def _exact_selector_map(names, sentinel, selector_tokens):
    mapping = {}

    def add(token, resolved):
        resolved = tuple(resolved)
        previous = mapping.get(token)
        if previous is not None and previous != resolved:
            raise RuntimeError(
                "Exact host selector token collision for " + repr(token)
            )
        mapping[token] = resolved

    names = tuple(dict.fromkeys(names))
    if names:
        add(sentinel, names)
    for name in names:
        # KRT passes raw names into recovery filters after expansion. CLI glob
        # spellings use collision-free opaque tokens from the sidecar instead
        # of sharing a namespace with legal raw KiCad names.
        add(name, (name,))
    for token, name in selector_tokens:
        if name in names:
            add(token, (name,))
    return mapping


def _install_exact_net_selection():
    """Make host-owned DSL net names exact, including hierarchical aliases.

    Upstream intentionally lets a bare ``SIG`` pattern also select
    ``/Sheet/SIG``.  That is convenient for the CLI but unsafe for an exact DSL
    and for targeted rip authorization. Calls made with the compact sentinel,
    encoded CLI tokens, or raw names returned by an earlier exact expansion
    are narrowed; every other native KRT query keeps its upstream
    wildcard/sheet-leaf semantics.
    """
    selector_tokens = _EXACT_SELECTOR_SCOPE.get("selectorTokens", ())
    net_selection = _EXACT_SELECTOR_SCOPE.get("netSelection", ())
    rip_selection = _EXACT_SELECTOR_SCOPE.get("ripSelection", ())
    net_sentinel = _EXACT_SELECTOR_SCOPE.get("netSentinel", _EXACT_NET_SENTINEL)
    rip_sentinel = _EXACT_SELECTOR_SCOPE.get("ripSentinel", _EXACT_RIP_SENTINEL)
    selectors = [
        _exact_selector_map(
            net_selection,
            net_sentinel,
            selector_tokens,
        ),
        _exact_selector_map(
            rip_selection,
            rip_sentinel,
            selector_tokens,
        ),
    ]
    owned_tokens = {token for token, _name in selector_tokens}
    if net_selection:
        owned_tokens.add(net_sentinel)
    if rip_selection:
        owned_tokens.add(rip_sentinel)
    # Legacy mappings remain accepted for developer invocations. Precompute
    # them once as token -> immutable exact-name tuple as well.
    for key in ("COPILOT_ROUTER_EXACT_NET_SELECTION",
                "COPILOT_ROUTER_EXACT_RIP_SELECTION"):
        pairs = _exact_selector_pairs(key)
        if pairs:
            mapping = {}
            for pattern, name in pairs:
                mapping[pattern] = (name,)
                mapping[name] = (name,)
                owned_tokens.add(pattern)
            selectors.append(mapping)
    selectors = [mapping for mapping in selectors if mapping]
    if not selectors:
        return

    # A host-owned token must have one meaning across every exact scope.  Do
    # this check before choosing a scope so a colliding legacy developer
    # mapping cannot silently win by list order.
    resolved_by_token = {}
    for mapping in selectors:
        for token, names in mapping.items():
            previous = resolved_by_token.get(token)
            if previous is not None and previous != names:
                raise RuntimeError(
                    "Exact host selector token collision for " + repr(token)
                )
            resolved_by_token[token] = names

    import net_queries
    original_expand = net_queries.expand_net_patterns
    original_matches = net_queries.matches_net_filter

    missing = object()
    resolve_cache = {}
    available_cache = {}

    def resolve(patterns):
        requested = tuple(patterns or ())
        if not requested:
            return None
        cached = resolve_cache.get(requested, missing)
        if cached is not missing:
            return cached
        for mapping in selectors:
            if all(pattern in mapping for pattern in requested):
                ordered = tuple(dict.fromkeys(
                    name for pattern in requested for name in mapping[pattern]
                ))
                result = (ordered, frozenset(ordered))
                resolve_cache[requested] = result
                return result
        resolve_cache[requested] = None
        return None

    def exact_or_native(patterns, context):
        exact = resolve(patterns)
        if exact is None and any(pattern in owned_tokens for pattern in (patterns or ())):
            raise RuntimeError(
                f"Exact host {context} selector mixes an owned token with "
                "patterns outside its exact scope"
            )
        return exact

    def available_names(pcb_data):
        key = id(pcb_data)
        cached = available_cache.get(key)
        if cached is not None and cached[0] is pcb_data:
            return cached[1]
        available = {
            str(net.name) for net in pcb_data.nets.values()
            if getattr(net, "name", None)
        }
        for pads in pcb_data.pads_by_net.values():
            available.update(
                str(pad.net_name) for pad in pads if getattr(pad, "net_name", None)
            )
        frozen = frozenset(available)
        available_cache[key] = (pcb_data, frozen)
        return frozen

    def expand_net_patterns(pcb_data, patterns, exclude_unconnected=True):
        exact = exact_or_native(patterns, "net")
        if exact is None:
            return original_expand(pcb_data, patterns, exclude_unconnected)
        ordered, exact_set = exact
        absent = sorted(exact_set.difference(available_names(pcb_data)))
        if absent:
            raise RuntimeError("Exact host net selector is absent from the PCB: " + ", ".join(absent))
        return list(ordered)

    def matches_net_filter(net_name, patterns):
        exact = exact_or_native(patterns, "net filter")
        return net_name in exact[1] if exact is not None else original_matches(net_name, patterns)

    net_queries.expand_net_patterns = expand_net_patterns
    net_queries.matches_net_filter = matches_net_filter

    # identify_power_nets() is an older KRT path that calls fnmatch directly
    # instead of matches_net_filter().  Without this companion, the host's
    # opaque exact tokens match no board net: --power-nets is present in the
    # invocation, POUR-LAUNCH still notices zone nets independently, but
    # config.power_net_widths stays empty and every downstream power policy is
    # silently disabled.
    original_identify_power_nets = net_queries.identify_power_nets

    def identify_power_nets(pcb_data, patterns, widths):
        exact = exact_or_native(patterns, "power-net")
        if exact is None:
            return original_identify_power_nets(pcb_data, patterns, widths)
        if len(patterns) != len(widths):
            raise ValueError(
                f"patterns ({len(patterns)}) and widths ({len(widths)}) "
                "must have same length"
            )
        by_name = {
            str(net.name): net_id
            for net_id, net in pcb_data.nets.items()
            if getattr(net, "name", None) and net_id != 0
        }
        output = {}
        for pattern, width in zip(patterns, widths):
            for name in resolved_by_token[pattern]:
                net_id = by_name.get(name)
                if net_id is not None and net_id not in output:
                    output[net_id] = width
        return output

    net_queries.identify_power_nets = identify_power_nets
    route_module = sys.modules.get("route")
    if route_module is not None and hasattr(route_module, "identify_power_nets"):
        route_module.identify_power_nets = identify_power_nets

    # Length matching has its own glob matcher and routing_common imports it
    # into a module-local alias.  Resolve the same opaque selector tokens here
    # so names containing glob syntax (for example DATA[0]) remain literal.
    import length_matching
    original_length_match_finder = length_matching.find_nets_matching_patterns

    def find_nets_matching_patterns(all_net_names, patterns):
        exact = exact_or_native(patterns, "length-match")
        if exact is None:
            return original_length_match_finder(all_net_names, patterns)
        ordered, exact_set = exact
        available = frozenset(str(name) for name in all_net_names)
        absent = sorted(exact_set.difference(available))
        if absent:
            raise RuntimeError(
                "Exact host length-match selector is absent from routed nets: "
                + ", ".join(absent)
            )
        return list(ordered)

    length_matching.find_nets_matching_patterns = find_nets_matching_patterns
    # Rebind aliases in modules that may have imported the original before
    # this patch. Modules imported later receive the patched attribute from
    # length_matching normally.
    for module_name in ("routing_common", "route"):
        module = sys.modules.get(module_name)
        if module is not None and hasattr(module, "find_nets_matching_patterns"):
            module.find_nets_matching_patterns = find_nets_matching_patterns


_install_exact_net_selection()
_install_exact_rip_overrides()
_install_explicit_diff_pairs()
_install_qfn_pad_allowlist()
