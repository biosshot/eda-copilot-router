# Router backend boundaries

Status: accepted
Date: 2026-08-11

## Decision

The router core must not depend on EasyEDA WASM, Freerouting, KiCad file
structures, or any other concrete routing engine. EasyEDA WASM is one optional
backend and must be replaceable without changing rule compilation, polygon
planning, special-net routing, validation, or transaction handling.

The public orchestration model uses three independent adapter boundaries:

1. `BoardFormatAdapter` imports KiCad or EasyEDA data into the existing `RawPcb`
   DTO plus routing context, and applies a validated `RoutePatch` to a temporary
   native document.
2. `RouterBackendAdapter` translates a neutral `RoutingProblem` for one routing
   algorithm and returns an untrusted `RouteCandidate`. It never reads or writes
   the source board directly.
3. `NativeVerificationAdapter` runs the target EDA's native zone refill, DRC,
   and connectivity checks before a result can be committed.

Do not add backend-specific route-job types to the DSL. The DSL describes
electrical intent and constraints. The core planner selects internal phases and
delegates only supported ordinary nets to a backend.

The first complete-cycle implementation uses one routing backend and four
ordered stages:

1. Plan all requested power polygons, apply every ready outline, and run the
   native EDA refill.
2. Invoke the backend once for all special nets: every declared differential
   pair and every explicit equal-length group. Persist these nets as protected
   copper and run native refill before the next backend invocation.
3. Invoke the same backend once for all remaining non-GND nets, excluding the
   special nets from the ordinary pass.
4. Run the final native refill and complete validation.

This staging is an orchestration policy, not a set of DSL route-job types. A
future backend may replace KiCadRoutingTools without changing the electrical
intent or the stage contract.

## Rule ownership and preflight

Native board DRC and net classes are the default rule source. DSL rules may add
semantic constraints or tighten native constraints; they must not silently
weaken them. Preferred/default values are not hard constraints.

All hard constraints are combined by intersection:

- width ranges are intersected;
- the greatest minimum clearance is used;
- allowed-layer and allowed-via sets are intersected;
- differential-pair width, gap, skew, via, and maximum-uncoupled-length
  constraints are intersected.

An empty intersection is `RULE_CONFLICT`. A backend translation that cannot
prove exact preservation of a required rule is `LOSSY_RULE_TRANSLATION`. Either
condition rejects the complete run before any routing begins. Preflight should
report all discovered diagnostics, but must not call the backend after a hard
failure.

Each backend exposes granular, test-backed capabilities. Important capabilities
include selected-net routing, immutable existing copper, hard keepouts,
per-net width and clearance, allowed layers, via policies, incremental routing,
deterministic seeds, native coupled differential pairs, paired vias, skew
limits, and matched-group tuning. A capability declaration is not trusted until
the backend passes the corresponding conformance test.

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

1. Import and hash an immutable snapshot.
2. Compile rules and complete capability negotiation.
3. Plan and refill polygons on a temporary native board.
4. Route all special nets in one backend invocation, protect their copper, and
   run native refill on the resulting snapshot.
5. Route all remaining non-GND nets in one backend invocation.
6. Run the final native refill and complete validation.
7. Commit atomically only when final validation passes every hard rule.

No failed result modifies the source document. Partial and invalid output may
be retained only as an explicitly named diagnostic artifact together with its
stage report. A preflight conflict prevents backend invocation, while runtime
routing/refill diagnostics are recorded and the workflow continues whenever a
usable board artifact remains.

## Planned backend roles

- `KiCadRoutingToolsBackendAdapter`: first complete-cycle backend for both the
  single special-net invocation and the single remaining-net invocation.
- `EasyEdaWasmBackendAdapter`: compatibility and benchmark backend only.
- `FreeroutingBackendAdapter`: mature ordinary-net batch baseline and possible
  later replacement behind the same adapter contract.
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
