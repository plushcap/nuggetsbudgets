import type { Merchant, MerchantRule } from '../../services/api';
import type { MerchantWrite } from '../../services/api/merchants';
import type { MerchantFormData } from '../forms/MerchantFormFields';

/** What the add and edit pages send for a merchant. */
export type MerchantFields = MerchantWrite;

const trimmed = (value: string | undefined): string | undefined => value?.trim() || undefined;

/**
 * The merchant form's values as the create and update calls take them: the name trimmed, each
 * optional text trimmed, and the auto-tag's id (or null). The id is the form's own state, the
 * merchant's `transaction_auto_tag_id` until the picker changes it, not the tag the picker
 * finds in the tags list: with the list still loading (or failed) that was none, and saving
 * cleared the merchant's auto-tag. On create (`'omit'`) an empty text is
 * left out. On update (`'clear'`) it is sent as null, so the server clears it (a website,
 * account id or notes emptied were left out of the PUT), and the merchant's image goes back as
 * it was: the PUT writes every field, so one left out (the image, which the form doesn't edit)
 * was cleared.
 */
export function merchantFields(
  form: MerchantFormData,
  autoTagId: number | null,
  emptyText: 'omit' | 'clear',
): MerchantFields {
  const clear = emptyText === 'clear';
  const text = (value: string | undefined) => trimmed(value) ?? (clear ? null : undefined);
  const website = text(form.merchant_website);
  const accountId = text(form.merchant_accountid);
  const notes = text(form.notes);
  const instructions = text(form.instructions);
  const image = typeof form.merchant_image === 'string' && form.merchant_image ? form.merchant_image : null;
  return {
    name: form.name.trim(),
    ...(website !== undefined ? { merchant_website: website } : {}),
    ...(accountId !== undefined ? { merchant_accountid: accountId } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(clear ? { merchant_image: image } : {}),
    transaction_auto_tag_id: autoTagId,
  };
}

/** The merchant's fields as the edit form shows them. */
export const merchantFormValues = (merchant: Merchant): MerchantFormData => ({
  name: merchant.name,
  merchant_website: merchant.merchant_website || '',
  merchant_accountid: merchant.merchant_accountid || '',
  notes: merchant.notes || '',
  instructions: merchant.instructions || '',
  merchant_image: merchant.merchant_image || null,
});

export type MerchantRuleMethod = MerchantRule['method'];

/** Each matching method's name, in the order the method picker lists them. */
export const MERCHANT_RULE_METHOD_LABELS: Record<MerchantRuleMethod, string> = {
  exact: 'Exact Match',
  contains: 'Contains Text',
  starts_with: 'Starts With',
  ends_with: 'Ends With',
  regex: 'Regular Expression',
};

/** What each matching method matches, shown under the picker and on each rule. */
export const MERCHANT_RULE_METHOD_DESCRIPTIONS: Record<MerchantRuleMethod, string> = {
  exact: 'Import merchant text must match exactly, ignoring case',
  contains: 'Import merchant text must contain this text',
  starts_with: 'Import merchant text must start with this text',
  ends_with: 'Import merchant text must end with this text',
  regex: 'Import merchant text must match this regular expression',
};

/** The merchant pages' paths. */
export const merchantPaths = {
  list: '/settings/merchants',
  add: '/settings/merchants/add',
  view: (merchant: Pick<Merchant, 'uuid'>) => `/settings/merchants/${merchant.uuid}/view`,
  edit: (merchant: Pick<Merchant, 'uuid'>) => `/settings/merchants/${merchant.uuid}/edit`,
  rules: (merchant: Pick<Merchant, 'uuid'>) => `/settings/merchants/${merchant.uuid}/rules`,
};
