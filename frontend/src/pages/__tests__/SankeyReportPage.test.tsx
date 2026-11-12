import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import SankeyReportPage from '../SankeyReportPage';

const sankeyParams = vi.hoisted(() => ({ calls: [] as Array<{ start_date: string; end_date: string }> }));
vi.mock('../../hooks/queries', () => ({
  useReportRootsQuery: () => ({ data: [], isLoading: false }),
  useSankeyReportQuery: (_root: string | undefined, params: { start_date: string; end_date: string }) => {
    sankeyParams.calls.push(params);
    return { data: null, isLoading: false, isError: false };
  },
}));
vi.mock('@nivo/sankey', () => ({ ResponsiveSankey: () => null }));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useParams: () => ({ rootTagUuid: 'root-1' }) };
});

const renderedRange = () => {
  renderWithProviders(<Theme><SankeyReportPage /></Theme>);
  const { start_date, end_date } = sankeyParams.calls[sankeyParams.calls.length - 1];
  return [start_date, end_date];
};

// The default range is the first of this month through today, in the
// user's own days.
describe('SankeyReportPage default range', () => {
  beforeEach(() => { sankeyParams.calls = []; });

  describe('9:30 pm on Oct 31 in Los Angeles (Nov 1 in UTC)', () => {
    pinTimeZone('America/Los_Angeles', '2026-10-31T21:30:00-07:00');
    it('is Oct 1 to Oct 31', () => {
      expect(renderedRange()).toEqual(['2026-10-01', '2026-10-31']);
    });
  });

  describe('8:00 am on Nov 1 in Kiritimati (Oct 31 in UTC)', () => {
    pinTimeZone('Pacific/Kiritimati', '2026-11-01T08:00:00+14:00');
    it('is Nov 1 to Nov 1', () => {
      expect(renderedRange()).toEqual(['2026-11-01', '2026-11-01']);
    });
  });

  describe('noon on Oct 15 in Berlin (UTC+2)', () => {
    pinTimeZone('Europe/Berlin', '2026-10-15T12:00:00+02:00');
    it('starts on Oct 1, not Sep 30', () => {
      expect(renderedRange()).toEqual(['2026-10-01', '2026-10-15']);
    });
  });
});
