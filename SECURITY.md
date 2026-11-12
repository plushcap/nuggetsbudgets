# Security policy

Nuggets holds a family's financial data, so we take vulnerability reports seriously and
handle them privately.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub instead: open the repository's **Security** tab and
choose **Report a vulnerability**. That creates a private advisory that only you and the
maintainers can see.

Please include:

- what an attacker could do, and which roles are involved (a ledger member, an organization
  admin, a deployment admin, someone not signed in, or a holder of an MCP token);
- the steps to reproduce it, ideally against a fresh install;
- the version or commit you tested.

## What to expect

- We aim to acknowledge a report within **7 days**, and to tell you within **30 days** whether
  we accept it and how we plan to fix it.
- We fix accepted issues on the `main` branch, publish a GitHub security advisory, and credit
  you unless you ask us not to.
- Please give us a reasonable chance to release a fix before disclosing the problem publicly.

## Supported versions

Nuggets is self-hosted and is developed on `main`. Security fixes land on `main` and in the
next release; older releases don't get backports. Keep your deployment on the latest
release.

## Scope

In scope: the backend API, the web app, the MCP server at `/api/mcp`, the Docker images
and compose files in this repository, and the database migrations. Of particular interest:

- one ledger or organization reaching another's data (rows are kept apart by Postgres
  row-level security);
- ways around authentication, CSRF protection or the role checks;
- ways to read the secrets Nuggets stores (encrypted bank and OneDrive credentials, the
  backup key).

Out of scope: deployments that run Nuggets in a way it refuses or warns against (for
example, without HTTPS, or serving as a database role that bypasses row-level security), denial of service
by exhausting the host's resources, and findings in third-party services such as SimpleFin
or Microsoft OneDrive.
