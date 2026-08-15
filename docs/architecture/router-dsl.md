# Local router DSL

Status: next contract accepted; implementation migration pending
Updated: 2026-08-14

## Fixed decisions

The canonical DSL is the existing local statement-oriented JavaScript DSL used
by the polygon engine and similar in style to the server placement DSL. It is
not JSON and has no required top-level wrapper.

Do not introduce `routing({ copper, rules, ... })`, `RoutingIntentV2`, an AST
version field, or a second incompatible polygon builder.

The copper syntax remains statement-oriented and semantic. Layer identifiers
are EDA-neutral canonical names owned by `RoutingBoard`, not native KiCad
names:

```js
polygon("VSYS")
  .connect(pad("U1", 8), pad("L1", 2))
  .on("TOP")
  .compact()

plane({
  net: "GND",
  layers: "OUTER",
  region: board(),
  stitching: true,
})
```

In particular:

- `polygon(net)` keeps its current signature; no mandatory polygon ID is added;
- `plane({...})` keeps its object form;
- physical copper layers are `TOP`, `BOTTOM`, and `INNER_1` through
  `INNER_30`;
- semantic selectors are `OUTER` and `ALL`; `MULTI` remains a pad/via span
  concept and is not a routable physical layer;
- the KiCad adapter maps `F.Cu`, `In1.Cu`, and `B.Cu` at the boundary only;
- `pad`, `net`, `board`, and `components` retain their meanings;
- polygon geometry is semantic and contains no generated coordinates;
- `components(...)` remains reserved until implemented;
- omission of stitching does not silently enable it;
- zone priority is not exposed by the DSL. The core assigns it
  deterministically: compact polygons precede board-wide planes, and a
  board-wide GND plane receives the lowest internal priority.

## Rule statements

DRC and electrical routing requirements belong in this same local router DSL,
not in the component-placement DSL. They are independent top-level statements
next to `polygon(...)` and `plane(...)`, not entries in a wrapper array.

The target rule vocabulary covers:

- an ordinary net rule: width, clearance, allowed layers, via geometry, and
  optional length/impedance requirements;
- a power net rule: optional maximum current and/or explicit minimum width,
  optional temperature rise (default 16 C), width ceiling (absolute maximum
  10 mm), and via-current intent;
- differential pair membership and optional width, gap, impedance, skew,
  uncoupled length, layers, and via constraints;
- explicit equal-length groups and tolerance;
- a full physical board stack with 1 oz used only as a fallback when the input
  and DSL do not provide copper thickness.

Every field that can be obtained from `RoutingBoard`, imported DSN/native DRC,
the imported stackup, or a safe router default is optional in the DSL. The DSL
states intent and deliberate overrides; it does not require the LLM to repeat
known board data or calculate geometry. Resolution order is:

1. explicit DSL value;
2. imported board/rule/stack value;
3. documented safe fallback, when one exists;
4. a preflight diagnostic when the value is required but cannot be inferred
   honestly.

For example, omitted copper thickness may use the documented 1 oz fallback,
but controlled-impedance routing does not guess an unknown dielectric thickness
or relative permittivity.

```js
signalNet("CLK", { trackWidthMm: 0.2, clearanceMm: 0.2, maxLengthMm: 40 })
powerNet("VBUS", {
  maxCurrentA: 2,
  maxTempRiseC: 16,
  powerPads: [pad("J1", 1), pad("Q1", 8)],
  tapWidthMm: "drc-min",
})
diffPair("usb", {
  positive: "USB_DP",
  negative: "USB_DM",
  gapMm: 0.2,
  maxSkewMm: 0.25,
})
matchedGroup("data", { nets: ["D0", "D1", "D2"], toleranceMm: 0.1 })
stack({
  fallbackCopperThicknessOz: 1,
  viaPlatingThicknessUm: 20,
  layers: [
    { name: "TOP", kind: "copper", thicknessOz: 1 },
    { name: "CORE", kind: "dielectric", thicknessMm: 1.53, relativePermittivity: 4.3 },
    { name: "BOTTOM", kind: "copper", thicknessOz: 1 },
  ],
})
```

For a current-derived `powerNet`, `powerPads` identify the terminals that must
be joined by the high-current trunk. Other pads on the same net are low-current
taps and may neck down to `tapWidthMm` (default `drc-min`). Power width and
parallel-via requirements apply to the trunk, not to every control/sense pad.
This distinction is required rather than guessed from geometry.

`maxCurrentA` and `minTrackWidthMm` are compatible, not mutually exclusive. If
both are present, the effective trunk minimum is the stricter of the
current-derived width and the explicit minimum. If neither is present, the
power net inherits its width from its named class or effective DRC. The DSL
does not require an LLM to repeat a width already supplied by the board.

## Global DRC and named net classes

`drc(...)` sets optional global/default fields. It is one structured statement;
the DSL does not add order-dependent setters such as `setClearance()` or
`setVia()`.

```js
drc({
  clearanceMm: 0.2,
  edgeClearanceMm: 0.5,
  holeToHoleClearanceMm: 0.25,
  minTrackWidthMm: 0.127,
  preferredTrackWidthMm: 0.254,
  via: {
    minDiameterMm: 0.45,
    preferredDiameterMm: 0.6,
    minDrillMm: 0.2,
    preferredDrillMm: 0.3,
    minAnnularRingMm: 0.1,
    viaInPad: "allow",
  },
})
```

`netClass(...)` is the reusable physical-rule mechanism for ordinary or
special nets that share geometry but are not necessarily power nets:

```js
netClass("WIDE_SIGNALS", {
  nets: ["LED_A", "LED_B", "MOTOR_SENSE"],
  minTrackWidthMm: 0.3,
  preferredTrackWidthMm: 0.5,
  clearanceMm: 0.2,
  allowedLayers: "OUTER",
  via: { preferredDiameterMm: 0.8, preferredDrillMm: 0.4 },
})
```

All class fields except the class name and non-empty net membership are
optional and inherit from global DRC. An explicit per-net declaration may
further specialize its assigned class. Effective precedence is imported DRC,
then `drc(...)`, then `netClass(...)`, then explicit per-net/special intent.
Semantic requirements such as current or impedance are compatibility checks
and derived constraints; an explicit value that makes them impossible is a DSL
error.

When the terminal command is `applyDrcRules()` or `runAll()`, named DSL classes
are persisted as real named net classes by capable KiCad/EasyEDA adapters, with
their exact net assignments. `runRouting()` may use the effective class without
requesting persistence, subject to the existing `DRC_APPLY_REQUIRED` rule.

## Controlled impedance

Impedance is a constraint inside `signalNet(...)` or `diffPair(...)`, not a
separate top-level statement. The containing statement determines whether the
target is single-ended or differential:

```js
signalNet("RF_IN_AC", {
  impedance: {
    targetOhm: 50,
    tolerancePercent: 10,
    topology: "microstrip",
    reference: { net: "GND" },
  },
})

diffPair("USB", {
  positive: "USB_DP",
  negative: "USB_DM",
  impedance: {
    targetOhm: 90,
    tolerancePercent: 10,
    topology: "microstrip",
    reference: { net: "GND" },
  },
})
```

The reference layer is deliberately not part of the DSL. The compiler selects
the nearest physically eligible copper carrying the requested reference net,
using dielectric distance in the resolved stack. For stripline it resolves the
nearest valid reference copper on both sides when the model requires both. The
routed layer still comes from the net's effective `allowedLayers` rule.

The first controlled-impedance contract supports `microstrip`, `stripline`, and
`coplanar`. Topology, tolerance, and reference net may be omitted only when the
imported board or assigned class resolves them unambiguously. The compiler
never guesses a dielectric thickness, relative permittivity, or nonexistent
reference plane. If no suitable reference copper can be proven, preflight
reports `IMPEDANCE_REFERENCE_NOT_FOUND`.

For microstrip and stripline the compiler normally derives track width. A
coplanar constraint has two geometric variables: when an explicit or inherited
preferred width exists, the compiler derives the coplanar gap; when an explicit
gap exists, it may derive the width. If both are explicit, it validates them;
if neither variable can be anchored, the declaration is ambiguous and fails
preflight. Explicit width/gap constraints and the semantic impedance target
must have a non-empty common solution.

## Physical stack

`stack(...)` replaces `fabrication(...)`. Every field is optional when the
adapter already imported an equivalent value. A complete declaration can
contain copper and dielectric layers, finished thickness, solder mask, and via
plating process data:

```js
stack({
  boardThicknessMm: 1.6,
  fallbackCopperThicknessOz: 1,
  viaPlatingThicknessUm: 20,
  layers: [
    { name: "TOP", kind: "copper", thicknessOz: 1 },
    {
      name: "CORE",
      kind: "dielectric",
      thicknessMm: 1.53,
      relativePermittivity: 4.3,
      lossTangent: 0.02,
      material: "FR4",
    },
    { name: "BOTTOM", kind: "copper", thicknessOz: 1 },
  ],
  solderMask: {
    top: { thicknessMm: 0.02, relativePermittivity: 3.3 },
    bottom: { thicknessMm: 0.02, relativePermittivity: 3.3 },
  },
})
```

The compiler merges the declaration field-by-field with the imported stack,
validates physical layer order and finished thickness, and reports missing
electrical properties only when a requested operation (for example impedance
calculation) actually requires them.

The object fields use explicit unit suffixes where values would otherwise be
ambiguous. Backend paths, presets, and search knobs remain outside the DSL.

Semantic and absolute requirements belong to the same rule statement and may
be used together. For example, a power rule may provide current and temperature
rise so the compiler derives a minimum width, while also providing an absolute
minimum or maximum width. A differential-pair rule may provide impedance and
also explicit width or gap. The compiler uses the intersection of compatible
requirements and reports a DSL conflict when no legal value exists.

## Terminal commands

Every DSL program ends with exactly one of these commands:

```js
applyDrcRules()
runRouting()
runAll()
```

These are DSL commands, not package API calls. They record the requested
operation in the interpreter and return no value. Only the outer package
`run(...)` call returns `RoutingResult`.

- `applyDrcRules()` compiles the DSL rule statements and requests that the host
  persist the effective DRC fields. It does not execute polygon or routing
  backends.
- `runRouting()` executes all requested polygon, plane, special-net, and
  ordinary routing work without requesting a native DRC update.
- `runAll()` is the single-command form of applying effective DRC rules first
  and then running the complete routing workflow.

Multiple terminal commands and a program with no terminal command are DSL
errors. `runAll()` is semantically equivalent to the two operations, but a DSL
program does not spell it as two command calls.

All rule statements are compiled for all three operations. With
`runRouting()`, effective DSL rules may equal or tighten the source rules, but
they may not require copper that violates a weaker source constraint. Such a
program fails preflight with `DRC_APPLY_REQUIRED`; the caller must select
`runAll()` (or run a separate `applyDrcRules()` program) instead.

## Scope, cleanup, and quality

The following statements are accepted for the next contract:

```js
quality({ profile: "completion-first", maxCandidates: 3 })
onlyNets("USB_DP", "USB_DM", "USB_VBUS")
ignoreNets("GND", "TEST_POINT")

clearRouting({
  nets: ["USB_DP", "USB_DM"], // or "all"
  items: ["tracks", "vias", "zones"],
})
```

- quality profiles are `fast`, `balanced`, `quality-first`, and
  `completion-first`;
- `maxCandidates` has a hard maximum of 16; documentation recommends at most
  3 unless the caller explicitly wants a portfolio search;
- `onlyNets` establishes the route scope and `ignoreNets` subtracts from it;
- differential pairs and matched groups are atomic when scope is resolved;
- copper already electrically connected by retained tracks or planned zones is
  removed from backend obligations;
- `clearRouting` can target all nets or an explicit net list;
- cleanup item kinds are explicit. The default is tracks and vias; zones are
  removed only when `"zones"` is requested;
- fixed/locked copper is never cleared.

## Separation from backend tuning

Backend choice, executable paths, iteration counts, raw rip-up limits, A* costs,
and backend-specific search switches are not board DSL. Portable `quality` and
candidate count are DSL policy; each backend adapter maps that policy to its
own supported controls. The router does not impose a time limit: callers stop
work only through the `AbortSignal` passed to `run(...)`.

```text
local router DSL = copper intent + electrical/routing rules
quality policy   = portable search objective
backend adapter  = engine-specific tuning
```

## Via fences

`viaFence(...)` is a portable special-routing statement. It marks every net in
`along` as special, routes those nets in the existing special stage alongside
differential pairs and matched groups, and then adds a via array next to their
actual retained track geometry before the remaining-routing stage starts.

```js
viaFence("RF_FENCE", {
  along: [
    "Net-(C1-Pad1)",
    "RF_IN_AC",
    "RF_OUT_DC",
    "Net-(C5-Pad2)",
  ],
  net: "GND",
})
```

The first argument is a stable fence name. `along` is a non-empty exact net
list; it is not a net-name pattern. `net` is the net assigned to every emitted
via. A fence is independent of impedance intent and may follow any routable
net, not only a differential pair or RF net.

Optional geometry controls are deliberately small:

```js
viaFence("RF_FENCE", {
  along: ["RF_IN_AC"],
  net: "GND",
  pitchMm: 0.8,
  offsetMm: 0.6,
  rows: 2,
  rowSpacingMm: 0.7,
  stagger: true,
  via: { diameterMm: 0.5, drillMm: 0.25 },
})
```

- candidates are always placed on both sides of the retained routed path.
  There is no `sides` option until a portable directed-path selector can
  define left and right without ambiguity;
- omitted `rows` means two rows per side. Every second row is shifted by half
  a pitch by default, forming a triangular lattice that covers the gaps in the
  preceding row; `rows` is limited to 1..8;
- omitted `rowSpacingMm` uses the triangular-lattice spacing
  `pitchMm * sqrt(3) / 2`; `stagger: false` disables the half-pitch shift;
- omitted via geometry is inherited from effective DRC for the fence net;
- omitted `offsetMm` is the closest DRC-correct offset derived from the routed
  signal width, effective clearance, and via diameter;
- omitted `pitchMm` selects a dense, DRC-correct automatic pitch;
- explicit values are requirements, not suggestions, and are rejected when
  they conflict with effective rules.

The feature adds no workflow phase and requires no via-fence implementation in
an external router backend. The backend routes the special `along` nets; the
router core post-processes their resulting tracks into via candidates. The
generated vias are present before remaining routing and therefore act as normal
obstacles for that pass.

A via fence is not a plane or zone generator. A fence via may be assigned to
`GND` without any GND plane in the same run. Net assignment alone does not
claim that the via is electrically connected; later native copper, plane fill,
or other routing must provide that connection, and final native verification
is authoritative. Fence vias are ordinary `RoutingResult.copper.vias`; there
is no fence-specific output geometry type and they do not create implicit
preconnected pad groups.

Placement is best-effort without weakening DRC:

- a candidate that conflicts with pads, tracks, vias, zones, keepouts, the
  board edge, or effective via rules is skipped;
- if any `along` net is incomplete, no fence is emitted and
  `VIA_FENCE_SOURCE_INCOMPLETE` records the exact missing nets;
- if no candidate can be placed, the statement records
  `VIA_FENCE_NOT_PLACED` and remaining routing still runs;
- intermediate fence diagnostics do not decide board validity; the final
  native verification does.

## Portable advanced routing statements

The next contract reserves portable statements/options for capabilities already
available in KRT and meaningful for other backends:

- explicit `busGroup(...)` rather than backend-only automatic bus detection;
- `matchedGroup(...)` with exactly one of length tolerance in millimetres or
  propagation-delay tolerance in picoseconds;
- AC-coupled differential-pair matching;
- automatic return vias near differential-pair signal vias, distinct from the
  explicit net-assigned `viaFence(...)` statement;
- explicit fanout method selection (`bga`, `qfn`, `stub`, or `underpad`); the
  current contract deliberately exposes only `disableFanout(component(...),
  pad(...))`, while KRT selects conservative QFN/QFP fanout automatically;
- teardrop post-processing;
- `onlyComponents(...)` as a portable scope selector.

Raw A* costs, MPS/inside-out switches, grid resolution, raw iteration and rip-up
limits, and proximity penalties remain adapter mappings of `quality(...)`.
Polarity/pin swaps and schematic rewrites remain outside this copper-only
contract until the result model can represent an explicit schematic/netlist
patch.

## Still open before implementation

- exact option names for the reserved advanced routing statements;
- which optional stack process fields are needed beyond impedance and
  current/via calculations;
- adapter capability diagnostics for features that a selected backend cannot
  implement.

## Rule semantics

Source rules arrive through `RoutingBoard.rules`. A DSL rule replaces only the
fields and scopes it explicitly assigns. Unspecified values inherit the source
rule. Semantic requirements are compiled to geometry; explicit absolute values
then constrain the same effective rule set. Overrides may be stricter or weaker
when the selected terminal operation applies DRC. Every difference is reported
in `RoutingResult.rules.overriddenFields`. The complete precedence decision is in
[`drc-rule-precedence.md`](./drc-rule-precedence.md).
