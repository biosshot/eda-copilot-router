# PowerBank E2E

This fixture is an immutable, unrouted copy of the PowerBank placement and
netlist. It has no tracks, vias, or zones. `routing.js` is the only routing
intent: it applies DRC rules, plans power polygons and the GND plane, routes
three USB differential pairs, and routes ordinary nets.

Run the fixture with the single built-in `native-auto` KRT policy:

```powershell
npm run e2e:powerbank
```

Use an explicit unique output name when comparing changes:

```powershell
npm run e2e:powerbank -- --run-id native-auto-local
```

Results are written to `results/e2e/powerbank/<run-id>/`; this directory is
ignored by Git. The fixture is copied before every run and its SHA-256 is
verified afterwards. The runner has no timeout. `Ctrl+C` is forwarded to the
router as an `AbortSignal`.

There is no external quality profile or candidate-count switch. The router
resolves one board-aware plan, invokes the backend once, and applies a usable
`partial` result as well as a complete one. Backend subprocess artifacts and
the final native connectivity/DRC reports remain under the run directory.
