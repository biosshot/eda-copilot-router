"""Make native KiCad filled copper a net-aware KRT obstacle.

KRT 0.20.2 parses zone outlines for connectivity, but its ordinary maze map
does not stamp the actual ``filled_polygon`` copper.  This packaged patch uses
the already-refilled board written by the host and augments KRT's existing
per-net obstacle caches.  The cache for the net currently being routed is
removed by KRT in the normal way, so a zone remains conductive for its owner
without becoming hundreds of fake track terminals.
"""

from __future__ import annotations

import os
import re
from typing import Dict, List, Tuple

import numpy as np

import kicad_exact_fill
import obstacle_cache
import obstacle_map
from routing_config import GridCoord
from routing_utils import build_layer_map


_ORIGINAL_BUILD_BASE = obstacle_map.build_base_obstacle_map
_ORIGINAL_PRECOMPUTE = obstacle_cache.precompute_net_obstacles
_CACHE_ATTRIBUTE = "_copilot_router_exact_filled_copper"
_ROUTER_PLANE_PREFIX = "copilot-router:plane:"
_ZONE_NAME_RE = re.compile(r'\(name\s+"((?:[^"\\]|\\.)*)"\)')


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
