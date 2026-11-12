import { describe, it, expect, afterEach, vi } from 'vitest';
import { mockApi } from '../../../test/apiServer';
import { transaction } from '../../../test/fixtures';
import { getTransaction } from '../transactions';

const PARENT_UUID = '0190a000-0000-7000-8000-0000000000a1';
const TAG = { id: 1, uuid: '0190a000-0000-7000-8000-0000000000f1', name: 'Trip', color: '#2563eb', icon: null };

/** GET /transactions/:uuid for a split parent: the whole row, and `split` as its one split. */
const splitParent = (split: Record<string, unknown>) => ({
  ...transaction({ id: 7, uuid: PARENT_UUID, amount: '-40.00', is_split_parent: true }),
  tenant_id: 1, account_id: 3, assigned_to: null, notes: null, external_transaction_id: null, external_link: null,
  institution_transaction_status: null, transfer_transaction_id: null, transfer_source_account_id: null,
  budget_matching_confidence: null, budget_matching_method: null, budget_matching_rule_id: null, budget_period_cleared_from: null,
  budget_period_cleared_start: null,
  synced_amount: null, synced_transactiondate: null, synced_category: null, synced_name: null, synced_location: null,
  synced_description: null, is_import: false, import_provider: null, import_transaction_id: null, import_payee: null,
  import_posted_date: null, import_transacted_at: null, import_amount: null, import_description: null,
  import_pending: false, import_imported_at: null, tags: [],
  split_children: [{
    id: 11, uuid: '0190a000-0000-7000-8000-0000000000b1', amount: '-40.00', description: null,
    budget_item_id: null, budget_period_id: null, budget_period_item_id: null, budget_item_name: null,
    budget_item_uuid: null, status: 'cleared', transaction_date: '2026-10-15', type: 'expense', ...split,
  }],
});

// The splits' tags are what re-editing them sends back, so the answer must have them.
describe('getTransaction', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads each split's tags", async () => {
    mockApi({ [`GET /transactions/${PARENT_UUID}`]: splitParent({ tags: [TAG] }) });
    const read = await getTransaction(PARENT_UUID);
    expect(read.split_children[0]?.tags).toEqual([TAG]);
    expect(read.split_children[0]?.amount).toBe(-40);
  });

  it('refuses an answer whose split comes without its tags', async () => {
    mockApi({ [`GET /transactions/${PARENT_UUID}`]: splitParent({}) });
    await expect(getTransaction(PARENT_UUID)).rejects.toThrow(/split_children\.0\.tags/);
  });
});
