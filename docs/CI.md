# Continuous integration

GitHub Actions runs `.github/workflows/ci.yml` for every pull request, every push
to `main`, and manual runs from the Actions tab.

Both Ubuntu and Windows use Node.js 22 and run:

```sh
npm ci
npm test
npm run build
```

The tests use local mock agents and disposable data. No model credentials or
repository secrets are needed. Each job has a ten-minute timeout; a newer run
for the same PR or branch cancels the older run. Actions are pinned to commit
SHAs, and the workflow has read-only repository permissions.

Check both **Test and build** results on the PR before merging. This workflow
reports checks; it does not configure branch protection or deploy/restart an
installed Hub. Deployment remains the local installation workflow described in
[MIGRATION.md](MIGRATION.md).
