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
  sign-in carries on, and the backups already copied to it stay. Until then scheduled backups aren't
  copied to OneDrive, and each one logs a warning saying so. Then delete the `ONEDRIVE_*`
  and `ENCRYPTION_KEY` variables from your stack or `.env`.

### Fixed

- The plain-text part of notification emails reads as the email does: apostrophes, `=` and
  © come out as characters, not codes, Outlook-only markup no longer leaves a stray "96",
  and the button's and the unsubscribe link's addresses are in it.
- A screen reader reads the menu's Activity link with its count as "Activity, 2 new"; it
  read "Activity , 2 new", with a pause before the comma.

## 3.0.0 (2026-11-12)

The first public release.
