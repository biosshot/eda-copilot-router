# @easyeda-copilot/router

EDA-neutral PCB routing core. Hosts convert KiCad, EasyEDA, or DSN into one
`RoutingBoard`, call `run(...)`, then transactionally apply `RoutingResult` and
perform native refill/DRC.

The package does not expose EasyEDA `RawPcb`, a full EDA snapshot, or a generic
PCB patch. The result contains the complete replacement state of router-owned
editable tracks, vias, and zones.

```js
import { run } from "@easyeda-copilot/router"

const result = await run({
  board,
  backend,
  dsl: `
    powerNet("VBUS", { maxCurrentA: 2, maxTempRiseC: 16 })
    polygon("VBUS")
      .connect(pad("U1", 8), pad("Q1", 1))
      .on(topLayer())
      .compact()
    runAll()
  `,
})
```

`applyDrcRules()`, `runRouting()`, and `runAll()` are terminal DSL commands and
return no values. Only `run(...)` returns `RoutingResult`.

The CLI accepts EDA-neutral JSON plus DSL source:

```text
copilot-router validate board.json --dsl routing.dsl.js
copilot-router run board.json --dsl routing.dsl.js --backend ./backend.js -o result.json
copilot-router doctor
```
