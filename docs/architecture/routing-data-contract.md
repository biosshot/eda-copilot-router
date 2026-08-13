# Routing data contract

Status: accepted direction
Date: 2026-08-13

## Boundary

- EasyEDA `RawPcb` remains internal to EasyEDA.
- EasyEDA `BoardAssemble` remains unchanged.
- KiCad keeps its native S-expression AST outside the router core.
- DSN is the preferred standard interchange format and Freerouting transport.
- The router parses/imports external data into one internal `RoutingBoard`.
- The router returns `RoutingResult`; it never returns a rebuilt native board.

DSN is not the internal object model. KRT does not consume DSN, EasyEDA WASM
does not consume DSN, and polygon planning needs efficient typed geometry.
Backend adapters may serialize `RoutingBoard` to DSN, temporary KiCad, or
another engine-specific format.

## Units and coordinates

All public routing geometry uses millimetres. The internal convention is X to
the right, Y down, and clockwise degrees. Importers perform any required DSN or
native coordinate conversion exactly once.

No `version`, `schema`, `V1`, or `V2` fields are part of these structures before
the first public release.

## Core types

The exact TypeScript spelling may change during implementation, but the
ownership and semantic fields below are fixed.

```ts
interface RoutingBoard {
  outline: PointMm[]
  cutouts: PointMm[][]
  layers: RoutingLayer[]
  nets: RoutingNet[]
  pads: RoutingPad[]
  keepouts: RoutingKeepout[]
  stackup?: RoutingStackup
  rules: RoutingRules
  copper: {
    fixed: RoutingCopper
    editable: RoutingCopper
  }
}

interface RoutingCopper {
  tracks: RoutedTrack[]
  vias: RoutedVia[]
  zones: RoutedZone[]
}

interface RoutingResult {
  status: "complete" | "partial" | "error"
  operation: "apply-drc" | "route" | "all"
  rules: {
    effective: RoutingRules
    applyRequested: boolean
    overriddenFields: RoutingRuleOverride[]
  }
  copper?: RoutingCopper
  diagnostics: Diagnostic[]
  metrics: RoutingMetrics
}
```

`RoutingBoard` is routing-relevant data, not a lossless EDA document. It does
not contain schematic symbols, library links, silkscreen, 3D models, editor UI
state, or arbitrary native metadata. Pads retain component designator and pad
number so the DSL can use `pad("U1", 8)`. Optional component bounds may be added
only when a routing feature such as `components(...)` regions needs them.

`RoutedTrack` is a width plus a polyline on one copper layer. `RoutedVia`
contains position, finished geometry, and layer span. `RoutedZone` is a native
copper-zone intent: net, layer set, outline, priority, and connection settings.
It is not an editor-specific filled-polygon cache. Exact fill belongs to the
target EDA.

## Copper ownership

Input `fixed` copper is immutable. It may be used as an obstacle and electrical
connection but must be returned unchanged by every backend.

Input `editable` copper is owned by the current routing invocation and may be
ripped up or replaced. `RoutingResult.copper` is the complete final state of
that editable/router-owned copper, not an append-only list and not a full PCB.
This lets completion and blocker repair reroute earlier generated copper without
requiring a general-purpose PCB patch format.

`RoutingResult.copper` is present only when the DSL selected `runRouting()` or
`runAll()`. An `applyDrcRules()`-only operation does not execute polygon or
routing backends and therefore does not produce replacement copper.

The host applies a result transactionally by replacing only router-owned copper
and preserving native objects outside that ownership. If a host wants existing
native routes to become editable, it deliberately places them in the editable
input set instead of the fixed set.

## Rules

`RoutingRules` contains normalized source rules imported from DSN or supplied
by a native adapter. The local router DSL may express semantic electrical
requirements, absolute geometry values, or both. The compiler derives geometry
from semantic requirements, combines it with compatible absolute constraints,
and produces one effective rule set for every backend.

The result always reports the effective rules and which fields differ from the
source. `rules.applyRequested` is true only for `applyDrcRules()` and
`runAll()`. It tells the host to persist those effective fields; the DSL command
itself does not return or directly mutate an EDA document. See
[`drc-rule-precedence.md`](./drc-rule-precedence.md).

## Validation ownership

The core reports rule compilation, routing completion, and portable geometry
diagnostics. Final native validity belongs to the host. Depending on the
selected operation, the host first persists requested effective rules, then
replaces router-owned copper when present, refills zones, and runs native
DRC/connectivity checks.
