import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { apiError, mockApi, type ApiRequest } from '../../test/apiServer';
import DeploymentTimeZoneCard from '../DeploymentTimeZoneCard';

/**
 * The deployment's time zone on the Backup page: it shows the stored zone, saves
 * the one picked with PUT /api/admin/deployment-settings, and says under the field why the
 * server refused one.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ toast, default: toast }));

// jsdom lacks the pointer-capture and scroll APIs Radix Select calls.
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

const ZONES = [
  { value: 'UTC', label: 'UTC', offset: 'UTC+0' },
  { value: 'America/New_York', label: 'Eastern Time', offset: 'UTC-5/-4' },
  { value: 'Asia/Tokyo', label: 'Tokyo', offset: 'UTC+9' },
];

const renderCard = () => renderWithProviders(<Theme><DeploymentTimeZoneCard /></Theme>);

describe('DeploymentTimeZoneCard', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('shows the stored zone, and saves the one picked', async () => {
    let stored = 'America/New_York';
    const api = mockApi({
      'GET /admin/deployment-settings': () => ({ settings: { application_timezone: stored } }),
      'GET /settings/timezones': ZONES,
      'PUT /admin/deployment-settings': (req: ApiRequest) => {
        stored = (req.body as { settings: { application_timezone: string } }).settings.application_timezone;
        return { success: true, settings: { application_timezone: stored } };
      },
    });
    renderCard();
    const field = await screen.findByRole('combobox', { name: 'Time zone' });
    await waitFor(() => expect(field).toHaveTextContent('Eastern Time (UTC-5/-4)'));

    await userEvent.click(field);
    await userEvent.click(await screen.findByRole('option', { name: 'Tokyo (UTC+9)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Time Zone' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Deployment time zone saved'));
    expect(api.calls('PUT /admin/deployment-settings').map((r) => r.body)).toEqual([{ settings: { application_timezone: 'Asia/Tokyo' } }]);
    await waitFor(() => expect(api.calls('GET /admin/deployment-settings').length).toBeGreaterThanOrEqual(2));
    expect(field).toHaveTextContent('Tokyo (UTC+9)');
    expect(api.unhandled).toEqual([]);
  });

  it("says to save again when some ledgers' goal history wasn't moved to the zone", async () => {
    mockApi({
      'GET /admin/deployment-settings': () => ({ settings: { application_timezone: 'UTC' } }),
      'GET /settings/timezones': ZONES,
      'PUT /admin/deployment-settings': () => ({
        success: true,
        settings: { application_timezone: 'Asia/Tokyo' },
        tenants_not_clamped: 2,
        notice: "2 tenants' goal history could not be moved to the new time zone; save the time zone again to retry.",
      }),
    });
    renderCard();
    const field = await screen.findByRole('combobox', { name: 'Time zone' });
    await waitFor(() => expect(field).toHaveTextContent('UTC'));

    await userEvent.click(field);
    await userEvent.click(await screen.findByRole('option', { name: 'Tokyo (UTC+9)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Time Zone' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "Time zone saved, but 2 ledgers' goal history couldn't be moved to it. Save the time zone again to retry.",
    ));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows a stored zone the list lacks', async () => {
    mockApi({
      'GET /admin/deployment-settings': { settings: { application_timezone: 'Europe/Lisbon' } },
      'GET /settings/timezones': ZONES,
    });
    renderCard();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Time zone' })).toHaveTextContent('Europe/Lisbon'));
  });

  it("says under the field why the server refused a zone, and keeps the button", async () => {
    mockApi({
      'GET /admin/deployment-settings': { settings: { application_timezone: 'UTC' } },
      'GET /settings/timezones': ZONES,
      'PUT /admin/deployment-settings': apiError(400, 'application_timezone must be an IANA time zone such as America/New_York', 'VALIDATION_ERROR'),
    });
    renderCard();
    const field = await screen.findByRole('combobox', { name: 'Time zone' });
    await waitFor(() => expect(field).toHaveTextContent('UTC (UTC+0)'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Time Zone' }));

    expect(await screen.findByText('application_timezone must be an IANA time zone such as America/New_York')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field.getAttribute('aria-describedby')).toContain('deployment-timezone-error');
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save Time Zone' })).toBeEnabled();
  });

  it("says so when the zone didn't load", async () => {
    mockApi({
      'GET /admin/deployment-settings': apiError(500, 'Internal server error', 'INTERNAL_ERROR'),
      'GET /settings/timezones': ZONES,
    });
    renderCard();
    expect(await screen.findByText(/The deployment's time zone didn't load/)).toBeInTheDocument();
  });
});
