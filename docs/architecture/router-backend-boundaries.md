# Router backend boundaries

Status: accepted
Date: 2026-08-11

## Decision

The router core must not depend on EasyEDA WASM, Freerouting, KiCad file
structures, or any other concrete routing engine. EasyEDA WASM is one optional
backend and must be replaceable without changing rule compilation, polygon
planning, special-net routing, validation, or transaction handling.

The public orchestration model uses three independent adapter boundaries:

1. A host/DSN adapter imports native data into the single internal
   `RoutingBoard` and later applies `RoutingResult` without rebuilding unrelated
   native objects.
2. `RouterBackendAdapter` translates `RoutingBoard` for one routing algorithm
   and returns untrusted router-owned copper. It never reads or writes the
   source board directly.
3. A native verification adapter runs the target EDA's zone refill, DRC, and
   connectivity checks after the result has been applied.

EasyEDA `RawPcb`, `BoardAssemble`, KiCad AST nodes, `PcbSnapshotV1`, and
`PcbPatchV1` are not router-core contracts. DSN is a supported interchange and
backend transport; it is not the core's in-memory model.

Do not add backend-specific route-job types to the DSL. The DSL describes
electrical intent and constraints. The core planner selects internal phases and
delegates only supported ordinary nets to a backend.

The complete-cycle implementation uses adapters and six ordered stages:

1. Plan all requested power polygons, apply every ready outline, and run the
   native EDA refill.
2. Invoke the backend once for all special nets: every declared differential
   pair and every explicit equal-length group. Persist these nets as protected
   copper and run native refill before the next backend invocation.
3. Invoke the same backend once for all remaining non-GND nets, excluding the
   special nets from the ordinary pass.
4. Refill, derive the exact residual ordinary-net set, and run a bounded
   completion portfolio. Candidates start from the same incumbent, preserve
   prior copper/placement/zone outlines, and vary only search/order/rip-up
   policy; they never weaken compiled geometry.
5. Materialize requested plane/stitching intents and refill.
6. Run the final native refill and complete validation.

This staging is an orchestration policy, not a set of DSL route-job types. A
future backend may replace KiCadRoutingTools without changing the electrical
intent or the stage contract.

## Rule ownership and preflight

Source DRC and net classes (from DSN or another input adapter) provide defaults.
Router DSL rules have higher priority and replace the source values for the
fields and scopes they explicitly set. Unspecified fields continue to inherit
their source values. A DSL value may therefore be either stricter or weaker
than the value imported from DSN; a difference between DSN and DSL is not a
rule conflict.

The rule compiler records every effective value that differs from the source in
`RoutingResult.rules.overriddenFields`. When the terminal DSL command is
`applyDrcRules()` or `runAll()`, the target EDA adapter applies those overrides
before copper and native refill/validation. `runRouting()` does not persist DRC;
preflight therefore rejects an effective DSL rule that would make its output
illegal under unchanged source DRC. Invalid DSL values, contradictory semantic
and absolute requirements inside the DSL, unknown targets, and
lossless-translation failures remain errors; only source-versus-DSL value
differences are resolved by DSL precedence.

Power-current intent is compiled in the core, not in an LLM or backend. Each
declared power net supplies exactly one of `maxCurrentA` or `minTrackWidthMm`.
Current-derived width uses the physical native stackup when present, otherwise
the documented 1 oz baseline, with `maxTempRiseC=16` by default. Calculated
width may not exceed the configured limit or the absolute 10 mm guard. Via
geometry starts from the smallest legal DRC/fabrication size; required parallel
barrel-copper capacity is calculated and checked after routing. These compiled
per-net constraints are shared by every remaining backend and final validation.

A backend translation that cannot prove exact preservation of an effective
rule is `LOSSY_RULE_TRANSLATION`. It rejects the complete run before routing.
Preflight should report all discovered diagnostics, but must not call the
backend after a hard failure.

Each backend exposes granular, test-backed capabilities. Important capabilities
include selected-net routing, immutable existing copper, hard keepouts,
per-net width and clearance, allowed layers, via policies, incremental routing,
deterministic seeds, native coupled differential pairs, paired vias, skew
limits, and matched-group tuning. A capability declaration is not trusted until
the backend passes the corresponding conformance test.

For polygon-first routing, preserving the zone record is not enough. The
backend must also prove `fixed-zone-obstacles`: generated compact/plane zones
must constrain its route search. `preconnected-pad-groups` tells the backend
which terminals are already electrically joined by those zones, so it does not
add redundant tracks between them.

## Special-net routing

A differential pair is never intentionally routed as two independent ordinary
nets followed by length tuning. The special stage submits all declared
differential pairs and explicit equal-length groups to one backend invocation.
There is no core-owned differential-pair router and no protocol-specific
exception, including for USB-C. If the backend cannot represent the required
coupling or matching constraints, preflight records `CAPABILITY_MISMATCH` and
does not invoke that backend.

The special-net result is untrusted geometry. Coupling, connectivity, pair gap,
skew, maximum uncoupled length, equal-length tolerance, widths, vias, and layers
are checked during final native validation when the native project declares
those rules; the workflow never invents missing electrical limits. A backend
fallback that emits single-ended members is not silently accepted as a
differential-pair result.
The special nets are excluded from the remaining-net invocation so the ordinary
pass cannot reinterpret or replace them as independent nets. Their exact
segment/arc/via geometry is also protected in backend project metadata and
compared after the pass; net-count equality is insufficient because a
same-count reroute can still destroy coupling or matching.

## Stage diagnostics and final validity

Runtime failures do not crash the workflow. Every stage records its status,
diagnostics, elapsed time, memory metrics when available, and the latest board
artifact it was able to produce. A failed polygon plan does not suppress other
ready polygon plans. A failed routing or refill stage does not prevent a later
stage when a usable input artifact still exists; an impossible dependency is
recorded as `skipped_due_to_dependency`.

Intermediate stage statuses are diagnostic only. In particular, polygon plan
or post-refill connectivity errors do not directly make the board invalid.
The board's `valid` value is derived solely from the final validation result
after the last native refill. Final validation re-evaluates all applicable DRC,
connectivity, polygon-target, differential-pair, and equal-length constraints
against the actual final copper. A previously reported stage error may therefore
coexist with `valid: true` if the final board satisfies every required check.
Conversely, successful stages never imply `valid: true`.

## Transaction invariant

The source board is immutable throughout routing:

1. Import an immutable `RoutingBoard` and separate fixed from editable copper.
2. Compile rules and complete capability negotiation.
3. Plan and refill polygons on a temporary native board.
4. Route all special nets in one backend invocation, protect their copper, and
   run native refill on the resulting snapshot.
5. Route all remaining non-GND nets in one backend invocation.
6. Evaluate bounded completion candidates only for native-open ordinary nets.
7. Add requested plane/stitching copper and refill.
8. Run the final native refill and complete validation.
9. Return `RoutingResult`; the host applies it transactionally and owns the
   final native validation/commit decision.

No failed result modifies the source document. Partial and invalid output may
be retained only as an explicitly named diagnostic artifact together with its
stage report. A preflight conflict prevents backend invocation, while runtime
routing/refill diagnostics are recorded and the workflow continues whenever a
usable board artifact remains.

## Planned backend roles

- `KiCadRoutingToolsBackendAdapter`: first complete-cycle backend for both the
  single special-net invocation and the single remaining-net invocation.
- `EasyEdaWasmBackendAdapter`: compatibility and benchmark backend only.
- `FreeroutingBackendAdapter`: selectable ordinary-net batch backend. It uses a
  KiCad DSN/SES bridge, temporary ignored classes for GND and special nets, and
  fixed pre-existing copper; KRT remains the special-net backend. A thin
  headless launcher applies the ignore-class flags that Freerouting 2.3.0 only
  applies in its GUI path and disables its unscoped fanout pre-pass; the stock
  Freerouting batch router and optimizer still own all routing geometry.
- Core polygon engine: native-zone outline planning, independent of trace
  routing backends.
- Core special-net intent and final validators remain backend-neutral; detailed
  coupled routing and length tuning belong to a capable backend.

Longer term, a backend-neutral global capacity planner should reserve routing
regions, bottlenecks, layer transitions, pair corridors, and tuning space. This
is geometric congestion planning for the existing placement, not automatic
schematic-block detection.

## Reference implementations to study

- KiCadRoutingTools: coupled-pair centerline/offset routing and paired vias.
- tscircuit-autorouter: capacity-mesh and hypergraph pipeline architecture.
- Topola: topology-first navigation and rubber-band routing.
- KiCad PNS: shape-based push-and-shove and local repair.
- Freerouting: mature batch maze routing, rip-up/reroute, and optimization.
- route-rnd: external-router protocol and self-described routing methods.
- OrthoRoute/PathFinder: negotiated congestion and historical resource costs.
