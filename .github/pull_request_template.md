## What and why

<!-- What this changes, and the problem it solves. Link the issue it fixes: "Fixes", then its number (here only: the code and docs cite no numbers). -->

## How it was verified

<!-- The checks you ran (per package, see CONTRIBUTING.md), the test that fails without the
fix, and anything you checked by hand. -->

## Checklist

- [ ] Checks pass for every package I changed (backend, frontend, shared, mcp)
- [ ] A bug fix comes with a test that fails without it
- [ ] Schema change: a migration with a `-- === DOWN ===` part, and regenerated `schema.generated.ts`
- [ ] New route: its access level is in `route-authorization.test.ts` and the snapshot is updated
- [ ] CLAUDE.md updated where a rule it documents changed, and an entry under Unreleased in CHANGELOG.md for a change people running Nuggets will notice
