# Final compact-outline regularization

Multi-branch compact zones previously received only short-edge cleanup after
their branch unions. This can leave pad-envelope steps and corridor flares in
the final outline even when a simpler shape would preserve the connections.

The final pass compares a bounding rectangle, an octilinear envelope, and
straight or two-segment replacements of boundary chains. A convex-hull detector
identifies concave chains as individual bays with a mouth width and depth.
Only shallow local bays can receive extra fill; a deep U-shaped routing gap
is not treated as a cosmetic dent. Its score includes
perimeter, vertex count, concave turns and area change, scaled to the local
copper body. Every step improves the score without increasing vertex count. Single-branch
zones retain their existing dedicated regularization.

Acceptance gates:

- One contour with only 0/45/90-degree edges; crossing proposals are rejected.
- First subtract foreign obstacle bounds expanded by clearance from the rough
  corridor envelopes. Require the remaining core and outline to be connected;
  preserve all feasible core copper and never trim a target pad body. If this
  is infeasible, retain the prior rough outline for native verification.
- Validate the entire accepted outline against the obstacle reserve, including
  intersections inherited from the input. This fixes the old added-area-only check.
- Ordinary shortcuts retain a 12% growth allowance. Detected bays may spend an
  additional local fill allowance (at most 12% per mouth), capped at 25% total
  growth over the original. Area cannot drop below 88%; total added plus removed
  area is at most 35%. Perimeter cannot increase.
- The final pass respects the planner's board-area limit, so cleanup cannot
  turn a previously valid zone into an oversized skipped zone.
- Added copper cannot extend outside the board outline, including concave
  edges. Cutouts and zone keepouts are supplied as mechanical obstacles.
- Both the initial clearance cut and every final simplified ring are checked;
  validating only intermediate Clipper paths is insufficient at rounding scale.
- At most twelve passes, 64 sampled chain starts and 256 distinct shortlisted
  proposals per pass. Work is charged to the existing search budget. Near
  budget exhaustion, retain the best contour instead of failing the zone.

These are rough zone outlines. Native refill, exact copper clearance,
connectivity after refill and thermals still require backend verification.
Obstacle bounding boxes are conservative; this pass does not replace DRC.

## Regression

`npm run test:polygon:outline` checks the captured 24V case from run
`pcb-dsl-237c8743` (2026-09-13, D7.1/C3.1/U16.1). The fixture retains the original
outline, protected geometry and relevant nearby obstacles. The revised result
has 8 vertices versus the original 26 (the first cleanup had 14), area 67.203
versus 55.994 mm², and perimeter 33.435 versus 43.931 mm. The nearby foreign
pad has a 0.152 mm reserve and the large upper bay disappears. Tests cover
feasible protected copper, target pad bodies, inherited overlap removal, area
budgets, allowed angles, deterministic output, shallow/blocked/deep bays,
blocked fallback and budget fallback.

The polygon integration suite also exercises Powerbank and band_amp:
`npm run e2e:no-kicad:polygon`.

The outline test command also runs 228 deterministic stress cases: rotation,
reflection, scaling, budget interruption and seeded shallow/deep/blocked
notches. Regressions cover long collinear flanks hiding a narrow bay mouth,
generic envelopes bypassing the deep-slot policy, excessive initial core
restoration, and post-simplification loss of a tiny protected sliver.
