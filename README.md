# @easyeda-copilot/router

EDA-neutral routing core with one production backend: KiCad Routing Tools
(KRT). The package compiles the local routing DSL into effective design rules,
plans compact polygons/planes, runs KRT, and returns portable copper geometry.

Native KiCad file import, project-rule persistence, refill, DRC, and atomic
application belong to a separate host adapter. This repository neither edits
nor builds that host project.

## Public surface

- `@easyeda-copilot/router` — `run(...)`, board/result contracts and validation.
- `@easyeda-copilot/router/dsl` — DSL compiler and preflight.
- `@easyeda-copilot/router/backends/krt` — the only routing backend.
- `@easyeda-copilot/router/backends/assets` — managed KRT asset support.
- `@easyeda-copilot/router/schema` and `/core` — portable contracts/schema.

```js
import { createKrtBackend, run } from "@easyeda-copilot/router"

const backend = createKrtBackend({
  transport, // supplied by the native EDA host
  artifactsDirectory: "results/krt",
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

`trackWidthMm` and `via.diameterMm` / `via.drillMm` are nominal geometry.
Their `min*` counterparts are hard manufacturing/DRC limits and also bound
neck-down geometry.

## Development

```text
npm ci
npm test
npm run test:e2e:krt-corpus:contract
npm run e2e:interf_u_unrouted
```

E2E runners use a prebuilt native host adapter but never build or modify its
repository. Generated artifacts are written only under this repository's
ignored `results/` directory.

KRT `v0.20.4` is downloaded lazily, verified by SHA-256, patched from
`assets/krt-patches`, and cached per user. `COPILOT_ROUTER_KRT_DIR` is an
optional explicit development/air-gapped override.

Architecture details are in [`docs/architecture`](docs/architecture), and the
DSL declarations are in [`docs/routing-dsl.d.ts`](docs/routing-dsl.d.ts).
