import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import TagSelector, { type Tag } from '../TagSelector';

const tag = (id: number, name: string, lastUsed: string | null, extra: Partial<Tag> = {}) =>
  ({
    id,
    uuid: `t-${id}`,
    name,
    hierarchy_path: `Root/${name}`,
    level: 1,
    color: '#2563eb',
    is_active: true,
    last_used_at: lastUsed,
    ...extra,
  }) as unknown as Tag;

const tags = [
  tag(1, 'Groceries', '2026-01-01T00:00:00Z'),
  tag(2, 'Travel', '2026-03-01T00:00:00Z'),
  tag(3, 'Gifts', null),
  tag(4, 'Archived', '2026-04-01T00:00:00Z', { is_active: false }),
  tag(5, 'Auto', null),
];

const renderSelector = (onChange = vi.fn(), selectedTags: Tag[] = []) =>
  render(
    <Theme>
      <TagSelector selectedTags={selectedTags} onChange={onChange} tags={tags} />
    </Theme>,
  );

const optionNames = () =>
  within(screen.getByRole('listbox', { name: 'Tags' }))
    .getAllByRole('option')
    .map((o) => o.textContent ?? '');

describe('TagSelector', () => {
  it('lists active tags most recently used first, then never-used ones by name', async () => {
    renderSelector();
    await userEvent.click(screen.getByRole('button', { name: 'Select tags...' }));
    const names = optionNames();
    expect(names).toHaveLength(4);
    expect(names[0]).toContain('Travel');
    expect(names[1]).toContain('Groceries');
    expect(names[2]).toContain('Auto');
    expect(names[3]).toContain('Gifts');
  });

  it('searches names and hierarchy paths', async () => {
    renderSelector();
    await userEvent.click(screen.getByRole('button', { name: 'Select tags...' }));
    await userEvent.type(screen.getByRole('combobox', { name: 'Search tags' }), 'gro');
    expect(optionNames()).toEqual([expect.stringContaining('Groceries')]);
  });

  it('adds the highlighted tag with the arrow keys and Enter', async () => {
    const onChange = vi.fn();
    renderSelector(onChange, [tags[1]]);
    await userEvent.click(screen.getByRole('button', { name: '1 tag selected' }));
    await userEvent.type(screen.getByRole('combobox', { name: 'Search tags' }), 'gift');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith([tags[1], tags[2]]);
  });

  // Removing a chip took its button away and left the focus on the page.
  it('puts the focus on the field after removing a chip', async () => {
    const onChange = vi.fn();
    renderSelector(onChange, [tags[1]]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Travel' }));
    expect(onChange).toHaveBeenCalledWith([]);
    expect(screen.getByRole('button', { name: '1 tag selected' })).toHaveFocus();
  });
});
