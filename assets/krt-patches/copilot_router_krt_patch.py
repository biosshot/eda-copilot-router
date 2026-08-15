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
import math
import copy
from typing import Dict, List, Tuple

import numpy as np

import kicad_exact_fill
import obstacle_cache
import obstacle_map
import single_ended_routing
from routing_config import GridCoord
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
    import json
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


_install_qfn_pad_allowlist()
