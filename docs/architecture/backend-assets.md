# Router backend assets

Status: accepted

## Rule

An end user must never clone, download, unpack, or point Copilot Router at a
router implementation manually. Every public backend is either bundled by its
host integration or prepared lazily by the package.

Python follows the same rule. A compatible system/KiCad interpreter is reused
when it passes the runtime probe. If none is usable, the package lazily prepares
a pinned, redistributable CPython runtime below the router cache. The managed
interpreter is invoked by absolute path and never modifies `PATH`, the Windows
registry, a global Python installation, or global `site-packages`.

Managed assets use a pinned upstream version, immutable URL, expected byte
size, and SHA-256. The package downloads only when that backend is first used,
rejects an integrity mismatch, rejects unsafe archive paths and symbolic links,
publishes the cache atomically, and reuses it offline. There is no network work
in `postinstall`. A concurrent process uses the same installation lock rather
than creating a second partial cache.

The default cache is the platform user cache under `eda-copilot/router`.
`COPILOT_ROUTER_CACHE_DIR` or `RouterAssetPolicy.cacheDirectory` may relocate
it. `allowDownload: false` is the explicit offline policy: a missing cached
asset then produces a structured error instead of silently changing backend or
version.

## Backend

- EasyEDA WASM worker JavaScript and WebAssembly are bundled in the npm package.
  They require no download, Python, global install, or host-owned path. Package
  contract tests assert that both assets are present, and a no-KiCad smoke test
  starts the real worker and routes a board through the shipped WebAssembly.
- KRT is managed from the official `v0.21.3` release archive. The package also
  selects the release's platform-specific `grid_router` module and prepares
  every dependency declared by that release's `requirements.txt` in a
  backend-owned Python cache when the selected interpreter does not already
  provide a ready KRT environment. Dependency installation uses `pip --target`;
  it never writes to the interpreter's global environment.
- Managed Python is CPython `3.12.14` from the immutable
  `python-build-standalone` `20260814` release. A platform-specific stripped
  install-only archive is selected for each platform already supported by KRT.
  Its SHA-256 is pinned in code and it is reused offline after first preparation.
Explicit KRT directories remain supported only as development/air-gapped
overrides. They are validated for required files and are never part of the
normal installation instructions.

KRT is never discovered implicitly from the current working directory. An
override must be explicit in configuration/environment; otherwise the pinned
managed release is used. The final readiness probe imports both the native
router module and the packaged Copilot Router patch, then requires KRT's
`route.py:--json-out` and `route_summary.py` capabilities. An upstream API
drift therefore fails before board routing starts.

## Pinned releases

- KRT: `v0.21.3`, SHA-256
  `fd6e9f880e5defbd1747f4a5437735184486fabece55ce8b2a1397c25b611a64`
- Python: CPython `3.12.14`, `python-build-standalone` release `20260814`;
  per-platform SHA-256 values are returned by `managedPythonRelease()`.
Version upgrades are code changes: update the pinned metadata, run backend
conformance tests, and publish a new package. Runtime code never resolves
`latest`.
