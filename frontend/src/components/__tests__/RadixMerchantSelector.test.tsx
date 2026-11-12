import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import type { MerchantLite } from '../../services/api';
import RadixMerchantSelector from '../RadixMerchantSelector';

const merchant = (id: number, name: string, website?: string) =>
  ({ id, uuid: `m-${id}`, name, merchant_website: website }) as MerchantLite;

const merchants = [
  merchant(1, 'Corner Store'),
  merchant(2, 'Acme Hardware', 'acme.example'),
  merchant(3, 'Bakery'),
  ...Array.from({ length: 10 }, (_, i) => merchant(10 + i, `Zed ${String(i).padStart(2, '0')}`)),
];

function Harness({ start = '', onSelect = vi.fn(), onCreateNew }: {
  start?: string;
  onSelect?: (m: MerchantLite | null) => void;
  onCreateNew?: (name: string) => void;
}) {
  const [value, setValue] = useState(start);
  return (
    <Theme>
      <RadixMerchantSelector
        value={value}
        onChange={setValue}
        onSelectMerchant={onSelect}
        onCreateNew={onCreateNew}
        merchants={merchants}
      />
    </Theme>
  );
}

const options = () => within(screen.getByRole('listbox', { name: 'Merchants' })).getAllByRole('option');

describe('RadixMerchantSelector', () => {
  it('opens on the first ten merchants, alphabetical', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Select a merchant...' }));
    const names = options().map((o) => o.textContent);
    expect(names).toHaveLength(10);
    expect(names[0]).toContain('Acme Hardware');
    expect(names[1]).toContain('Bakery');
    expect(names[2]).toContain('Corner Store');
  });

  it('searches names and websites', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Select a merchant...' }));
    await userEvent.type(screen.getByRole('combobox', { name: 'Search merchants' }), 'acme.ex');
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining('Acme Hardware')]);
  });

  it('opens with the current value as the search', async () => {
    render(<Harness start="Corner Store" />);
    await userEvent.click(screen.getByRole('button', { name: 'Selected merchant: Corner Store' }));
    expect(screen.getByRole('combobox', { name: 'Search merchants' })).toHaveValue('Corner Store');
    expect(options()).toHaveLength(1);
  });

  it('picks with the arrow keys and Enter, starting from nothing highlighted', async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Select a merchant...' }));
    const search = screen.getByRole('combobox', { name: 'Search merchants' });
    await userEvent.type(search, 'b');
    // Only Bakery has a 'b'; the arrow highlights it.
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bakery' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('offers to add a merchant no one has', async () => {
    const onCreateNew = vi.fn();
    render(<Harness onCreateNew={onCreateNew} />);
    await userEvent.click(screen.getByRole('button', { name: 'Select a merchant...' }));
    await userEvent.type(screen.getByRole('combobox', { name: 'Search merchants' }), 'Florist');
    await userEvent.click(screen.getByRole('option', { name: /Add "Florist"/ }));
    expect(onCreateNew).toHaveBeenCalledWith('Florist');
  });
});
