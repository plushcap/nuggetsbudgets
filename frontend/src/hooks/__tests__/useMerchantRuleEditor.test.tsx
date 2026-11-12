import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import { useMerchantRuleEditor } from '../useMerchantRuleEditor';
import { createMerchantRule, deleteMerchantRule, updateMerchantRule, type Merchant, type MerchantRule } from '../../services/api';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, createMerchantRule: vi.fn(), updateMerchantRule: vi.fn(), deleteMerchantRule: vi.fn() };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const acme = { id: 1, uuid: 'm-1', name: 'Acme' } as Merchant;
const rule = { id: 5, uuid: 'r-5', method: 'starts_with', matching_text: 'ACME' } as MerchantRule;

function setup(merchant: Merchant | null = acme) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useMerchantRuleEditor(merchant), { wrapper }).result;
}

describe('useMerchantRuleEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createMerchantRule).mockResolvedValue(rule);
    vi.mocked(updateMerchantRule).mockResolvedValue(rule);
    vi.mocked(deleteMerchantRule).mockResolvedValue();
  });

  it("adds a rule for the merchant, its text trimmed, then closes and empties the form", async () => {
    const editor = setup();
    act(() => editor.current.openNew());
    act(() => editor.current.form.setValue('matching_text', '  SMPLMART  '));
    await act(() => editor.current.save());
    expect(createMerchantRule).toHaveBeenCalledWith('m-1', { method: 'contains', matching_text: 'SMPLMART' });
    expect(toast.success).toHaveBeenCalledWith('Rule created successfully');
    expect(editor.current.formOpen).toBe(false);
    expect(editor.current.form.getValues('matching_text')).toBe('');
  });

  it('edits the rule it was started on, and updates it rather than adding one', async () => {
    const editor = setup();
    act(() => editor.current.startEdit(rule));
    expect(editor.current).toMatchObject({ formOpen: true, editingRule: rule });
    expect(editor.current.form.getValues()).toStrictEqual({ method: 'starts_with', matching_text: 'ACME' });
    act(() => editor.current.form.setValue('matching_text', 'ACME CO'));
    await act(() => editor.current.save());
    expect(updateMerchantRule).toHaveBeenCalledWith('r-5', { method: 'starts_with', matching_text: 'ACME CO' });
    expect(createMerchantRule).not.toHaveBeenCalled();
    expect(editor.current.editingRule).toBeNull();
  });

  it('keeps the form open and says why a save failed', async () => {
    vi.mocked(createMerchantRule).mockRejectedValue(new Error('That pattern is too complex'));
    const editor = setup();
    act(() => editor.current.openNew());
    act(() => editor.current.form.setValue('matching_text', '(a+)+'));
    await act(() => editor.current.save());
    expect(toast.error).toHaveBeenCalledWith('That pattern is too complex');
    expect(editor.current.formOpen).toBe(true);
  });

  it('deletes a rule only once confirmed', async () => {
    const editor = setup();
    let done: Promise<void> = Promise.resolve();
    act(() => { done = editor.current.deleteRule(rule); });
    await waitFor(() => expect(editor.current.confirmationProps.isOpen).toBe(true));
    expect(deleteMerchantRule).not.toHaveBeenCalled();
    act(() => editor.current.confirmationProps.onConfirm());
    await act(() => done);
    expect(deleteMerchantRule).toHaveBeenCalledWith('r-5');
    expect(toast.success).toHaveBeenCalledWith('Rule deleted successfully');
  });
});
