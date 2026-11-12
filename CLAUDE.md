# CLAUDE.md — Working in the Nuggets codebase

Guidance for Claude (and other AI assistants) contributing to Nuggets. Read this
before writing code; [CONTRIBUTING.md](./CONTRIBUTING.md) is the human contributors' guide.
The project's other documentation (architecture, features, deployment) is kept outside this
repository.

> ⚠️ **Do not invent data — especially column and table names.** Verify against the
> code and schema before writing queries. The source of truth is the code, not any
> document (including this one).

---

## 🎯 What Nuggets is

A self-hosted, **collaborative family finance manager**. A family's members share their
ledgers: everyone in a ledger sees and edits all of its data. Ledgers are kept apart by
Postgres row-level security; inside one, design for shared data, audit trails and data
integrity, **not** per-user isolation.

Stack at a glance: Node/TypeScript (ESM) + Express + PostgreSQL 18 on the backend
(Kysely over a shared `pg` pool); React 19 + Vite + React Query + Radix + Tailwind on
the frontend; `@nuggets/shared` Zod types in between; an MCP server mounted at
`/api/mcp`. Everything runs in Docker.

---

## 🧱 Non-negotiable invariants

These are the patterns most likely to be violated. Treat them as hard rules.

### Naming: the isolation unit is a `tenant` (the UI says "Ledger")
- The per-household data-isolation unit is the **`tenant`** entity: tables `tenants` /
  `tenant_users`, `sessions.active_tenant_id`, the `tenant_id` column on every scoped
  table, and the RLS GUC `app.current_tenant_id`. **Code, DB, logs, and backend
  `error:` message text all say `tenant`**, identifiers and file names included (the
  backend's `npm run lint` refuses an identifier, key or field that says ledger, `id-match`;
  file names it doesn't read).
- The **UI is the only layer that renames it** — end users see "**Ledger**". Keep that
  translation in the frontend's rendered strings/toasts only; never put "ledger" into
  backend code, the DB, logs, or error messages, and don't rename the `tenant` /
  `Tenant*` identifiers.
- **"Budget" ≠ the isolation unit.** "Budget" is the envelope-budgeting *feature*
  (`budget_items`, `budget_period`, `budget_period_items`, `BudgetService`). It used to be
  the UI label for the tenant and collided with this feature — that collision is why the
  UI moved to "Ledger". Don't reintroduce "budget" for the tenant.
- Hierarchy: **Organization** (a family) → **Ledger** = `tenant` (one shared financial
  dataset) → accounts · transactions · **Budget** · categories · …

### Shared-household data model
- **No `user_id` filtering on financial tables.** `WHERE user_id = $1` is wrong here.
- `user_id` exists only in **audit** columns (who changed what), never for access.
- Any member of a ledger may read and write all of that ledger's data. The boundary is signing in
  plus ledger membership, or being an admin of the ledger's organization or of the deployment.
- **Membership takes consent**: people join an organization only by accepting an invitation
  (`InvitationService`) or by a deployment admin adding them; a ledger takes only members of its
  organization. Nothing an org or ledger admin calls may answer differently for an email that has
  an account. The global `users` flags (`is_locked`, `login_disabled`) change only through
  `applyUserAccountFlags`, which leaves anyone with access outside the acting organization to a
  deployment admin.

### Tenant isolation: run tenant queries through `getDb()` (RLS)
- Tenant data is isolated by Postgres **RLS** keyed on the `app.current_tenant_id` GUC,
  which is set only inside the request's `withTenant` transaction. Tenant-scoped queries
  **must** run on **`getDb()`** (that transaction) — never a freshly built
  `new Kysely({ pool })` / raw pool connection, which has no GUC, so any tenant table it
  touches fails with `no tenant is set for this query (app.current_tenant_id)`. This
  bites services that take a `pool` in their constructor for tenant work: take none and
  call `getDb()` inside (see the `BalanceRebalanceService` / `BudgetItemMatcher` fixes).
- **Background jobs** run each tenant in `withTenant` (`forEachTenant`), and `getCurrentTenantId()`
  returns that transaction's tenant before any request's.
- **No network I/O inside a tenant transaction**: an open one holds a pooled connection
  and its row locks while the third party answers. Code that sends email or push, or calls
  SimpleFin or the price provider, runs outside one and opens short `withTenant(tenantId, …)`
  transactions around its database work: `forEachTenantId` for jobs, `tenantNetworkHandler`
  for routes. The pool ends a transaction left idle for 5 minutes. A timer or interval a request may arm
  (a scheduler started from an admin route) is created inside `runDetached` (`db/withTenant.ts`):
  a timer keeps the context it was created in, so its runs would act as that request.
- **Retention:** a table that grows with use (logs, history, sessions) gets a job in
  `services/maintenance/retention.ts`, which runs daily: batched deletes (a `MATERIALIZED`
  pick, `deleteBatch`), bounded per run, per ledger in short `withTenant` transactions. It
  deletes only what nothing reads any more, never financial records; add the table and its
  period to that file's table, with a `*.db.test.ts` that it deletes
  exactly that.
- `globalDb` is only for control-plane tables (`tenants` / `organizations` / `users`). To
  read the active tenant's control-plane row inside a tenant txn:
  `WHERE id = current_tenant_id()`.
- RLS is the only enforcement layer. Request code on a table with the standard
  tenant policy needn't add `tenant_id = current_tenant_id()` (it may). Where RLS doesn't reach,
  filter in code:
  - **tables without RLS:** every table without `tenant_id` but the organization tables below,
    plus `tenant_users` and `personal_access_tokens`. A query meant for one tenant's or
    organization's rows filters on `tenant_id` / `organization_id` itself, or for `users` joins
    through `tenant_users` / `organization_users` (without it, an admin of one organization
    reached another's people);
  - **`user_profile_images`:** profile pictures belong to a user, not a ledger, so the table has no
    RLS; its routes serve one only to its owner, people sharing an organization or ledger with
    them, and deployment admins;
  - **SQL run as the migration role** (migrations, scripts): it's the database superuser, which RLS
    never applies to, so it sees every tenant.
- A **new tenant table** gets `tenant_id integer NOT NULL DEFAULT current_tenant_id()
  REFERENCES tenants(id)`, indexed by its `(tenant_id, …)` unique key (not a `tenant_id`-only index
  beside one: `indexHygiene.db.test.ts`), `ENABLE` and `FORCE ROW LEVEL SECURITY`, and one policy:
  `USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`.
  `rls-catalog.test.ts` fails until it has the RLS, the policy and the default. A new view needs
  `WITH (security_invoker = true)`, or it reads every tenant's rows with its owner's rights.
- **An organization's own tables have RLS one level up (2026-11-04):**
  `organization_simplefin_connections`, `organization_price_sync_settings` and
  `organization_price_sync_runs`, on the `app.current_organization_id` GUC and
  `current_organization_id()`, which raises `no organization is set for this query` when it is
  unset. Run their queries in `withOrganization(orgId, fn)` (`db/withTenant.ts`; `getOrgDb()`
  inside it). `withTenant` sets the tenant's own organization too, so a ledger's transaction
  reads its organization's rows, and `withOrganization` joins it rather than open a second
  connection; otherwise it opens a short transaction of its own, with no network I/O inside.
  A job across organizations visits each in its own (`getAllOrganizationIds`).
  A **new organization table** gets `organization_id integer NOT NULL DEFAULT
  current_organization_id() REFERENCES organizations(id)` with an index, `ENABLE` and `FORCE ROW
  LEVEL SECURITY`, and one policy: `USING (organization_id = current_organization_id()) WITH CHECK
  (organization_id = current_organization_id())`; `rls-catalog.test.ts` fails until it has them.
  The membership tables (`organization_users`, `organization_invitations`) and `tenants` stay
  control plane, read before any organization is chosen.
- **Keys between ledger tables include `tenant_id`:** a referenced table has
  `UNIQUE (tenant_id, id)`, and a foreign key to it is `(tenant_id, col) REFERENCES t (tenant_id, id)`
  (`ON DELETE SET NULL (col)` where it nulls), so a row can't point at another ledger's row;
  `rls-catalog.test.ts` checks it. A route taking a numeric id checks it under RLS first and
  answers 400 `INVALID_REFERENCE` (`services/tenantReferences.ts`).
- **The database checks the ledger's money rules at COMMIT:** a split transaction's
  splits add up to it, and a transfer's two sides point at each other with opposite amounts.
  Write a parent and its splits, or both sides of a transfer, in one transaction.
- RLS doesn't apply to a superuser or BYPASSRLS role, so the server **refuses to start** as a
  role that is one, can act as one (or as a REPLICATION or server file/program role), or owns
  `public` tables (`db/servingRole.ts`, checked in `index.ts`). `ALLOW_RLS_BYPASS_ROLE=true`
  overrides it, but only while there is at most one tenant: the app relies on RLS to scope its
  queries, so with two their data would mix. Code that creates a tenant calls
  `assertMayAddTenant` in its transaction, which refuses a second one under the opt-out. A
  backup restore runs the whole check on the restored data before it swaps it in, and again
  after (`BackupService`, `services/restoreJob.ts`).

### Event-sourced budgets
- **Never store** budgeted/actual/remaining amounts. Compute from the
  `budget_period_transactions` event log via the PostgreSQL `calculate_*_for_period_item`
  functions.
- All budget mutations go through `BudgetService`. Direct
  `UPDATE budget_period_items SET budget = …` is forbidden.
- A change is appended as an event of the difference, never by editing events' amounts. Code
  that reads a figure and records a change from it locks the period item first
  (`FOR NO KEY UPDATE`). An envelope's starting balance is a `starting_balance` event
  (`BudgetService.changeStartingBalance`); `budget_period_items.starting` isn't read. Periods
  are ordered by `start_date`, never by id.

### Money and balances
- `DECIMAL(12,2)` for all monetary values — **never** float.
- Amounts are **pre-signed** (income positive, expense negative). A balance is a plain
  `SUM(amount)` — no `CASE WHEN type = 'expense' THEN -amount` logic.
- `pg` returns NUMERIC as **strings**; coerce explicitly, don't assume numbers.
- Money math is integer cents (`backend/src/utils/money.ts`): parse with `toCents`, which refuses
  more than 2 decimals; add and compare cents; write with `centsToAmount`. Never sum floats.
- **One balance definition.** An account balance is `calculate_account_balance(id)`
  (or `calculate_account_balance_as_of(id, date)`): `SUM(amount)` of its transactions with
  `parent_transaction_id IS NULL`, dated on or before `app_today()` (the as-of date), so a
  future-dated transaction counts from its date. Every balance reader calls it (lists through
  `AccountBalanceService.getBalances`, one query; a history of dates through
  `account_balances_as_of(ids, dates)`, the same balance at each date in one pass); don't
  write another sum. **Net worth** is
  `net_worth_as_of(date)` over the `net_worth_accounts` view (not hidden, not "excluded from net
  worth", in dollars; closed accounts count); a liability counts minus its pre-signed balance,
  never `ABS()`. The snapshot, the rebuild and `GET /net-worth/current` all use it. The opening
  balance is a `'starting balance'` transaction; **`accounts.nuggets_balance` is retired**
  (always 0, never read). Don't cache or snapshot balances, and never write from a GET. A
  balance that can't be computed is `null` + `balance_unavailable`, shown as
  "Unavailable", never `0`.

### Temporal types: `timestamptz` for instants, `date` for calendar dates
- **An instant (a moment something happened) is `timestamptz`.** Every `*_at` / audit /
  event column — `created_at`, `updated_at`, `sent_at`, `expires_at`, `last_used_at`,
  `scheduled_for`, sync start/end times, imported-at, etc. Postgres stores `timestamptz`
  as a normalized UTC instant and converts on I/O. The containers run `TZ: UTC` and the
  pools pin every session to `TimeZone=UTC` (`db/pgSession.ts`), but no result may depend
  on either.
- **A calendar date (a day with no time-of-day) is `date`.** `transaction_date`,
  `bill_date`, budget-period `start_date`/`end_date`, `snapshot_date`, `target_date`, …
  A calendar date must **never** become `timestamptz` — shifting it across a zone
  boundary would corrupt budget-period assignment, reporting, and reconciliation.
- **A calendar date travels as a `'YYYY-MM-DD'` string**, DB to JSON and back: `pg`
  reads `date` as text (`db/pgSession.ts`) and codegen types it `string`. Never route one
  through a `Date` (`new Date('2026-12-31')` is Dec 30 west of UTC); day math is in
  `utils/calendarDate.ts`.
- **"Today" is the household's day: the `application_timezone` setting** (UTC until set).
  Use `appToday()` / `appDateOf()` (`utils/appDate.ts`) in code and `app_today()` in SQL;
  never `new Date().toISOString().slice(0, 10)`, `CURRENT_DATE` or `now()::date`.
- **In the UI, a calendar date goes through `utils/dateUtils.ts`**: `todayLocal()` for a
  default, `parseCalendarDate` / `formatCalendarDate` / `calendarMonthKey` /
  `calendarDaysBetween` to show, bucket or count, `formatInstantDate` for a timestamptz. Never
  `new Date('YYYY-MM-DD')` or `toISOString().slice(0, 10)`; `npm run lint:guard` rejects both.
- **Never use `timestamp without time zone` (naive) for new columns.** It only "works"
  because everything runs UTC today and breaks silently the moment a local-time value is
  written or a server's zone changes. The whole schema was retrofitted off it.
- **Classify by meaning, not by name.** A column named `*_date` that actually stores a
  moment (e.g. `balance_date` = the instant a balance snapshot was taken, written
  `new Date()`) is an **instant → `timestamptz`**. Conversely a `*_at`-ish name that is
  truly date-only stays `date`. Check what the code writes before choosing.
- `pg` serializes `timestamptz` as ISO-8601 with an offset (`2026-06-14T23:40:00.000Z`),
  not the naive `2026-06-14 23:40:00`. Response Zod schemas / `coerce*` helpers and any
  frontend `new Date(...)` parsing must accept the offset form.

### Identifiers (dual-ID)
- Internal: numeric `id` for PKs/FKs/JOINs. Public: `uuid` in API URLs (non-enumerable).
- **Every table has a `uuid` column: `uuid NOT NULL DEFAULT uuidv7()` plus a unique
  index/constraint (named `<table>_uuid_key`).** New tables must include one — it is the
  public identifier and keeps the schema "PK-ready" (a uuid that is non-null, unique, and
  time-sortable can become a primary key without rework). The one exception is the migration
  runner's own `schema_migrations`.
- UUID defaults are **UUIDv7** (`uuidv7()`), never `gen_random_uuid()` (v4). `uuidv7()` is
  a Postgres 18 builtin; all environments run `postgres:18`. Existing rows were backfilled
  from v4 to v7, so the whole table sorts in creation order by `uuid`.
- Soft-delete with flags (`hide_account`, `close_account`); avoid hard `DELETE`.

### Security (financial app)
- Parameterized queries only (Kysely / `sql` templates). Never interpolate input into
  SQL strings. A `LIKE`/`ILIKE` pattern built from input or stored text goes through
  `utils/likePattern.ts` (`containsPattern`, `prefixPattern`, `suffixPattern`, or
  `escapeLikeSql` for a column), so its `%`, `_` and `\` match themselves.
- **A regex someone typed never runs on the main thread.** Saving a regex rule checks
  it with `regexRuleProblem` (`@nuggets/shared`: length, nested repeats; the rule schemas and
  `answerInvalidPattern` use it); running one goes through `matchUserPatterns`
  (`utils/userRegex.ts`, a worker with a per-pattern time limit). In Postgres (`~*`) it runs
  under a short statement timeout in a savepoint (`runRegexPreview`, `services/merchants/regexPreview.ts`).
- **Uploads:** multer gets count and size limits (`IMAGE_UPLOAD_LIMITS`,
  `ATTACHMENT_UPLOAD_LIMITS`) and runs after the auth guard. An image is stored through
  `storeImage` / `storeProfileImage`, which take its type from its bytes and strip its
  metadata (`sanitizeImage`, `utils/uploadSafety.ts`); an attachment's bytes must match its
  extension. A download names its file with `contentDisposition()`, never a hand-built header.
  A URL a member stores for others to open is checked (`websiteUrlProblem`, `@nuggets/shared`)
  and rendered through `utils/safeUrls.ts` in the UI.
- Protected routes go through `authenticateToken`; ledger routes also through
  `resolveTenant, requireTenantMember`; admin routes also through `requireTenantAdmin`,
  `requireOrgAdmin` or `requireDeploymentAdmin`, or a check that runs before anything else
  (the org routes call `assertOrgAdmin` in a `uuid` param handler). Authorize **before**
  validating the body and before any file-upload (`multer`) middleware.
- Every route has an access level in `ACCESS` in
  `backend/src/__tests__/route-authorization.test.ts`. That test boots the real app and checks
  each route: 401 without a session, 403 for every signed-in role below its level, access for
  the roles at or above it (GET routes), and CSRF on every non-public mutation. A new route
  fails it until `__snapshots__/route-authorization.routes.txt` is regenerated
  (`npx vitest run <that test> -u`: the file first, since `-u` takes an optional value);
  check the level the route got in that diff, and add an `ACCESS` entry if the inherited
  one is wrong.
- **Personal access tokens (MCP tokens) reach only what `TOKEN_ROUTES` in
  `middleware/tokenAccess.ts` lists:** `/api/mcp` and, route by route, the ledger routes the
  MCP tools call. Every other route answers a token 403 `INTERACTIVE_SESSION_REQUIRED`, and a
  `read` token may only GET/HEAD the listed ones (403 `TOKEN_READ_ONLY`). So a new route
  decides whether tokens may call it: closed by default; open it only when an MCP tool calls
  it, by adding `METHOD /path` to `TOKEN_ROUTES` and regenerating
  `__snapshots__/route-authorization.token-routes.txt` (same `-u` run as above; the test
  checks every route against the list). Never open account, credential, admin or
  cross-ledger routes to tokens. A new MCP tool calling a route that isn't listed fails
  `personal-access-tokens.test.ts`. The API rate limiter counts a token's requests in its own
  bucket (`apiRateLimitKey`, by `jti`), the MCP tools' calls back from 127.0.0.1 included; a
  request without a token counts by address.
- **Step-up:** creating a credential (an MCP token, a passkey) takes `requireRecentReauth`: a
  browser session whose user confirmed their password or passkey in the last 5 minutes
  (`sessions.reauthenticated_at`; signing in counts), else 403 `REAUTH_REQUIRED`, which the
  UI answers with `useReauth` + `ReauthDialog`. Routes that must never take a token use
  `requireInteractiveSession`.
- Validate input (Zod where practical). Don't leak internals in error responses.
- **Error answers are `{ error, code, requestId }`** (`ApiErrorBody` in `@nuggets/shared`; the
  request's id is also its `X-Request-Id` header). An internal error's text (a database,
  library or mailer error's `message`, a stack) never goes in an answer, nor in anything a
  member reads back (a sync log's `error_message`, a bulk call's per-row result): log it as
  `{ err }` and answer a generic message: rethrow to the route wrapper, which does it
  (`answerError`, `utils/apiError.ts`), and use `publicErrorMessage(err, fallback)` for a
  stored or per-row result. A failure the caller can act on is a refusal: a `DomainError`
  (`services/domainErrors.ts`: status, code, a message written for people, details), which the
  route wrapper and the global error handler answer `{ ...details, error, code, message,
  requestId }`. A hand-written `res.status(4xx).json({ error })` gets its `code` (from the
  status) and `requestId` filled in (`middleware/requestScope.ts`). Clients branch on `code`,
  never on the text. An `/api` path no route answers is a JSON 404.
- **Ending a user's access ends every credential.** Code that locks a user, or changes or
  resets a password, calls `revokeAllUserCredentials` (`services/personalAccessTokens.ts`):
  it revokes their sessions *and* their MCP personal access tokens. Revoking only sessions
  leaves the tokens working. Disabling sign-in (`login_disabled`) is the exception:
  it passes `keepTokens`, since a service account works through its tokens.
  - **Serialize on the user's row** (`services/userCredentialLock.ts`). Make the account
    change and the revocation inside `withUserCredentialLock` (`users` row FOR UPDATE).
  - Code that creates a credential (a session, a rotation, a token) takes the row FOR KEY
    SHARE (`lockUserForNewCredential`) and re-checks the account under it before inserting.
  - Otherwise a credential checked before the change and inserted after the revocation
    survives it.
- **Passwords.** Code that sets a password checks it with `checkNewPassword` and hashes
  it with `hashPassword` (`utils/passwords.ts`; cost `BCRYPT_ROUNDS`), never `bcrypt.hash`
  directly. The policy is `passwordPolicy.ts` in `@nuggets/shared`, the same code the pages run
  (they get the server's settings from `GET /api/auth/password-policy`), so change it there.
  Sign-in never checks the policy, and answers a wrong password the same, in the same time,
  for an unknown address and a locked or disabled account (`compareWithoutAccount`; the
  password is checked before the account's state).
  Password sign-in is throttled per account (`LoginThrottleService`): charge before
  checking, refund on a correct password.
- Secrets come from Docker secret files (in `SECRETS_PATH`); production refuses one set in the
  environment (`secretsInEnvironment`, at startup and in migrate), where the variables stand in for
  the files only in development and the tests — never commit them. CI's `repository-checks.yml` (every
  PR, a Markdown-only one too) runs gitleaks on the tree and on a PR's commits (`.gitleaks.toml`; a
  made-up test value carries `gitleaks:allow`, and each new one is listed for the reviewer) and
  `scripts/check-tracked-files.sh`, which refuses tracked uploads, dumps, exports, local settings,
  `.env`, password (`.pgpass`, `.netrc`) and key files, encrypted backups and anything under
  `secrets/`, `data/` or `backups/`. Fixtures use made-up figures, never a real paystub's or statement's (CONTRIBUTING.md).
- **Content-Security-Policy:** the SPA's policy lives in `frontend/public/serve.json`
  (the static server sends it); the backend sends a deny-all one. The SPA loads nothing from
  other origins and runs no inline script or `eval` (Zod runs `jitless`, `src/zodConfig.ts`,
  imported first); styles keep `'unsafe-inline'`, which Radix and react-hot-toast need. A change
  that needs another origin or an inline script changes the policy deliberately, in `serve.json`.
- **Secrets at rest — never plaintext in the DB.** Passwords are bcrypt-hashed
  (`users.password_hash`); session tokens are stored as a SHA-256 hash
  (`sessions.session_token_hash`); MCP/PAT tokens are stateless JWTs (only the `jti` +
  metadata are persisted, never the token). Any *other* secret that must live in the DB
  (an integration credential — e.g. the SimpleFin `access_url`, OneDrive tokens) is
  **encrypted with `EncryptionService.encryptString` / `decryptString`** (the
  credential-domain AES key is HKDF-derived from the `data_encryption_key` Docker secret).
  **Never** drop a secret into `system_settings.setting_value` (or any column) in the
  clear — that key/value store is for non-secret config only. Secrets that don't need to
  live in the DB stay Docker secret files. A new encrypted column or setting goes in
  `REWRAP_TARGETS` / `ENCRYPTED_SETTINGS` (`services/secretRewrap.ts`), or rotating the key
  (`rewrap-secrets`) leaves it unreadable. Stored credentials are sealed
  with the key's id (`seal(…, keyId)`, envelope v3); backup files stay v2.
- **Cookies and CSRF:** read a cookie's name from `sessionCookieName()` /
  `csrfCookieName()` (`__Host-` prefixed whenever cookies are Secure: in production, or with
  `COOKIE_SECURE=true` or an https `DOMAIN_URL`), never a literal. A cookie-authenticated
  write's `X-CSRF-Token` is HMAC(`csrf_secret`, session token) (`utils/csrfToken.ts`);
  `setSessionCookie` sets the CSRF cookie with it. The CSRF-exempt sign-in endpoints take JSON
  only. In production a weak secret stops the server (`weakSecrets`, `utils/docker-secrets.ts`).

---

## 🗄️ Verify the schema before writing SQL

Common naming conventions (do not assume otherwise):
- Primary keys are `id` (e.g. `accounts.id`, **not** `account_id`).
- Name columns are `name` (e.g. `merchants.name`, **not** `merchant_name`).
- Type columns vary: `budget_items.expense_type`, `accounts.account_type`.

Verification order:
1. Read the relevant migration in `backend/migrations/` (most recent that touched the
   table wins; there are none before the v3.0.0 baseline).
2. Check `backend/init.sql` (the baseline: schema, functions, triggers).
3. Check generated types in `backend/src/db/schema.generated.ts`.
4. If still unsure, query the running DB:
   `docker exec nuggets_postgres psql -U nuggetsApp_user -d nuggets_db -c "\d <table>"`.

After a schema migration, regenerate types: `cd backend && npm run db:codegen`, and commit
the result. CI runs `db:codegen:check` (migrate → regenerate → `git diff --exit-code`), so a
hand-edited `schema.generated.ts` must match codegen **exactly** (alphabetical columns;
nullable, no-default columns are `T | null`). `kysely-codegen` also turns a column's
`COMMENT ON COLUMN` into a JSDoc block above the field — either match it or omit the comment.

---

## 📦 Backend conventions (ESM)

- ES Modules only: `import`/`export`, **no** `require`/`module.exports`.
- **Local imports must use `.js` extensions** even for `.ts` files
  (`import x from '../services/Foo.js'`).
- No `__dirname`/`__filename` globals — use `getDirname(import.meta.url)` from
  `utils/esm-compat.js`.
- Route handlers: wrap a ledger route with `tenantHandler` (its request transaction, below),
  one that waits on a third party with `tenantNetworkHandler`, and a signed-in route outside a
  ledger with `authHandler` (typed `req.user`, centralized error handling); each answers 401
  without a signed-in user, so they run behind `authenticateToken`. **Routers:** a
  module exports a named `createXRoutes(deps)` per router, taking the slice of
  `RouteDependencies` (`routes/dependencies.ts`: services and mount-time `config`, never a
  pool) it uses, or nothing, and building a new router each call. `routes.ts` mounts each
  with its guards (`authenticateToken`, then `resolveTenant, requireTenantMember`, then an
  admin check); a route adds only its own extras. Public routes get a factory of their own,
  mounted first (`createAuthPublicRoutes`, `createPasskeySignInRoutes`,
  `createOneDriveCallbackRoutes`).
- **A route parses its input and calls a service.** Parse with `validateBody(schema)` /
  `validateQuery(schema)` and a schema from `@nuggets/shared` (the domain's own file; a query
  schema is built from the `query*` primitives in `primitives.ts`, and read with
  `parsedQuery(req, schema)`). The work is in `services/<domain>/`, on `getDb()` (ledger data) or
  `globalDb` (control plane); only a service that needs connections of its own holds a pool
  (`BackupService`'s backup lock, `ImportService`'s sync claim). A refusal is the domain's
  `DomainError` subclass (`TransactionRefusal`, `AccountError`, `UserError`, …, or a new one
  with factories), thrown by the service. Routes don't catch to re-answer an error: a refusal
  or a failure propagates to the route wrapper, which answers it and rolls the request back. A
  catch stays only to clean up, map a specific error (a lock conflict) to a refusal, or carry
  on. `routes/test-data.ts` (dev tooling, not mounted in production unless `ENABLE_TEST_DATA`) is
  the one route file that may query directly.
- **Request transactions:** `tenantHandler` runs the handler in one `withTenant`
  transaction, which commits only if the answer is below 400. An error answer rolls back
  everything the handler wrote, so don't rely on a write surviving one. A database error
  aborts the transaction: code that catches one and carries on must run the statement in
  `withSavepoint` (`db/withTenant.ts`), or `withTenant` throws and the request fails with
  a 500. Don't run two `withSavepoint` calls at once on one transaction (`Promise.all`).
- App composition is split: `app.ts` (middleware) → `routes.ts` (routing) →
  `index.ts` (start). Keep middleware registration order intact.
- **Startup, health and shutdown.** `/api/health` is liveness (the process answers);
  `/api/ready` is readiness (services started, not shutting down, database answering,
  migrations applied), and the container healthchecks use it. A scheduler starts in
  `ApplicationLifecycleService.initializeServices` and throws when it couldn't start (startup
  retries it, then exits 1 if the database was unreachable, else serves on, not ready); don't
  await long work there (a first run). Stop it in the lifecycle's shutdown, and in
  `pauseSchedulersForRestore`. A setting the server can't run without is checked at startup
  (`utils/productionConfig.ts`: `validateStartupConfig`), not at first use.
- **Settings live in `backend/src/config.ts`.** Read an environment variable through
  `config()` (typed, parsed once with Zod), never `process.env.X`; a secret through the
  `utils/docker-secrets.ts` helpers (`readDockerSecret`, `envSecret`). The backend's ESLint
  refuses any other `process.env` read outside tests (a function may default a plain `env`
  parameter to it, so its tests can pass another; not a destructured one). A new setting
  gets an entry there (type, default, description); `npm run docs:env` prints the deployment
  docs' settings table from it. `config.test.ts` fails on a variable read
  but not listed, or a listed one nothing reads. A value it can't use is a
  startup problem, listed with the rest.
- Prefer **Kysely** for new queries; reserve raw `sql` for complex/set-returning
  queries and DDL. Both share the one pool in `db.ts`.
- **Lists page first.** Choose the page from the main table alone (filters on its own
  columns: a joined name or uuid becomes `fk IN (SELECT id …)`), ordered with `id` as the last
  tiebreaker, then join names and aggregate (tags) for that page only; count without joins. Read
  `page`/`limit`/`offset` with `utils/pagination.ts`, which bounds them.
- **Under RLS an index serves only leakproof conditions.** Postgres won't run a non-leakproof
  operator below the tenant policy, so `ILIKE`/`LIKE`/`~*`, `lower(col) = …` and trigram or
  expression indexes don't help a request query (`=`/`<`/`= ANY` on plain columns do). Check the
  plan as `nuggets_app` with the tenant set, not as the owner.

### Logging (Pino — mandatory)
- Use the `logger` from `utils/logger.js`; **never** `console.log`.
- Structured calls: `logger.info({ userId, action }, 'message')`.
- Log errors as `{ err }` (not the bare error): `logger.error({ err }, 'failed')`.
- **No bodies, queries or emails in a log line:** log a body's field names
  (`bodyKeys(req.body)`), a URL's path (`pathOnly`), an email masked (`maskEmail`), and ids
  rather than amounts, payees or descriptions. `REDACT_PATHS` (`utils/logger.ts`) scrubs the
  credential field names it lists up to three levels deep; add a new one there.
- Every line logged while a request runs carries its `requestId` (the `X-Request-Id` the
  answer has, which the UI shows on a server error), the `userId` and the `tenantId`; a
  background job's per-tenant lines carry the `tenantId` (the logger's `mixin`,
  `logContext` in `utils/logger.ts`). Don't log them by hand or make up request ids. An
  inbound `X-Request-Id` (the MCP tools forward theirs) is kept only if it is ≤64 of
  `[A-Za-z0-9._:-]`.
- Logs are JSON to stdout, viewed via **Dozzle**. There is **no** Loki/Promtail/Grafana
  stack (removed intentionally) — don't reintroduce one or reference it.

---

## 🎨 Frontend conventions

### API calls — the #1 recurring bug
The `apiGet/apiPost/apiPut/apiDelete/apiPatch/apiPostFormData` helpers in
`frontend/src/services/api/base.ts` **already prepend `/api`**.

```ts
// ✅ correct — base.ts adds /api
apiGet<Account[]>('/accounts');            // → GET /api/accounts
// ❌ wrong — produces /api/api/accounts (404)
apiGet<Account[]>('/api/accounts');
```

A failed call rejects with an `ApiError` (`base.ts`): its message is the server's reason
(`message`, else `error`) in Ledger wording, and a 5xx's names the request id ("(reference
…)") so a report can quote it; it carries `status`, `code` and `requestId`. Toast
`apiErrorMessage(error, fallback)` (`utils/errors.ts`) and branch on `errorCode(error)`;
don't read `response.data.error` yourself. A call that reads the body another way (a file
download) checks the answer with `assertOk(response)`, not its own `if (!response.ok)`.

### Data fetching
- Use the typed React Query hooks in `frontend/src/hooks/queries/*`. The global client
  is tuned (`staleTime: 30s`, `refetchOnWindowFocus: false`) — don't override
  `refetchOnWindowFocus` per-query without reason.
- Prefer server-side filtering/pagination over fetching whole tables and filtering on
  the client.
- Default a query's data to `EMPTY_LIST` (`utils/emptyList.ts`), not a literal `[]`, when an
  effect depends on it: `= []` is a new array on every render while the query is loading,
  so an effect that sets state from it loops (React error #185).

### Forms
- Use `react-hook-form` + Zod resolvers and the centralized types in
  `frontend/src/types/forms.ts` with their `createDefault*Form()` initializers — not
  ad-hoc inline form state.
- IDs are numbers, not strings. Use `null` for "no selection", `''` for empty text.
  Don't `parseInt` values already typed as numbers; don't `.trim()` a possibly-null
  field without `?.`.
- Every field has a name (a `<label htmlFor>`, or `aria-labelledby` for the custom
  pickers; `controlNames.test.ts` checks), and its error is tied to it: show it
  with `<FieldError fieldId message>` and spread `fieldErrorProps(fieldId, error)` on the
  control (`aria-invalid` + `aria-describedby`; pickers take `fieldErrorDescribedBy`).
  Keep the submit button enabled and focus the first invalid field on a refused submit
  (`focusFirstError` for fields react-hook-form can't focus). A dialog's form starts
  over with `useFormReset` when it opens.
- Money is entered with `CurrencyInput`, never `type="number"`; it reads `1,234.56` and
  `1.234,56` and refuses an ambiguous amount rather than cut it (`utils/parseAmount.ts`).

### UI / theming / a11y — Radix-led design system

The app **leads on Radix Themes**. The runtime theme picker (accent / gray / radius /
appearance) only works if every surface gets its color from the theme, so color must come
from Radix, never from static Tailwind. Three layers, in priority order:

- **Radix Themes — the default for anything it provides.** Layout (`Flex`/`Grid`/`Box`/
  `Container`/`Section`), typography (`Heading`/`Text`), all controls (`Button`,
  `IconButton`, `TextField`, `TextArea`, `Select`, `Checkbox`, `RadioGroup`, `Switch`,
  `SegmentedControl`), overlays (`Dialog`, `AlertDialog`, `DropdownMenu`, `Popover`,
  `Tooltip`), data display (`Table`, `Badge`, `Callout`, `Separator`, `ScrollArea`).
  Color/spacing/size come from **props** (`color`/`variant`/`size`/`gap`/`p`), not className.
- **Tailwind — thin utility layer only.** Gradients, keyframe animations (`animate-*`),
  text/render effects (`truncate`, `line-clamp-*`, `object-cover`), and **Radix CSS-var
  arbitrary classes** for residual raw elements (e.g. `bg-[var(--gray-3)]`,
  `text-[var(--gray-11)]`, `border-[var(--gray-6)]`). **No layout, no static colors, no
  `dark:`** on any element.
- **Custom (sanctioned, permanent) — keep, don't replace.** The gaps Radix can't fill:
  `RadixDatePicker`, `RadixColorPicker`, `RadixIconPicker`, `RadixMerchantSelector`,
  `RadixBudgetItemSelector`, `TagSelector`, `RadixTransactionTable`, `CurrencyInput`,
  `SharedPagination`, `ConfirmationDialog`, `NuggetSpinner`/`NuggetsLogo`; `@nivo` charts;
  `react-hot-toast`. These must follow the same color rules internally.
- **One searchable picker: `Combobox`.** The merchant, budget-item and tag pickers
  are built on it (Radix Popover; the WAI-ARIA combobox pattern: a `role="combobox"` search
  box, `aria-activedescendant`, focus back on the trigger on close). A new searchable picker
  is another wrapper around it, not another dropdown; `Combobox.test.tsx` drives it by keyboard.

Color rules (Idiom A):
- **No `dark:` color classes** — Radix vars self-swap with appearance; `dark:` is an
  anti-pattern now. Retire static `gray-*`, `bg-white`, `text-black`, and the
  `accessible-*`/`dark-*` token layers.
- Decorative `blue-*`/`purple-*` → `var(--accent-*)` so the picker drives them. Keep
  `red`/`green`/`amber` (via `var(--red-11)` etc.) only where **semantic**.
- Color goes in Radix props or `var(--*)` arbitrary classes — **never** inline `style`. A colour
  from data (a tag's, a budget item's, a person's, a chart slice's) may stay inline, with
  `/* lint:guard colour: <a few words why> */` on its property (a reason under three words is
  an error, not a marker). The marker is for data only: never mark a written-out colour
  (`lint:guard` refuses the inline colours it can trace, through consts, maps, functions,
  spreads, destructuring and the app's own imports, and in a DOM `el.style` write, and a marked
  literal). A colour a chosen fill falls back to goes in classes (`chosenColourProps`).
- **Text is step 11, or 12**: steps 9–10 are fills (as low as 1.2:1 on the page). On
  the app's light gray-2 page, step 11 of green, amber, yellow, orange, teal and jade is
  4.26–4.46:1, under AA, so their text is step 12 (`color="green" highContrast`, or
  `textColorProps(color)` for a computed one). Text on a step-9 fill is
  `var(--<color>-contrast)`, never `text-white`. Steps 3–8 aren't text at all (an icon may be,
  and a separator with `aria-hidden`). `npm run lint:guard` enforces all of these, on
  `<Badge>` and `<Callout.Text>` too.
- **Charts** take colours from `useChartTheme()` (`hooks/useChartTheme.ts`: the theme's values,
  resolved for nivo, and `chart.nivo` for `theme`), never an `isDark` hex. Each chart sits in a
  `ChartFigure` (title, a one-sentence summary, and its numbers as a table behind "Show data").

Layout & width:
- Structural layout is **Radix primitives**, not `div` + Tailwind flex/grid/spacing.
- **Every page renders inside one `PageContainer`** (`components/PageContainer.tsx`), in
  every state (loading, error, empty), so it keeps its width as it loads. Its `width` is the
  page's kind, never a list of pages:
  - `wide` (the default): every page that shows content — lists, hubs, detail pages, reports,
    settings lists. Up to 1600px, centred, so tables and card grids use a desktop's width (give
    a card grid an `xl` column count rather than stretching single cards);
  - `form`: a single-column form (~880px); forms never go wider;
  - `editor`: an editor with a side panel, like the budget-item and goal edit pages (~1136px);
  - `auth`: a centred card, like sign-in.

  It sets the side gutters (`px={{ initial: '4', sm: '6' }}`). `npm run lint:guard` refuses a
  width wrapper written by hand in `src/pages/` (a Radix `Container`, a `maxWidth` or a
  `max-w-*` of 768px or more) and a page component that returns without `PageContainer`.
- Mobile-first: cards on mobile, tables on desktop; bottom tabs vs sidebar nav. Two-up form
  fields via `<Grid columns={{ initial: '1', sm: '2' }} gap>`.

Components & a11y:
- Buttons/links are Radix `Button`/`IconButton` (icon-only needs `aria-label`) — no
  hand-rolled `<button>` styling. Inputs are Radix or the sanctioned selectors — no raw
  `<input>/<select>/<textarea>` in pages.
- Overlays are Radix; no hand-rolled portal menus/modals. No browser `confirm()`/`alert()`
  — use `ConfirmationDialog` + `useConfirmation`.
- Loading uses the shared `PageLoader`; page headers use `PageHeader` /
  `SettingsPageHeader`.
- Accessibility is mandatory: Atkinson Hyperlegible font, WCAG-compliant contrast (avoid
  `text-gray-400/500`; prefer `var(--gray-11/12)`), Radix focus rings (don't kill them with
  `outline-none`), ARIA labels.
- What a mouse can open, the keyboard can: no `onClick` on a `Card`, `Box` or
  `Table.Row` alone. A card that leads somewhere puts its title in a `StretchedLink`
  (controls inside it take `ABOVE_STRETCHED_LINK`); a table row puts a `Link` in its name
  cell and keeps `rowClick(...)` for the mouse; a right-click `ContextMenu` needs a button
  that opens the same actions.
- **A settings page states who may open it:** a new page under `/settings` gets an entry
  in `components/settingsAccess.ts` (the lowest role that may open it, the level the backend
  sets for the routes it calls, and whether it needs a ledger) and is wrapped with `guard(…)`
  in `SettingsPage.tsx`. Someone below that role sees a `Callout` saying so, never a blank page
  or a 403 toast; the settings menu shows only the pages a person can open.
- Every page has one `<h1>`: `PageHeader`, `SettingsPageHeader` and `ReportHeader` render
  it. After a navigation the shell (`useRouteFocus` in `FlexLayout`) focuses it and sets
  `document.title` to "`<h1>` – Nuggets"; without one, a screen reader lands on an unnamed
  `main`. Menu links take `aria-current` from `navCurrent` (`components/navigation.ts`).
- Shareable state in URL params; transient UI state in `sessionStorage`; never put
  navigation state in `localStorage`. Read and write storage through `utils/storage.ts`,
  which never throws (storage can be blocked or full).

---

## 🔌 MCP server (`/api/mcp`)

- Tools live in `mcp/src/tools/*.ts`, registered via `registerTool`; they're thin wrappers
  that call backend `/api/*` routes with `client.get/put/post`.
- **Coerce numeric inputs:** LLMs often send numbers as strings, so use `z.coerce.number()`
  (not `z.number()`) for ids/amounts/pages — otherwise tool calls fail input validation
  (`expected number, received string`).
- **Treat tool arguments as hostile:** a model can be prompt-injected by text it read.
  A uuid argument is `z.string().uuid()`, and a path with an argument in it is built with
  ``apiPath`/api/annotations/${uuid}` `` (`mcp/src/client.ts`), which encodes each value as
  one segment. The client refuses a path that isn't `/api/…`, or that the URL parser would
  resolve to another route (`..`, `%2e%2e`, `\`), so `uuid: '../admin/…'` can't reach admin.
- **Every tool states its effect:** `readOnly: true`, or `destructive: true` (it updates,
  replaces or removes) / `false` (it only adds). The type requires one; clients read them.
- **Untrusted text:** results carry bank- and outsider-written fields (`description`,
  `import_payee`, `notes`, `merchant_name`, annotation `body`, …: `UNTRUSTED_FIELDS` in
  `tools/helpers.ts`, plus a tool's `untrustedFields`) as `{ "untrusted": … }`, and the server
  instructions say it's data, never instructions. A new field such text lands in goes there.
- Tests (`mcp/__tests__/`, helpers in `harness.ts`) stub `fetch` and assert verb/path/body;
  `callTool` hits the handler directly, while `callToolValidated` parses through the tool
  schema first (use it to test input coercion). **A new tool needs a case in
  `tool-coverage.test.ts`** (its args and the exact requests), or that file fails; from the
  case it also checks numbers sent as strings and a path in place of each uuid.
  `httpHandler.test.ts` drives the HTTP transport with the SDK's own client.

---

## 🐳 Development (Docker-only)

The app runs **only** in Docker — never `npm run dev` on the host (the ESM build and
deps are baked into the images).

```bash
npm run setup          # once: .env, ./secrets/*.txt, ./data
npm run dev            # rebuild the images, replace backend + frontend, start (docker compose up --build)
npm run dev:detached   # detached
npm run logs           # follow logs (or open Dozzle at http://localhost:8888)
docker compose restart backend
npm run down           # stop
npm run down:volumes   # stop + DROP volumes — DESTRUCTIVE, confirm with the user first
```

The dev compose serves as `nuggets_app` like production and migrates on start. A setup from
before that needs `npm run setup` again, to create `secrets/app_db_password.txt`; the compose
file's connection settings (`DB_HOST`, `DB_USER`, …) now win over any left in `.env`.

Containers: `nuggets_backend` (:5000), `nuggets_frontend` (:3000),
`nuggets_postgres` (:5432), `dozzle` (:8888). Code changes require a container rebuild:
`npm run dev`. It removes the backend and frontend containers with their anonymous volumes
(`node_modules`, `dist`) first, since a recreated container would otherwise keep the old
build in them; the database's named volume stays. A bare `docker compose up --build` runs
the old code.

### npm workspace; `@nuggets/shared` — rebuild after editing
The packages are one npm workspace: `shared`, `mcp`, `backend`, `frontend` and `e2e`,
listed in the root `package.json`, with **one `package-lock.json` at the root** (no
per-package lockfiles). `npm ci` at the root installs them all (dependencies hoisted to the
root `node_modules`), and `npm run build` there builds them in order: shared, mcp, backend,
frontend (`npm run build:server` stops before the frontend). A package depends on another by
path (`"@nuggets/shared": "file:../shared"`, `"nuggets-mcp": "file:../mcp"`: never `"*"`, which
an install outside the workspace would look up on the public registry), linked in
`node_modules`, and the backend imports the MCP handler as `'nuggets-mcp'`. Each package's
scripts still run in its directory (`cd backend && npm run test:unit`) or from the root with
`-w` (`npm run test:unit -w backend`). `overrides` live only in the root `package.json` (npm
ignores a workspace's). `frontend/static-server` is outside the workspace, with its own
lockfile (the frontend image installs it alone): `npm ci --prefix frontend/static-server`.

Backend, frontend, and mcp consume `@nuggets/shared` as its built `dist/`. After editing
`shared/src/`, run `npm run build -w shared` **before** type-checking/running the consumers —
otherwise they compile against the old types and you'll chase phantom errors (`mcp` likewise
for the backend: `npm run build -w mcp`). CI builds shared first in every job; locally it's
on you.

### Migrations
```bash
./migrate.sh status | migrate | rollback [N] | create
docker exec nuggets_backend npm run migrate:status
```
Migrations apply automatically on backend startup (`docker-entrypoint.sh` runs
`node dist/scripts/migrate.js migrate` as the owner). An empty database gets
`backend/init.sql` first, so a plain or external Postgres 18 needs nothing loaded;
the server itself never runs DDL, and refuses to start without the schema
(`db/schemaReady.ts`).

**The baseline.** `init.sql` is the whole schema as of v3.0.0, which replaced every migration
up to v2.4.0 with it. A database records it as one `schema_migrations` row of its own
(`20261113000000`, `db/baseline.ts`), with no file. A v2.4.0 database (its rows exactly v2.4.0's
161, `db/v240Migrations.ts`) is cut over to it by the runner in one transaction
(`backend/upgrade/from-v2.4.0.sql`: never edit it, its SHA-256 is the baseline's checksum),
and the result compared with a fresh baseline's fingerprint (`upgrade/baseline-fingerprint.txt`,
`db/schemaFingerprint.ts`): a warning names what differs, never a refusal;
one from an older release, or with migrations this code doesn't know, is refused unchanged
(upgrade to v2.4.0 first; roll the unknown ones back, or restore a backup), and `migrate status`
says the same refusal. CI loads a v2.4.0 install (`src/test/fixtures/v2.4.0-install.sql`),
lets the runner cut it over and compares it with a fresh install (`check-migrations.sh upgrade`).

Add new migrations as timestamped SQL in `backend/migrations/` (`npm run migrate:create`, which
stamps UTC now, or, while the clock is behind the newest version it knows, that version's day at
now's time of day), newer than the baseline and with a version of its own (the
runner refuses one that isn't):
- **Every new migration has a `-- === DOWN ===` part** that undoes it. `migrationFiles.test.ts`
  fails without one (`NEWEST_WITHOUT_DOWN` is the baseline's version), and CI rolls back every
  migration newer than the baseline and compares the schema
  (`backend/scripts/check-migrations.sh rollback`, which passes when there is none).
- **Never edit an applied migration**: its checksum (UP part, line endings normalized) is in
  `schema_migrations`, and the runner refuses to start on a mismatch.
- Each migration runs in one transaction. `CREATE INDEX CONCURRENTLY` and the like go in a
  migration whose UP part has a line `-- nuggets:no-transaction` (statements run one by one;
  keep them idempotent). A statement waits at most `MIGRATION_LOCK_TIMEOUT` (5 s) for a
  lock, then the migration is retried. CONTRIBUTING.md has the safe-migration checklist.
- **Don't hand-edit `backend/init.sql`.** It's generated: `backend/scripts/regen-init-sql.sh`
  (Docker) rebuilds it from the previous baseline plus every migration and checks the result
  makes the same database. Its seed is the baseline's row plus a row for each migration folded
  in, whose files stay.

---

## ✅ Before you finish a change

Verify each package you touched:
- **backend** — `npm run type-check` (the source with `noUncheckedIndexedAccess`,
  `tsconfig.build.json`; then the tests without it, `tsconfig.test.json`. `tsconfig.json` names
  the two, so a bare `npx tsc --noEmit` checks nothing), `npm run lint`, `npm run test:run`
- **frontend** — `npm run type-check` (the source with `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`, `tsconfig.app.json`; then the tests without them,
  `tsconfig.test.json`; then the Vite configs. `tsconfig.json` names the three, so a bare
  `npx tsc --noEmit` checks nothing), `npm run lint`, **`npm run lint:guard`** (the Idiom-A
  design-system guard), `npm run test:run`
- **shared** — `npm run build` (its build *is* the type-check; rebuild so consumers update)
- **mcp** — `npm run type-check` (sources and tests, as the backend's; a bare `npx tsc --noEmit`
  checks nothing), `npm run test:run`
- **e2e** (a change to a page or route the journeys use) — `npm run type-check`, and
  `e2e/run.sh` (CI's `e2e` job runs it)

**TypeScript's flags:** every package is `strict` with `noUnusedLocals` and `noUnusedParameters`.
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on in shared and in the source
of mcp, the backend and the frontend. The tests (`tsconfig.test.json`) keep
`noUncheckedIndexedAccess` off, since a wrong index already fails the test; the frontend's keep
`exactOptionalPropertyTypes` off too. In source an index that can miss gets a real check (`?? ''`, a
refusal); a value the code knows is there goes through `oneRow` / `present`
(`backend/src/utils/present.ts`), never `!`. `noPropertyAccessFromIndexSignature` is on in
shared only: don't turn it on elsewhere, or rewrite `x.name` as `x['name']` for it.

Coverage counts every file under `src/`, tested or not; `npm run test:coverage` (CI)
fails below the floors in each package's `vitest.config.ts` (backend also per directory, and only
with `DATABASE_URL` set: the floors measure the whole suite). Raise
a floor when coverage grows; don't lower one to get a change through. The backend build
(`tsconfig.build.json`) leaves tests out of `dist/`; `npm run type-check` still checks them.

Then:
- If you changed the schema, run `db:codegen` and commit the regenerated types.
- Re-check the invariants above — especially tenant `getDb()`/RLS, shared-data (no
  `user_id` filter), event-sourced budgets, pre-signed amounts, and the `/api` prefix rule.
- Don't reintroduce removed infrastructure (Loki/Promtail/Grafana) or stale patterns.

> **Backend tests are three Vitest projects.** `unit` runs anywhere, with no
> database or secrets (`npm run test:unit`); `integration` needs Postgres; `migrations` (the
> tests that change the schema: `*Migration.test.ts`, `*Migrations.db.test.ts`, such as the
> cutover's `v240CutoverMigration.test.ts`) needs it too
> and runs one file at a time after the others, so its DDL never meets another file's
> queries. `npm run test:integration` runs the last two; `npm run test:run` runs all three, or
> `unit` alone while `DATABASE_URL` isn't set. A test that needs the database is named
> **`*.db.test.ts`**, or lives in `src/routes/__tests__/`; CI runs `unit` without a database,
> so a misnamed one fails there.
> The project globs are in `backend/vitest.config.ts`. The backup round trip
> (`BackupService.roundTrip.db.test.ts`) also needs `pg_dump`/`pg_restore` of the server's
> major version: set `PG_BIN_DIR` (e.g. `/usr/lib/postgresql/18/bin`) where PATH has older
> ones. It skips without them, except in CI, where it fails.

### DB-backed backend tests run under RLS, one ledger per file
- CI runs the app under test as **`nuggets_app`** (`DB_USER=nuggets_app`, `APP_DB_PASSWORD`;
  migrate grants the role its login), so every DB-backed suite runs under RLS, as production
  does. `DATABASE_URL` stays the owner connection. `createTestTenant()` and
  `rls-catalog.test.ts` refuse a superuser or BYPASSRLS app role.
- To run them locally, follow CI's `test-backend` steps (`ci-cd.yml`): load `backend/init.sql`
  into a fresh database, migrate as the owner with `APP_DB_PASSWORD` set (that grants
  `nuggets_app` its login), then run the tests with that step's env: `DB_USER=nuggets_app`,
  the same `APP_DB_PASSWORD`, and `DATABASE_URL` as the owner.
- Isolation itself is asserted by `rls-catalog.test.ts` (forced RLS and the exact tenant
  policy on every `public` table with `tenant_id` — except the control-plane
  `tenant_users` and `personal_access_tokens`, which are guarded in code; no views, rules or
  SECURITY DEFINER functions that bypass it — apart from the tracked exceptions it lists),
  `rls-isolation.test.ts` (two tenants, real queries) and `tenant-isolation-api.test.ts` (two
  ledgers in two organizations through every member, tenant-admin, org-admin and signed-in
  route; a new such route with a path parameter needs an id in its `urlFor`, and its known-leak
  lists must match exactly). `tenantReferences.db.test.ts` shows the database refusing a reference
  to another tenant's row. A suite that only runs under RLS proves nothing about
  isolation unless it checks another tenant's rows too.
- Give each integration file its own ledger with **`createTestTenant()`**
  (`src/test/testTenant.ts`): mount `tenant.context()`, seed and inspect through
  `tenant.pool` (the app role, scoped to that ledger), and call `tenant.cleanup()` in
  `afterAll` — it purges the whole ledger. Hand the code under test the app's own pool
  (`db.ts`'s default export), never `tenant.pool`, whose ledger setting would hide a query
  that runs outside `getDb()`. Never write fixtures into the seeded tenant 1 or hard-code a
  `tenant_id`: files run in parallel, and shared ledgers make tenant-wide assertions flaky.

### Verify the outcome, then get an adversarial review — for all work
- **Verify outcomes, not just code.** Run what you changed and observe the result:
  reproduce a bug before fixing it and show it fixed; for CI, deploy or script changes,
  prove the job or script actually does what you claim (read its logs/output).
- **Before calling any change done** — code, tests, config, CI, scripts or docs — have an
  independent agent review it **adversarially**. Give it the diff and the claims to falsify,
  not your reasoning; it should try to break the change by running it, not just read it.
- Fix what it confirms, or say why not. Send substantial fixes back for another review.
- When you report, say what was verified, how, and what wasn't.

---

## 🔀 PRs & CI

- Branch off `main`; **never commit to `main`.** One logical change per PR; rebase onto the
  updated `main` after each merge so the next PR stays a clean diff.
- **The tree cites no issue or pull request numbers, and no audit or requirement codes**
  (`SEC-AUTH-`, `DB-`, `FR-CA-` and their kin, with a number): not in code, comments, test
  titles, docs or messages. The project is published without its history, and the audit and the
  requirements lived in issues, so a number or a code points at nothing; say what the change
  does and why instead. Commit messages and PR descriptions may cite them. `node scripts/check-issue-refs.mjs` (in
  `repository-checks.yml`, after its cases, `node --test scripts/check-issue-refs.test.mjs`)
  fails on one, a link to one included; the top of the script lists what it leaves alone.
- Open the PR as a **draft**, then **mark it ready for review** — CI
  (`.github/workflows/ci-cd.yml`) only runs on **non-draft** PRs (checks read "skipped"
  until then), and it `paths-ignore`s `**/*.md` + `docs/**` (docs-only PRs run no checks).
- CI jobs (non-draft PRs targeting `main`/`develop`):
  - **`test-backend`**: `npm ci` (root) → build shared + mcp (run MCP tests) → load `init.sql` → build backend
    → type-check its source and tests → run migrations → **`db:codegen:check`** → the
    migration checks (rollback round trip, fresh install on an empty database, the upgrade
    from a v2.4.0 install) → unit tests
    without a database → backend tests
    (both projects, coverage) → backend lint → **`npm audit --omit=dev --audit-level=high`**
    at the root, once for every workspace (the root lockfile; `--workspace` misattributed the
    hoisted tree).
  - **`test-frontend`**: `npm ci` (root) → build shared → `type-check` (its source, tests and
    Vite configs) → `test:coverage` → `lint` →
    **`lint:guard`** → `build` → the built `index.html` checked (`check:build`) → the same
    audit for `frontend/static-server`.
  - The audit fails on a high or critical advisory in a production dependency, including one
    published after your change. Fix it by upgrading the package, not by lowering the level.
    Run `npm audit fix` and `npm update <pkg>` at the root (they write the one lockfile),
    with Node 26's npm (11), as CI's `npm ci` does; don't write the lockfile with an older
    npm (npm 10, Node 22's, crashed on the old `file:../shared` links with `Cannot read
    properties of null (reading 'edgesOut')`).
- Everything runs on **Node 26** (`.nvmrc`, each `package.json`'s `engines`, `@types/node`'s
  major, the Dockerfiles' `FROM` lines, and `node-version` in `ci-cd.yml` and
  `docker-images.yml`); change them together, and the docs with them:
  `node scripts/check-doc-versions.mjs` (in `repository-checks.yml`) fails when a tracked
  Markdown file (but CHANGELOG.md) or script states another version of Node,
  PostgreSQL, React, Vite, Express or the other tools it tracks; "Node 22's npm" (a version's
  own thing) isn't read as a statement. Search other files (the workflows' `PG_BIN_DIR`) for
  the old one. Dependabot (`.github/dependabot.yml`) opens monthly update PRs for npm (the workspace
  root and `frontend/static-server`), Docker base images and GitHub Actions, grouped so each group is
  one PR across every npm package (each PR runs the whole CI suite and costs Actions minutes).

---

## 🚫 Anti-pattern quick list

```text
WHERE user_id = $1                         # financial tables are shared
new Kysely({ pool }) for tenant data       # tenant queries run on getDb() (RLS GUC)
UPDATE budget_period_items SET budget = …  # budgets are event-sourced
SUM(CASE WHEN type='expense' THEN -amount) # amounts are pre-signed; just SUM(amount)
balance FLOAT                              # use DECIMAL(12,2)
gen_random_uuid() for new uuid defaults    # use uuidv7()
created_at timestamp without time zone      # instants are timestamptz; calendar days are date
new Date().toISOString().slice(0, 10)       # today is appToday(); day math is utils/calendarDate.ts
WHERE due_date >= CURRENT_DATE              # the household's today is app_today()
transaction_date timestamptz                # calendar dates stay date — never tz-shift them
new table without a uuid column            # every table: uuid NOT NULL DEFAULT uuidv7() + unique
/api/accounts in a frontend service path   # base.ts already adds /api
console.log(...)                           # use Pino logger
logger.error(err)                          # use logger.error({ err }, '...')
window.confirm(...)                         # use ConfirmationDialog
className="dark:text-white"                 # no dark: anywhere; Radix vars self-swap
className="text-gray-500 bg-white"          # static colors; use var(--gray-11)/<Card>
<button className="bg-blue-600 ...">        # use Radix <Button>/<IconButton>
<div className="max-w-7xl mx-auto">         # use one <PageContainer width="…">
<input className="..."> in a page          # use Radix TextField / sanctioned selector
import x from '../db'                       # ESM needs '../db.js'
multer before authenticateToken            # auth first, then upload
```
