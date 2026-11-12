import { describe, it, expect } from 'vitest';
import { useEffect, useState } from 'react';
import { render, screen, getConfig } from '@testing-library/react';

/** Shows its text after `afterMs`, as a page does once a slow first render settles. */
function Late({ afterMs }: { afterMs: number }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs]);
  return shown ? <p>arrived</p> : null;
}

describe('the test setup (src/test/setup.ts)', () => {
  it('gives findBy* and waitFor 5 s, not Testing Library’s 1 s', async () => {
    expect(getConfig().asyncUtilTimeout).toBe(5000);
    render(<Late afterMs={1500} />);
    expect(await screen.findByText('arrived')).toBeInTheDocument();
  });
});
