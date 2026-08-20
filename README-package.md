# @easyeda-copilot/router

EDA-neutral PCB routing contracts, DSL compiler, polygon/plane planning, and a
single KRT backend.

The host converts its native board into `RoutingBoard`, calls `run(...)`, and
applies `RoutingResult` using native refill and DRC. Native editor structures
are not part of the package API.

```js
import { run } from "@easyeda-copilot/router"

const result = await run({
  board,
  signal: abortController.signal,
  policy: { profile: "balanced", maxCandidates: 1 },
  dsl: `
    powerNet("VBUS", { maxCurrentA: 2 })
    runAll()
  `,
})
```

The package lazily prepares pinned KRT `v0.20.4`; no manual checkout is
required. Downloads are integrity-checked and cached. The optional
`COPILOT_ROUTER_KRT_DIR` override is intended for development or air-gapped
installations.

The CLI accepts EDA-neutral JSON plus DSL source:

```text
copilot-router validate board.json --dsl routing.dsl.js
copilot-router run board.json --dsl routing.dsl.js -o result.json
copilot-router doctor
```
