# DRC rule precedence

This decision is authoritative for the router refactor.

1. Rules imported from DSN, KiCad, EasyEDA, or another board adapter are the
   default source rules.
2. Router DSL rules have higher priority.
3. A DSL rule replaces only the fields and scopes it explicitly specifies.
   Unspecified fields inherit their source values.
4. DSL overrides may be stricter or weaker than source rules. A value
   difference between DSN and DSL is not `RULE_CONFLICT`.
5. Derived DSL requirements, such as a width calculated from current and
   temperature rise, are treated as explicit DSL overrides after calculation.
6. The compiler emits effective rules for backends and records differences
   from the source as `RoutingResult.drcChanges`.
7. The target adapter persists those changes before applying tracks, vias, and
   zones, then runs native refill and DRC against the effective rules.
8. Invalid values, contradictory DSL assignments to the same field and scope,
   unknown nets/layers, and lossy backend translation are still errors.

Example:

```text
DSN USB_VBUS minimum width: 0.20 mm
DSL USB_VBUS minimum width: 0.65 mm
Effective minimum width:    0.65 mm
RoutingResult.drcChanges:   0.20 -> 0.65 mm
```

The same precedence applies when the DSL deliberately requests a smaller
value. The router must not silently restore the DSN value.
