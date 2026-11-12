import { useState } from 'react';
import { Box, Button, Checkbox, Flex, Select, Text, TextField } from '@radix-ui/themes';
import FormSelectRoot from '../forms/FormSelectRoot';
import { Plus, Trash2 } from 'lucide-react';
import { notificationFacts, type Condition, type ConditionRuleKind, type NotificationFactType } from '@nuggets/shared';

/**
 * Editing a notification rule's condition as a form:
 * "all of", "any of" and "not" around comparisons of a fact with a value, each
 * fact offered with the comparisons and values that make sense for its type,
 * in words rather than keys. The server checks the result again on save.
 */

type Comparison = Extract<Condition, { fact: string }>;

interface Choice {
  key: string;
  label: string;
}

interface FactChoice {
  fact: string;
  label: string;
  type: 'boolean' | 'number' | 'choice' | 'words';
  values?: Choice[] | undefined;
}

/** What each fact is called here; facts come from @nuggets/shared, in its order. */
const factLabels: Record<ConditionRuleKind, Record<string, string>> = {
  budget_item: {
    name: 'Its name',
    category: 'Its category',
    kind: 'Expense or income',
    envelope: 'It’s an envelope (rolls over)',
    bill: 'It’s a bill',
    budgeted: 'Budgeted this period ($)',
    spent: 'Spent this period ($)',
    received: 'Received this period ($)',
    remaining: 'Left in it ($)',
    percent_used: 'Percent of its budget used',
    over_budget: 'It’s over budget',
    days_left: 'Days left in the period',
    percent_of_period: 'Percent of the period gone',
  },
  transaction: {
    amount: 'Its amount, signed (money out is negative)',
    size: 'Its size ($, in or out)',
    direction: 'Money in or out',
    type: 'Its type',
    description: 'Its description',
    merchant: 'Its merchant',
    account: 'Its account',
    budget_item: 'Its budget item',
    has_budget_item: 'It’s in a budget item',
    review_status: 'Its review status',
    from_bank_sync: 'It came from bank sync',
    pending: 'The bank still shows it pending',
    days_since_added: 'Days since it was added',
  },
  review_reminder: {
    unreviewed_count: 'Transactions waiting for review',
    unreviewed_total: 'Their total ($)',
    oldest_unreviewed_days: 'Days the oldest has waited',
  },
  bill: {
    name: 'The bill’s name',
    category: 'Its category',
    amount: 'Amount due ($)',
    paid: 'It’s paid',
    partly_paid: 'It’s partly paid',
    skipped: 'It’s skipped this time',
    days_until_due: 'Days until it’s due (negative once past)',
    varies: 'Its amount varies',
  },
};

const valueLabels: Record<string, string> = {
  expense: 'An expense',
  income: 'Income',
  in: 'Money in',
  out: 'Money out',
  payment: 'Payment',
  transfer: 'Transfer',
  'starting balance': 'Starting balance',
  'balance adjustment': 'Balance adjustment',
  'needs review': 'Needs review',
  reviewed: 'Reviewed',
  flagged: 'Flagged',
};

/** A kind's facts, the first of which a new comparison starts from. */
type FactChoices = [FactChoice, ...FactChoice[]];

/**
 * The facts a rule of `kind` can compare, labelled. Every kind has some (@nuggets/shared's
 * notificationFacts); one without would be a bug there, so it throws rather than start a
 * comparison on no fact.
 */
export function factsFor(kind: ConditionRuleKind): FactChoices {
  const facts: Record<string, NotificationFactType> = notificationFacts[kind];
  const [first, ...rest] = Object.entries(facts).map(([fact, type]): FactChoice => ({
    fact,
    label: factLabels[kind][fact] ?? fact,
    type: type.type,
    values: type.type === 'choice' ? type.values.map((key) => ({ key, label: valueLabels[key] ?? key })) : undefined,
  }));
  if (!first) throw new Error(`No notification facts for ${kind}`);
  return [first, ...rest];
}

const nodeKinds = {
  all: 'All of these',
  any: 'Any of these',
  not: 'Not this',
  compare: 'Matches',
} as const;
type NodeKind = keyof typeof nodeKinds;

function kindOf(condition: Condition): NodeKind {
  if ('all' in condition) return 'all';
  if ('any' in condition) return 'any';
  if ('not' in condition) return 'not';
  return 'compare';
}

function emptyComparison(fact: FactChoice): Comparison {
  if (fact.type === 'words') return { fact: fact.fact, hasWords: ['word'] };
  if (fact.type === 'number') return { fact: fact.fact, gte: 0 };
  if (fact.type === 'boolean') return { fact: fact.fact, is: true };
  return { fact: fact.fact, is: fact.values?.[0]?.key ?? null };
}

/** The comparison `condition` comes down to when it's one alone; undefined when it holds more. */
function soleComparison(condition: Condition): Comparison | null | undefined {
  if ('fact' in condition) return condition;
  if ('not' in condition) return undefined;
  const parts = 'all' in condition ? condition.all : condition.any;
  if (parts.length === 0) return null;
  const [only] = parts;
  return parts.length === 1 && only && 'fact' in only ? only : undefined;
}

/**
 * `condition` as the kind `to`, keeping every part: Not wraps the whole
 * condition, and a group made from a Not takes what it held.
 */
function convert(condition: Condition, to: NodeKind, facts: FactChoices): Condition {
  if (to === 'compare') return soleComparison(condition) ?? emptyComparison(facts[0]);
  if (to === 'not') return 'not' in condition ? condition : { not: condition };
  const inner = 'not' in condition ? condition.not : condition;
  const parts = 'all' in inner ? inner.all : 'any' in inner ? inner.any : [inner];
  return to === 'all' ? { all: parts } : { any: parts };
}

interface ConditionEditorProps {
  value: Condition;
  onChange: (condition: Condition) => void;
  kind: ConditionRuleKind;
  /** Names the condition for screen readers: "Large purchase, sent when". */
  label: string;
  readOnly?: boolean | undefined;
}

/** A condition, editable in place. */
export function ConditionEditor({ value, onChange, kind, label, readOnly = false }: ConditionEditorProps) {
  const facts = factsFor(kind);
  const node = kindOf(value);
  return (
    <Flex direction="column" gap="2" role="group" aria-label={label}>
      <Box>
        <FormSelectRoot value={node} disabled={readOnly} onValueChange={(next) => onChange(convert(value, next as NodeKind, facts))}>
          <Select.Trigger aria-label={`${label}: kind of condition`} />
          <Select.Content position="popper">
            {Object.entries(nodeKinds).map(([key, text]) => (
              <Select.Item
                key={key}
                value={key}
                // A group of several parts can't become one match without losing some.
                disabled={key === 'compare' && soleComparison(value) === undefined}
              >
                {text}
              </Select.Item>
            ))}
          </Select.Content>
        </FormSelectRoot>
      </Box>
      {'fact' in value ? (
        <ComparisonEditor value={value} onChange={onChange} facts={facts} label={label} readOnly={readOnly} />
      ) : 'not' in value ? (
        <Box pl="4" className="border-l-2 border-[var(--gray-6)]">
          <ConditionEditor value={value.not} onChange={(part) => onChange({ not: part })} kind={kind} label={`${label}, not`} readOnly={readOnly} />
        </Box>
      ) : (
        <GroupEditor value={value} onChange={onChange} kind={kind} label={label} readOnly={readOnly} />
      )}
    </Flex>
  );
}

/**
 * Ids for a group's parts, kept in step with adding and removing them, so a
 * part's controls stay with the part rather than its position.
 */
function usePartIds(count: number) {
  const [state, setState] = useState(() => ({ ids: Array.from({ length: count }, (_id, at) => at), next: count }));
  let { ids } = state;
  // The count changed some other way than added/removed (a reset from outside): every
  // part gets a new id. Adjusting state while rendering re-renders before committing.
  if (ids.length !== count) {
    ids = Array.from({ length: count }, (_id, at) => state.next + at);
    setState({ ids, next: state.next + count });
  }
  return {
    ids,
    added: () => setState((current) => ({ ids: [...current.ids, current.next], next: current.next + 1 })),
    removed: (index: number) =>
      setState((current) => ({ ...current, ids: current.ids.filter((_id, at) => at !== index) })),
  };
}

function GroupEditor({
  value,
  onChange,
  kind,
  label,
  readOnly,
}: ConditionEditorProps & { value: { all: Condition[] } | { any: Condition[] } }) {
  const group = 'all' in value ? 'all' : 'any';
  const parts = 'all' in value ? value.all : value.any;
  const partIds = usePartIds(parts.length);
  const set = (next: Condition[]) => onChange(group === 'all' ? { all: next } : { any: next });

  return (
    <Flex direction="column" gap="3" pl="4" className="border-l-2 border-[var(--gray-6)]">
      {parts.length === 0 && <Text size="2" color="gray">{group === 'all' ? 'Always.' : 'Never.'}</Text>}
      {parts.map((part, index) => (
        <Flex key={partIds.ids[index]} gap="2" align="start" wrap="wrap">
          <Box flexGrow="1">
            <ConditionEditor
              value={part}
              onChange={(changed) => set(parts.map((existing, at) => (at === index ? changed : existing)))}
              kind={kind}
              label={`${label}, part ${index + 1}`}
              readOnly={readOnly}
            />
          </Box>
          {!readOnly && (
            <Button
              type="button"
              variant="ghost"
              color="gray"
              aria-label={`Remove ${label}, part ${index + 1}`}
              onClick={() => {
                partIds.removed(index);
                set(parts.filter((_part, at) => at !== index));
              }}
            >
              <Trash2 size={16} />
              Remove
            </Button>
          )}
        </Flex>
      ))}
      {!readOnly && (
        <Box>
          <Button
            type="button"
            variant="soft"
            onClick={() => {
              partIds.added();
              set([...parts, emptyComparison(factsFor(kind)[0])]);
            }}
          >
            <Plus size={16} />
            Add a part
          </Button>
        </Box>
      )}
    </Flex>
  );
}

const numberOperators = {
  is: 'is',
  lt: 'is less than',
  lte: 'is at most',
  gt: 'is more than',
  gte: 'is at least',
} as const;

function operatorOf(comparison: Comparison): string {
  for (const operator of ['is', 'in', 'lt', 'lte', 'gt', 'gte', 'hasWords'] as const) {
    if (operator in comparison) return operator;
  }
  return 'is';
}

interface PartProps {
  value: Comparison;
  onChange: (condition: Condition) => void;
  label: string;
  readOnly: boolean;
}

function ComparisonEditor({ value, onChange, facts, label, readOnly }: PartProps & { facts: FactChoices }) {
  const fact = facts.find((choice) => choice.fact === value.fact);
  return (
    <Flex gap="2" align="center" wrap="wrap">
      <FormSelectRoot
        value={value.fact}
        disabled={readOnly}
        onValueChange={(next) => onChange(emptyComparison(facts.find((choice) => choice.fact === next) ?? facts[0]))}
      >
        <Select.Trigger aria-label={`${label}: fact`} />
        <Select.Content position="popper">
          {/* A fact the editor doesn't offer stays shown, so nothing changes silently. */}
          {!fact && <Select.Item value={value.fact}>{value.fact}</Select.Item>}
          {facts.map((choice) => (
            <Select.Item key={choice.fact} value={choice.fact}>{choice.label}</Select.Item>
          ))}
        </Select.Content>
      </FormSelectRoot>
      {fact?.type === 'boolean' ? (
        <FormSelectRoot
          value={'is' in value && value.is === false ? 'no' : 'yes'}
          disabled={readOnly}
          onValueChange={(next) => onChange({ fact: value.fact, is: next === 'yes' })}
        >
          <Select.Trigger aria-label={`${label}: is it`} />
          <Select.Content position="popper">
            <Select.Item value="yes">Yes</Select.Item>
            <Select.Item value="no">No</Select.Item>
          </Select.Content>
        </FormSelectRoot>
      ) : fact?.type === 'words' ? (
        <WordsInput value={value} onChange={onChange} label={label} readOnly={readOnly} />
      ) : fact?.type === 'number' ? (
        <NumberComparison value={value} onChange={onChange} label={label} readOnly={readOnly} />
      ) : (
        <ChoiceComparison value={value} onChange={onChange} values={fact?.values ?? []} label={label} readOnly={readOnly} />
      )}
    </Flex>
  );
}

const phrasesOf = (text: string) => text.split(',').map((phrase) => phrase.trim()).filter(Boolean);

/**
 * The words a comparison looks for, typed with commas between them. Each
 * keystroke is saved; the text is kept as typed (a trailing comma, say) until
 * the words change from outside, as when the fact does.
 */
function WordsInput({ value, onChange, label, readOnly }: PartProps) {
  const words = 'hasWords' in value ? value.hasWords : [];
  const saved = words.join('\n');
  const [typed, setTyped] = useState({ text: words.join(', '), saved });
  const shown = typed.saved === saved ? typed.text : words.join(', ');
  return (
    <TextField.Root
      readOnly={readOnly}
      aria-label={`${label}: has any of these words, separated by commas`}
      value={shown}
      onChange={(event) => {
        const phrases = phrasesOf(event.target.value);
        setTyped({ text: event.target.value, saved: phrases.join('\n') });
        onChange({ fact: value.fact, hasWords: phrases });
      }}
    />
  );
}

function NumberComparison({ value, onChange, label, readOnly }: PartProps) {
  const operator = operatorOf(value);
  const current = (value as Record<string, unknown>)[operator];
  const number = typeof current === 'number' ? current : typeof current === 'string' ? Number(current) : null;
  // The box keeps what is typed — nothing, while replacing a number — until the
  // number changes from outside; only a number is saved.
  const [typed, setTyped] = useState({ text: number === null ? '' : String(number), number });
  const shown = typed.number === number ? typed.text : String(number ?? '');
  const write = (nextOperator: string, operand: number | null) => {
    if (nextOperator === 'none') onChange({ fact: value.fact, is: null });
    else onChange({ fact: value.fact, [nextOperator]: operand ?? 0 } as Comparison);
  };
  const shownOperator = operator === 'is' && current === null ? 'none' : operator;

  return (
    <>
      <FormSelectRoot value={shownOperator} disabled={readOnly} onValueChange={(next) => write(next, number)}>
        <Select.Trigger aria-label={`${label}: comparison`} />
        <Select.Content position="popper">
          {Object.entries(numberOperators).map(([key, text]) => (
            <Select.Item key={key} value={key}>{text}</Select.Item>
          ))}
          <Select.Item value="none">has no value</Select.Item>
        </Select.Content>
      </FormSelectRoot>
      {shownOperator !== 'none' && (
        <TextField.Root
          inputMode="decimal"
          readOnly={readOnly}
          aria-label={`${label}: number`}
          value={shown}
          onChange={(event) => {
            const text = event.target.value.trim();
            const next = text !== '' && Number.isFinite(Number(text)) ? Number(text) : null;
            setTyped({ text: event.target.value, number: next ?? number });
            if (next !== null) write(operator, next);
          }}
        />
      )}
    </>
  );
}

function ChoiceComparison({ value, onChange, values, label, readOnly }: PartProps & { values: Choice[] }) {
  const chosen = 'in' in value ? value.in : 'is' in value ? [value.is] : [];
  // A chosen key the editor no longer offers stays shown, by its key.
  const shown = [
    ...values,
    ...chosen
      .filter((item): item is string => typeof item === 'string')
      .filter((item) => !values.some((choice) => choice.key === item))
      .map((item) => ({ key: item, label: item })),
  ];
  // Each box is named by the option it shows; the group names the condition they belong to.
  return (
    <Flex gap="3" align="center" wrap="wrap" role="group" aria-label={`${label}: is one of`}>
      <Text size="2" color="gray">is one of</Text>
      {shown.map((option) => (
        <Text as="label" size="2" key={option.key}>
          <Flex gap="1" align="center">
            <Checkbox
              disabled={readOnly}
              checked={chosen.includes(option.key)}
              onCheckedChange={(checked) => {
                const next = checked === true ? [...chosen, option.key] : chosen.filter((item) => item !== option.key);
                onChange(next.length === 1 ? { fact: value.fact, is: next[0] ?? null } : { fact: value.fact, in: next });
              }}
            />
            {option.label}
          </Flex>
        </Text>
      ))}
    </Flex>
  );
}
