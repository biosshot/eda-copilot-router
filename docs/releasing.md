# Releasing `@eda-copilot/router`

Releases are built and published only by `.github/workflows/publish.yml` from
the public `biosshot/eda-copilot-router` repository. A tag must exactly match
the package version with a `v` prefix, for example package `0.1.0` and tag
`v0.1.0`. Ubuntu and Windows release gates must both pass before publication.

## First publication

npm requires a package to exist before a Trusted Publisher can be attached to
it. For the first tag only, create the repository secret `NPM_TOKEN` with a
granular publish token authorized for the `@eda-copilot` scope, then push the
tag. The workflow publishes the public scoped package with provenance.

After the first package version exists, authenticate npm CLI 11.5.1 or newer
with an account that owns the package and configure the GitHub Actions trust:

```text
npm trust github @eda-copilot/router --repo biosshot/eda-copilot-router --file publish.yml --allow-publish --yes
```

The npm account must have 2FA enabled for the trust command. After the trust is
configured, remove the `NPM_TOKEN` repository secret. Future tag workflows use
short-lived GitHub OIDC credentials and require no npm publish token.

## Normal release

1. Update `package.json` and `package-lock.json` to the new version.
2. Commit and push the release changes to `main`.
3. Confirm the normal CI workflow is green.
4. Create and push the matching signed or annotated `vX.Y.Z` tag.
5. Confirm both release-gate jobs and the npm publish job succeed.

Do not publish from a developer checkout after Trusted Publishing is enabled.
