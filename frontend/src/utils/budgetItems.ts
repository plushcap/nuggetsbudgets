import type { BudgetItem } from '../services/api';
import { budgetItemStatus } from '@nuggets/shared';

/**
 * The budget items a person can assign something to: everything not archived.
 * `keepId` (a transaction's current item) stays even when archived, so an
 * existing assignment still shows.
 */
export function assignableBudgetItems<T extends { id: number; status?: BudgetItem['status'] | undefined }>(items: T[], keepId?: number | null): T[] {
  return items.filter((item) => item.status !== budgetItemStatus.enum.archived || item.id === keepId);
}
