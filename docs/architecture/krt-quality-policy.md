# KRT quality and safety policy

## Authority

The managed backend uses KiCadRoutingTools `v0.21.3`. KRT supplies search;
compiled `RoutingRules` and native verification remain authoritative. Quality
profiles may change search effort and route costs, but must never weaken DRC.

Ordinary `route.py` calls request an authoritative merged `--json-out`
artifact. The adapter retains every raw `JSON_SUMMARY` for forensics and the
single compact `JSON_SUMMARY_MIN` verdict, but derives diagnostics from the
merged artifact so a successful reconciliation cannot remain reported as a
first-pass failure.

## Hard geometry invariants

The adapter must not automatically reduce clearance, hole clearance, board-edge
clearance, via diameter/drill, an allowed-layer set, or the compiled hard track
minimum. Existing copper is kept and native rules are not rewritten by KRT.

Ordinary routing deliberately omits global `--clearance`: KRT treats it as a
ceiling which can flatten stricter net classes. Exact fabrication overrides
still pin the hard geometry. Because `route.py` accepts one via geometry, a
mixed invocation uses the largest required minimum via and drill. This can
reduce completion, but cannot create an undersized via.

`KICAD_NET_RESCUE` stays disabled because it may reduce clearance. Terminal
escalation is enabled for dense-pad escape and may reduce track width only to
the compiled minimum, never below `0.127 mm`.

## Neck-down and taper

Neck-down is always enabled:

```text
KICAD_IMPEDANCE_NECKDOWN=1
```

Preferred or impedance-derived width is nominal; the compiled minimum is the
hard width. Every quality profile requests a `0.5 mm` neck-down and `0.5 mm`
taper. The packaged patch preserves KRT's obstacle-aware wide/narrow decision,
merges artificial `0.5 mm` sampling cuts, and reconstructs the taper over the
full proven-wide run in 4..16 monotonic constant-width steps.

This is a smooth stepped transition, not a native KiCad teardrop. A KiCad track
segment has one constant width, while the current EDA-neutral result cannot
transport a native polygonal teardrop. Do not enable `--add-teardrops` until
that geometry can be returned and verified end-to-end.

## Quality profiles

| Profile | Grid | Main/probe iterations | Rip-up | Heuristic | Via/proximity/turn/direction costs | Dynamic | Blocker / abandon |
|---|---:|---:|---:|---:|---|---|---|
| `fast` | 0.10 | 120k / 5k | 2 | 2.0 | 50 / 10 / 1000 / 250 | off | `cost` / `stranded` |
| `balanced` | 0.10 | 300k / 5k | 4 | 1.8 | 50 / 10 / 1000 / 250 | off | `cost` / `complete-nets` |
| `quality-first` | 0.05 | 600k / 10k | 5 | 1.3 | 80 / 16 / 1500 / 400 | off | `cost` / `complete-nets` |
| `completion-first` | 0.05 | 750k / 10k | 5 | 1.9 | 10 / 0 / 250 / 0 | on | `mincut` / `weighted-probe` |

Fast and balanced automatically refine to `0.05 mm` when an in-scope nominal
track/differential feature is below `0.20 mm`, a terminal has a pad dimension
below `0.35 mm`, or another pad of the same component is within `0.65 mm`. The
pad thresholds deliberately match KRT's own fine-tap detector. The global
`0.127 mm` neck-down floor alone is not a trigger, so large power pads keep the
faster grid. Special and remaining scopes choose their grids independently.

Dynamic search extension is allowed only in `completion-first`. Production
does not use `--stats` or `--debug-memory`; KRT's stats path can repeat routing
work after a successful search.

## Dense-package escape audit

Managed KRT `0.21.3` ships a separate `qfn_fanout.py`. It detects
QFN/QFP geometry and emits short outward surface stubs, or an optional
under-pad via escape. `route.py` does not invoke this tool automatically, so
terminal escalation currently starts from the original pad even though the
fanout implementation is available.

A controlled PowerBank smoke test on U1 (QFN-40, 0.50 mm pitch) used the
compiled `0.20 mm` clearance, `0.127 mm` hard width, and `0.05 mm` grid. The
surface fanout escaped 20 of 25 non-GND nets and rejected five obstructed nets;
native KiCad DRC found no new errors. Running the unchanged balanced MPS route
after those stubs took 37.4 seconds and reduced the result from 10 open
non-GND nets to five: `USB_A1_DP`, `USB_A1_VBUS`, `USB_DM`, `VREG_3V1`, and
`VSYS_PORT`.

The router therefore orchestrates the existing KRT fanout rather than adding a
second escape geometry engine. It runs inside the KRT backend before maze
routing, uses compiled per-board geometry, and preserves accepted stubs as
locked input copper. KRT's own `qfn_fanout.py` post-fanout DRC summary is
retained; there is no separate native fanout checkpoint. Native DRC remains the
final board-level authority. Fanout is attempted once per dense component over
the complete routing scope before power, differential, matched, or ordinary
maze routing. The generated stubs remain independent local escapes; coupled
members are still completed by KRT's differential routing path.

`powerNet(...)` does not make a net special. It supplies electrical geometry
to the ordinary/main KRT pass; only differential pairs, matched groups and
`viaStitch(...)` mode-`along` source nets belong to the logical special scope.

The DSL can select the QFN/QFP escape method without restating DRC geometry:

```js
fanout(component("U1"), { method: "auto", extensionMm: 0.2 })
disableFanout(component("U3"), pad("U1", 14), pad("U1", 15))
```

`auto` keeps accepted surface stubs and retries only unescaped nets with the
under-pad via method. `stub` and `underpad` select one method directly.
Fanout vias always permit via-in-pad; the fanout subprocess receives the
explicit KRT `same-net-pad-clearance=-1` sentinel. Via diameter/drill,
clearance, edge clearance and track width still come from compiled DRC.

A component target suppresses all automatic fanout on that component. A pad
target suppresses every physical pad sharing that logical component/pad key.
Neither form disables normal routing. Pads already connected by generated
polygon copper remain eligible: polygon connectivity collapses later maze
terminals but must not suppress a useful escape from a dense package. Pads
already touching routed track/via copper are not fanned again.

Automatic component fanout excludes nets owned by the special stage. Their
diff-pair, matched-group, or along-stitch router must leave the dense package from
the original pads as one atomic geometry problem; asymmetric fixed stubs can
otherwise make a routable pair fail clearance. Ordinary pad escapes are still
reserved before special routing.

The whole-board profile cascade degrades toward completion, not away from it:

- `fast` and `completion-first`: selected profile only;
- `balanced`: balanced, then completion-first;
- `quality-first`: quality-first, balanced, then completion-first.

The first whole-board candidate with zero open nets wins. The cascade contains
at most three distinct quality profiles.

Within each profile, the much cheaper special stage has its own bounded search
portfolio. `quality.maxCandidates` is passed through as its limit (hard maximum
16), and the search stops as soon as all declared special nets pass KRT's
geometry-aware connectivity audit without increasing the special-net DRC
violation count. Every attempt starts from the same immutable pre-special
board. The deterministic variants include:

- declared pair order (`original`) with zero rip-up first;
- ordinary MPS and reversed-round MPS (most-conflicting round first);
- inside-out ordering;
- isolated variants with zero, profile maximum, half-maximum and one rip-up.

The selected special candidate alone is copied forward. Rip-up in a losing
candidate therefore cannot damage a pair routed by another candidate. KRT GND
return vias are disabled during differential search because PowerBank showed
real pair-via clearance errors; explicit return stitching or later plane
stitching owns those vias with board-level context.

`single_ended_followup_nets` are not silently accepted. The adapter invokes one
scoped `route.py` follow-up with zero rip-up, verifies that all existing coupled
copper remains a multiset subset of the result, and reruns KRT's connectivity
checker. A fully deferred or failed pair remains invalid even when ordinary
single-ended copper could connect its members. Only a routed multipoint pair
with short incomplete branches can become complete through this follow-up.

## Argument rules

- Ordinary, power and completion subprocesses use `--ordering mps`. Isolated
  special candidates may use `original`, `mps`, reversed-round `mps`, or
  `inside_out`. `KICAD_DIRECT_FIRST=0` prevents KRT from repartitioning
  bare-BGA nets after the selected order; scope selection is not an implicit
  priority override.
- `route.py`-only neck-down and rip-up-abandon options are never sent to
  `route_diff.py`.
- Differential intra-pair matching is enabled only when a skew limit was
  compiled; no arbitrary `0.1 mm` requirement is invented.
- Native GND return vias are suppressed during differential search; explicit
  `viaStitch(...)` mode `return` runs against final routed and plane geometry.
- A mixed set of skew-constrained and unconstrained differential pairs fails
  preflight instead of globally imposing meanders on every pair.
- Different match tolerances in one atomic special invocation also fail
  preflight instead of silently applying the strictest tolerance to all groups.
- DSL meander spacing is centre-to-centre millimetres; KRT receives
  `spacingMm / trackWidthMm`, because its CLI uses width multiples.
- Conflicting per-net layer sets fail preflight. An output track outside its
  compiled layers rejects the routed delta.
- `--keep-input-copper`, `--no-fix-drc-settings`, fixed-zone obstacles and
  exact fabrication overrides remain mandatory.

## Deferred, not silently promised

- native track/pad teardrops;
- per-net via geometry or incompatible layer groups in one process;
- additional candidate dimensions beyond ordering and bounded rip-up;
- terminal-specific `powerPads` / `tapWidthMm` topology;
- enforcement of `maxUncoupledLengthMm`;
- KRT time matching, AC-coupling matching and per-layer costs;
- native KRT coplanar/impedance controls beyond compiled width/gap;
- layer-swap and proximity-guide portfolio variants.

Each new upstream option needs an exact DSL mapping, DRC-preserving defaults,
result validation, and an E2E regression before it becomes production policy.
