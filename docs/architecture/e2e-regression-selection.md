# E2E regression selection

Status: accepted test selection; fixture normalization and DSL migration may
still be pending

The focused cross-feature regression set is intentionally small enough for
frequent local runs while covering the routing contracts currently under
design.

## Fast

- `cap_chain`: basic ordinary routing and connectivity;
- `qfn_diffpair_escape`: dense-package escape plus differential routing;
- `band_amp`: controlled-impedance declarations and explicit `viaFence(...)`.

`band_amp` replaces `flat_hierarchy` in the focused set. It is a four-copper-
layer, initially unrouted RF chain. Its native project does not provide a
complete dielectric stack, so its DSL fixture must declare the missing stack
properties before an impedance result can be accepted. The via-fence test uses
the actual routed RF-chain tracks and does not require a GND plane.

## Medium

- `powerbank`: compact power polygons, power/sense pad roles, multiple USB
  differential pairs, DRC inheritance, remaining routing, and GND plane work;
- `splitflap_driver`: a larger ordinary/multipoint routing case.

## Slow or nightly

- `routed_output`: preservation and cleanup behavior on a board that already
  contains routing.

`flat_hierarchy` remains a reserve fixture rather than part of the focused six.
The selection defines coverage, not an instruction to commit or rewrite local
fixture data. Every runnable fixture remains immutable and writes results only
to its own ignored results directory.
