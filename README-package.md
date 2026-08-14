# @easyeda-copilot/router

EDA-neutral PCB routing core. Hosts convert KiCad, EasyEDA, or DSN into one
`RoutingBoard`, call `run(...)`, then transactionally apply `RoutingResult` and
perform native refill/DRC.

The package does not expose EasyEDA `RawPcb`, a full EDA snapshot, or a generic
PCB patch. The result contains the complete replacement state of router-owned
editable tracks, vias, and zones.

```js
import { run } from "@easyeda-copilot/router"
import { createEasyEdaWasmBackend } from "@easyeda-copilot/router/backends/easyeda-wasm"

const result = await run({
  board,
  backend,
  signal: abortController.signal,
  policy: { profile: "balanced", maxCandidates: 2 },
  dsl: `
    powerNet("VBUS", { maxCurrentA: 2, maxTempRiseC: 16 })
    polygon("VBUS")
      .connect(pad("U1", 8), pad("Q1", 1))
      .on(topLayer())
      .maxPadFreeGapWidths(4.5)
      .compact()
    runAll()
  `,
})
```

Quality profiles form an internal cascade. For example, `balanced` tries
`fast` and then `balanced`, stopping early when a candidate has no open nets.
There are no internal routing deadlines: a profile runs to completion and the
host may cancel the whole operation through `AbortSignal`.

KRT is the default complete-routing backend for the KiCad host integration.
It does not require a separately cloned checkout: on first use the package
downloads the pinned official KRT release, verifies its SHA-256, prepares its
platform module and Python dependencies in the user cache, and reuses that
cache offline. `COPILOT_ROUTER_KRT_DIR` is only an optional development
override. Freerouting uses the same managed-asset policy for its pinned JAR.

The EasyEDA WASM backend is still EDA-neutral: the EasyEDA host integration
bundles and injects its local engine. End users are not asked for worker/WASM
paths. The public MIT package does not redistribute those proprietary assets;
direct package consumers may inject an engine they are licensed to use.

```js
const backend = createEasyEdaWasmBackend({
  engine: async (input, context) => localRouter(input, context),
})
```

The stock WASM input has no native filled-zone obstacle primitive. The adapter
therefore materializes fixed zones as a temporary same-net copper mesh while
routing. That mesh is never returned or written to the EDA; native refill is
still authoritative. Plane zones remain simpler because the core creates them
after routing.

`applyDrcRules()`, `runRouting()`, and `runAll()` are terminal DSL commands and
return no values. Only `run(...)` returns `RoutingResult`.

For `powerNet(...)`, current and temperature limits calculate the preferred
trunk width. Short neck-downs, especially fine-pitch pad escapes, remain
allowed down to the fixed `0.127 mm` hard floor; the backend must not replace
the preferred width of the rest of the route with that floor.

The CLI accepts EDA-neutral JSON plus DSL source:

```text
copilot-router validate board.json --dsl routing.dsl.js
copilot-router run board.json --dsl routing.dsl.js --backend ./backend.js -o result.json
copilot-router doctor
```
