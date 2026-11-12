import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import type { Condition, ConditionRuleKind } from '@nuggets/shared';
import { ConditionEditor } from '../ConditionEditor';

// jsdom lacks the pointer-capture and scroll APIs Radix Select calls.
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

function Harness({ start, kind, onChange }: { start: Condition; kind: ConditionRuleKind; onChange: (c: Condition) => void }) {
  const [value, setValue] = useState(start);
  return (
    <Theme>
      <ConditionEditor
        value={value}
        kind={kind}
        label="Rule"
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </Theme>
  );
}

async function choose(trigger: string, option: string) {
  await userEvent.click(screen.getByRole('combobox', { name: trigger }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('ConditionEditor', () => {
  it('offers only the facts of the rule kind, and resets the comparison to fit a new fact', async () => {
    const onChange = vi.fn();
    render(<Harness start={{ fact: 'size', gte: 500 }} kind="transaction" onChange={onChange} />);

    await userEvent.click(screen.getByRole('combobox', { name: 'Rule: fact' }));
    expect(screen.queryByRole('option', { name: 'Spent this period ($)' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'Its merchant' }));

    expect(onChange).toHaveBeenLastCalledWith({ fact: 'merchant', hasWords: ['word'] });
    expect(screen.getByRole('textbox', { name: 'Rule: has any of these words, separated by commas' })).toHaveValue('word');
  });

  it('turns a group into Not and back without losing a part', async () => {
    const start: Condition = { any: [{ fact: 'direction', is: 'out' }, { fact: 'size', gte: 500 }] };
    const onChange = vi.fn();
    render(<Harness start={start} kind="transaction" onChange={onChange} />);

    await choose('Rule: kind of condition', 'Not this');
    expect(onChange).toHaveBeenLastCalledWith({ not: start });
    await choose('Rule: kind of condition', 'Any of these');
    expect(onChange).toHaveBeenLastCalledWith(start);
  });

  it("won't squash a two-part group into one match", async () => {
    render(<Harness start={{ all: [{ fact: 'pending', is: true }, { fact: 'size', gte: 1 }] }} kind="transaction" onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Rule: kind of condition' }));
    expect(screen.getByRole('option', { name: 'Matches' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps a half-typed number in the box and saves only numbers', async () => {
    const onChange = vi.fn();
    render(<Harness start={{ fact: 'percent_used', gte: 90 }} kind="budget_item" onChange={onChange} />);
    const box = screen.getByRole('textbox', { name: 'Rule: number' });

    await userEvent.clear(box);
    expect(box).toHaveValue('');
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.type(box, '79.5');
    expect(onChange).toHaveBeenLastCalledWith({ fact: 'percent_used', gte: 79.5 });

    await choose('Rule: comparison', 'has no value');
    expect(onChange).toHaveBeenLastCalledWith({ fact: 'percent_used', is: null });
  });

  it('writes one ticked value as is and several as in', async () => {
    const onChange = vi.fn();
    render(<Harness start={{ fact: 'review_status', is: 'needs review' }} kind="transaction" onChange={onChange} />);
    const choices = screen.getByRole('group', { name: 'Rule: is one of' });
    await userEvent.click(within(choices).getByRole('checkbox', { name: 'Flagged' }));
    expect(onChange).toHaveBeenLastCalledWith({ fact: 'review_status', in: ['needs review', 'flagged'] });
    await userEvent.click(within(choices).getByRole('checkbox', { name: 'Needs review' }));
    expect(onChange).toHaveBeenLastCalledWith({ fact: 'review_status', is: 'flagged' });
  });

  it("keeps a part's half-typed number with that part when an earlier part is removed", async () => {
    const onChange = vi.fn();
    render(
      <Harness
        start={{ all: [{ fact: 'size', gte: 500 }, { fact: 'size', gte: 90 }] }}
        kind="transaction"
        onChange={onChange}
      />,
    );
    // Part 2's box is emptied: the box keeps '' while the saved number stays 90.
    await userEvent.clear(screen.getByRole('textbox', { name: 'Rule, part 2: number' }));
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Remove Rule, part 1' }));
    expect(onChange).toHaveBeenLastCalledWith({ all: [{ fact: 'size', gte: 90 }] });
    // The surviving part is now part 1 and still shows what was typed into it.
    expect(screen.getByRole('textbox', { name: 'Rule, part 1: number' })).toHaveValue('');

    // A part added afterwards starts fresh.
    await userEvent.click(screen.getByRole('button', { name: 'Add a part' }));
    expect(screen.getByRole('textbox', { name: 'Rule, part 1: number' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Rule, part 2: number' })).toHaveValue('0');
  });

  it('adds and removes parts of a group', async () => {
    const onChange = vi.fn();
    render(<Harness start={{ all: [] }} kind="review_reminder" onChange={onChange} />);
    expect(screen.getByText('Always.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add a part' }));
    expect(onChange).toHaveBeenLastCalledWith({ all: [{ fact: 'unreviewed_count', gte: 0 }] });
    await userEvent.click(screen.getByRole('button', { name: 'Remove Rule, part 1' }));
    expect(onChange).toHaveBeenLastCalledWith({ all: [] });
  });
});
