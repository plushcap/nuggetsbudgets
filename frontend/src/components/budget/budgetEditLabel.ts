/**
 * The name of the button that opens an item's inline budget edit: the item and the amount
 * it shows. A screen reader heard only the amount ("$600.25, button"); the amount
 * stays at the end, so the name still holds the text people see on it.
 */
export const budgetEditLabel = (itemName: string, amountText: string): string =>
  `Edit budget for ${itemName}, ${amountText}`;
