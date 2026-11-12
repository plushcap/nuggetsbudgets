import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { TransactionTag } from '@nuggets/shared';
import type { Transaction } from '../../services/api';
import { SHEET_CLOSE_DELAY_MS, useTransactionActionsSheet } from '../useTransactionActionsSheet';

const tag = (id: number, uuid: string) => ({ id, uuid, name: uuid }) as unknown as TransactionTag;
const groceries = tag(1, 'tag-groceries');
const vacation = tag(2, 'tag-vacation');
const first = { id: 1, uuid: 't-1', tags: [groceries] } as unknown as Transaction;
const second = { id: 2, uuid: 't-2', tags: [] } as unknown as Transaction;

function setup(ok = true) {
  const actions = { applyTag: vi.fn(async () => ok), removeTag: vi.fn(async () => true) };
  const { result } = renderHook(() => useTransactionActionsSheet(actions));
  return { actions, result };
}

describe('useTransactionActionsSheet', () => {
  afterEach(() => vi.useRealTimers());

  it('opens on the main menu with the transaction and its tags, and keeps them a moment after closing', () => {
    vi.useFakeTimers();
    const { result } = setup();
    act(() => result.current.openFor(first));
    act(() => result.current.setMenu('assignUser'));
    expect(result.current).toMatchObject({ open: true, transaction: first, menu: 'assignUser', tags: [groceries] });

    act(() => result.current.close());
    expect(result.current).toMatchObject({ open: false, menu: 'main', transaction: first });
    act(() => vi.advanceTimersByTime(SHEET_CLOSE_DELAY_MS));
    expect(result.current.transaction).toBeNull();
  });

  // The close timer used to run on regardless, so reopening the sheet on another row within
  // 200 ms emptied it under the person.
  it('reopened on another row before the close finishes, keeps that row', () => {
    vi.useFakeTimers();
    const { result } = setup();
    act(() => result.current.openFor(first));
    act(() => result.current.close());
    act(() => result.current.openFor(second));
    act(() => vi.advanceTimersByTime(SHEET_CLOSE_DELAY_MS * 2));
    expect(result.current).toMatchObject({ open: true, transaction: second });
  });

  it('runs an action, then closes', async () => {
    const { result } = setup();
    act(() => result.current.openFor(first));
    const action = vi.fn(async () => true);
    await act(() => result.current.runAndClose(action));
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.open).toBe(false);
  });

  it('applies the tags added and removes the ones taken off, showing the change at once', async () => {
    const { actions, result } = setup();
    act(() => result.current.openFor(first));
    await act(() => result.current.changeTags([vacation]));
    expect(actions.applyTag).toHaveBeenCalledWith(first, 'tag-vacation');
    expect(actions.removeTag).toHaveBeenCalledWith(first, 'tag-groceries');
    expect(result.current.tags).toStrictEqual([vacation]);
  });

  it('puts the old tags back when a change fails', async () => {
    const { result } = setup(false);
    act(() => result.current.openFor(first));
    await act(() => result.current.changeTags([groceries, vacation]));
    expect(result.current.tags).toStrictEqual([groceries]);
  });

  // The focus went to <body> when the sheet closed (it has no Dialog.Trigger).
  it('gives the focus back to what opened it, unless that has left the page', () => {
    const { result } = setup();
    const quick = document.body.appendChild(document.createElement('button'));
    quick.focus();
    act(() => result.current.openFor(first));
    document.body.focus();
    const closing = new Event('focus.autoFocusOnUnmount', { cancelable: true });
    result.current.returnFocus(closing);
    expect(quick).toHaveFocus();
    expect(closing.defaultPrevented).toBe(true);

    act(() => result.current.openFor(second, quick));
    quick.remove();
    const again = new Event('focus.autoFocusOnUnmount', { cancelable: true });
    result.current.returnFocus(again);
    expect(again.defaultPrevented).toBe(false);
  });
});
