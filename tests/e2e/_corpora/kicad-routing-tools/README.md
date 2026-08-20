# KiCadRoutingTools corpus E2E

This suite derives its routing fixtures from the upstream `kicad_files` content
in `drandyhaas/KiCadRoutingTools` at the commit recorded in `SOURCE.json`.
User-local `.kicad_prl` preferences are excluded. Boards and the few
`.kicad_pro` sidecars may carry explicit regression/rule adjustments, so the
contract validates their presence and DSL expectations rather than claiming
stale byte-for-byte upstream hashes. Each PCB is an independent case with the
same layout as `powerbank`:

```text
tests/e2e/<case>/
  fixture/
  routing.js
  run.mjs
```

The case directories are direct siblings of `tests/e2e/powerbank`. This `_corpora`
directory contains only collection-level `UPSTREAM_LICENSE`, `SOURCE.json`,
`manifest.json`, documentation, and the multi-case launcher.

The DSL declares only intent supported by clear net naming or upstream examples.
Ordinary undeclared nets remain part of the routing scope and inherit native KiCad
DRC. Existing tracks, vias, and zones are imported as fixed copper.

## Commands

Static contract only; no autorouter is started:

```powershell
npm run test:e2e:krt-corpus:contract
```

List or run explicit cases:

```powershell
npm run e2e:krt-corpus -- --list
npm run e2e:krt-corpus -- --case cap_chain --profile balanced --max-candidates 1
npm run e2e:krt-corpus -- --all --profile balanced --max-candidates 1

# A case is also directly runnable:
node tests/e2e/cap_chain/run.mjs --profile balanced
```

The runner has no internal timeout. `Ctrl+C` is forwarded through `AbortSignal`.
Results are isolated under `results/e2e/kicad-routing-tools/<case>/<run-id>`.

Some upstream boards currently expose strict KiCad adapter gaps (duplicate
designators, custom pad shapes, or an unknown-net fixed track). They remain in the
corpus unchanged and are marked in `manifest.json`; those failures are regression
targets, not reasons to mutate the source fixtures.
