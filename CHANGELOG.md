# Changelog

Notable changes to Nuggets, newest first. Each release is a git tag `vX.Y.Z`.

## Unreleased

### Security

- Passkey sign-in refuses a credential id longer than any can be before it reads it. A long
  run of `=` in one held the server for seconds per request.
- OneDrive's app registration (client ID, secret and redirect URI) is no longer read from
  the stack's environment: it comes only from the Backup page, where it is stored encrypted.
  The compose files and env templates no longer offer `ONEDRIVE_CLIENT_ID`,
  `ONEDRIVE_CLIENT_SECRET` or `ONEDRIVE_REDIRECT_URI`. Until a redirect URI is saved there,
  it is `DOMAIN_URL`'s `/api/onedrive/callback`.

  **Upgrading:** if you set those variables and never saved the registration on the Backup
  page, OneDrive shows as not set up: enter the same three values there, and its sign-in and
  the backups already copied to it carry on. Then delete the `ONEDRIVE_*` variables from your
  stack or `.env`.

### Fixed

- The plain-text part of notification emails reads as the email does: apostrophes, `=` and
  © come out as characters, not codes, Outlook-only markup no longer leaves a stray "96",
  and the button's and the unsubscribe link's addresses are in it.
- A screen reader reads the menu's Activity link with its count as "Activity, 2 new"; it
  read "Activity , 2 new", with a pause before the comma.

## 3.0.0 (2026-11-12)

The first public release.
