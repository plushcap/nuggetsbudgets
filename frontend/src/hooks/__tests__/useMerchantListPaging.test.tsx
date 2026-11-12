import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { MERCHANT_SEARCH_DEBOUNCE_MS, useMerchantListPaging } from '../useMerchantListPaging';

function setup(route: string) {
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
  return renderHook(() => ({ paging: useMerchantListPaging(), location: useLocation(), navigate: useNavigate() }), { wrapper }).result;
}

describe('useMerchantListPaging', () => {
  afterEach(() => vi.useRealTimers());

  it("starts on the URL's page, and keeps the page in the URL", () => {
    const result = setup('/settings/merchants?page=3');
    expect(result.current.paging.currentPage).toBe(3);
    act(() => result.current.paging.setCurrentPage(4));
    expect(result.current.location.search).toBe('?page=4');
    act(() => result.current.paging.setCurrentPage(2));
    expect(result.current.location.search).toBe('?page=2');
  });

  // It compared window.location.search, which isn't the router's location (in a memory
  // router it is always empty), so going back to page 1 left ?page=3 in the URL.
  it("takes the page out of the router's URL on page 1", () => {
    const result = setup('/settings/merchants?page=3');
    act(() => result.current.paging.setCurrentPage(1));
    expect(result.current.location.search).toBe('');
  });

  it('asks for a search once the typing settles, and goes back to page 1 then', () => {
    vi.useFakeTimers();
    const result = setup('/settings/merchants?page=3');
    act(() => result.current.paging.setSearchTerm('ac'));
    act(() => vi.advanceTimersByTime(MERCHANT_SEARCH_DEBOUNCE_MS - 1));
    expect(result.current.paging).toMatchObject({ searchTerm: 'ac', debouncedSearchTerm: '', currentPage: 3 });

    act(() => result.current.paging.setSearchTerm('acm'));
    act(() => vi.advanceTimersByTime(MERCHANT_SEARCH_DEBOUNCE_MS));
    expect(result.current.paging).toMatchObject({ debouncedSearchTerm: 'acm', currentPage: 1 });
  });

  // The page was kept in state, seeded from the URL once, so a link to the list (or to
  // another page of it) while it was open was put back to the page in state.
  it.each([
    ['/settings/merchants', 1, ''],
    ['/settings/merchants?page=2', 2, '?page=2'],
  ])('follows a link to %j while on page 3', (to, page, search) => {
    const result = setup('/settings/merchants?page=3');
    act(() => { void result.current.navigate(to); });
    expect(result.current.paging.currentPage).toBe(page);
    expect(result.current.location.search).toBe(search);
  });

  it.each(['?page=abc', '?page=0', '?page=-2', '?page=1.5'])('reads %j as page 1', (search) => {
    const result = setup(`/settings/merchants${search}`);
    expect(result.current.paging.currentPage).toBe(1);
  });
});
