# Router backend boundaries

Status: accepted
Date: 2026-08-28

## Decision

The router core must not depend on KiCad file structures or KRT process
details. KRT is isolated behind the backend contract so rule compilation,
polygon planning, special-net routing, validation, and transaction handling
remain portable.

The public orchestration model uses three independent boundaries:

1. A host adapter imports native data into the single internal
   `RoutingBoard` and later applies `RoutingResult` without rebuilding unrelated
   native objects.
2. `RouterBackendAdapter` receives one normalized `BackendRouteRequest`,
   including its board-aware `request.plan`, and exposes one `route()` entry
   point. It returns an untrusted complete replacement for transaction-owned
   editable copper. It never reads or writes the source board directly.
3. The host's board adapter runs the target EDA's zone refill, DRC, and
   connectivity checks after the result has been applied. This remains outside
   `run(...)`; no separate verifier callback is required by the current core
   contract.

Backend distribution follows [backend-assets.md](backend-assets.md): KRT is a
verified lazy-managed asset and EasyEDA WASM is bundled with the package. A
manual checkout is never part of the public backend contract.

KiCad AST nodes and other native document objects are not router-core
contracts.

KRT remains the default engine for `run()` and the standalone KiCad CLI. The
EasyEDA host may select the production Hybrid adapter. Its temporary KiCad board
is materialized by one router-owned codec with no host or caller override. A
built-in standalone KiCad operation composes native import/apply around the
same portable core. See
[`accepted-cleanup-and-standalone-direction.md`](./accepted-cleanup-and-standalone-direction.md).

Hybrid is an internal routing strategy, not a second DSL or contract. On boards
with at most two copper layers it sends differential, matched, power,
critical/high-priority, impedance, fanout, bus-detection, via-sensitive, and
per-net-layer-constrained scopes to the unchanged KRT adapter. EasyEDA WASM
receives only the ordinary remaining scope.
On multilayer boards Hybrid passes the exact original request to KRT. The full
board and all existing copper remain visible to both leaf backends; only the
internal `request.plan` and compiled intent are narrowed.

If a leaf backend fails preflight or at runtime, Hybrid retries the other leaf
on the full routable scope when possible. Every fallback is explicitly
`partial`, retains diagnostics from every attempted stage, and selects the best
usable checkpoint with the same semantic candidate grader used by the core.
If neither leaf can start, the incoming editable checkpoint is returned as
`partial` with both errors. Hybrid does not add a second clearance/DRC verifier;
native verification remains the host boundary described below.

Do not add backend-specific route-job types to the DSL. The DSL describes
electrical intent and constraints. The core planner selects internal phases and
delegates only supported ordinary nets to a backend.

Before that call, the core canonicalizes all layers to `TOP`, `INNER_n`, and
`BOTTOM`, compiles rules, resolves `priority` and `viaPreference`, and plans
compact polygons as fixed obstacles. The resolved plan partitions compatible
differential, matched, and critical groups without exposing engine flags in the
authoring surface.

The current KRT adapter then owns this sequence inside the single `route()`
call:

1. Run QFN/QFP fanout only for explicit `fanout(...)` targets. A failed
   fanout remains a diagnostic search aid and does not suppress maze routing.
2. Route differential pairs and matched groups in compatible native batches.
   Successfully verified special copper becomes protected before ordinary
   routing.
3. Route critical ordinary groups and protect only results that pass the
   critical connectivity/protection gate.
4. Give high-priority and via-sensitive (`avoid` or `forbid`) ordinary nets an
   early bounded pass. They remain editable so native blocker recovery can
   still move them.
5. Route all remaining and still-open ordinary nets with KRT's native rescue,
   terminal escalation, pre-existing rip-up recovery, dynamic iteration, and
   finalization recovery enabled.
6. Audit full-scope connectivity and DRC. Group still-open ordinary nets by
   compatible layer/via policy. Then consider already-connected ordinary
   `avoid`/`forbid` nets that are at most 10 mm long and still contain vias;
   these are force-rerouted one net at a time. Both job kinds share a maximum
   of eight attempts and about 30% of measured ordinary-route time after the
   main pass (with a 5 s minimum on tiny boards). Routing, connectivity and DRC
   audits all share this wall-clock bound.
7. Accept each repair only when full-scope connectivity does not regress,
   scoped native DRC does not increase, and no protected copper is damaged.
   Open-net jobs must improve connectivity or DRC. Connected-net jobs must
   strictly reduce the target's via count. Rejected boards remain artifacts,
   not routing input.
8. Return the final accepted audit and complete editable replacement, even when
   the result is partial.

Repair remains a backend-internal stage, not another public route entry point
or an unbounded per-net fan-out. Connected-net force routing is deliberately
restricted to short via-sensitive ordinary nets. Special nets stay under their
dedicated verification flow. A critical ordinary target may be temporarily
unprotected only from its own isolated force-reroute; all other protected nets
remain locked, and the target ledger entry must be restored before acceptance.

After `route()` returns, the core semantically compares the snapshot with its
pre-route checkpoint, then materializes core-owned plane and `viaStitch(...)`
intents through structural checkpoints. The host finally maps canonical layers
back to native names, applies the result, refills native zones, and runs native
DRC/connectivity checks.

This staging is orchestration policy, not a set of DSL route-job types. There
is no public quality profile, candidate-count knob, or special/remaining
backend method. Hybrid composes leaf backends without changing the electrical
intent or the single-call core contract.

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

Power-current intent is compiled in the core, not in an LLM or backend. A
declared power net may supply `maxCurrentA`, nominal `trackWidthMm`, hard
`minTrackWidthMm`, any combination of them, or none when its effective class
already supplies the geometry. Current-derived width uses the physical native
stackup when present, otherwise the documented 1 oz baseline, with
`maxTempRiseC=16` by default. Calculated width is the preferred trunk width,
not a pad-escape minimum. Short neck-downs remain legal down to the effective
fab/DRC minimum (0.127 mm by default). **All backend neck-down mechanisms are always enabled**, including
KRT impedance neck-down and its normal power-tap/pad-escape neck-down. No adapter
may emit a `--no-*-neckdown` option or a `NECKDOWN=0` environment override.
Neck-down still may not cross the effective compiled DRC minimum. The
preferred width may not exceed the configured limit or the absolute 10 mm
guard. Via
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
nets followed by length tuning. The plan places all declared differential pairs
and explicit equal-length groups in special constraint groups; KRT coalesces
only groups whose native geometry, tolerances, and layer sets are compatible.
These are internal subprocesses of the one backend invocation, not separate
core/backend calls. There is no core-owned differential-pair router and no
protocol-specific exception, including for USB-C. If the backend cannot
represent the required coupling or matching constraints, preflight records
`CAPABILITY_MISMATCH` and does not invoke that backend.

The special-net result is untrusted geometry. Coupling, connectivity, pair gap,
skew, maximum uncoupled length, equal-length tolerance, widths, vias, and layers
are checked during final native validation when the native project declares
those rules; the workflow never invents missing electrical limits. A backend
fallback that emits single-ended members is not silently accepted as a
differential-pair result.
Successfully verified special nets are recorded as protected in backend project
metadata and checked after later batches; net-count equality is insufficient
because a same-count reroute can still destroy coupling or matching.

Ordinary batches are partitioned by compatible allowed-layer sets, clearance
buckets and hard neck-down-width buckets. Early
via-sensitive batches are additionally partitioned by `viaPreference` so the
semantic preference can become a KRT search cost without turning it into a DRC
rule. `avoid` is a strong preference; `forbid` is represented as a prohibitive
search cost and is also audited in the core snapshot score. A shared 32-batch
execution ceiling bounds critical/early/main process growth; unscheduled
compatibility overflow is reported as open partial scope rather than widening
allowed layers or exhausting memory. Native logs are spooled in full to disk
and retained in memory only as bounded tails.

Exact net scopes and explicit P/N mappings travel in JSON sidecars with
collision-free opaque tokens and constant-size CLI sentinels. Sentinels are
dynamically displaced if a legal net has the same spelling. The complete native tool argv is also disk-backed;
the operating-system command contains only a fixed bootstrap and file paths.
This avoids the Windows command-line limit on large boards and keeps literal
names exact even when KRT reuses expanded raw names in recovery filters.
Connectivity and DRC verdicts also use result sidecars, so a large payload
cannot be truncated out of the bounded log tail.

`viaStitch(...)` remains a core-owned postprocessor. Mode `along` uses only
source nets that the backend reports completed; `return`, `grid`, and `around`
run with final board context after routing and plane planning. No stitch mode
creates another backend route job. The presence of a net-assigned fence via
does not itself prove connectivity to a plane or other same-net copper; that
remains a final native connectivity question.

## Stage diagnostics and final validity

Runtime failures do not erase useful work. KRT records subprocess diagnostics
and artifacts, and returns the latest parseable replacement even if the engine
status is `partial` or `error`. Transport status is diagnostic input, not a
standalone quality gate.

The core performs one semantic comparison between that backend snapshot and
the pre-route editable checkpoint. Structural validity and protected-copper
regressions outrank completion; then priority-weighted opens, special-constraint
violations, DRC evidence, via preferences, via count, and route length decide
whether the backend snapshot is retained. This is recovery selection between
the incumbent and one backend result, not a user-configurable profile or
candidate cascade.

Core postprocessors similarly retain the last structurally applicable
checkpoint. Consequently open nets, a failed internal subprocess, or an
unavailable postprocessor normally produce an applicable `partial` result.
Only hard preflight failure, caller abort, structurally unusable copper, or
immutable/protected-copper damage may reject the affected snapshot. Final
native validity still belongs to the host after apply, zone refill, DRC, and
connectivity checks.

## Transaction invariant

The source board is immutable throughout routing:

1. Import an immutable board, split fixed/editable copper, and canonicalize all
   physical layers to `TOP`/`INNER_n`/`BOTTOM`.
2. Compile rules, resolve `request.plan`, and complete capability negotiation.
3. Apply `clearRouting()` only to the transaction copy and plan compact polygon
   obstacles as fixed copper.
4. Call `backend.route(request)` exactly once. The backend may run its bounded
   internal stages and returns a complete editable replacement.
5. Audit that replacement against the pre-route checkpoint and retain the safer
   applicable snapshot.
6. Add requested planes and all `viaStitch(...)` modes through structural
   checkpoints.
7. Return `RoutingResult`, including useful copper when status is `partial`.
8. The host maps canonical layers back to native identifiers, applies the
   transaction, refills zones, and owns final native DRC/connectivity validation.

No failed or partial result modifies the source document by itself. A preflight
conflict prevents backend invocation, while runtime diagnostics remain attached
to the best usable snapshot. Because backend copper is a full editable
replacement, a native rip-up/recovery is preserved instead of being merged with
obsolete editable input.

## Backend roles

- `HybridBackendAdapter`: thin scope selection and bounded fallback. It owns no
  KRT routing stages and introduces no public route-job contract.
- `KiCadRoutingToolsBackendAdapter`: KRT leaf backend; it owns
  compatible special batches, critical/high ordering, native recovery, final
  connectivity audit, and conversion of the routed board to one replacement.
- `EasyEdaWasmBackendAdapter`: ordinary-net leaf backend for the remaining
  scope. It consumes effective per-net width, clearance, and via geometry and
  returns a complete editable replacement.
- Core polygon engine: native-zone outline planning, independent of trace
  routing backends.
- Core route planning, snapshot grading, plane/stitch postprocessing, and final
  contracts remain backend-neutral; detailed coupled routing and length tuning
  belong to a capable backend.

Longer term, a backend-neutral global capacity planner should reserve routing
regions, bottlenecks, layer transitions, pair corridors, and tuning space. This
is geometric congestion planning for the existing placement, not automatic
schematic-block detection.

## Reference implementations to study

- KiCadRoutingTools: coupled-pair centerline/offset routing and paired vias.
- tscircuit-autorouter: capacity-mesh and hypergraph pipeline architecture.
- Topola: topology-first navigation and rubber-band routing.
- KiCad PNS: shape-based push-and-shove and local repair.
- route-rnd: external-router protocol and self-described routing methods.
- OrthoRoute/PathFinder: negotiated congestion and historical resource costs.
