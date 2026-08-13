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

The EasyEDA WASM backend is still EDA-neutral: the host supplies the local
engine function or explicit worker/WASM asset paths. The package never opens
EasyEDA and does not download or bundle proprietary router assets.

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

The CLI accepts EDA-neutral JSON plus DSL source:

```text
copilot-router validate board.json --dsl routing.dsl.js
copilot-router run board.json --dsl routing.dsl.js --backend ./backend.js -o result.json
copilot-router doctor
```
