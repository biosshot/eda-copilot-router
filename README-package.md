# @easyeda-copilot/router

An EDA-neutral PCB routing package. An editor adapter captures one normalized
`PcbSnapshotV1`, the routing core works only with JSON-compatible data, and the
adapter applies one `PcbPatchV1` afterwards. KiCad, EasyEDA and backend
processes are therefore replaceable boundaries rather than core dependencies.

## Local installation

Use a local file dependency while developing the copilots:

```json
{
  "dependencies": {
    "@easyeda-copilot/router": "file:../copilot-router"
  }
}
```

From `kicad-copilot` use `file:../copilot-router`; from
`easyeda-copilot/mcp` use `file:../../copilot-router`. For a reproducible CI or
release check, build a tarball with `npm pack` and install that `.tgz` instead.
The package has no postinstall hook and does not download router engines.

## Library API

```ts
import { routePcb } from "@easyeda-copilot/router"
import {
  routing, polygon, pad, topLayer, diffPair,
} from "@easyeda-copilot/router/dsl"

const intent = routing({
  copper: [
    polygon("vsys-local", "VSYS")
      .connect(pad("U1", 8), pad("L1", 2))
      .on(topLayer()),
  ],
  special: [diffPair("usb-device", "USB_DP", "USB_DM")],
})

const result = await routePcb({ snapshot, intent, backend })
// Host adapter applies result.patch once, then runs native refill/DRC.
```

`intent` contains electrical/design requirements only. Backend choice,
executable paths, timeouts and search profiles are runtime policy and stay out
of the portable document.

## Adapter lifecycle

1. The EasyEDA or KiCad host captures a complete normalized snapshot.
2. The package routes without calling an EDA.
3. The host applies the patch transactionally.
4. The host performs native refill and DRC. Only this step can declare the
   native board valid.

Adapter authors implement `BoardFormatAdapter` from
`@easyeda-copilot/router/adapters/contracts`. Router engines implement
`RouterBackendAdapter` from the same entrypoint. Native adapter code belongs in
the consuming copilot (or a separately versioned adapter package), so the core
does not acquire unstable editor/runtime dependencies.

## CLI

The CLI is intentionally a thin JSON harness:

```powershell
copilot-router validate snapshot.json --intent intent.json
copilot-router route snapshot.json --intent intent.json `
  --backend ./my-backend.js --output result.json
copilot-router doctor --backend ./my-backend.js
```

A backend module exports a `RouterBackendAdapter` as `default` or `backend`.
The CLI does not launch or contact an EDA and has no hardcoded project paths.

## Packaging checks

```powershell
npm run build:package
npm run test:package
npm pack --dry-run
```
