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

## Backends

- KRT is managed from the official `v0.20.2` release archive. The package also
  selects the release's platform-specific `grid_router` module and prepares
  `numpy`, `scipy`, and `shapely` in a backend-owned Python cache when the local
  interpreter does not already provide them.
- Freerouting is managed from the official `v2.3.0` release JAR using the same
  cache and integrity contract.
- EasyEDA WASM is bundled by the local EasyEDA Copilot host and injected as an
  engine. It is not downloaded from an undocumented URL or redistributed in
  the public MIT tarball without an explicit redistribution license.

Explicit KRT directories and Freerouting JAR paths remain supported only as
development/air-gapped overrides. They are validated for required files and
are never part of the normal installation instructions.

## Pinned releases

- KRT: `v0.20.2`, SHA-256
  `f314ffc3ac2cbe90a0a559cb8d1adff12b9e136406c18e1e29100536f869efac`
- Freerouting: `v2.3.0`, SHA-256
  `3cf18d608437740bc497db6b8ef5888e2e60a08de0def20691d1bad0c0e0ee24`

Version upgrades are code changes: update the pinned metadata, run backend
conformance tests, and publish a new package. Runtime code never resolves
`latest`.
