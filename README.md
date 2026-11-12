# Nuggets

Envelope budgeting for families: **every dollar has a purpose, and every spend has a budget.**

Nuggets is a self-hosted finance manager that a household runs together. Its budget is a
monthly plan that gives each dollar of income a job, and every transaction is matched to the
part of the plan it spends. It is built to be run with an AI agent beside you: an MCP server is
part of the app, so an agent can sort transactions, explain what it did, ask when it isn't
sure, and learn from your answers.

> **Draft.** This README is a first draft and the setup guide is still being written. To work
> on the code, see [CONTRIBUTING.md](./CONTRIBUTING.md); to report a vulnerability, see
> [SECURITY.md](./SECURITY.md).

## The method

### Every dollar has a purpose

Each month starts with a plan. Your income is divided among **budget items** until every dollar
is assigned to one of them:

| Kind of item | What it's for | How it counts in the month |
|---|---|---|
| **Income** | Paychecks and other money coming in | What actually came in |
| **Monthly expense** | Spending that recurs every month: groceries, fuel, eating out | What you actually spent |
| **Bill** (a fixed monthly expense) | Rent, utilities, subscriptions | What you spent, and what is still to pay |
| **Envelope** | Money set aside now for spending later: car repairs, holidays, a bill paid once a year | The whole amount planned for it, whether or not it was spent |
| **Goal** (savings) | Building something up: an emergency fund, a down payment | The amount planned for it this month |

A made-up month, with $5,000 of income:

| Item | Kind | Planned |
|---|---|---|
| Rent | Bill | $1,800 |
| Utilities | Bill | $200 |
| Groceries | Monthly expense | $700 |
| Fuel | Monthly expense | $200 |
| Car repairs | Envelope | $150 |
| Holidays | Envelope | $250 |
| Car insurance (paid yearly) | Envelope | $100 |
| Emergency fund | Goal | $1,600 |
| **Total** | | **$5,000** |

The plan adds up to the income: nothing is left without a purpose. The Budget page shows, for
every item, what was planned, what was spent and what is left, with two summaries:

- **Budget:** the plan's own balance, planned income less planned spending and saving. It is $0
  when every dollar has a job.
- **Actual:** what is really left. That's the income received, less what monthly expenses
  spent, less what envelopes and goals were given.

### Every spend has a budget

Every income and expense transaction gets a budget item. Transfers between your own accounts
don't: they move money, they don't spend it. Imported transactions arrive marked
**needs review** and wait on the **Tasks** page until a person or an agent confirms where they
belong (unless the account is set to mark them reviewed automatically). Spending ten dollars on coffee is fine; spending it without knowing which part of the
plan paid for it is what the method avoids.

The Tasks page starts out showing the tasks assigned to you. Turn on **Include Unassigned** to
see everything waiting, or give each bank account a **default assignee for imported
transactions** (Edit Account → Import Automation).

Sorting gets faster as the ledger learns your habits:

- **Merchants** tidy the bank's payee text (`SQ *BLUE BOTTLE 0423`) into one named merchant.
- **Budget matching rules** fill in the budget item on imported transactions, for accounts with
  "Automatically categorize transactions using matching rules" turned on (Edit Account →
  Import Automation). A rule matches by text (exact, contains, starts with, ends with, or a
  regular expression) or by merchant, optionally only within an amount range. The merchant's
  past assignments and similar descriptions help too. A matched transaction still waits on the
  Tasks page, already filled in, so accepting it is one click.
- A transaction can be **split** across several budget items.

### Envelopes live in one high-yield savings account

Envelopes are money you have set aside but not yet spent, so Nuggets keeps them somewhere real.
All envelopes are designed to share **one high-yield savings account**. Mark it as the
**envelope account**: on the account's page choose **Manage → Edit Account** and tick
"Designate as envelope account for budget comparison" (the same box is on Add Account). Only
one account can be the envelope account.

- **Envelope money earns interest** while it waits for the car repair or the holiday.
- **Pay envelope expenses as usual.** Pay them from your everyday account and match each one to
  its envelope.
- **Move the net at month end.** **Close-Out** shows the net to move into the savings account:
  what the envelopes were given, less what they spent. It also shows what you actually
  transferred and flags any difference. If the envelopes spent more than they were given, the
  money moves back out.
- **Reconcile the account.** Close-Out also checks the account against the envelopes: its
  balance should equal the total of every envelope's balance. When they match, the envelopes
  are backed by real money in the bank. The check uses today's balance, so close out the month
  before the next month's money moves.

An envelope keeps its balance from month to month (it "rolls over"), so a $100-a-month
insurance envelope holds $1,200 when the yearly bill arrives. An envelope can have a target
amount and date, and a starting balance for money it held before you started using Nuggets.

### The monthly cycle

1. **Plan.** Create the month's budget period. Every budget item with a default amount gets it,
   and you adjust the plan until every dollar has a purpose.
2. **Spend and sort.** Transactions arrive from your bank (through SimpleFIN) or are entered by
   hand. Imports wait on the Tasks page, with a budget item already filled in where a rule or
   the merchant's history knew it, for a person or an agent to confirm.
3. **Close out.** The Close-Out page goes through the month:
   - income, monthly spending, and what envelopes and goals were given;
   - what is left, and what is left once the bills still to pay are taken out too;
   - which monthly expenses and envelopes were overspent;
   - accounts that should be at zero;
   - the transfer to the envelope account, and its reconciliation.

   Then the next month begins.

Each change to a budget is recorded as an event, with who made it and when, rather than
overwriting a number, so a month's plan keeps the history of how it changed.

## Agent-assisted budgeting

Nuggets is built to be run with an AI agent. The app includes an **MCP server**
([Model Context Protocol](https://modelcontextprotocol.io)) at `/api/mcp`, with more than a
hundred tools. They cover:

- accounts and transactions;
- budget items, budget periods and matching rules;
- merchants, tags and goals;
- investments and notifications;
- tasks and notes.

### What an agent does

- **Works through the Tasks queue.** It reads the transactions waiting for review, matches each
  to a budget item (and merchant), and marks it reviewed in one step.
- **Explains itself.** On a transaction it can leave its reasoning, a question for you or a
  decision. A question it flags for you shows as a banner on that transaction's page and on the
  **Activity** page.
- **Learns from your answers.** On the agent's notes you can choose **Looks good** or **Flag
  incorrect**, with a reason. An incorrect one comes back to the agent's inbox, and the agent is
  asked to change what it relied on (a rule, or the instructions below) and record what it
  changed.
- **Follows your instructions.** Merchants, budget items and accounts each have an
  `instructions` field: plain-language guidance written for agents, apart from the notes people
  read. For example: "Split Costco between Groceries and Household; anything over $300 is
  probably the yearly membership, so ask." When you tell the agent something worth keeping, it
  writes it there.
- **Answers questions.** How much is left in the holiday envelope? What did we spend on eating
  out this quarter? Which envelopes are overspent?

### Connecting an agent

1. **Create a token.** In Nuggets, open **Settings → MCP Access**. Each token:
   - works in one ledger;
   - is **read only** (the default) or **read and write**;
   - expires after 30 days, 90 days or a year.

   Creating one needs a recent sign-in: Nuggets asks for your password or passkey again if it
   has been more than a few minutes. The same page lists your tokens and revokes them.
2. **Copy the setup it shows.** It appears once, right after the token is created:
   - **Claude Code:** a ready-made `claude mcp add --transport http nuggets …` command.
   - **Claude Desktop:** a config snippet for `claude_desktop_config.json`. It runs the
     `mcp-remote` bridge, so it needs Node.js on that computer.
   - **Another MCP client:** one that can send a bearer token over streamable HTTP connects to
     `https://<your Nuggets address>/api/mcp` with the header `Authorization: Bearer <token>`.
     Nuggets doesn't offer OAuth sign-in for MCP clients.

### Guard rails

- **A token reaches only the routes the agent's tools use.** Account settings, passwords,
  administration and other ledgers are refused. A read-only token can't change anything.
- **Bank text is marked as untrusted.** Text written by banks, merchants or other people (a
  payee, a memo, a note) reaches the agent marked as data, and the server tells the agent never
  to act on it.
- **The agent works as you, never as more.** A token carries the access of the person who
  made it, in one ledger. The agent's reasoning and questions sit on the transactions it
  touched, where you can mark them right or wrong.

## Also in Nuggets

- **For the whole household.** An organization (your family) holds one or more **ledgers**.
  Everyone in a ledger sees and edits all of it. People join by invitation, and each ledger's
  data is kept apart by the database itself (PostgreSQL row-level security).
- **Accounts and net worth.** Checking, savings, cash, credit card, loan, mortgage, line of
  credit, investment and business accounts, their balances over time, and a net worth report.
- **Bills, goals and reports.** Upcoming bills with due dates; goals linked to accounts and
  envelopes, with progress history; spending reports by tag, and a Sankey view of where the
  money went.
- **Investments.** Holdings and lots, cost basis, realized and unrealized gains, dividends,
  fees, and look-through into what funds hold.
- **Notifications.** Email and web push for budget items, transactions, bills, review
  reminders and a weekly digest, with rules you set.
- **Sign-in and safety.**
  - Passkeys or passwords.
  - Encrypted backups, with optional upload to OneDrive.
  - CSV exports of transactions, accounts, budget items and budget periods.

## Running Nuggets

Nuggets runs in Docker: a backend (Node 26), a web app, and PostgreSQL 18. Each release
publishes its images to the GitHub Container Registry:

```
ghcr.io/plushcap/nuggets-backend
ghcr.io/plushcap/nuggets-frontend
ghcr.io/plushcap/nuggets-postgres
```

[`docker-compose.portainer.yml`](./docker-compose.portainer.yml) runs the stack from those
images (as a Portainer stack, or with `docker compose`), on the `latest` release unless you set
`NUGGETS_IMAGE_TAG`. It expects a reverse proxy in front of it and two Docker networks you
create once (`frontend` and `admin`). The comments in the file explain each setting. Each
[release](https://github.com/plushcap/nuggetsbudgets/releases) also attaches a copy pinned to
its own version. A full setup guide is on the way.

To develop Nuggets, see [CONTRIBUTING.md](./CONTRIBUTING.md). The app runs in Docker
(`npm run setup`, then `npm run dev`); the setup script needs Node 26 on your machine.

## License

Copyright (C) 2025-2026 The Nuggets contributors.

Nuggets is source-available under the [PolyForm Noncommercial License 1.0.0](./LICENSE)
(`PolyForm-Noncommercial-1.0.0`). You may use, run, change and share it for any noncommercial
purpose: for yourself and your household, for study or research, or within a charity, school or
public body. Commercial use, including selling it, building a product on it, or running it as a
paid service, is not licensed. For a commercial license, ask the copyright holder through the
repository.

The license comes with no warranty; see its "No Liability" section.
