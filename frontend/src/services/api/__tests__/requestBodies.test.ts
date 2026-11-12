import { describe, it, expectTypeOf } from 'vitest';
import type { categoryWriteSchema, merchantCreateSchema } from '@nuggets/shared';
import type { Category, Patch, RequestBody } from '../types';
import type { CategoryWriteBody } from '../categories';
import type { InstitutionWriteBody } from '../institutions';
import type { MerchantWrite } from '../merchants';
import type { TransactionBulkEdit, TransactionEdit } from '../transactions';
import type { BudgetItemFormData } from '../../../types/forms';

/**
 * A request body takes `null` and `undefined` where the API does, under
 * `exactOptionalPropertyTypes`. A body is its route's own shared schema's input
 * (`RequestBody`) or, for a route without one, a `Patch` of the entity's fields. These are
 * type checks: `npm run type-check` (tsconfig.test.json) fails on a body type that can't
 * carry null, as `Partial<Category>` couldn't (Category's `notes` was `notes?: string`). The
 * tests' config has no `exactOptionalPropertyTypes`, so `undefined` is the app build's check.
 */
describe('request body types', () => {
  it('carry null for a cleared field and undefined for one left out', () => {
    expectTypeOf<{ name: string; icon: string; notes: null; description: undefined }>().toExtend<CategoryWriteBody>();
    expectTypeOf<{ name: string; notes: null }>().toExtend<InstitutionWriteBody>();
    expectTypeOf<{ name: string; merchant_website: null; notes: null; transaction_auto_tag_id: null }>().toExtend<MerchantWrite>();
    expectTypeOf<{ notes: null; budget_item_id: null; description: undefined }>().toExtend<TransactionEdit>();
    expectTypeOf<{ description: null; notes: undefined }>().toExtend<BudgetItemFormData>();
    expectTypeOf<{ notes: null }>().toExtend<Patch<Category>>();
  });

  it("leave out a loose schema's other keys, so a misspelt field is a type error", () => {
    expectTypeOf<RequestBody<typeof categoryWriteSchema>>().not.toHaveProperty('nmae');
    expectTypeOf<keyof RequestBody<typeof merchantCreateSchema>>().toEqualTypeOf<'name' | 'merchant_website'>();
  });

  it("still need a route's required fields", () => {
    expectTypeOf<{ icon: string }>().not.toExtend<CategoryWriteBody>();
    expectTypeOf<{ notes: null }>().not.toExtend<InstitutionWriteBody>();
  });

  // Patch<…> said null was none for every field, which the route refuses for these.
  it('take null only where the API does', () => {
    expectTypeOf<{ amount: null }>().not.toExtend<TransactionEdit>();
    expectTypeOf<{ type: null }>().not.toExtend<TransactionEdit>();
    expectTypeOf<{ status: null }>().not.toExtend<TransactionEdit>();
    expectTypeOf<{ review_status: null }>().not.toExtend<TransactionEdit>();
    expectTypeOf<{ transaction_date: null }>().not.toExtend<TransactionEdit>();
    expectTypeOf<{ status: null }>().not.toExtend<TransactionBulkEdit>();
    expectTypeOf<{ review_status: null }>().not.toExtend<TransactionBulkEdit>();
    expectTypeOf<{ assigned_to: null; budget_item_id: null }>().toExtend<TransactionBulkEdit>();
  });
});
