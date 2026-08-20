# Router backend assets

Status: accepted

## Rule

An end user must never clone, download, unpack, or point Copilot Router at a
router implementation manually. Every public backend is either bundled by its
host integration or prepared lazily by the package.

Managed assets use a pinned upstream version, immutable URL, expected byte
size, and SHA-256. The package downloads only when that backend is first used,
rejects an integrity mismatch, rejects unsafe archive paths and symbolic links,
publishes the cache atomically, and reuses it offline. There is no network work
in `postinstall`. A concurrent process uses the same installation lock rather
than creating a second partial cache.

The default cache is the platform user cache under `easyeda-copilot/router`.
`COPILOT_ROUTER_CACHE_DIR` or `RouterAssetPolicy.cacheDirectory` may relocate
it. `allowDownload: false` is the explicit offline policy: a missing cached
asset then produces a structured error instead of silently changing backend or
version.

## Backend

- KRT is managed from the official `v0.20.4` release archive. The package also
  selects the release's platform-specific `grid_router` module and prepares
  `numpy`, `scipy`, and `shapely` in a backend-owned Python cache when the local
  interpreter does not already provide them.
Explicit KRT directories remain supported only as development/air-gapped
overrides. They are validated for required files and are never part of the
normal installation instructions.

KRT is never discovered implicitly from the current working directory. An
override must be explicit in configuration/environment; otherwise the pinned
managed release is used. The final readiness probe imports both the native
router module and the packaged Copilot Router patch, so an upstream API drift
fails before board routing starts.

## Pinned releases

- KRT: `v0.20.4`, SHA-256
  `a989af2fa719c3b8d0763cae73dc0be5738a4c3e73c64741a7baaf0c4730c60c`
Version upgrades are code changes: update the pinned metadata, run backend
conformance tests, and publish a new package. Runtime code never resolves
`latest`.
