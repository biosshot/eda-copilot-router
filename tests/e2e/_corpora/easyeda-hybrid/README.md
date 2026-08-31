# EasyEDA hybrid routing corpus

This corpus contains the real canonical `RoutingBoard + RoutingProgram` inputs
used during the 2026-08-31 hybrid/KRT workflow study. The runnable fixtures are
stored in the repository; no test reads `%TEMP%`, an EasyEDA document, or a
research-results directory.

Each case contains:

- `fixture/<id>/input.json`: the complete canonical router request;
- `fixture/<id>/routing.dsl.js`: the original public DSL source;
- `fixture/<id>/hole-overrides.json`: the historical pad-hole normalization
  applied while importing the old capture.

New EasyEDA captures do not need these overrides. The host now exports native
`pcb_PrimitivePad.getState_Hole()` records alongside autorouter JSON. Historical
captures predate that fix, so their drill data is documented explicitly and is
kept conservative for routing clearance. These derived fixtures are regression
inputs, not fabrication sources.

Run every case:

```text
npm run e2e:easyeda-hybrid-corpus -- --all
```

Run selected cases:

```text
npm run e2e:easyeda-hybrid-corpus -- 8dcca4bc 2568fa74
```

With no case arguments, only cases classified as `stable` in `manifest.json`
run. `diagnostic` cases are useful targeted regressions with known partial
results. `archive` keeps expensive historical checkpoints reproducible without
putting duplicate three-minute failures in the default suite. `--all` still
runs all three tiers.

Every case has measured, improvement-friendly expectations: an upper bound on
open nets and runtime rather than an exact copper fingerprint. Stable cases
also assert the semantic feature that makes them useful (matched-group,
impedance, or differential verification). Results and generated KiCad boards
are written below ignored `results/`.
