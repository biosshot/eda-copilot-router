# Fixed-placement staged autorouter benchmark

The backend-independent routing architecture and its fail-fast invariants are
recorded in [`docs/architecture/router-backend-boundaries.md`](docs/architecture/router-backend-boundaries.md).

This benchmark keeps every KiCad footprint at its existing position and compares three EasyEDA WASM routing strategies:

1. `baseline`: all non-GND nets in one pass.
2. `block-local-first`: local IP5328P/USB port blocks first, shared power trunks last.
3. `skeleton-first-repair`: USB pairs and shared power trunks first, remaining local nets second, then up to two blocker-aware rip-up/repair attempts.

All variants:

- remove existing tracks, vias, arcs, and zones from a cloned board;
- never route GND;
- use the same KiCad DRC/netclass rules;
- route with final track widths instead of widening thin tracks after routing;
- enable the same differential-pair mapping;
- preserve the original component placement;
- write boards, router JSON, KiCad DRC JSON, timing, and memory metrics under `results/`.

Run:

```powershell
npm run build
npm test
```

Environment overrides:

- `COPILOT_ROUTER_BOARD`
- `COPILOT_ROUTER_RULES_BOARD`
- `COPILOT_ROUTER_TIMEOUT_MS`
- `COPILOT_ROUTER_REPAIR_TIMEOUT_MS` (default: 90 seconds per repair attempt)
- `COPILOT_ROUTER_CLEARANCE_MARGIN_MM`
- `COPILOT_ROUTER_DIFF_PAIRS=0` to disable differential-pair routing for an isolation test.
- `COPILOT_ROUTER_RESULT_SET` to keep isolation runs in a separate results subdirectory.

## Local native-zone planner MVP

The planner is local to this package and consumes the existing universal
`RawPcb` contract. KiCad and EasyEDA are backend adapters; their native zone
fillers remain responsible for exact pad avoidance, DRC clearance, thermal
spokes, clipping, and island removal.

The LLM-facing DSL only names the copper net and the pads that should be joined.
It never supplies polygon points, absolute bounds, clearance, or refill settings:

```js
polygon("VSYS")
  .connect(pad("U1", 8), pad("L1", 2))
  .on(topLayer())
  .compact()

polygon("GND")
  .connect(net("GND"))
  .on(outerLayers())
  .plane()
  .priority(1)
```

`compact()` derives point-like pad heads joined by obstacle-aware 0/45/90-degree
corridors and is rejected when its candidate area exceeds 10% of the board.
Boundary complexity has no point-count limit: the cleanup removes only short
spikes/slivers and redundant collinear points, so a dense multi-pad net remains
one useful contour instead of falling back to disconnected rectangles. Corridor
width and obstacle inflation come from the target EDA's track-width/clearance
rules; dense endpoint pins use a short directional taper before routing around a
foreign neighbour.
Free corridor segments are then widened independently, up to a relative compact
cap and the nearest foreign-pad obstacle. The search keeps half of one useful
routing corridor in reserve, so a local pinch narrows only its own segment rather
than throttling the whole connection. Pad-envelope throats and body widths are
joined by exact 45-degree flares; short-step cleanup removes parallel teeth while
preserving the mandatory pad/corridor core. Metrics expose both
`corridorWidthMinMm` and `corridorBodyWidthMaxMm`.
After unioning pads and corridors, a DRC-derived morphological closing fills
only narrow concave dead-end pockets. It does not apply global padding or grow
the outer envelope, so otherwise unusable slots become useful power copper
without consuming a through-routing channel. Metrics expose the chosen
`pocketClosingRadiusMm` and resulting `filledPocketAreaMm2`.
Foreign-pad keepouts are deliberately not cut into this rough outline: such
subtractions created serrated 0.002-0.07 mm edges. KiCad/EasyEDA performs exact
clearance clipping during native refill, followed by the post-refill connectivity
validator.
The default maximum pad-free span is 4.5 widths of the narrower target pad;
`.maxPadFreeGap(...)` overrides it per rule. Explicit `pad(...)` targets are
mandatory: an impossible compact connection is reported as a plan error while
the rest of the program continues. Only an explicit `plane()` permits a
board-scale outline. Touching same-net plans are unioned before native-zone
export. The adapter reads physical values from the target EDA's design rules
when it creates the native zone.

Build and run the Powerbank smoke test:

```powershell
npm run build
npm run test:poly
npm run test:poly:dsl
```

The test keeps the source board untouched. It writes derived
`Powerbank.poly-clean.kicad_pcb` and `Powerbank.poly-generated.kicad_pcb`
boards beside the source, and JSON/SVG/metrics under `results/poly-engine/`.
Run KiCad's native refill and DRC on the generated board with:

```powershell
kicad-cli pcb drc --format json --severity-all --refill-zones --save-board `
  --output results/poly-engine/generated-drc.json `
  D:\MyProject\kicad\Powerbank\Powerbank.poly-generated.kicad_pcb

npm run test:poly:fill
```

The post-refill test verifies connectivity against KiCad's actual filled copper.
If refill clips a corridor into islands, validation returns an error with the
target-pad copper groups and continues without crashing.
