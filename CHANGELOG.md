# Changelog

Notable changes to Nuggets, newest first. Each release is a git tag `vX.Y.Z`.

## Unreleased

### Security

- Passkey sign-in refuses a credential id longer than any can be before it reads it. A long
  run of `=` in one held the server for seconds per request.
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

### Changed

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

- The plain-text part of notification emails reads as the email does: apostrophes, `=` and
  © come out as characters, not codes, Outlook-only markup no longer leaves a stray "96",
  and the button's and the unsubscribe link's addresses are in it.
- A screen reader reads the menu's Activity link with its count as "Activity, 2 new"; it
  read "Activity , 2 new", with a pause before the comma.
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
