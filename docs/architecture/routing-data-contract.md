# Routing data contract

Status: accepted direction
Date: 2026-08-28

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

The router core has one strict physical-layer namespace: `TOP`, `BOTTOM`, and
`INNER_1`, `INNER_2`, ... in physical stack order. No native EDA layer name is
valid inside `RoutingBoard`, a compiled rule, a backend result, or a core
postprocessor. `RoutingLayer.index` carries the physical ordering used to assign
the inner-layer identifiers.

Board adapters own both directions of translation. For example, the KiCad
adapter imports `F.Cu`, `In1.Cu`, and `B.Cu` as `TOP`, `INNER_1`, and `BOTTOM`,
then maps canonical result copper back to KiCad names when it applies the
transaction. EasyEDA and other hosts do the same at their boundary. This is an
intentional pre-1.0 break: callers must not pass native layer aliases directly
to the core.

## Core types

The exact TypeScript spelling may change during implementation, but the
ownership and semantic fields below are fixed.

```ts
interface RoutingBoard {
  outline: PointMm[]
  cutouts: PointMm[][]
  layers: RoutingLayer[]
  nets: RoutingNet[]
  components: RoutingComponent[]
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
  operation: "apply-drc" | "apply-stackup" | "copper" | "route" | "all"
  rules: RoutingRules
  stackup?: {
    effective: RoutingStackup
    applyRequested: true
  }
  clearRouting?: RoutingClearIntent
  copper?: RoutingCopper
  diagnostics: Diagnostic[]
  metrics: RoutingMetrics
  requiresNativeVerification: true
}

interface BackendRouteRequest {
  board: RoutingBoard
  program: CompiledRoutingProgram
  plan: ResolvedRoutePlan
  rules: RoutingRules
}

interface BackendRouteResult {
  status: "complete" | "partial" | "error"
  copper: RoutingCopper
  diagnostics?: RoutingDiagnostic[]
  metrics?: Partial<RoutingMetrics>
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

Input `editable` copper participates in routing. Existing objects remain part
of the result unless `clearRouting()` selects them; selected objects may then
be removed or rerouted. `RoutingResult.copper` is the complete final logical
state of that editable copper, not an append-only list and not a full PCB.
This lets completion and blocker repair reroute earlier generated copper without
requiring a general-purpose PCB patch format.

The same replacement rule applies at the backend boundary.
`BackendRouteResult.copper` is the complete transaction-owned editable
replacement produced by the one `backend.route(request)` call. It is not an
additions delta. Fixed copper is absent from the replacement and must remain
unchanged. This is what lets native recovery rip and rebuild editable blockers
without the core accidentally restoring the obsolete routes.

`BackendRouteRequest.plan` is the single board-aware semantic routing plan. It
contains the selected net scope, resolved `priority`/`viaPreference` policy,
compatible differential, matched, and critical groups, explicit fanout
targets, and the ordinary main scope. Backends consume this normalized plan;
they do not infer execution policy from statement order or expose separate
special/remaining entry points.

`RoutingResult.copper` is present when the DSL selected `runCopper()`,
`runRouting()`, or `runAll()`. An `applyDrcRules()`- or `applyStackup()`-only
operation does not produce replacement copper. `runCopper()` plans zone
outlines and independent stitching without starting a routing backend; exact
native fill remains a host operation.

`RoutingResult.clearRouting` authorizes the explicit pre-route discard selected
by `clearRouting(...)`; it determines which unlocked editable objects are
removed from the transaction input before the backend starts. The backend's
complete replacement may subsequently omit or rebuild other transaction-owned
editable objects as part of native blocker recovery even when no clear intent
was requested. Fixed/locked copper is never eligible. An adapter preserves
unchanged native objects by identity when their geometry is unchanged and
replaces changed or omitted editable objects from the final snapshot.

The built-in KiCad adapter applies those replacement semantics to unlocked
tracks, vias, and zones. Native locked copper and normalized graphical-copper
obstacles remain fixed. Consequently `clearRouting()` can discard selected
unlocked routing copper before search while native KRT recovery can still move
other editable blockers without touching actual locks.

## Partial-result invariant

A parseable, structurally applicable board snapshot remains useful even when a
router process reports an error or leaves nets open. The core semantically
audits the backend replacement against its pre-route checkpoint and keeps the
better applicable snapshot. Core-owned plane and `viaStitch(...)`
postprocessors use the same checkpoint rule: invalid later geometry cannot
erase the last usable copper.

A `partial` result is therefore applicable through the same transactional host
path as a complete result; the status reports incompleteness rather than vetoing
the copper. A run is rejected before any copper is returned only when preflight
cannot produce a legal request, the caller hard-aborts, no structurally usable
snapshot exists, or immutable/protected copper damage makes a snapshot unsafe.
Incomplete routing by itself is not a rejection condition.

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

The result always reports the complete effective rules. The host persists them
only for `applyDrcRules()` and `runAll()`; `runRouting()` may use only a rule set
that remains legal under unchanged source DRC. The DSL command itself does not
return or directly mutate an EDA document. See
[`drc-rule-precedence.md`](./drc-rule-precedence.md).

## Validation ownership

The core reports rule compilation, routing completion, and portable geometry
diagnostics. Final native validity belongs to the host or an optional native
verification stage. Depending on the
selected operation, the host first persists requested effective rules, then
applies explicitly requested copper deletion and new geometry, refills zones,
and runs native DRC/connectivity checks.
