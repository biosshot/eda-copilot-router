# eda-copilot-router

EDA-neutral routing core with KiCad Routing Tools (KRT), a bundled EasyEDA WASM
router, and a production Hybrid strategy. The package compiles the local
routing DSL into effective design rules, plans compact polygons/planes, runs
the selected strategy, and returns portable copper geometry.

EasyEDA and KiCad hosts may keep using the EDA-neutral `RoutingBoard` /
`RoutingResult` boundary. The package also includes a standalone KiCad file
adapter and CLI; neither KRT routing path requires installed KiCad.

KRT remains the default for `run()` and the KiCad CLI. EasyEDA hosts can select
Hybrid: on boards with at most two copper layers it sends constrained nets to
the unchanged KRT backend and ordinary remaining nets to EasyEDA WASM. On
multilayer boards it delegates the original request to KRT. There is no
caller-selected quality profile or candidate-count tuning surface.

## Public surface

- `eda-copilot-router` — `run(...)`, board/result contracts and validation.
- `eda-copilot-router/dsl` — DSL compiler and preflight.
- `eda-copilot-router/backends/hybrid` — KRT/EasyEDA scope orchestration and fallback.
- `eda-copilot-router/backends/easyeda-wasm` — bundled ordinary-net router.
- `eda-copilot-router/backends/krt` — KRT leaf backend.
- `eda-copilot-router/backends/assets` — managed KRT asset support.
- `eda-copilot-router/adapters/kicad` — standalone KiCad import/apply.
- `eda-copilot-router/schema` and `/core` — portable contracts/schema.

```js
import { createHybridBackend, run } from "eda-copilot-router"

const backend = createHybridBackend({
  krt: {
    artifactsDirectory: "results/krt",
    // pythonPath: "/explicit/python", // optional; COPILOT_ROUTER_PYTHON also works
  },
})

const result = await run({
  board,
  backend,
  dsl: `
    drc({
      minTrackWidthMm: 0.127,
      trackWidthMm: 0.254,
      via: {
        minDiameterMm: 0.6,
        diameterMm: 0.6,
        minDrillMm: 0.3,
        drillMm: 0.3,
      },
    })
    runAll()
  `,
})
```

Or route a native KiCad board directly:

```text
copilot-router route board.kicad_pcb --dsl routing.dsl.js -o routed.kicad_pcb
```

This writes a new board and never overwrites the input. Without KiCad, zone
outlines are preserved and the result is marked for later native refill/DRC by
the host. `--python` selects KRT's Python interpreter; normal discovery already
checks `COPILOT_ROUTER_PYTHON`, standard KiCad Python locations, `python3`, and
`python`. When none is usable, the package downloads a pinned portable CPython
into its private cache. KRT dependencies are installed from the managed
release's `requirements.txt` into a separate `pip --target` cache, never into a
global Python environment.

`stack(...)` materializes the effective physical layer table before routing
and is returned for transactional host application. `applyStackup()` applies
only that stack, while `runCopper()` plans polygon/plane zone outlines without
starting KRT. The KiCad adapter treats unlocked tracks, vias, and zones as
editable by default; native locked copper remains fixed.

`trackWidthMm` and `via.diameterMm` / `via.drillMm` are nominal geometry.
Their `min*` counterparts are hard manufacturing/DRC limits and also bound
neck-down geometry.

## Development

```text
npm ci
npm test
npm run e2e:no-kicad:polygon
npm run e2e:no-kicad:packed
npm run test:e2e:krt-corpus:contract
npm run e2e:interf_u_unrouted
```

GitHub Actions keeps separate checks for the package/adapter contract, portable
routing without KRT or Python, polygon planning on real boards without KRT or
KiCad, and managed-KRT routing from an installed npm tarball without KiCad or a
local KRT checkout.

Native E2E runners use the adapter built in this package. Generated artifacts
are written only under this repository's ignored `results/` directory.

KRT `v0.21.3` is downloaded lazily, verified by SHA-256, patched from
`assets/krt-patches`, and cached per user. `COPILOT_ROUTER_KRT_DIR` is an
optional explicit development/air-gapped override.

Architecture details are in [`docs/architecture`](docs/architecture), and the
DSL declarations are in [`docs/routing-dsl.d.ts`](docs/routing-dsl.d.ts).
Release tags and npm Trusted Publishing are described in
[`docs/releasing.md`](docs/releasing.md).
