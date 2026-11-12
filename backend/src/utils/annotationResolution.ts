/**
 * Wording used when an activity thread is manually resolved from the Activity
 * page. Kept as a pure helper (no DB imports) so it is unit-testable without a
 * database, and so the phrasing lives in one place.
 */
export function manualResolutionBody(budgetItemName: string | null): string {
  return budgetItemName
    ? `user manually resolved the activity and assigned the transaction to ${budgetItemName}`
    : 'user manually resolved the activity';
}
