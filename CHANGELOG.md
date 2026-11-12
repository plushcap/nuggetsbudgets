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

- Production reads secrets only from their Docker secret files, and refuses to start with
  one set in the environment: `DB_PASSWORD`, `APP_DB_PASSWORD`, `JWT_SECRET`,
  `SESSION_SECRET`, `CSRF_SECRET`, `MIGRATION_DB_PASSWORD` or `BACKUP_DB_PASSWORD`. The
  error names the variable and the file it belongs in. The two owner-password overrides
  have files of their own now, `migration_db_password` and `backup_db_password` (optional).
  Development and the tests still take the variables.

  **Upgrading:** nothing to do with the provided compose files, which pass no secret in the
  environment. If your stack or `.env` sets one of those variables, put its value in the
  secret file named after it (`jwt_secret` for `JWT_SECRET`) and remove the variable; the
  server won't start until you do.

### Fixed

- The plain-text part of notification emails reads as the email does: apostrophes, `=` and
  © come out as characters, not codes, Outlook-only markup no longer leaves a stray "96",
  and the button's and the unsubscribe link's addresses are in it.
- A screen reader reads the menu's Activity link with its count as "Activity, 2 new"; it
  read "Activity , 2 new", with a pause before the comma.

## 3.0.0 (2026-11-12)

The first public release.
