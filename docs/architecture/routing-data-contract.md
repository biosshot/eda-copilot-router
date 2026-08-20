# Routing data contract

Status: accepted direction
Date: 2026-08-13

## Boundary

- KiCad keeps its native S-expression AST outside the router core.
- Native document formats remain outside the routing core. Optional file
  adapters may live in this package without changing the core contract.
- The host imports external data into one internal `RoutingBoard`.
- The router returns `RoutingResult`; it never returns a rebuilt native board.

An interchange format is not the internal object model. The router-owned KRT
codec materializes a temporary board directly from `RoutingBoard`; hosts do not
provide a transport or codec override.

The compact-polygon implementation uses a private `PolygonScene` geometry view
to keep Clipper algorithms independent of the full board contract. It is not an
exchange format, is not exported by the package, and is constructed only at an
adapter/call boundary.

## Units and coordinates

All public routing geometry uses millimetres. The internal convention is X to
the right, Y down, and clockwise degrees. Importers perform any required DSN or
native coordinate conversion exactly once.

No `version`, `schema`, `V1`, or `V2` fields are part of these structures before
the first public release.

Physical copper layers use stable names selected by the board adapter and used
consistently throughout one `RoutingBoard`. The built-in KiCad adapter retains
`F.Cu`, `In1.Cu`, and `B.Cu`; an EasyEDA adapter may use its own stable names.
`RoutingLayer.index` carries physical ordering.

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
copper-zone intent: net, layer set, outline, compiler-assigned priority, and
connection settings. Zone priority is an internal deterministic output detail,
not a router DSL field. `RoutedZone` is not an editor-specific filled-polygon
cache. Exact fill belongs to the target EDA. Standalone apply can therefore
emit valid zone outlines without pretending that an un-clipped outer contour
is an exact native fill.

Core postprocessors such as `viaStitch(...)` return normal `RoutedVia` objects.
Their provenance may be retained in diagnostics or metrics, but it does not
create another copper primitive or imply electrical connection merely because
a net is assigned.

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

Pair/group topology is explicit in the same object: `differentialPairs`
contains stable pair ids plus positive/negative net names, while
`matchedGroups` contains member nets and tolerance. Width and gap fields alone
are never used to guess pair membership from net names.

The result always reports the effective rules and which fields differ from the
source. `rules.applyRequested` is true only for `applyDrcRules()` and
`runAll()`. It tells the host to persist those effective fields; the DSL command
itself does not return or directly mutate an EDA document. See
[`drc-rule-precedence.md`](./drc-rule-precedence.md).

## Validation ownership

The core reports rule compilation, routing completion, and portable geometry
diagnostics. Final native validity belongs to the host or an optional native
verification stage. Depending on the
selected operation, the host first persists requested effective rules, then
replaces router-owned copper when present, refills zones, and runs native
DRC/connectivity checks.
