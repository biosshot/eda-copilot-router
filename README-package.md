# eda-copilot-router

EDA-neutral PCB routing contracts, DSL compiler, polygon/plane planning, and a
single KRT backend.

A host can convert its native board into `RoutingBoard`, call `run(...)`, and
apply `RoutingResult` using native refill and DRC. Native editor structures are
not part of the core contract. A built-in KiCad file adapter is also exported
for standalone use.

```js
import { run } from "eda-copilot-router"

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

Python is also zero-setup. The package first reuses a compatible Python 3.9+
interpreter. If none is available—or the local interpreter cannot prepare the
KRT environment—it downloads pinned portable CPython 3.12 into the same private
router cache. KRT dependencies come from the managed release's
`requirements.txt` and are installed with `pip --target` into a versioned cache;
nothing is installed globally and the machine's `PATH` is not changed.

The CLI accepts EDA-neutral JSON plus DSL source, or a native KiCad board:

```text
copilot-router validate board.json --dsl routing.dsl.js
copilot-router run board.json --dsl routing.dsl.js -o result.json
copilot-router route board.kicad_pcb --dsl routing.dsl.js -o routed.kicad_pcb
copilot-router doctor
```

`route` does not require KiCad or `kicad-cli`. Native zone refill and final DRC
are deliberately left to an installed host/native verification stage.

`stack(...)` changes the effective physical board used by the same routing
call. Use `applyStackup()` for a stack-only operation or `runCopper()` to emit
zone outlines without invoking KRT.
