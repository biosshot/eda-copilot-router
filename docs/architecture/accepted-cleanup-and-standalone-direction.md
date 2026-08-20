# Accepted cleanup and standalone direction

Status: accepted direction; implementation pending
Date: 2026-08-20

This record fixes the next contract changes without making KiCad the primary
host. `copilot-router` remains the shared EDA-neutral routing agent used by
both EasyEDA and KiCad integrations. Native hosts convert their documents to
`RoutingBoard`, apply `RoutingResult`, and own final editor-specific work.

## Immediate public-contract cleanup

The next implementation removes the following unenforced fields instead of
continuing to accept constraints that neither the core nor KRT guarantees:

- `ViaOptions.maxCount`;
- `signalNet(...).maxLengthMm`;
- calculated `RoutingRuleValues.via.minParallelCount` (it is not currently an
  authorable `ViaOptions` field, but it is also not enforced after compilation);
- the complete legacy `viaFence` DSL/type/export surface.

`viaStitch(..., { maxVias })` remains because its scope is explicit and the
core enforces it. The implementation currently stored in `via-fence.ts` is to
be renamed to `via-stitch.ts`; this is an internal rename, not another intent.

`components(...)` must be documented and typed per use site. It is currently
valid for the implemented `viaStitch` grid/around selectors and is not thereby
valid for a plane region.

## Existing geometry is reused before adding primitives

No new `FixedCopperRegion` collection is accepted at this stage. Importers may
polygonize fixed copper text, graphics, curves, and native filled copper into
`copper.fixed.zones`. These fixed entries are immutable occupied copper, are
never router-owned refill requests, and must be included in the compact
polygon scene as well as the KRT input.

To cover unconnected copper without inventing a synthetic electrical net, the
implementation may make `RoutedZone.net` optional only for
`copper.fixed.zones`. Router-generated and editable zones continue to require a
real net. Fill, thermal, and island-removal options describe editable/native
zone intents and are not applied to flattened fixed obstacle polygons.

No standalone mechanical-obstacle collection is accepted at this stage.
Holes belonging to PTH or NPTH pads use `RoutingPad.hole`; board openings use
`RoutingBoard.cutouts`. This already covers the through-hole connector pads in
the powerbank fixture. A separate primitive will be considered only after a
real input is found that cannot be represented as a pad hole or board cutout.

The required correction remains: `routingBoardToPolygonScene()` must stop
discarding fixed/editable tracks, vias, zones, cutouts, and keepouts.

## Verification stays at the host boundary

No `verifier` callback is added to `run(...)` now. The normal agent flow is:

1. the EasyEDA or KiCad host imports `RoutingBoard`;
2. `copilot-router` returns `RoutingResult`;
3. the host applies the result, refills native zones, and runs native DRC and
   connectivity checks.

This is already represented by `BoardFormatAdapter.apply(...)` and
`BoardApplyResult.nativeVerification`. `requiresNativeVerification` therefore
remains truthful when only `run(...)` was called.

A callback inside the routing core is deferred until the core has a concrete
need to use native validation during routing, for example to compare candidate
routes by native DRC or to continue a later stage from an exact native refill.
Standalone CLI orchestration may call the board adapter after `run(...)`; that
does not require putting editor-specific verification into the core API.

## KRT is the default engine

KRT is the only production backend and becomes the default. Ordinary callers
and the CLI must not be required to select it with `--backend` or load an
arbitrary JavaScript backend module. The low-level backend interface may
remain for testing and future replacement engines.

KRT consumes a temporary KiCad board even when the originating host is
EasyEDA. `KrtBoardTransport` is the low-level bridge that materializes this
temporary input and reads KRT's routed output back into `RoutingCopper`. It is
not a second board model and must not appear in the DSL.

For host integrations, the bridge is constructed by the EasyEDA/KiCad adapter
layer. For standalone KiCad commands, it is constructed internally by the
built-in KiCad adapter. A public `createKiCadTransport()` workflow is not part
of the accepted high-level API. If a fully generic `RoutingBoard`-to-KRT codec
can preserve all required pads, rules, fixed copper, and filled-zone obstacles,
it may later become the built-in default bridge for both hosts.

## Optional standalone KiCad path

The package will additionally provide a KiCad adapter and high-level CLI path:

```text
copilot-router route board.kicad_pcb --dsl routing.dsl.js -o routed.kicad_pcb
```

The high-level operation composes native import, the internal KRT bridge,
`run(...)`, transactional apply, refill, and native checks. Callers do not
manually call `createKiCadTransport()`.

The canonical portable path remains available for EasyEDA and other hosts:

```text
native host -> RoutingBoard -> run(...) -> RoutingResult -> native host
```

Standalone KiCad support is an additional adapter, not a change in ownership
of the core contract and not a dependency on the separate `kicad-copilot`
project. Router E2E tests should ultimately use the router-owned adapter rather
than importing a sibling project build.

## Deferred decisions

The following are deliberately not part of the next implementation:

- a verifier callback inside `run(...)`;
- a separate host-capability matrix. Until it becomes necessary, an adapter
  must return an error diagnostic rather than silently ignore an unsupported
  result field;
- guard rings, routing-keepout DSL, teardrops, pad-specific zone connections,
  and other new DSL features;
- JSON schema versioning and migrations;
- new fixed-copper or mechanical-obstacle collections without a demonstrated
  case that the existing normalized geometry cannot represent.
