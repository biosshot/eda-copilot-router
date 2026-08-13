# Local router DSL

Status: partially accepted; DRC function signatures pending
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

The rule vocabulary must cover at least:

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

Exact function names, argument order, and chaining/object style for these rule
statements are intentionally not accepted yet. No implementation should choose
them before a dedicated DSL review. This prevents the experimental
`routing({ ... })` API from becoming an accidental contract.

## Separation from runtime policy

Backend choice, executable paths, quality profiles, candidate limits, timeout,
iteration counts, rip-up limits, costs, and meander search preferences are not
board DSL. They are runtime options supplied to the route call or CLI.

```text
local router DSL = copper intent + electrical/routing rules
routing policy   = how aggressively backends search
```

## Rule semantics

Source rules arrive through `RoutingBoard.rules`. A DSL rule replaces only the
fields and scopes it explicitly assigns. Unspecified values inherit the source
rule. Overrides may be stricter or weaker and every difference is emitted as a
DRC change. The complete precedence decision is in
[`drc-rule-precedence.md`](./drc-rule-precedence.md).
