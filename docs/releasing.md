# Releasing `eda-copilot-router`

Releases are built and published only by `.github/workflows/publish.yml` from
the public `biosshot/eda-copilot-router` repository. A tag must exactly match
the package version with a `v` prefix, for example package `0.1.0` and tag
`v0.1.0`. Ubuntu and Windows release gates must both pass before publication.

## Trusted publishing

The npm package trusts GitHub Actions workflow `publish.yml` in
`biosshot/eda-copilot-router` for publishing. The trust was configured with:

```text
npm trust github eda-copilot-router --repo biosshot/eda-copilot-router --file publish.yml --allow-publish --yes
```

The npm account must have 2FA enabled to change this configuration. Tag
workflows use short-lived GitHub OIDC credentials and require no npm publish
token. Do not add a registry token to the publish job.

## Normal release

1. Update `package.json` and `package-lock.json` to the new version.
2. Commit and push the release changes to `main`.
3. Confirm the normal CI workflow is green.
4. Create and push the matching signed or annotated `vX.Y.Z` tag.
5. Confirm both release-gate jobs and the npm publish job succeed.

Do not publish from a developer checkout after Trusted Publishing is enabled.
