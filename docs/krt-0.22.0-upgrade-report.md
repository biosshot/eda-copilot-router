# KRT 0.22.0 integration and routing policy changes

Date: 2026-09-10. Local validation: Windows x64, Python 3.11, KiCad 10.0.

## Scope

- GND and /GND participate in KRT, Hybrid and WASM routing, fanout, fallback,
  recovery and connectivity accounting. onlyNets/ignoreNets remain explicit.
  The compiler applies the runAll width floor to ground too. The former
  krtUnplannedGroundNets export is retained as a deprecated empty diagnostic.
- QFN no longer receives `--allow-via-in-pad` or the forced
  `--same-net-pad-clearance -1`. Plane stitching defaults viaInPad to false;
  existing explicit viaInPad=true DSL requests remain supported.
- At the user's request, no positive same-net-pad-clearance is introduced.
  This change removes automatic opt-ins; it is not a board-wide prohibition
  on every via-in-pad placement in ordinary routing or rescue.
- Managed KRT is pinned to [v0.22.0](https://github.com/drandyhaas/KiCadRoutingTools/releases/tag/v0.22.0).
  The archive size is 7,467,221 bytes and its SHA-256 is
  `75df60b82df577f5087be07ff07b3ef1b867c362ba57da8ad347c1f6a5f2f66e`.

## Compatibility

The [upstream design-rule change](https://github.com/drandyhaas/KiCadRoutingTools/pull/866)
makes --clearance a Default-class override. Ordinary and ordinary-matched
calls already inherit materialized project rules without this argument.
Special calls retain their compiled Default-class value. No call uses the
new --clearance-ceiling to flatten stricter classes. Names and comments in
the adapter now describe this contract. Existing fab-overrides and hard-rule
audits remain active.

Installer metadata, documented release pins and CI cache assertions use
0.22.0. The production installer downloaded the release into its normal cache
with source=download, passed its startup/capability/patch checks, and ran the
native E2Es without a development KRT override.

## Checks

- Full `npm run test:package`: PASS, including bundled WASM offline Hybrid
  fallback, backend contracts, codec/adapter checks, and both corpus manifests.
- Managed `krt.mjs`, `krt_native_workflow.mjs`, `krt_ground.mjs`, and
  `krt_matched_semantic.mjs`: PASS.
- Ground regressions also passed on 0.21.3 before the version change:
  GND and /GND without a plane; exact ignoreNets; a connected plane needing no
  new tracks; split plane islands needing a connection; an impossible ground
  route remaining in openNets.
- Plane stitching regression: a coarse grid no longer adds pad-centered vias
  implicitly, while explicit viaInPad=true still works.
- The QFN corpus invocation artifacts confirm neither via-in-pad CLI flag is
  forced. The existing Python filled-zone/neckdown patch also passed its
  synthetic check against the downloaded 0.22.0 release during assessment.

## Native corpus comparison

Both arms use the same updated ground and via-in-pad policy. The old arm
selects the local 0.21.3 runtime via development override; the new arm uses
the managed 0.22.0 release. Version labels in old-arm runtime metrics still
reflect the package pin, so the run IDs and explicit override identify the
actual engine. Fixtures were unchanged. QFN adds explicit
`fanout(component("U1"), { method: "underpad" })` to its original pair DSL.

Each arm ran KiCad baseline/final DRC. Counts below include ground and all
native violations, not just routed-net scope. “Added DRC” compares each result
with its own input, not with the other engine.

| Case | Native open nets, both versions | Final native errors / warnings, both | Added DRC, both | Tracks 0.21.3 → 0.22.0 | Vias, both |
| --- | --- | --- | --- | --- | --- |
| cap_chain | none | 0 / 0 | 0 | 20 → 20 | 0 |
| qfn_interior_pads + explicit underpad fanout | FOREIGN | 5 / 5 | 4 | 14 → 14 | 2 |
| band_amp | RF_IN_AC, RF_OUT_DC | 4 / 57 | 0 | 95 → 94 | 72 |

There is no regression in native open-net or DRC counts between these engine
versions on this sample. This is not a full-corpus quality or speed claim;
the runs overlapped, so wall time is not a controlled benchmark.

The QFN stress case is not DRC-clean. Both arms add two 0.127 mm fanout tracks
which KiCad grades against a 0.2 mm minimum, plus two dangling-via warnings.
The fixture has no .kicad_pro and already contains three 0.127 mm tracks
reported below that minimum. Its remaining FOREIGN disconnected copper is
outside the backend's multi-pad routing scope. The old backend reports
partial and the new one complete after an upstream diagnostic change, even
though native findings are the same. Use the native evidence above, not that
status change, to evaluate this case. Aligning missing-project import rules
and reporting all orphan copper are separate follow-up work.

Band_amp intentionally opts into viaInPad=true in its existing DSL. Its
72 vias therefore do not test the new stitching default. It retains the same
two open RF nets on both engines; ground is connected after refill.

Local comparison artifacts are in `results/e2e/kicad-routing-tools/`
(`cap_chain`, `qfn_interior_pads`) and `results/e2e/band-amp/band_amp/`,
with run IDs `router-021-20260910` and `router-022-20260910`. Each contains
summary.json, routing-result.json, native DRC reports and KRT invocation files.

## Remaining validation limits

Linux and macOS CI matrices were updated but not executed locally. The full
22-board corpus was not routed in this change. Positive same-net-pad-clearance
and a universal via-pad overlap gate remain deferred by user direction.
