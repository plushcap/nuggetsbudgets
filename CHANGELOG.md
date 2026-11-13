# Changelog

Notable changes to Nuggets, newest first. Each release is a git tag `vX.Y.Z`.

## Unreleased

### Changed

- Each GitHub Release's description lists what changed in it: its section of this changelog,
  then the pull requests merged since the release before it. A release made before this has
  only a link to the changelog: run **Rewrite release notes** from the Actions tab on `main`,
  with its tag, to add the list (the rest of its description and its attached compose file stay
  as they are).
- A bank transaction is linked to one entered by hand of the same amount dated up to 7 days
  before it; it was 4. A transfer entered the day it is sent can post five business days later,
  over a weekend, and was added beside the manual entry instead of being linked to it. An entry
  dated after the bank's transaction is still linked only up to 4 days after it, so next week's
  payment of the same amount, entered early, isn't taken for this week's; and a balance
  adjustment the sync booked, only up to 4 days either side, so an unrelated bank transaction
  of its amount a week later doesn't take it over.
- A bank transaction is no longer linked to a part of a split transaction, or to a side of a
  move between budget periods. Neither is ever at the bank, and either link left the bank's
  transaction out of the balance.

### Fixed

- Close-Out's envelope reconciliation, and the Budget page's Envelope Comparison, compare a
  month's envelopes with the envelope account's money through that month, counted as the
  envelopes are: what is filed under that month or an earlier one, and what is filed under none
  (the opening balance among them) and dated by its last day. Both used the account's balance
  today for every month, so a past month showed a variance of everything that had moved since.
  Both say which month the figure is through; for the current month it can differ from the
  account's balance today, by what is dated later in the month or filed under another.
  `GET /api/budgets/periods/:uuid/envelope-balance` answers it.

## 3.1.0 (2026-11-13)

### Security

- OneDrive's app registration (client ID, secret and redirect URI) is no longer read from
  the stack's environment: it comes only from Settings → Database Backup, where it is stored
  encrypted. The compose files and env templates no longer offer `ONEDRIVE_CLIENT_ID`,
  `ONEDRIVE_CLIENT_SECRET` or `ONEDRIVE_REDIRECT_URI`, and the development-only
  `ENCRYPTION_KEY` is gone too (OneDrive's tokens are sealed with the data encryption key,
  which `npm run setup` makes). The form starts the redirect URI on `CLIENT_URL` (else
  `DOMAIN_URL`) with `/api/onedrive/callback`.

  **Upgrading:** if your stack set any of the `ONEDRIVE_*` variables, open Settings →
  Database Backup. If OneDrive shows as not set up, enter the same three values there: its
  sign-in carries on, and the backups already copied to it stay. Until then scheduled
  backups aren't copied to OneDrive, and each one logs a warning saying so. Then delete the
  `ONEDRIVE_*` and `ENCRYPTION_KEY` variables from your stack or `.env`.
- minimatch 11 and glob 14, which fix two moderate advisories: minimatch could be made to
  build huge numbers of patterns from one glob (a denial of service), and glob kept walking
  the filesystem after its AbortSignal had cancelled it. An old dependency override held
  every package but one at minimatch 9; overrides now raise only the affected versions,
  minimatch to 11 and glob to 14. The server never matches a glob: only ESLint and mjml's
  command-line tool do.
- Production reads secrets only from their Docker secret files, and refuses to start with
  one set in the environment: `DB_PASSWORD`, `APP_DB_PASSWORD`, `JWT_SECRET`,
  `SESSION_SECRET` or `CSRF_SECRET`. The error names the variable and the file it belongs in.
  Production always reads the files now, whatever `USE_DOCKER_SECRETS` says, and the
  `restore`, `rewrap-secrets`, `setup-token` and `migrate-images-to-db` commands refuse a
  variable too. Development and the tests still take the variables (a file, when there is
  one, wins).
- `MIGRATION_DB_PASSWORD`, `BACKUP_DB_PASSWORD` and `BACKUP_DB_USER` are gone. The database
  owner signs in with `db_password`, the password Postgres gave it, for migrations, backups
  and restores alike: a second owner password could only repeat it. A separate backup role
  served one case, an external Postgres whose owner isn't a superuser: restoring a backup
  now needs the owner to be one (grant it for the restore there). Production refuses to start
  while one of the three reaches the backend: 3.0.0's compose files pass `BACKUP_DB_USER`
  through, the new ones don't pass it at all.

  **Upgrading:** nothing to do with the provided compose files, which pass no secret in the
  environment. If your stack or `.env` sets one of the five secret variables, put its value
  in the secret file named after it (`jwt_secret` for `JWT_SECRET`) and remove the variable.
  If it sets `MIGRATION_DB_PASSWORD`, `BACKUP_DB_PASSWORD` or `BACKUP_DB_USER`, remove it
  (`db_password` must hold the owner's password, as it does with the provided compose files).
  The server won't start until you do, except for a `BACKUP_DB_USER` that the new compose
  files no longer pass, which is ignored (backups run as the owner).

### Changed

- The main menu is reordered: Home, Budgets, Tasks, Close-Out, Goals, Bills, Accounts,
  Transactions, Agent Activity, Tags, Investments, then Reports, set apart. Dashboard is now
  **Home** and Activity **Agent Activity** in the menu, and Investments carries a small
  **Beta** tag.
- A budget period with transactions can no longer be deleted, which left its transactions
  without a period. **Settings → Budget Periods** offers to archive it instead: an archived
  period leaves the period pickers (the Budget and Close-Out pages, a transaction's period,
  the filters, transfers and exports), and its transactions, budget and every envelope balance
  stay as they are. The page hides archived periods until **Show archived** is pressed, and
  restores one with a click. A period with no transactions is still deleted, with its budget.
  A picker still shows the period it holds, archived or not (a transaction's period, the
  period a link opens).

  The API refuses such a delete with 409 `BUDGET_PERIOD_HAS_TRANSACTIONS` (with
  `transaction_count`), and its answer no longer has `transactions_unassociated`. Periods carry
  `archived_at`; `POST /api/budget-periods/:uuid/archive` and `…/restore` set and clear it. The
  database migration that adds the column runs when the server starts.

### Fixed

- Creating a budget period from the Budget page's **Create Period** now takes in that month's
  transactions that have no period yet, as **Settings → Budget Periods → Add** always has.
  Before, the month's existing transactions stayed outside the new period. When one of them is
  being changed at that moment, the dialog now says so (nothing was saved, try again) instead
  of a generic failure.
- A new budget period, made either way, no longer takes in a transaction a member took out of a
  period (for instance one moved to another month's period and then taken out of it), as the
  bank sync already didn't. As with the bank sync, a transaction that last left its own month's
  period goes back in when that period has been deleted and the month's period is made again;
  that includes the transactions a delete took out of their period before such a delete was
  refused (see Changed).

## 3.0.0 (2026-11-12)

The first public release.

### Security

- Passkey sign-in refuses a credential id longer than any can be before it reads it. A long
  run of `=` in one held the server for seconds per request.

### Fixed

- The plain-text part of notification emails reads as the email does: apostrophes, `=` and
  © come out as characters, not codes, Outlook-only markup no longer leaves a stray "96",
  and the button's and the unsubscribe link's addresses are in it.
- A screen reader reads the menu's Activity link with its count as "Activity, 2 new"; it
  read "Activity , 2 new", with a pause before the comma.
