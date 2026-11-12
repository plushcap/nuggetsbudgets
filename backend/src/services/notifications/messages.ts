import type { BudgetItemSubject, TransactionSubject, WeekSummary } from './facts.js';
import type { Occurrence } from '../bills/BillService.js';
import { daysBetween } from './schedule.js';
import type { Facts } from './conditions.js';
import { DEFAULT_CURRENCY, DEFAULT_LOCALE, budgetItemFactKind, type MoneyFormat } from '@nuggets/shared';
import { moneyText } from '../tenantMoneyFormat.js';

/**
 * What one notification says, for both channels. The email is laid out by the
 * `rule_message` template; `path` is the in-app page both the email button and
 * a tapped push open. Pure: everything it says comes from its arguments, its
 * amounts in the ledger's money format (`money`, USD in en-US when not given).
 */
export interface MessageContent {
  subject: string;
  heading: string;
  paragraphs: string[];
  buttonText: string;
  path: string;
  push: { title: string; body: string };
}

const DEFAULT_MONEY: MoneyFormat = { currency: DEFAULT_CURRENCY, locale: DEFAULT_LOCALE };

/** Amounts as the ledger shows them. */
function moneyIn(money: MoneyFormat): (value: number) => string {
  return (value) => moneyText(value, money);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "Friday, October 2" for a 'YYYY-MM-DD' day, read as a calendar date (no zone shift). */
function dayWords(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function greeting(firstName: string | null): string {
  return `Hi ${firstName?.trim() || 'there'},`;
}

export function budgetItemMessage(
  ruleLabel: string,
  item: BudgetItemSubject,
  firstName: string | null,
  money: MoneyFormat = DEFAULT_MONEY
): MessageContent {
  const dollars = moneyIn(money);
  const { facts } = item;
  const budgeted = Number(facts.budgeted);
  const remaining = Number(facts.remaining);
  const income = facts.kind === budgetItemFactKind.enum.income;
  const used = Number(income ? facts.received : facts.spent);
  const percent = typeof facts.percent_used === 'number' ? ` (${facts.percent_used}%)` : '';

  const figures = income
    ? `${item.name} has received ${dollars(used)} of the ${dollars(budgeted)} budgeted${percent} in ${item.periodName}.`
    : `${item.name} has spent ${dollars(used)} of its ${dollars(budgeted)} budget${percent} in ${item.periodName}.`;
  const standing = income
    ? null
    : remaining < 0
      ? `That's ${dollars(-remaining)} over budget.`
      : `${dollars(remaining)} is left${typeof facts.days_left === 'number' ? ` with ${plural(facts.days_left, 'day', 'days')} to go` : ''}.`;

  return {
    subject: `${ruleLabel}: ${item.name}`,
    heading: item.name,
    paragraphs: [greeting(firstName), standing ? `${figures} ${standing}` : figures],
    buttonText: 'Open the budget item',
    path: `/budget-items/${item.itemUuid}/view`,
    push: {
      title: `${ruleLabel}: ${item.name}`,
      body: standing ? `${dollars(used)} of ${dollars(budgeted)}. ${standing}` : `${dollars(used)} of ${dollars(budgeted)}.`,
    },
  };
}

export function transactionMessage(
  ruleLabel: string,
  transaction: TransactionSubject,
  firstName: string | null,
  money: MoneyFormat = DEFAULT_MONEY
): MessageContent {
  const dollars = moneyIn(money);
  const { facts } = transaction;
  const who = String(facts.merchant ?? facts.description ?? 'a transaction');
  const size = dollars(Number(facts.size));
  const outgoing = facts.direction === 'out';
  const account = facts.account ? ` in ${facts.account}` : '';
  const what = outgoing ? `${size} at ${who}` : `${size} from ${who}`;

  return {
    subject: `${ruleLabel}: ${what}`,
    heading: what,
    paragraphs: [
      greeting(firstName),
      `${outgoing ? 'A payment of' : 'A deposit of'} ${what}${account}, dated ${dayWords(transaction.transactionDate)}.`,
    ],
    buttonText: 'Open the transaction',
    path: `/transactions/${transaction.uuid}`,
    push: { title: ruleLabel, body: `${what}${account}.` },
  };
}

export function reviewReminderMessage(
  ruleLabel: string,
  facts: Facts,
  firstName: string | null,
  money: MoneyFormat = DEFAULT_MONEY
): MessageContent {
  const dollars = moneyIn(money);
  const count = Number(facts.unreviewed_count);
  const waiting = plural(count, 'transaction is', 'transactions are');
  const total = Number(facts.unreviewed_total);
  const oldest = typeof facts.oldest_unreviewed_days === 'number'
    ? ` The oldest is ${plural(facts.oldest_unreviewed_days, 'day', 'days')} old.`
    : '';

  return {
    subject: `${ruleLabel}: ${plural(count, 'transaction', 'transactions')} to review`,
    heading: `${plural(count, 'transaction', 'transactions')} to review`,
    paragraphs: [greeting(firstName), `${waiting} waiting for your review, totalling ${dollars(total)}.${oldest}`],
    buttonText: 'Review transactions',
    path: '/tasks?showMyTasks=true&includeUnassigned=false',
    push: { title: `${plural(count, 'transaction', 'transactions')} to review`, body: `Totalling ${dollars(total)}.${oldest}` },
  };
}

/** The weekly digest, reporting the seven days ending `lastDay` (the day it was due). */
export function digestMessage(
  ruleLabel: string,
  summary: WeekSummary,
  lastDay: string,
  tenantName: string,
  firstName: string | null,
  money: MoneyFormat = DEFAULT_MONEY
): MessageContent {
  const dollars = moneyIn(money);
  const flows = `In the seven days to ${dayWords(lastDay)}, ${dollars(summary.moneyIn)} came in and ${dollars(summary.moneyOut)} went out.`;
  const over = summary.overBudget.length === 0
    ? 'No budget item is over budget.'
    : `Over budget: ${summary.overBudget.slice(0, 5).join(', ')}${summary.overBudget.length > 5 ? `, and ${summary.overBudget.length - 5} more` : ''}.`;
  const review = summary.toReview === 0
    ? 'Nothing is waiting for review.'
    : `${plural(summary.toReview, 'transaction is', 'transactions are')} waiting for review.`;

  return {
    subject: `${ruleLabel}: ${tenantName}`,
    heading: `The week to ${dayWords(lastDay)}`,
    paragraphs: [greeting(firstName), flows, over, review],
    buttonText: 'Open Nuggets',
    path: '/',
    push: {
      title: `${ruleLabel}: ${tenantName}`,
      body: `${dollars(summary.moneyIn)} in, ${dollars(summary.moneyOut)} out. ${summary.overBudget.length} over budget, ${summary.toReview} to review.`,
    },
  };
}

/** "today", "tomorrow", "in 3 days", "yesterday", "5 days ago". */
function whenDue(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

export function billMessage(
  ruleLabel: string,
  occurrence: Occurrence,
  today: string,
  firstName: string | null,
  money: MoneyFormat = DEFAULT_MONEY
): MessageContent {
  const dollars = moneyIn(money);
  const name = occurrence.bill.name;
  const days = daysBetween(today, occurrence.due_date);
  const amount = dollars(occurrence.expected);
  const due = days < 0
    ? `${name} (${amount}) was due ${dayWords(occurrence.due_date)}, ${whenDue(days)}`
    : `${name} (${amount}) is due ${dayWords(occurrence.due_date)}, ${whenDue(days)}`;
  const standing = occurrence.status === 'partly_paid'
    ? `${dollars(occurrence.paid)} of it is paid so far.`
    : 'No payment has come in for it yet.';

  return {
    subject: `${ruleLabel}: ${name}`,
    heading: name,
    paragraphs: [greeting(firstName), `${due}. ${standing}`],
    buttonText: 'Open bills',
    path: `/bills?month=${occurrence.due_date.slice(0, 7)}`,
    push: {
      title: `${ruleLabel}: ${name}`,
      body: `${amount} ${days < 0 ? 'was due' : 'due'} ${whenDue(days)}. ${standing}`,
    },
  };
}

/**
 * The plain-text part of a notification email, composed from the message
 * itself rather than stripped from the HTML, so it carries both links.
 */
export function plainText(content: MessageContent, buttonUrl: string, unsubscribeUrl: string, fromName: string): string {
  return [
    ...content.paragraphs,
    `${content.buttonText}:\n${buttonUrl}`,
    `From ${fromName} in Nuggets. To stop these emails:\n${unsubscribeUrl}`,
  ].join('\n\n');
}
