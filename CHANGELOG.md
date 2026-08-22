# Changelog

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
