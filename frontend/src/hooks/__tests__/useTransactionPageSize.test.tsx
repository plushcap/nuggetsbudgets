import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { DEFAULT_TRANSACTION_PAGE_SIZE, useTransactionPageSize } from '../useTransactionPageSize';

/**
 * The transaction tables' rows per page: this browser's choice, in local storage, the same
 * in every table that shows it, and the default where none (or none it offers) is stored.
 */

const KEY = 'transaction-page-size';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(KEY);
});

describe('useTransactionPageSize', () => {
  it('is the default until a size is chosen, and a size it offers once one is', () => {
    const { result } = renderHook(() => useTransactionPageSize());
    expect(result.current[0]).toBe(DEFAULT_TRANSACTION_PAGE_SIZE);

    act(() => result.current[1](200));
    expect(result.current[0]).toBe(200);
    expect(localStorage.getItem(KEY)).toBe('200');
  });

  it('ignores a size it does not offer, chosen or stored', () => {
    for (const stored of ['0', '-25', '37', '1000', '25.5', 'fifty', '']) {
      localStorage.setItem(KEY, stored);
      expect(renderHook(() => useTransactionPageSize()).result.current[0]).toBe(DEFAULT_TRANSACTION_PAGE_SIZE);
    }
    localStorage.setItem(KEY, '100');
    const { result } = renderHook(() => useTransactionPageSize());
    act(() => result.current[1](37));
    expect(result.current[0]).toBe(100);
    expect(localStorage.getItem(KEY)).toBe('100');
  });

  // A table's footer moves it to the page that keeps its rows in view before its size changes;
  // a size changed under a table on screen, by another table or another tab, would leave it on
  // a page of other rows.
  it("changes a table's size only through its own setter; the next table opened reads the choice", () => {
    const one = renderHook(() => useTransactionPageSize());
    const two = renderHook(() => useTransactionPageSize());
    act(() => one.result.current[1](25));
    expect(one.result.current[0]).toBe(25);
    expect(two.result.current[0]).toBe(DEFAULT_TRANSACTION_PAGE_SIZE);
    expect(renderHook(() => useTransactionPageSize()).result.current[0]).toBe(25);
  });

  it('takes a choice made in another tab from the next table opened, not under one on screen', () => {
    const open = renderHook(() => useTransactionPageSize());
    act(() => open.result.current[1](25));

    act(() => {
      localStorage.setItem(KEY, '100');
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: '100' }));
    });
    open.rerender();
    expect(open.result.current[0]).toBe(25);
    expect(renderHook(() => useTransactionPageSize()).result.current[0]).toBe(100);
  });

  it('keeps a choice for this page while storage refuses it', () => {
    localStorage.setItem(KEY, '25');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const { result } = renderHook(() => useTransactionPageSize());
    act(() => result.current[1](200));
    expect(result.current[0]).toBe(200);
    expect(localStorage.getItem(KEY)).toBe('25');

    // Once storage takes a choice again, that is the size.
    vi.restoreAllMocks();
    act(() => result.current[1](100));
    expect(result.current[0]).toBe(100);
    expect(localStorage.getItem(KEY)).toBe('100');
  });
});
