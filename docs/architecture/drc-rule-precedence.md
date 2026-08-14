# DRC rule precedence

This decision is authoritative for the router refactor.

1. Rules imported from DSN, KiCad, EasyEDA, or another board adapter are the
   default source rules.
2. Router DSL rules have higher priority.
   Global `drc(...)` fields are followed by reusable named `netClass(...)`
   fields and then explicit per-net/special declarations.
3. A DSL rule replaces only the fields and scopes it explicitly specifies.
   Unspecified fields inherit their source values.
4. One DSL statement may combine semantic requirements and absolute DRC
   parameters. Semantic requirements are compiled first. Compatible bounds are
   intersected; for example, a current-derived minimum width of 0.52 mm plus an
   explicit minimum of 0.60 mm produces 0.60 mm.
5. DSL overrides may be stricter or weaker than source rules. A value
   difference between DSN and DSL is not `RULE_CONFLICT`.
6. Contradictions inside the DSL are errors. Examples include a derived minimum
   width above an explicit maximum, or an exact width below a current-derived
   minimum.
7. The compiler emits effective rules for backends and records source
   differences in `RoutingResult.rules.overriddenFields`.
   Parameters already present in imported rules/stackup are not required in
   the DSL. Missing values use a documented safe fallback only when one exists;
   otherwise a feature that needs the value fails preflight instead of guessing.
8. `applyDrcRules()` and `runAll()` set
   `RoutingResult.rules.applyRequested=true`; the target adapter persists the
   effective overrides before native copper application/refill.
   Named DSL net classes are persisted as named native classes, including exact
   net assignments, when the target adapter supports native classes.
9. `runRouting()` sets `applyRequested=false`. It may use equal or stricter DSL
   requirements without persisting them, but preflight rejects any effective
   rule that would make generated copper illegal under the unchanged source
   DRC with `DRC_APPLY_REQUIRED`.
10. Invalid values, unknown nets/layers, and lossy backend translation remain
    errors.

Example:

```text
DSN USB_VBUS minimum width: 0.20 mm
DSL current-derived minimum: 0.52 mm
DSL absolute minimum width:  0.65 mm
Effective minimum width:    0.65 mm
overriddenFields:            0.20 -> 0.65 mm
```

The same precedence applies when the DSL deliberately requests a smaller
value. The router must not silently restore the DSN value, but that weaker
value requires `applyDrcRules()` or `runAll()` before it can be used for
routing.

The three terminal commands are imperative DSL statements and return no value.
The outer `run(...)` API returns the result containing the effective rules,
override report, optional routed copper, diagnostics, and metrics.
