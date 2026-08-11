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

## Differential-pair fallback

A differential pair is never routed as two independent nets followed by length
tuning. If the selected backend cannot satisfy every required coupled-pair
constraint, the core-owned `CoupledPairRouter` must route it first as one atomic
bundle:

1. Route a centerline in `(x, y, direction, layer)` state using an obstacle
   envelope for both traces and their gap.
2. Generate symmetric 0/45/90-degree P/N offsets.
3. Insert paired vias atomically with symmetric approaches and exits.
4. Validate clearance, pair gap, connectivity, skew, and maximum uncoupled
   length.
5. Lock the resulting pair before ordinary-net routing.

The ordinary-net backend is eligible for this fallback only if it can exclude
the pair nets and either preserve the resulting fixed copper or obey an
equivalent hard keepout envelope. Otherwise preflight returns
`CAPABILITY_MISMATCH`. Failure to find a valid coupled route returns
`DIFF_PAIR_UNROUTABLE` and aborts the transaction.

Matched groups follow the same principle: the global planner reserves tuning
capacity before detailed routing. If a hard length/skew target cannot be met,
the run fails instead of adding arbitrary meanders after the board is full.

## Transaction invariant

The source board is immutable throughout routing:

1. Import and hash an immutable snapshot.
2. Compile rules and complete capability negotiation.
3. Route into a neutral `RoutePatch` in a temporary workspace.
4. Validate the patch as untrusted geometry.
5. Apply it to a temporary native board.
6. Run native refill, DRC, and connectivity verification.
7. Commit atomically only when every hard rule passes.

`preflight_failed`, `routing_failed`, and `validation_failed` results never
modify the source document. Partial output may be retained only as an explicitly
named diagnostic artifact.

## Planned backend roles

- `EasyEdaWasmBackendAdapter`: compatibility and benchmark backend only.
- `FreeroutingBackendAdapter`: mature ordinary-net batch baseline.
- `KiCadRoutingToolsBackendAdapter`: experimental octilinear, length-matching,
  and differential-pair backend.
- Core polygon engine: native-zone outline planning, independent of trace
  routing backends.
- Core special-net modules: portable differential-pair and matched-group
  handling.

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
