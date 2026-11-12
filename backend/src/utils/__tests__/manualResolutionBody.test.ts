import { describe, it, expect } from 'vitest';
import { manualResolutionBody } from '../annotationResolution.js';

/**
 * The wording is the feature: manually resolving an activity records an `answer`
 * reply stating what happened, which is what moves the thread to `answered`.
 */
describe('manualResolutionBody', () => {
  it('names the budget item the transaction is assigned to', () => {
    expect(manualResolutionBody('Groceries')).toBe(
      'user manually resolved the activity and assigned the transaction to Groceries',
    );
  });

  it('omits the assignment clause when the transaction has no budget item', () => {
    // Better than emitting "assigned the transaction to null".
    expect(manualResolutionBody(null)).toBe('user manually resolved the activity');
  });

  it('handles budget item names containing spaces and punctuation', () => {
    expect(manualResolutionBody('Home & Garden Supplies')).toContain('assigned the transaction to Home & Garden Supplies');
  });
});
