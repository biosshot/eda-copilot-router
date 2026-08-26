# KiCadRoutingTools 0.21.3 upgrade report

- Date: 2026-08-26
- Branch: `feat/krt-0.21.3`
- Baseline: KRT `0.20.4` at copilot-router commit `8a25166`
- Target: KRT `0.21.3`, upstream tag commit
  `749cfa8333765288a807f825064b68015fd10ea9`

## Decision

Integrate `0.21.3`, with the managed backend pinned to the exact release
archive. The upgrade is worthwhile primarily for routing correctness fixes and
for a reliable machine-readable run contract. No sampled connectivity or DRC
regression was attributable to the new version.

Treat the release as monitored rather than risk-free. Upstream marks its PCM
metadata status as `testing`, and one representative large-board run was about
10% slower than `0.20.4`. That timing is a single-run signal, not a stable
benchmark.

## Upstream scope and useful changes

The upstream range `v0.20.4...v0.21.3` contains 492 commits and 418 changed
files. The parts relevant to copilot-router are:

- `route.py --json-out` writes the authoritative merged result after any
  reconciliation pass. This removes ambiguity when multiple raw
  `JSON_SUMMARY` records are printed.
- `JSON_SUMMARY_MIN` provides one compact outer-run verdict suitable for
  orchestration and regression evidence.
- capability discovery makes an incompatible KRT checkout fail during runtime
  preparation instead of failing later in a routing subprocess.
- routing fixes cover minimum hole-clearance handling, exact-fill/keep-out
  behavior, and warm-cache pad keep-outs.
- reachability, boxed-in/finalize verdicts, blocker naming and defect records
  improve failure forensics.
- placement legality, capacity analysis and review-sheet tooling are useful
  upstream additions, but are not exposed by the current routing-only public
  DSL.

## Integration changes

- Re-pinned the managed archive URL, SHA-256 and byte size to `0.21.3`.
- Added `route_summary.py` and `krt_capabilities.py` to the required archive and
  development-override contract.
- Added a startup capability probe for `route.py:--json-out` and
  `route_summary.py`.
- Every ordinary `route.py` stage now requests a stage-specific merged JSON
  artifact. Diagnostics consume that merged state while retaining all raw
  summaries for forensics.
- Added strict parsing and contract tests for exactly one
  `JSON_SUMMARY_MIN` record.
- Revalidated the frozen upstream corpus contract and updated public
  documentation plus the release changelog.

An old `COPILOT_ROUTER_KRT_DIR` override now fails fast instead of silently
running. This is intentional: the adapter depends on the new summary contract.

## A/B results

The strict comparison used the same source commit, DSL, KiCad installation,
quality profile and `flat_hierarchy` fixture; only the managed KRT version and
the adapter changes required to consume its output differed.

| Metric | KRT 0.20.4 | KRT 0.21.3 | Assessment |
|---|---:|---:|---|
| Router status | partial | partial | unchanged |
| Routed / open nets | 26 / 7 | 26 / 7 | unchanged |
| Copper tracks / vias | 550 / 0 | 550 / 0 | unchanged |
| Native unconnected items | 87 -> 9 | 87 -> 9 | unchanged |
| Native DRC violations | 70 -> 264 | 70 -> 264 | unchanged |
| Added native DRC violations | 194 | 194 | pre-existing issue, not an upgrade regression |
| Adapter elapsed time | 78.1 s | 86.0 s | +10.2%, single-run warning |
| Reported routing iterations | 451,833 | 2,574,151 | higher search effort |

Additional target-version runs:

- `cap_chain`: complete, unconnected `4 -> 0`, native DRC `0 -> 0`.
- `qfn_diffpair_escape`: partial, unconnected `2 -> 1`, no added native DRC;
  the merged reconciliation diagnostic replaced the old multiple-summary
  warning.
- managed no-KiCad smoke: complete, 36 tracks, 0 vias.
- 22-board upstream-corpus contract: passed.

## Improvements observed

- Reconciliation state is no longer guessed from the first stdout summary.
  The adapter records `KRT_RECONCILIATION_SUMMARY_MERGED` and uses the merged
  artifact as its diagnostic source.
- The compact summary is present exactly once in tested ordinary routing runs.
- Download, integrity verification, managed dependency/runtime preparation,
  packaged patch import and headless execution all work with the release
  archive.
- Existing complete and partial route outcomes in the sampled boards remain
  stable.

## Regressions and residual risks

- Performance: `flat_hierarchy` took 7.9 s longer (+10.2%) and reported 5.7x
  more iterations. Repeat benchmarking is needed before calling this a stable
  regression; connectivity and generated copper were identical.
- Existing DRC debt: both versions added the same 194 violations on
  `flat_hierarchy`. This must remain visible as a router-quality issue even
  though it is not caused by the upgrade.
- Partial dense-package case: `qfn_diffpair_escape` still leaves one foreign
  net open. The upgrade improves reporting, not completion, for that fixture.
- Upstream maturity: release metadata says `testing`.
- Compatibility: development/air-gapped overrides older than `0.21.3` no
  longer satisfy the capability contract.

## Verification performed

- `npm test`
- `npm run test:e2e:krt-corpus:contract`
- `npm run e2e:no-kicad`
- `npm run e2e:cap_chain`
- `npm run e2e:qfn_diffpair_escape`
- `npm run e2e:flat_hierarchy` on both KRT versions

All commands completed successfully. `partial` is an expected routed-result
state for the two documented incomplete fixtures, not a test-process failure.

## Recommendation after merge

Keep `0.21.3` as the managed default and watch route duration plus native DRC
delta in CI. Do not expose the new placement/review commands through the DSL
until they have EDA-neutral contracts and native verification. The next safety
work should gate or rank candidates by added native DRC violations so the
known `flat_hierarchy` debt cannot be mistaken for production-quality output.
