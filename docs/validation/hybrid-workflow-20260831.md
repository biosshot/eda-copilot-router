# Hybrid/KRT corpus validation — 2026-08-31

Branch: `feat/hybrid-easyeda-wasm-routing`  
KRT: `0.21.3`  
KiCad validation: `10.0.0`

## Pad-hole correction

The first research export lost native EasyEDA drill metadata. A plated
through-hole pad therefore reached KiCad as a copper pad on both layers with
`type=smd`, and KiCad quite correctly refused to use it as a layer bridge. This
looked deceptive in the editor: a B.Cu track could end exactly under the pad,
while DRC still reported a missing connection to the pad or an F.Cu track.

The production host now exports `pcb_PrimitivePad.getState_Hole()` records next
to the autorouter capture. The MCP adapter matches them by primitive id, or by
component, pad number, net and absolute position for older/reused EasyEDA pad
keys. Round and slotted holes, local offset and footprint rotation are retained
in the existing `RoutingPad.hole` contract; no DSL or public request/response
contract was added.

The nine historical inputs were copied into
`tests/e2e/_corpora/easyeda-hybrid/fixture`. Because those captures predate the
host fix, their explicitly documented drill overrides are conservative test
data and are marked `fabricationAuthoritative: false`. Future captures use the
native SDK value directly.

KiCad 10 DRC on all nine regenerated boards reports:

- `0` invalid/multi-layer-SMD padstack violations;
- J3.5 on `83efabb6` is now a `PTH pad`, not an all-copper SMD pad;
- the false `UART_TX` track-to-J3.5 missing connection is gone;
- no trace or via had to be moved to obtain that result.

## Physical stack correction

The first generated KiCad boards wrote adjacent copper records when a two-layer
EasyEDA declaration omitted its dielectric. KiCad still used `(general
(thickness 1.6))` for the 3D body, but the physical `(stackup ...)` described
only `0.06958 mm` of copper and no substrate. The codec now inserts the one
unambiguous 2L dielectric as finished thickness minus copper and explicitly
declared solder mask. For more than two copper layers every dielectric gap is
mandatory and preflight stops before backend execution when it is absent.

All nine saved boards were regenerated. Their stack sequence alternates copper
and dielectric, their serialized thickness sums to exactly `1.6 mm`, and KiCad
10 successfully imports and renders every board. The 4L fixture explicitly
declares `0.2 / 1.06084 / 0.2 mm` dielectric gaps. Solder mask is now preserved
as `F.Mask/B.Mask` instead of being dropped on export or misread as dielectric
on import.

## How the numbers are read

`Router open` is the final exact-scope Copilot Router audit. GND is normally not
maze-routed. `KiCad open` is the count of unique net names in native KiCad
`unconnected_items`, shown as `all / non-GND`. KiCad's item count is larger
because one open multipoint net can produce many missing item pairs.

The values now agree for ordinary full-board scopes. Two intentional exceptions
remain:

- `c6a5bead`: the router conservatively retains `ANTENNA` as open while KiCad
  considers the final copper connected;
- `b277f943`: the DSL routes an eight-net partial-power scope, while full-board
  KiCad DRC also reports the unrelated pre-existing open nets outside that
  scope.

## Reproducible EasyEDA corpus results

| Case | Tier / workflow | Wall time | Router open | KiCad open all/non-GND | KiCad items | Invalid padstack | Semantic result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `f841a674` | diagnostic / hybrid 2L | 74.846 s | 3 | 4 / 3 | 42 | 0 | differential route incomplete |
| `af23609f` | diagnostic / hybrid 2L | 33.598 s | 0 | 1 / 0 | 23 | 0 | three matched groups not verified |
| `8dcca4bc` | diagnostic / hybrid 2L | 96.365 s | 0 | 1 / 0 | 48 | 0 | QSPI 5-net group verified; GPIO group outside tolerance |
| `83efabb6` | archive / hybrid dense 2L | 208.097 s | 35 | 36 / 35 | 123 | 0 | dense checkpoint remains partial |
| `2568fa74` | stable / hybrid KRT-scoped 2L | 19.367 s | 0 | 0 / 0 | 0 | 0 | `RF_IN` and `RF_OUT` impedance verified |
| `2a52a7eb` | stable / pure KRT 4L | 35.930 s | 0 | 0 / 0 | 0 | 0 | one ESD differential pair verified |
| `c6a5bead` | diagnostic / hybrid 2L | 45.076 s | 1 | 1 / 0 | 38 | 0 | conservative `ANTENNA` partial |
| `4a770e3e` | archive / hybrid dense 2L | 193.866 s | 40 | 41 / 40 | 236 | 0 | duplicate dense failure checkpoint |
| `b277f943` | diagnostic / hybrid partial scope | 72.081 s | 8 | 41 / 40 | 223 | 0 | safe baseline retained, no editable copper |

The default corpus run contains only the two reproducible `stable` cases. `diagnostic`
cases have useful bounded partial expectations. The two expensive, largely
duplicated dense checkpoints remain reproducible as `archive`, but do not slow
the default suite. `--all` still runs every case. Expectations are upper bounds
on open nets and time, so a future improvement passes rather than breaking an
exact copper snapshot.

## Feature observations

### Matched groups

`8dcca4bc` closes every non-GND net, but two consecutive reruns produced the
same honest partial semantic result:

- QSPI: 5 nets, spread `6.506 mm <= 8 mm`;
- GPIO header: 14 nets, spread `9.808 mm > 8 mm`.

An earlier run happened to verify all 19 matched nets, but the current workflow
does not reproduce that result. The case is therefore diagnostic rather than a
default green regression. Its connectivity remains useful and its partial
diagnostics are preserved.

`af23609f` demonstrates the opposite case: final connectivity is zero-open,
but none of its three matched groups passed the length audit. It is retained as
a diagnostic fallback test, not advertised as a successful matched result.

### Stackup-aware impedance

`2568fa74` uses the physical stack:

- F.Cu copper `0.03479 mm`;
- FR-4 dielectric `1.49042 mm`, `Er=4.2`;
- B.Cu copper `0.03479 mm`;
- top and bottom solder mask `0.02 mm` each, `Er=3.3`;
- target `50 ohm`, grounded-coplanar gap `0.2 mm`.

The solver selected `0.842 mm`; KRT emitted a tapered `0.842773 mm` trunk and
calculated `50.0046 ohm`. `RF_IN` and `RF_OUT` are verified. The short
`RF_IN_IC`/`RF_OUT_IC` pad escapes are only `1.953 mm` long and remain at
`0.3 mm`, so they correctly produce `no-impedance-width-trunk` diagnostics.

### Four-layer pure KRT

`2a52a7eb` closed every non-GND net in `35.930 s` with no scoped KRT DRC
regression and no native KiCad open item. One ESD differential pair is fully
verified. Two other pairs are electrically short in the source topology and
fall back to single-ended completion, so the result remains honest `partial`.

### Performance boundary

The former `b277f943` run took `776 s`, including `648.15 s` in one
single-ended `net_rescue`. The bounded workflow now returns the safe original
checkpoint after `72.081 s` (`10.8x` faster) instead of spending ten minutes on
an ultimately rejected candidate.

The old `routed_output` nightly E2E exposed a separate remaining gap: its first
`route_diff.py` special candidate was still running after `615 s` and was
manually aborted. Single-ended rescue limits do not bound this differential
search path. This fixture is therefore not a passing/default regression and
needs a dedicated differential-search iteration budget.

## Existing focused KiCad E2E audit

The accepted focused set was run after the workflow changes:

| Case | Time | Router status | Non-GND open nets before → after | Native DRC before → after | Classification |
| --- | ---: | --- | ---: | ---: | --- |
| `cap_chain` | 18.750 s | complete | 3 → 0 | 0 → 0 | stable smoke |
| `qfn_diffpair_escape` | 17.340 s | partial | 1 → 1 (`FOREIGN`) | 6 → 6 | stable preservation/escape regression |
| `band_amp` | 40.430 s | partial | 7 → 2 | 61 → 61 | diagnostic impedance partial |
| `powerbank` | 140.180 s | partial | 27 → 11 | 89 → 90 | diagnostic; one warning regression |
| `splitflap_driver` | 31.270 s | complete | 82 → 0 | 77 → 78 | diagnostic until warning delta is explained |
| `routed_output` | >615 s | aborted/error | no final audit | no final audit | blocked nightly only |

All `e2e:no-kicad` variants pass: portable, polygon planning, managed KRT,
native workflow, matched semantics, EasyEDA WASM bottom-pad, standalone native
and packed-package installation.

## Conclusion

- The hole bug was real and is fixed at the EasyEDA source, not papered over in
  KiCad. Existing captured boards are now reproducible without reloading them.
- One EasyEDA bulk pass plus one shared KRT transaction works well when EasyEDA
  receives the ordinary two-layer nets; pure KRT remains the multilayer path.
- Connectivity, matched, differential and impedance dimensions must stay
  separate. A zero-open board is not automatically a semantically successful
  board.
- Partial results and all failed-attempt diagnostics are preserved.
- Dense power-heavy partitioning and the unbounded differential special search
  remain explicit follow-up problems; adding more pre/early/post stages would
  not solve either root cause.
