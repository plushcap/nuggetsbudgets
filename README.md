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

| Kind of item | What it's for | How it counts each month |
|---|---|---|
| **Monthly expense** | Spending that recurs every month: groceries, fuel, eating out | What you actually spent |
| **Bill** (a fixed monthly expense) | Rent, utilities, subscriptions, with a due date | What you spent, and what is still to pay |
| **Envelope** | Money set aside now for spending later: car repairs, holidays, the annual insurance premium | The whole amount you planned, whether or not it was spent |
| **Goal** (savings) | Building something up: an emergency fund, a down payment | The amount you put towards it |

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

The plan adds up to the income: nothing is left without a purpose. During the month the Budget
page shows, for every item, what was planned, what was spent and what is left. It also shows
how much of the month's income is still unassigned once monthly spending, envelopes and goals
are taken out. A second figure takes out the bills still to pay as well.

### Every spend has a budget

Every transaction is matched to a budget item. Nothing stays unsorted: a transaction that
hasn't been matched and reviewed waits on the **Tasks** page until someone (or an agent)
decides where it belongs. Spending ten dollars on coffee is fine; spending it without knowing
which part of the plan paid for it is what the method avoids.

Matching gets faster as the ledger learns your habits:

- **Merchants** tidy the bank's payee text ("SQ \*BLUE BOTTLE 0423") into one named merchant.
- **Budget matching rules** send future transactions to a budget item automatically: by text
  (exact, contains, starts with, ends with, or a regular expression) or by merchant,
  optionally only within an amount range.
- A transaction can be **split** across several budget items, and **transfers** between your
  own accounts are recorded as both sides of one move.

### Envelopes live in one high-yield savings account

Envelopes are money you have set aside but not yet spent, so Nuggets keeps them somewhere real.
All envelopes are designed to share **one high-yield savings account**: mark it as the
**envelope account** when you edit it (Accounts → the account → Edit → "Designate as envelope
account for budget comparison"). Only one account can be the envelope account.

- Envelope money earns interest while it waits for the car repair or the holiday.
- You pay envelope expenses from your everyday account as usual, and match them to the
  envelope. At the end of the month, **Close-Out** shows the net to move into the savings
  account: what the envelopes were given, less what they spent. It also shows what you actually
  transferred, and flags the difference. If the envelopes spent more than they were given, the
  money moves back out.
- Close-Out also **reconciles** the account: its balance should equal the total of every
  envelope's balance. When they match, the envelopes are backed by real money in the bank.

An envelope keeps its balance from month to month (it "rolls over"), so a $100-a-month
insurance envelope holds $1,200 when the yearly bill arrives. An envelope can have a target
amount and date, and a starting balance for money it held before you started using Nuggets.

### The monthly cycle

1. **Plan.** Start the month's budget period. Every budget item gets its usual amount, and that
   month's transactions are brought in. Adjust the plan until every dollar has a purpose.
2. **Spend and sort.** Transactions arrive from your bank (through SimpleFIN) or are entered by
   hand. Rules match the familiar ones; the rest wait on the Tasks page for a person or an
   agent.
3. **Close out.** The Close-Out page goes through the month:
   - income;
   - spending on monthly expenses;
   - what the envelopes and goals were given;
   - what is left;
   - the bills still unpaid;
   - which items and envelopes were overspent;
   - the transfer to the envelope account and its reconciliation.

   Then the next month begins.

Every change to a budget is recorded as an event, with who made it and when, rather than
overwriting a number. The history of a month's plan is always there to read.

## Agent-assisted budgeting

Nuggets is built to be run with an AI agent. The app includes an **MCP server**
([Model Context Protocol](https://modelcontextprotocol.io)) at `/api/mcp`, with more than a
hundred tools. They cover accounts, transactions, budget items and periods, matching rules,
merchants, tags, goals, investments, notifications, tasks and annotations. Any MCP client can
connect: Claude Code, Claude Desktop, or another agent.

### What an agent does

- **Sorts the Tasks queue.** It reads the transactions waiting for review, matches each to a
  budget item (and merchant), and marks it reviewed in one step.
- **Explains itself.** On any transaction or record it can leave a note of its reasoning, a
  question for you, or a decision. A question you need to answer shows on the **Activity** page
  and as a banner on the record.
- **Learns from your answers.** You can mark an agent's decision correct or incorrect. An
  incorrect one comes back to the agent, which changes what it was going on (a rule, or the
  instructions below) and records what it changed.
- **Follows your instructions.** Merchants, budget items and accounts each have an
  `instructions` field: plain-language guidance written for agents, apart from the notes people
  read. For example: "Split Costco between Groceries and Household; anything over $300 is
  probably the yearly membership, so ask." When you tell the agent something worth keeping, it
  writes it there.
- **Answers questions.** How much is left in the holiday envelope? What did we spend on eating
  out this quarter? Is the envelope account reconciled?

### Connecting an agent

1. In Nuggets, open **Settings → MCP Access** and create a token. A token works in one ledger,
   is **read-only** or **read and write**, and expires after the time you choose. Creating one
   needs a recent sign-in: Nuggets asks for your password or passkey again if it has been more
   than a few minutes. The same page lists your tokens and revokes them.
2. Copy the setup the page gives you:
   - **Claude Code:** a ready-made `claude mcp add --transport http nuggets …` command.
   - **Claude Desktop:** a config snippet for `claude_desktop_config.json`.
   - **Any other MCP client:** connect to `https://<your Nuggets address>/api/mcp` over
     streamable HTTP, with the header `Authorization: Bearer <token>`.

### Guard rails

- **A token reaches only the routes the agent's tools use.** Account settings, passwords,
  administration and other ledgers are refused. A read-only token can't change anything.
- **Bank text is marked as untrusted.** Text written by banks, merchants or other people (a
  payee, a memo, a note) reaches the agent marked as data, never as instructions. A transaction
  description can't tell the agent what to do.
- **The agent works as you, never as more.** A token carries the access of the person who
  made it, in one ledger. The agent's reasoning and questions sit on the records it touched,
  where you can mark them right or wrong.

## Also in Nuggets

- **For the whole household.** An organization (your family) holds one or more **ledgers**.
  Everyone in a ledger sees and edits all of it. People join by invitation, and each ledger's
  data is kept apart by the database itself (PostgreSQL row-level security).
- **Accounts and net worth.** Checking, savings, cash, credit card, loan, mortgage, line of
  credit and investment accounts, their balances over time, and a net worth report.
- **Bills, goals and reports.** Upcoming bills with due dates; goals linked to accounts and
  envelopes, with progress history; spending reports by tag, and a Sankey view of where the
  money went.
- **Investments.** Holdings and lots, cost basis, realized and unrealized gains, dividends,
  fees, and look-through into what funds hold.
- **Notifications.** Email and web push for budget items, transactions, bills, review
  reminders and digests, with rules you set.
- **Sign-in and safety.** Passkeys or passwords; encrypted backups, with optional upload to
  OneDrive; a full data export.

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
`NUGGETS_IMAGE_TAG`. Each [release](https://github.com/plushcap/nuggetsbudgets/releases) also
attaches a copy pinned to its own version. A full setup guide is on the way.

To develop Nuggets, see [CONTRIBUTING.md](./CONTRIBUTING.md): everything runs in Docker
(`npm run setup`, then `npm run dev`).

## License

Copyright (C) 2025-2026 The Nuggets contributors.

Nuggets is source-available under the [PolyForm Noncommercial License 1.0.0](./LICENSE)
(`PolyForm-Noncommercial-1.0.0`). You may use, run, change and share it for any noncommercial
purpose: for yourself and your household, for study or research, or within a charity, school or
public body. Commercial use, including selling it, building a product on it, or running it as a
paid service, is not licensed. For a commercial license, ask the copyright holder through the
repository.

The license comes with no warranty; see its "No Liability" section.
