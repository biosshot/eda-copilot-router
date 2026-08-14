# Local router DSL

Status: next contract under discussion; accepted decisions below are not all implemented yet
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
- omission of stitching does not silently enable it.

## Rule statements

DRC and electrical routing requirements belong in this same local router DSL,
not in the component-placement DSL. They are independent top-level statements
next to `polygon(...)` and `plane(...)`, not entries in a wrapper array.

The target rule vocabulary covers:

- an ordinary net rule: width, clearance, allowed layers, via geometry, and
  optional length/impedance requirements;
- a power net rule: exactly one of maximum current or explicit minimum width,
  optional temperature rise (default 16 C), width ceiling (absolute maximum
  10 mm), and via-current intent;
- differential pair membership and optional width, gap, impedance, skew,
  uncoupled length, layers, and via constraints;
- explicit equal-length groups and tolerance;
- a full physical board stack with 1 oz used only as a fallback when the input
  and DSL do not provide copper thickness.

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

## Still open before implementation

- the exact `drc(...)` and reusable `netClass(...)` shapes;
- the complete `stack(...)` fields for solder mask, dielectric loss tangent,
  finished thickness, and process limits;
- which portable KRT features become DSL concepts (bus groups, time matching,
  AC-coupled pair matching, return vias, fanout, teardrops) and which stay
  profile/backend implementation details.

## Rule semantics

Source rules arrive through `RoutingBoard.rules`. A DSL rule replaces only the
fields and scopes it explicitly assigns. Unspecified values inherit the source
rule. Semantic requirements are compiled to geometry; explicit absolute values
then constrain the same effective rule set. Overrides may be stricter or weaker
when the selected terminal operation applies DRC. Every difference is reported
in `RoutingResult.rules.overriddenFields`. The complete precedence decision is in
[`drc-rule-precedence.md`](./drc-rule-precedence.md).
