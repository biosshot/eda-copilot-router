# PowerBank E2E

This fixture is an immutable, unrouted copy of the PowerBank placement and
netlist. It has no tracks, vias, or zones. `routing.js` is the only routing
intent: it applies DRC rules, plans power polygons and the GND plane, routes
three USB differential pairs, and routes ordinary nets.

Run the default single `balanced` candidate:

```powershell
npm run e2e:powerbank
```

Use an explicit unique output name when comparing changes:

```powershell
npm run e2e:powerbank -- --run-id balanced-local
```

Results are written to `results/e2e/powerbank/<run-id>/`; this directory is
ignored by Git. The fixture is copied before every run and its SHA-256 is
verified afterwards. The runner has no timeout. `Ctrl+C` is forwarded to the
router as an `AbortSignal`.

The quality profile is runtime policy, not board intent. The default invokes
exactly one `balanced` candidate. Portfolio routing is opt-in with
`--max-candidates 2..32`.
