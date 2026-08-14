# Local router DSL

Status: accepted and implemented
Date: 2026-08-13

## Fixed decisions

The canonical DSL is the existing local statement-oriented JavaScript DSL used
by the polygon engine and similar in style to the server placement DSL. It is
not JSON and has no required top-level wrapper.

Do not introduce `routing({ copper, rules, ... })`, `RoutingIntentV2`, an AST
version field, or a second incompatible polygon builder.

The existing copper syntax and signatures remain stable:

```js
polygon("VSYS")
  .connect(pad("U1", 8), pad("L1", 2))
  .on(topLayer())
  .compact()

plane({
  net: "GND",
  layers: outerLayers(),
  region: board(),
  stitching: true,
})
```

In particular:

- `polygon(net)` keeps its current signature; no mandatory polygon ID is added;
- `plane({...})` keeps its object form;
- `pad`, `net`, `board`, `components`, `topLayer`, `bottomLayer`, `layers`, and
  `outerLayers` retain their meanings;
- polygon geometry is semantic and contains no generated coordinates;
- `components(...)` remains reserved until implemented;
- omission of stitching does not silently enable it.

## Rule statements

DRC and electrical routing requirements belong in this same local router DSL,
not in the component-placement DSL. They are independent top-level statements
next to `polygon(...)` and `plane(...)`, not entries in a wrapper array.

The implemented rule vocabulary covers:

- an ordinary net rule: width, clearance, allowed layers, via geometry, and
  optional length/impedance requirements;
- a power net rule: exactly one of maximum current or explicit minimum width,
  optional temperature rise (default 16 C), width ceiling (absolute maximum
  10 mm), and via-current intent;
- differential pair membership and optional width, gap, impedance, skew,
  uncoupled length, layers, and via constraints;
- explicit equal-length groups and tolerance;
- manufacturing fallbacks such as 1 oz copper only when the input does not
  provide a stackup.

```js
signalNet("CLK", { trackWidthMm: 0.2, clearanceMm: 0.2, maxLengthMm: 40 })
powerNet("VBUS", { maxCurrentA: 2, maxTempRiseC: 16, maxTrackWidthMm: 4 })
diffPair("usb", {
  positive: "USB_DP",
  negative: "USB_DM",
  gapMm: 0.2,
  maxSkewMm: 0.25,
})
matchedGroup("data", { nets: ["D0", "D1", "D2"], toleranceMm: 0.1 })
fabrication({ fallbackCopperThicknessOz: 1, viaPlatingThicknessUm: 20 })
```

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

## Separation from runtime policy

Backend choice, executable paths, quality profiles, candidate limits,
iteration counts, rip-up limits, costs, and meander search preferences are not
board DSL. They are runtime options supplied to the outer `run(...)` call or
CLI. The router does not impose a time limit: callers stop work only through
the `AbortSignal` passed to `run(...)`.

```text
local router DSL = copper intent + electrical/routing rules
routing policy   = how aggressively backends search
```

## Rule semantics

Source rules arrive through `RoutingBoard.rules`. A DSL rule replaces only the
fields and scopes it explicitly assigns. Unspecified values inherit the source
rule. Semantic requirements are compiled to geometry; explicit absolute values
then constrain the same effective rule set. Overrides may be stricter or weaker
when the selected terminal operation applies DRC. Every difference is reported
in `RoutingResult.rules.overriddenFields`. The complete precedence decision is in
[`drc-rule-precedence.md`](./drc-rule-precedence.md).
