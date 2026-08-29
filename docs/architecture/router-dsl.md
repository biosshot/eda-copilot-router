# Local router DSL

Status: implemented public contract
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
signalNet("CLK", { trackWidthMm: 0.2, clearanceMm: 0.2 })
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

`maxCurrentA`, `trackWidthMm`, and `minTrackWidthMm` are compatible. The
current-derived width and `trackWidthMm` select the nominal high-current trunk
width; `minTrackWidthMm` remains the hard lower bound for legal neck-downs. If
none are present, the power net inherits both values from its named class or
effective DRC. The DSL does not require an LLM to repeat geometry already
supplied by the board.

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
  trackWidthMm: 0.254,
  via: {
    minDiameterMm: 0.45,
    diameterMm: 0.6,
    minDrillMm: 0.2,
    drillMm: 0.3,
  },
})
```

`netClass(...)` is the reusable physical-rule mechanism for ordinary or
special nets that share geometry but are not necessarily power nets:

```js
netClass("WIDE_SIGNALS", {
  nets: ["LED_A", "LED_B", "MOTOR_SENSE"],
  minTrackWidthMm: 0.3,
  trackWidthMm: 0.5,
  clearanceMm: 0.2,
  allowedLayers: "OUTER",
  via: { diameterMm: 0.8, drillMm: 0.4 },
})
```

All class fields except the class name and non-empty net membership are
optional and inherit from global DRC. An explicit per-net declaration may
further specialize its assigned class. Effective precedence is imported DRC,
then `drc(...)`, then `netClass(...)`, then explicit per-net/special intent.
`trackWidthMm` and `via.diameterMm` / `via.drillMm` are nominal routing
geometry. Their `min*` counterparts are hard lower bounds; set nominal and
minimum to the same value when neck-down must be forbidden.
Semantic requirements such as current or impedance are compatibility checks
and derived constraints; an explicit value that makes them impossible is a DSL
error.

When the terminal command is `applyDrcRules()` or `runAll()`, named DSL classes
are persisted as real named net classes by capable native host adapters, with
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
    referenceNet: "GND",
  },
})

diffPair("USB", {
  positive: "USB_DP",
  negative: "USB_DM",
  impedance: {
    targetOhm: 90,
    tolerancePercent: 10,
    referenceNet: "auto",
  },
})
```

Topology, signal layer, reference layers, and coplanar gap are deliberately not
authorable. The compiler evaluates effective `allowedLayers`, the resolved
stack, board-wide plane intents, and imported solid reference zones. It then
classifies microstrip, symmetric/asymmetric stripline, coplanar waveguide, or
grounded coplanar waveguide and selects the nearest unambiguous physical
solution. Omitted `referenceNet` is equivalent to `"auto"`.

For coplanar structures the gap comes from the maximum applicable DRC and zone
clearance, because that is the separation native refill will preserve. The
compiler derives width unless `trackWidthMm` was explicitly supplied, in which
case it verifies the achieved impedance and tolerance. It never guesses a
dielectric thickness, relative permittivity, or reference net; incomplete or
equally eligible reference geometry is a preflight error.

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

The compiler merges the declaration field-by-field with the imported stack and
materializes its copper entries as the effective `RoutingBoard.layers` before
polygon planning or backend routing. A two-layer input may therefore declare a
four-layer stack and route that effective four-layer board in the same
`run(...)` call. `RoutingResult.stackup` asks the host to apply the identical
physical stack before applying returned copper. Missing electrical properties
are errors only when a requested calculation, such as impedance, requires them.

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
applyStackup()
runCopper()
runRouting()
runAll()
```

These are DSL commands, not package API calls. They record the requested
operation in the interpreter and return no value. Only the outer package
`run(...)` call returns `RoutingResult`.

- `applyDrcRules()` compiles the DSL rule statements and requests that the host
  persist the effective DRC fields. It does not execute polygon or routing
  backends.
- `applyStackup()` requires `stack(...)` and requests only the physical stack
  update. It does not execute copper planning or KRT.
- `runCopper()` executes compact polygon, plane, grid-stitch, and around-stitch
  planning without starting KRT. It returns native zone outlines; the host owns
  the exact zone refill. Route-dependent `along` and `return` stitching require
  `runRouting()` or `runAll()`.
- `runRouting()` executes all requested polygon, plane, special-net, and
  ordinary routing work without requesting a native DRC update. An authored
  `stack(...)` is still returned for physical application because routed copper
  may use newly declared layers.
- `runAll()` is the single-command form of applying effective DRC rules first
  and then running the complete routing workflow. When `stack(...)` is present,
  stackup, rules, and copper are returned together for one transactional host
  apply.

Multiple terminal commands and a program with no terminal command are DSL
errors. `runAll()` is semantically equivalent to the two operations, but a DSL
program does not spell it as two command calls.

All rule statements are compiled for every operation. With
`runRouting()`, effective DSL rules may equal or tighten the source rules, but
they may not require copper that violates a weaker source constraint. Such a
program fails preflight with `DRC_APPLY_REQUIRED`; the caller must select
`runAll()` (or run a separate `applyDrcRules()` program) instead.

## Scope, cleanup, and net routing preferences

The following statements are part of the implemented contract:

```js
onlyNets("USB_DP", "USB_DM", "USB_VBUS")
ignoreNets("GND", "TEST_POINT")

signalNet("XTAL_IN", { priority: "critical", viaPreference: "avoid" })
signalNet("XTAL_OUT", { priority: "critical", viaPreference: "avoid" })

clearRouting({
  nets: ["USB_DP", "USB_DM"], // or "all"
  items: ["tracks", "vias", "zones"],
})
```

- `priority` is `critical`, `high`, `normal`, or `low`; omission means
  `normal`;
- `viaPreference` is `auto`, `avoid`, or `forbid`; omission means `auto`;
- `avoid` is a strong search preference and `forbid` is a prohibitive
  best-effort preference. Neither is a DRC rule, so KRT may still retain a via
  when that is the only useful partial result;
- `onlyNets` establishes the route scope and `ignoreNets` subtracts from it;
- differential pairs and matched groups are atomic when scope is resolved;
- copper already electrically connected by retained tracks or planned zones is
  removed from backend obligations;
- `clearRouting` can target all nets or an explicit net list;
- cleanup item kinds are explicit. The default is tracks and vias; zones are
  removed only when `"zones"` is requested;
- `clearRouting` performs the requested pre-route cleanup exactly as before.
  Outside that scope, transaction-owned editable copper may still be moved or
  replaced by KRT's custody-backed blocker recovery; fixed/locked copper may not;
- fixed copper is never cleared. Host adapters should normally import unlocked
  native tracks, vias, and zones as editable; genuinely locked copper and
  normalized non-routing copper obstacles remain fixed.

## Separation from backend tuning

Backend choice, executable paths, iteration counts, raw rip-up limits, A* costs,
candidate count, profiles, and backend-specific search switches are not board
DSL. The router selects its search policy from the board and resolved intent.
Callers stop work through the `AbortSignal` passed to `run(...)`.

```text
local router DSL = copper intent + electrical/routing rules
net preferences  = portable priority and via intent
router policy    = automatically selected search objective
backend adapter  = engine-specific execution
```

## Bus, impedance, zones, and via stitching

The accepted advanced contracts are implemented and maintained in
[`advanced-routing-contracts.md`](./advanced-routing-contracts.md). In short:

- `busDetect(true)` delegates automatic grouping to KRT and emits only `--bus`;
  numeric detection controls are passed only when explicitly authored;
- impedance intent contains target, tolerance, and an optional reference net.
  The core derives topology, routing/reference layers, coplanar DRC gap, and
  width from the stack and actual solid reference copper;
- `ZoneOptions` is shared by `polygon(...).zone(...)` and `plane({ zone: ... })`;
- `viaStitch(...)` is one discriminated intent with `grid`, `along`, `around`,
  and `return` modes.

```js
busDetect(true)

signalNet("RF_IN", {
  impedance: { targetOhm: 50, tolerancePercent: 10, referenceNet: "auto" },
})

polygon("GND").connect(net("GND")).on("TOP").compact().zone({
  padConnection: { mode: "thermal", thermalGapMm: 0.2, spokeWidthMm: 0.25 },
})

viaStitch("RF_RETURN", {
  mode: "return",
  referenceNet: "auto",
  forNets: ["RF_IN"],
  maxDistanceMm: 1,
})

viaStitch("RF_GUARD", {
  mode: "along",
  net: "GND",
  routes: ["RF_IN"],
  pitchMm: 0.8,
})
```

Raw A* costs, MPS/inside-out switches, grid resolution, raw iteration and
rip-up limits, and proximity penalties remain internal router/backend policy.
Polarity/pin swaps and schematic rewrites remain outside this copper-only
contract.

## Rule semantics

Source rules arrive through `RoutingBoard.rules`. A DSL rule replaces only the
fields and scopes it explicitly assigns. Unspecified values inherit the source
rule. Semantic requirements are compiled to geometry; explicit absolute values
then constrain the same effective rule set. Overrides may be stricter or weaker
when the selected terminal operation applies DRC. Every difference is reported
in `RoutingResult.rules.overriddenFields`. The complete precedence decision is in
[`drc-rule-precedence.md`](./drc-rule-precedence.md).
