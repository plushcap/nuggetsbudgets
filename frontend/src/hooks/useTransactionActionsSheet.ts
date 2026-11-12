import { useEffect, useRef, useState } from 'react';
import type { TransactionTag } from '@nuggets/shared';
import type { Transaction } from '../services/api';
import type { TransactionQuickActions } from './useTransactionQuickActions';

/** The sheet's menus: its main list, and the pickers it opens. */
export type TransactionActionsMenu = 'main' | 'budgetPeriod' | 'budgetItem' | 'assignUser' | 'applyTag';

/** How long the sheet keeps its transaction after it closes, so it doesn't empty mid-animation. */
export const SHEET_CLOSE_DELAY_MS = 200;

export interface TransactionActionsSheet {
  open: boolean;
  /** The transaction the sheet acts on (kept briefly after it closes). */
  transaction: Transaction | null;
  menu: TransactionActionsMenu;
  setMenu: (menu: TransactionActionsMenu) => void;
  /** The transaction's tags as the tag picker shows them, changed at once (before they save). */
  tags: TransactionTag[];
  /** Open the sheet for `transaction`; `opener` (else the focused element) takes the focus back when it closes. */
  openFor: (transaction: Transaction, opener?: HTMLElement | null) => void;
  close: () => void;
  /**
   * The dialog's onCloseAutoFocus: the focus goes back to the button that opened the
   * sheet. Radix would give it to the dialog's Trigger, and the table opens the sheet without
   * one, so it went to <body>, and a keyboard user started over from the page's top.
   */
  returnFocus: (event: Event) => void;
  /** Runs an action, then closes the sheet. */
  runAndClose: (action: () => unknown) => Promise<void>;
  /**
   * The tag picker's change: applies the tags added and removes the ones taken off, one by one.
   * It shows the new tags at once, and puts the old ones back if any change fails (the action
   * has already said why).
   */
  changeTags: (next: TransactionTag[]) => Promise<void>;
}

/**
 * The transaction table's quick-actions sheet (a phone's "Quick" button, a desktop row's
 * "Quick actions" button): which transaction it's open for, which menu it shows, and the tag
 * picker's tags. The actions themselves are useTransactionQuickActions'.
 */
export function useTransactionActionsSheet(
  actions: Pick<TransactionQuickActions, 'applyTag' | 'removeTag'>,
): TransactionActionsSheet {
  const [open, setOpen] = useState(false);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [menu, setMenu] = useState<TransactionActionsMenu>('main');
  // A copy of the transaction's tags, so the multi-select picker shows a change at once,
  // without reloading the whole list.
  const [tags, setTags] = useState<TransactionTag[]>([]);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(clearTimer.current), []);
  const opener = useRef<HTMLElement | null>(null);

  const openFor = (next: Transaction, from?: HTMLElement | null) => {
    const focused = document.activeElement;
    opener.current = from ?? (focused instanceof HTMLElement && focused !== document.body ? focused : null);
    clearTimeout(clearTimer.current);
    setTransaction(next);
    setTags(next.tags ?? []);
    setMenu('main');
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setMenu('main');
    clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setTransaction(null), SHEET_CLOSE_DELAY_MS);
  };

  const returnFocus = (event: Event) => {
    const element = opener.current;
    opener.current = null;
    // A row the list re-rendered away has no button to go back to: the dialog's own way, then.
    if (!element?.isConnected) return;
    event.preventDefault();
    element.focus();
  };

  const runAndClose = async (action: () => unknown) => {
    await action();
    close();
  };

  const changeTags = async (next: TransactionTag[]) => {
    if (!transaction) return;
    const previous = tags;
    const before = new Set(previous.map((t) => t.id));
    const after = new Set(next.map((t) => t.id));
    const added = next.filter((t) => !before.has(t.id));
    const removed = previous.filter((t) => !after.has(t.id));

    setTags(next);
    // The mutations refresh the lists behind the sheet; a failure is shown and undone here.
    const results: boolean[] = [];
    for (const tag of added) results.push(await actions.applyTag(transaction, tag.uuid));
    for (const tag of removed) results.push(await actions.removeTag(transaction, tag.uuid));
    if (results.includes(false)) setTags(previous);
  };

  return { open, transaction, menu, setMenu, tags, openFor, close, returnFocus, runAndClose, changeTags };
}
