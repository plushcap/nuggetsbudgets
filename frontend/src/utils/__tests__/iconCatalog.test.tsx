import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { getIconByName } from '../iconCatalog';

describe('getIconByName', () => {
  afterEach(() => {
    vi.doUnmock('lucide-react/dynamicIconImports');
    vi.doUnmock('../logger');
    vi.resetModules();
  });

  // A lucide-react bump renamed the module export the paths were read from, and every
  // chosen icon rendered as an empty <svg>.
  it('draws the chosen icon once its module loads', async () => {
    const Wallet = getIconByName('Wallet')!.component;
    const { container } = render(<Wallet className="w-4 h-4" />);

    await waitFor(() => expect(container.querySelector('svg path')).not.toBeNull());
    expect(container.querySelector('svg')).toHaveClass('w-4', 'h-4');
  });

  it('resolves only canonical Lucide names', () => {
    expect(getIconByName('PiggyBank')?.name).toBe('PiggyBank');
    expect(getIconByName('NotAnIcon')).toBeUndefined();
    expect(getIconByName('wallet')).toBeUndefined();
    expect(getIconByName(null)).toBeUndefined();
  });

  it('warns, and draws an empty icon, when an icon module has no component', async () => {
    vi.resetModules();
    vi.doMock('lucide-react/dynamicIconImports', () => ({
      default: { wallet: () => Promise.resolve({ __iconData: { node: [] } }) },
    }));
    const warn = vi.fn();
    vi.doMock('../logger', () => ({ logger: { warn } }));
    const catalog = await import('../iconCatalog');

    const Wallet = catalog.getIconByName('Wallet')!.component;
    const { container } = render(<Wallet />);

    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0][0]).toMatchObject({ icon: 'wallet' });
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('svg path')).toBeNull();
  });
});
