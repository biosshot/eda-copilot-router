# Changelog

## Unreleased

- Add the Hybrid backend: on boards with at most two copper layers bundled
  EasyEDA WASM makes one global provisional route over all non-plane nets, then
  the shared KRT workflow replaces unverified hard-constraint copper and repairs
  true leftovers; locally compliant via-forbid/layer-only copper is retained
  for KRT audit, and multilayer routing remains full KRT.
- Preserve every leaf-backend diagnostic across preflight/runtime fallback and
  return the best semantically graded usable checkpoint as `partial` whenever
  a degraded route can still be applied.
- Upgrade the managed KiCadRoutingTools backend from `0.20.4` to `0.21.3`,
  including the new release archive integrity pin and runtime capability gate.
- Consume `route.py --json-out` as the authoritative merged reconciliation
  result and retain `JSON_SUMMARY_MIN` for compact machine-readable evidence.
- Document measured improvements, compatibility changes, and A/B regressions in
  `docs/krt-0.21.3-upgrade-report.md`.
- Add a pinned, private portable CPython fallback for machines without Python.
- Install KRT dependencies from the pinned runtime's `requirements.txt` into a
  versioned router cache instead of hardcoding or modifying global packages.
- Hide `maxVias` from the public routing DSL; via-count guardrails are
  implementation-owned.
- Raise the implementation-owned plane and explicit stitching-via guardrails
  from 500 to 4096 vias per plane or `viaStitch(...)` intent.
- Broaden Python discovery across virtualenv, Conda, installed KiCad/Python,
  pyenv, Windows launcher, macOS framework/Homebrew, and versioned PATH
  candidates, normalizing successful probes to an absolute interpreter path.
- Exercise the real bundled EasyEDA WASM Hybrid fallback with an empty offline
  KRT cache on Windows, Linux, and macOS CI; KRT absence remains a visible
  `partial` degradation while useful EasyEDA copper is retained.

## 0.2.1 - 2026-08-22

- Preserve all existing native copper unless `clearRouting()` explicitly
  selects its nets and item kinds for deletion.
- Keep stackup-only application from touching unlocked routing copper.
- Preserve unchanged native KiCad objects instead of recreating their geometry.

## 0.2.0 - 2026-08-22

- Materialize `stack(...)` as the effective physical layer table before copper
  planning and KRT routing, including two-to-four-layer routing in one call.
- Return applied stackup data through `RoutingResult` and write it through the
  standalone KiCad adapter before routed copper.
- Add the `applyStackup()` and KRT-free `runCopper()` DSL terminals.
- Import unlocked KiCad tracks, vias, and zones as editable by default while
  preserving native locked copper as fixed.
- Return retained editable copper as part of the complete replacement result.

## 0.1.0 - 2026-08-22

- Initial public release of the EDA-neutral router, KRT backend, routing DSL,
  standalone KiCad adapter/CLI, and no-KiCad CI coverage.
