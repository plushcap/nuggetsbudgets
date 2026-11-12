import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Coloured step-11 text on a table row's gray-3 hover was under AA's 4.5:1
 * (3.96-4.44:1 for green, amber, orange, yellow, teal, jade, blue, cyan, tomato and lime as text,
 * 3.56-4.47:1 for most colours' soft badges, measured in the built app). On a `row-hover` row it
 * takes step 12. jsdom doesn't cascade Radix's colour variables, so this checks the rule and its users;
 * the contrast itself was measured in Chromium.
 */
const src = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(src, 'index.css'), 'utf8');

describe('coloured text on a gray-3 hover row', () => {
  const block = /@media \(hover: hover\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  /** The selectors of the rule that sets step 12, and its declarations. */
  const rule = /\}\s*([^{}]*\.row-hover:hover[^{}]*)\{([^}]*)\}/.exec(block);

  it('the row turns gray-3 on hover', () => {
    expect(block).toMatch(/\.row-hover:hover \{\s*background-color: var\(--gray-3\);/);
  });

  it('text that is under AA there at step 11 takes step 12', () => {
    expect(rule).not.toBeNull();
    const [, selectors, declarations] = rule!;
    expect(declarations).toMatch(/--accent-11: var\(--accent-12\);/);
    expect(declarations).toMatch(/--accent-a11: var\(--accent-12\);/);
    for (const colour of ['green', 'amber', 'orange', 'yellow', 'teal', 'jade', 'blue', 'cyan', 'tomato', 'lime']) {
      expect(selectors).toContain(`[data-accent-color='${colour}']`);
    }
    // Soft badges in any colour but gray, and the theme accent when it is one of those.
    expect(selectors).toContain(".row-hover:hover .rt-Badge.rt-variant-soft:not([data-accent-color='gray'])");
    expect(selectors).toMatch(/\)\.radix-themes\s*\.row-hover:hover/);
    // Red text passes at step 11 (4.71:1) and keeps it.
    expect(selectors).not.toContain("[data-accent-color='red']");
  });

  it.each(['components/transactions/TransactionTableRow.tsx', 'components/merchants/MerchantTable.tsx'])(
    '%s marks its gray-3 hover rows',
    (file) => {
      const source = fs.readFileSync(path.join(src, file), 'utf8');
      expect(source).toMatch(/className="[^"]*\brow-hover\b/);
      expect(source).not.toMatch(/<Table\.Row[^>]*hover:bg-\[var\(--gray-3\)\]/);
    },
  );
});
