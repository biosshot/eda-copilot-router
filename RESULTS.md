# Fixed-placement routing strategy results

The source placement is unchanged in every candidate: 34 footprints, zero coordinate/layer mismatches. Existing routing (677 primitives) and two zones were removed before every run. GND was never routed.

All exact-width tests used the same KiCad rules: Default 0.25 mm, Power 0.30 mm, USB data 0.20 mm, 0.20 mm clearance plus a 0.025 mm router margin.

## Results

| Differential pairs | Strategy | Completed non-GND nets | Routing time | Peak RSS | Shorts | Clearance | Width | Skew |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| on | one-shot baseline | **15/27** | 324.3 s | 347.4 MB | 0 | 5 | 0 | 1 |
| on | block-local-first | 9/27 | 192.7 s | 350.4 MB | 0 | 5 | 0 | 0 |
| on | skeleton-first, before repair | 13/27 | ~338 s | n/a | 0 | 5 | 0 | 0 |
| off | one-shot baseline | **14/27** | 194.0 s | 347.6 MB | 0 | 6 | 0 | 2 |
| off | block-local-first | 9/27 | 205.3 s | 348.3 MB | 0 | **4** | 0 | 0 |
| off | skeleton-first + bounded repair | 12/27 | 162.0 s + 60 s timed-out repair | 345.5 MB | 0 | 7 | 0 | 1 |

The diff-on skeleton repair timed out after 360 seconds at 80%. The diff-off repair timed out after 60 seconds. In both cases the pre-repair candidate was retained.

## Interpretation

Full independent block routing is a poor fit for this board. U1 touches 23 of the 27 non-GND nets, so the USB-C, USB-A1, USB-A2, battery, and converter blocks all compete for the same U1 pad-ring escape space. Earlier block passes become immutable obstacles for later passes in the current EasyEDA adapter.

The useful part of block routing is local escape generation, not completing every block in isolation. A better next experiment is:

1. Generate only short DRC-clean escape stubs around U1 and connectors (roughly 0.8–1.5 mm).
2. Run one global route with every non-GND net still visible.
3. Try several net orderings / escape-direction seeds.
4. Select the candidate lexicographically by missing nets, shorts, clearance, width/skew, vias, and length.
5. Repair one failed net plus at most one blocker at a time; never reroute a 15–18-net repair set.

This preserves schematic-block knowledge without freezing complete local routes before the global router sees the board.

## Evidence

- Per-run `summary.json` and KiCad DRC JSON files are stored under `results/`.
- The diff-on skeleton pre-repair DRC is `results/skeleton-first-repair/90-before-repair-drc.json`.
- `scripts/check_placement.py` independently compares footprint positions and layers.
- `routing.svg` / `routing.png` files render the actual F.Cu/B.Cu segments and vias from each candidate PCB.

Trust level: high. Metrics are deterministic extractions from EasyEDA result JSON, KiCad 10 DRC JSON, and KiCad PCB S-expressions. The only approximate metric is diff-on skeleton routing time because the process ended during repair before writing its final summary.
