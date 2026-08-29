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
