# EDA-neutral router package

## Goal

The routing core must not need a live EasyEDA, KiCad, or other editor session.
An editor is contacted only at the transaction boundaries:

```mermaid
flowchart LR
  A["Native EDA document"] -->|capture once| B["PcbSnapshotV1"]
  B --> C["RoutingIntentV2 + RoutingPolicy"]
  C --> D["Pure routing core and injected backends"]
  D --> E["PcbPatchV1 + result snapshot + report"]
  E -->|apply once| F["Native EDA document copy"]
  F -->|optional refill and DRC| G["Native verification report"]
```

This boundary keeps slow or unstable editor APIs out of routing iterations and
makes the same routing problem reusable by multiple backends.

## Contracts

### `PcbSnapshotV1`

A snapshot contains a versioned `RawPcbV1`, its deterministic content hash,
and capture diagnostics. `RawPcbV1` uses millimetres, an explicit coordinate
convention, normalized copper geometry, stable primitive IDs, compiled routing
rules, layer stack, keepouts, zone outlines and native filled-copper contours.

The snapshot is immutable input. A backend must never mutate it.

### `RoutingIntentV2`

The intent describes electrical and copper requirements:

- compact power polygons and planes;
- power-current or explicit minimum-width requirements;
- differential pairs and matched groups;
- optional signal limits and manufacturing fallbacks.

It does not contain executable paths, backend names, timeouts, costs, or
meander search parameters. Those belong to runtime configuration or
`RoutingPolicy`.

Source DRC is the default. Router DSL rules override the source/DSN values only
for explicitly assigned fields and scopes; all other fields remain inherited.
Overrides may tighten or weaken the source rule. Every resulting difference is
returned as a DRC change for the target adapter to persist before native refill
and validation. Conflicting source and DSL values are therefore not a preflight
error; invalid or internally contradictory DSL remains an error.

### `PcbPatchV1`

A patch is tied to `baseSnapshotHash` and contains stable-ID add, remove, and
replace operations for routing copper. Applying it to another revision is an
error. The pure in-memory applicator is deterministic; an EDA adapter applies
the same operations transactionally to a native document copy.

Patch output is deliberate. Rebuilding a whole native PCB from generic JSON
would lose editor-specific footprint properties, library links, UUIDs, 3D
models, constraints, and other metadata.

## Validation ownership

The offline core can validate its normalized geometry and report
`complete`, `partial`, or `error`. It cannot honestly claim final native
validity because zone refill and exact DRC semantics belong to the target EDA.

Every core result therefore states whether native verification is required.
Only an optional edge verifier may apply the patch, refill native zones, run
native DRC/connectivity checks, and produce a final `valid` decision.

## Adapter responsibilities

A board-format adapter has two independent operations:

1. `capture(source) -> PcbSnapshotV1`
2. `apply(source, patch) -> native output copy`

Capture must provide stable IDs and compiled rules. Apply must reject a base
hash mismatch, preserve unknown native data, and avoid destructive clear-and-
rebuild behavior.

EasyEDA therefore needs a transactional patch bridge in addition to its
current preview-oriented `getPcbRaw()`. KiCad can use pure file parsing and
writing, with native refill/DRC as an optional final verifier.

## Backend responsibilities

A backend receives only an EDA-neutral routing problem. It declares explicit
capabilities and returns a patch candidate plus diagnostics. A capability or
rule mismatch is detected before the external process starts. Backend failure
is data in the report, not an uncaught workflow exception.

External engines are optional. The npm package must not download tools in a
postinstall hook. Executable and asset locations are supplied explicitly by
the host or by optional companion packages.

## Migration

The existing polygon and full-board workflows remain available as legacy
entrypoints while the boundary is migrated:

1. add package-owned contracts, DSL v2, public API, and CLI;
2. adapt current EasyEDA/KiCad captures to `PcbSnapshotV1` without changing
   routing behavior;
3. make the polygon engine consume the new snapshot;
4. wrap KRT, Freerouting, and EasyEDA WASM behind the neutral backend contract;
5. add transactional native patch writers and native verification adapters;
6. remove sibling source imports only after equivalent conformance fixtures
   pass for both editors.

The old shared `RawPcb` is retained as `RawPcbLegacy` during this migration. It
is a lossy geometry view and is not a supported round-trip interchange format.
