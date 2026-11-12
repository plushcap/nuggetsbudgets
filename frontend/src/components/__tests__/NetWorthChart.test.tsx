import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import NetWorthChart from '../NetWorthChart';
import { pinTimeZone } from '../../test/timeZone';

// ResponsiveLine measures its container, which jsdom lays out at 0×0. Draw the
// real chart at a fixed size instead, and list the points it is given.
vi.mock('@nivo/line', async (importOriginal) => {
  const { Line } = await importOriginal<typeof import('@nivo/line')>();
  type LineProps = ComponentProps<typeof Line>;
  return {
    ResponsiveLine: (props: Omit<LineProps, 'width' | 'height'>) => (
      <>
        <ol>{props.data[0].data.map((p) => <li key={String(p.x)}>{String(p.x)}</li>)}</ol>
        <Line {...(props as LineProps)} width={600} height={400} animate={false} />
      </>
    ),
  };
});
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

let history: { snapshot_date: string; net_worth: string }[] = [];
vi.mock('../../hooks/queries', () => ({
  useCurrentNetWorthQuery: () => ({ data: { current_net_worth: { net_worth: '100.00' } }, isLoading: false, isError: false }),
  useNetWorthHistoryQuery: () => ({ data: { history }, isLoading: false, isError: false }),
}));

// A snapshot_date is a calendar day. The API has sent it both as
// 'YYYY-MM-DD' and as an ISO instant at UTC midnight.
describe('NetWorthChart labels in Los Angeles', () => {
  pinTimeZone('America/Los_Angeles');

  it('labels monthly snapshots with their own month', () => {
    history = [
      { snapshot_date: '2026-06-01T00:00:00.000Z', net_worth: '2.00' },
      { snapshot_date: '2026-05-01', net_worth: '1.00' },
    ];
    render(<NetWorthChart period="month" limit={12} />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['May 2026', 'Jun 2026']);
  });

  it('labels daily snapshots with their own day', () => {
    history = [
      { snapshot_date: '2026-10-02', net_worth: '2.00' },
      { snapshot_date: '2026-10-01', net_worth: '1.00' },
    ];
    render(<NetWorthChart period="day" limit={30} />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Oct 1', 'Oct 2']);
  });

  it('labels yearly snapshots with their own year', () => {
    history = [
      { snapshot_date: '2026-01-01', net_worth: '2.00' },
      { snapshot_date: '2025-01-01', net_worth: '1.00' },
    ];
    render(<NetWorthChart period="year" limit={5} />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['2025', '2026']);
  });
});

// With no points nivo draws <path d="null">, which the browser reports as a
// console error per path; with one it draws a zero-length line.
describe('NetWorthChart with too little history', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['no', []],
    ['one', [{ snapshot_date: '2026-10-26', net_worth: '100.00' }]],
  ])('shows an empty state instead of the chart for %s point(s)', (_label, points) => {
    history = points;
    const consoleError = vi.spyOn(console, 'error');
    const { container } = render(<NetWorthChart period="week" limit={13} />);

    expect(screen.getByText('Not enough history to chart yet.')).toBeInTheDocument();
    expect(screen.getByText(/at least two different weeks/)).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelectorAll('path')).toHaveLength(0);
    // The current net worth still shows above it.
    expect(screen.getByText('$100')).toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('draws the chart from two points', () => {
    history = [
      { snapshot_date: '2026-10-26', net_worth: '150.00' },
      { snapshot_date: '2026-10-19', net_worth: '100.00' },
    ];
    const { container } = render(<NetWorthChart period="week" limit={13} />);

    expect(screen.queryByText('Not enough history to chart yet.')).toBeNull();
    const paths = [...container.querySelectorAll('[role="img"] path')].map((p) => p.getAttribute('d'));
    expect(paths.length).toBeGreaterThan(0);
    for (const d of paths) expect(d).toMatch(/^M/);
  });

  // The chart is one image with a name and a summary, and its numbers open as a table.
  it('has a text alternative and a data table', async () => {
    history = [
      { snapshot_date: '2026-10-26', net_worth: '150.00' },
      { snapshot_date: '2026-10-19', net_worth: '100.00' },
    ];
    render(<NetWorthChart period="week" limit={13} />);
    const chart = screen.getByRole('img', { name: 'Net worth over time' });
    expect(chart).toHaveAccessibleDescription('$100 on Oct 19, $150 on Oct 26; 2 points.');
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    const table = screen.getByRole('table', { name: 'Net worth over time' });
    expect(within(table).getAllByRole('row').map((r) => r.textContent)).toEqual(['DateNet worth', 'Oct 19$100', 'Oct 26$150']);
  });
});
