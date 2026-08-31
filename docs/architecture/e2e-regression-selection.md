# E2E regression selection

Status: measured and filtered on 2026-08-31.

The repository keeps every reproducible fixture, but does not pretend that
every process exit `0` is a passing board. Default tests must be bounded and
must state what they prove.

## Default/frequent

- `cap_chain`: ordinary routing, native connectivity `3 -> 0`, no DRC delta;
- `qfn_diffpair_escape`: dense escape and preservation of the fixture's
  pre-existing `FOREIGN` open/DRC fingerprint;
- EasyEDA hybrid corpus `stable` tier:
  - `2568fa74`: stackup-aware impedance verification;
  - `2a52a7eb`: four-layer pure KRT plus a verified ESD differential pair.

Run the two real EasyEDA/KRT stable boards with:

```text
npm run e2e:easyeda-hybrid-corpus
```

## Diagnostic/manual

- `band_amp`: impedance declarations and along-track stitching; currently two
  RF nets remain open, with no native DRC regression;
- `powerbank`: broad power/polygon/USB coverage; improves 27 non-GND open nets
  to 11 but adds one warning;
- `splitflap_driver`: closes all 82 non-GND nets but adds one warning;
- EasyEDA `8dcca4bc`: closes every net, but only its five-net QSPI matched
  group passes; the fourteen-net GPIO group measures 9.808 mm spread against
  an 8 mm tolerance, reproducibly across two reruns;
- EasyEDA hybrid corpus cases marked `diagnostic`: bounded, useful partial
  outcomes whose measured upper bounds are stored in the manifest.

These fixtures stay because they catch regressions, but they are not zero-open
green-board claims.

## Archive/nightly

- `83efabb6` and `4a770e3e`: expensive, largely duplicate dense-board
  checkpoints. They remain in the EasyEDA corpus as `archive` and run only
  when selected explicitly or through `--all`;
- `routed_output`: currently blocked. Its first differential special candidate
  exceeded 615 seconds and was aborted. Do not put it in regular CI until the
  differential search path has its own iteration budget and the runner has a
  hard timeout.

`flat_hierarchy` and the other standalone fixtures remain reserve inputs. They
have contract coverage and can be selected for targeted work, but were not
promoted into the measured default set merely because a runnable directory
exists.
