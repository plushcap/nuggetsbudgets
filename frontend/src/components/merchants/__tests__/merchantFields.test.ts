import { describe, it, expect } from 'vitest';
import type { Merchant } from '../../../services/api';
import { merchantFields, merchantFormValues, merchantPaths } from '../merchantFields';

const form = {
  name: '  Acme  ',
  merchant_website: ' https://acme.test ',
  merchant_accountid: '',
  notes: '   ',
  instructions: '',
  merchant_image: null,
};

describe('merchantFields', () => {
  it('trims the texts, leaves out the empty ones, and sends the auto-tag id', () => {
    expect(merchantFields(form, 4, 'omit')).toStrictEqual({
      name: 'Acme',
      merchant_website: 'https://acme.test',
      transaction_auto_tag_id: 4,
    });
  });

  it('clears empty instructions on an update, and sends null without an auto-tag', () => {
    expect(merchantFields(form, null, 'clear')).toStrictEqual({
      name: 'Acme',
      merchant_website: 'https://acme.test',
      merchant_accountid: null,
      notes: null,
      instructions: null,
      merchant_image: null,
      transaction_auto_tag_id: null,
    });
  });

  // An emptied website, account id or notes was left out of the PUT rather than sent as
  // null; and the image, which the form doesn't edit, was left out too, and the PUT writes every
  // field, so saving a merchant cleared its image.
  it('sends each emptied text as null on an update, and the merchant’s image as it was', () => {
    const emptied = { ...form, merchant_website: '  ', merchant_image: '/api/images/0190a000-0000-7000-8000-0000000000c1' };
    expect(merchantFields(emptied, null, 'clear')).toStrictEqual({
      name: 'Acme',
      merchant_website: null,
      merchant_accountid: null,
      notes: null,
      instructions: null,
      merchant_image: '/api/images/0190a000-0000-7000-8000-0000000000c1',
      transaction_auto_tag_id: null,
    });
    // A create leaves them out (the image is uploaded after it).
    expect(merchantFields(emptied, null, 'omit')).toStrictEqual({ name: 'Acme', transaction_auto_tag_id: null });
  });

  it('keeps instructions that have text either way', () => {
    const withInstructions = { ...form, instructions: ' call first ', notes: 'n' };
    for (const mode of ['omit', 'clear'] as const) {
      expect(merchantFields(withInstructions, null, mode)).toMatchObject({ instructions: 'call first', notes: 'n' });
    }
  });
});

describe('merchantFormValues', () => {
  it("shows a merchant's missing texts as empty fields", () => {
    const merchant = { id: 1, uuid: 'm-1', name: 'Acme', created_at: '2026-01-01T00:00:00Z', instructions: null } as Merchant;
    expect(merchantFormValues(merchant)).toStrictEqual({
      name: 'Acme',
      merchant_website: '',
      merchant_accountid: '',
      notes: '',
      instructions: '',
      merchant_image: null,
    });
  });
});

describe('merchantPaths', () => {
  it("builds each merchant page's path from its uuid", () => {
    const m = { uuid: 'm-1' };
    expect([merchantPaths.view(m), merchantPaths.edit(m), merchantPaths.rules(m)]).toStrictEqual([
      '/settings/merchants/m-1/view',
      '/settings/merchants/m-1/edit',
      '/settings/merchants/m-1/rules',
    ]);
  });
});
