# Contributing to Nuggets

Thanks for helping. Nuggets is a self-hosted, collaborative finance manager for families,
so a change is judged first on whether it keeps each family's data correct and private.

- **Security problems:** please follow [SECURITY.md](./SECURITY.md) instead of opening an
  issue.
- **Bugs and ideas:** open an issue with the templates provided. For a larger change, open
  an issue first so we can agree on the approach before you write the code.

Everyone taking part is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

Nuggets is source-available under the [PolyForm Noncommercial License 1.0.0](./LICENSE). By
contributing, you agree that your contribution may be distributed under that license, and that the
copyright holder may also license it under other terms, a commercial license included.

## Development setup

You need Docker with Compose v2, and Node.js 26 for the setup script and the test runners.
The app itself runs only in Docker.

```bash
npm run setup          # once: creates .env, the Docker secret files and ./data
npm run dev            # builds and starts Postgres, the backend, the frontend and Dozzle
```

The backend applies the database migrations when it starts. Then open
http://localhost:3000: the first visit asks for the setup token the backend logs at startup.

The repository is an npm workspace of five packages, with one `package-lock.json` at the
root:

| Package | What it is |
|---|---|
| `backend` | Express, Kysely and PostgreSQL |
| `frontend` | React, Vite and Radix Themes |
| `mcp` | the MCP server, mounted at `/api/mcp` |
| `shared` | the Zod schemas the other three use |
| `e2e` | the end-to-end tests (Playwright) |

To run the checks and tests on your machine, install and build once, from the root:

```bash
npm ci
npm run build          # shared, mcp, backend, then frontend: each uses the ones before it
```

After changing `shared/src`, rebuild it (`npm run build -w shared`) before checking the
packages that use it. Run a package's scripts in its directory (`cd backend && npm run
test:unit`) or from the root with `-w` (`npm run test:unit -w backend`), and add a
dependency from the root (`npm install <pkg> -w backend`) so the root lockfile changes with it.

## Backend tests

The backend tests are three Vitest projects:

- **unit** tests need nothing else: `npm run test:unit` in `backend/`.
- **integration** tests need a PostgreSQL 18 database with the schema. They run the app as
  the unprivileged `nuggets_app` role, so row-level security applies as in production. They
  are the `*.db.test.ts` files, the route tests in `src/routes/__tests__/` and the few others
  `backend/vitest.config.ts` lists.
- **migrations** tests (`*Migration.test.ts`, and the ones `backend/vitest.config.ts` lists)
  change the schema in a transaction they roll back, and run one file at a time after the
  others.

`npm run test:run` runs all three, or only the unit tests while `DATABASE_URL` isn't set. CI
runs the unit tests without a database, so a new test that needs one must be named
`*.db.test.ts` (or `*Migration.test.ts`), or live in `src/routes/__tests__/`.

A throwaway Postgres 18 in Docker is enough for the integration tests. Use the Alpine image, as
CI does: its C collation orders text the way the tests expect. The migration runner loads the
schema into the empty database and gives `nuggets_app` its login:

```bash
docker run -d --name nuggets-test-db -p 127.0.0.1:55433:5432 \
  -e POSTGRES_USER=test_user -e POSTGRES_PASSWORD=test_password -e POSTGRES_DB=test_db postgres:18-alpine
cd backend
npm run build
export DATABASE_URL=postgresql://test_user:test_password@localhost:55433/test_db \
  DB_HOST=localhost DB_PORT=55433 DB_NAME=test_db DB_USER=nuggets_app DB_PASSWORD=test_password \
  MIGRATION_DB_USER=test_user APP_DB_PASSWORD=test_app_password \
  JWT_SECRET=test_secret SESSION_SECRET=test_session_secret CSRF_SECRET=test_csrf_secret
node dist/scripts/migrate.js migrate
npm run test:run
```

Run `node dist/scripts/migrate.js migrate` again after adding or pulling migrations, and
`docker rm -fv nuggets-test-db` to throw the database away.

## Conventions

[CLAUDE.md](./CLAUDE.md) is the full reference for how code here is written. It's addressed
to AI assistants, but the rules are the same for everyone. The ones most often missed:

- **Ledger data is isolated by Postgres row-level security.** Tenant queries run on
  `getDb()`, inside the request's tenant transaction, never on a fresh pool connection.
- **Money** is `DECIMAL(12,2)`, and amounts are pre-signed: a balance is `SUM(amount)`.
- **Budgets are event-sourced:** never store budgeted, actual or remaining amounts.
- **Time:** instants are `timestamptz`, calendar days are `date`. Every table has a `uuid`
  column (`uuidv7()`).
- **Routes:** every route has an access level, checked by
  `backend/src/__tests__/route-authorization.test.ts`. A new route fails it until its
  snapshot is regenerated (`npx vitest run src/__tests__/route-authorization.test.ts -u`);
  check the level it got. MCP tokens reach only the routes listed in `TOKEN_ROUTES`
  (`backend/src/middleware/tokenAccess.ts`).
- **The UI** uses Radix Themes components and theme colours only (`npm run lint:guard`).
- **TypeScript** is strict in every package; `npm run type-check` checks the source and the
  tests.
- **Test data is made up:** invented people, employers, merchants, amounts and dates, never
  figures from a real paystub, statement or export, even rounded or renamed.
- **Some files never go in git:** uploads, data exports and dumps, `.env` files, the
  `secrets/`, `data/` and `backups/` folders, encrypted backups, password and key files.
  `scripts/check-tracked-files.sh` fails on one.
- **No secrets, even in tests.** CI runs [gitleaks](https://github.com/gitleaks/gitleaks) on
  the tree and on your commits. A made-up value that looks like a key gets a `gitleaks:allow`
  comment on its line.
- **No issue or pull request numbers, or audit codes, in the tree:** code, comments and test
  titles say what a change does and why. Commit messages and pull requests may cite them
  (`scripts/check-issue-refs.mjs`).
- **Versions:** a Markdown file or script that states a version of Node.js, PostgreSQL,
  React and the like must match the files that set it (`scripts/check-doc-versions.mjs`).
- **GitHub Actions** pin every action to a full commit SHA, with its version as a comment,
  and give each job only the permissions it uses.

## Database migrations

Change the schema with a timestamped migration in `backend/migrations/`
(`npm run migrate:create` in `backend/` after a build), with a `-- === DOWN ===` part that
undoes it. Then run `npm run db:codegen` in `backend/` and commit the regenerated
`src/db/schema.generated.ts`. The schema starts from a baseline, `backend/init.sql`, which is
generated (`backend/scripts/regen-init-sql.sh`): don't edit it by hand.

Migrations run on installs that are in use, so:

- **Never edit a migration that has been merged.** The runner checksums each applied one
  and refuses to start when a file changed. Fix it with a new migration.
- **Give every migration a DOWN part.** CI rolls back every migration, applies them again
  and compares the schema.
- **Expand, then contract.** Add the new column or table, move the code over, and drop the
  old one in a later migration, so an older image still runs against the new schema during
  an upgrade or a rollback.
- **Constraints on a big table:** add them `NOT VALID`, then `VALIDATE CONSTRAINT` in a later
  migration, which takes a lighter lock and doesn't block writes.
- **Backfills** go in a migration of their own, in batches when the table can be large.
- **Indexes on tables that can be large:** `CREATE INDEX CONCURRENTLY`, which can't run in a
  transaction. Put it in a migration whose UP part has a line `-- nuggets:no-transaction`, keep
  only such statements in it, and make them idempotent (`IF NOT EXISTS`, and
  `DROP INDEX CONCURRENTLY IF EXISTS` first, since a failed build leaves an invalid index).
- **Locks:** a migration waits at most 5 s for a lock and is retried a few times. One that
  needs a lock a busy table rarely gives up should be written to need a lighter one.
- **Test what it does to existing rows** in a `*Migration.test.ts`, over rows seeded as an
  older install holds them, in a transaction that is rolled back.

## Before you open a pull request

Run the checks for each package you changed:

| Package | Checks |
|---|---|
| backend | `npm run type-check`, `npm run lint`, `npm run test:run` (with the test database when you changed anything the integration tests cover) |
| frontend | `npm run type-check`, `npm run lint`, `npm run lint:guard`, `npm run test:run` |
| shared | `npm run build`, `npm run lint` |
| mcp | `npm run type-check`, `npm run lint`, `npm run test:run` |

For a bug fix, add a test that fails without the fix. CI runs all of the checks on every pull
request that is ready for review.

## Pull requests

- Branch off `main` and keep each pull request to one change.
- Write commit messages as `type(scope): summary`, for example
  `fix(import): keep the period cache in step with savepoints`, and say in the body why the
  change is needed and how you checked it.
- Open the pull request as a draft and mark it ready when it's done: CI runs only on pull
  requests that are ready for review.
- Fill in the pull request template, including how you verified the change.
- Add an entry under Unreleased in [CHANGELOG.md](./CHANGELOG.md) for a change that people
  running Nuggets will notice.
