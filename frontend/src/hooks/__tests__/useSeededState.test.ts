import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSeededState } from '../useSeededState';

describe('useSeededState', () => {
  it('starts from the seed', () => {
    const { result } = renderHook(() => useSeededState(() => 'seeded', []));
    expect(result.current[0]).toBe('seeded');
  });

  it('keeps a local change until a dependency changes, then seeds again', () => {
    const { result, rerender } = renderHook(({ source }) => useSeededState(() => source.toUpperCase(), [source]), {
      initialProps: { source: 'a' },
    });
    act(() => result.current[1]('edited'));
    expect(result.current[0]).toBe('edited');

    rerender({ source: 'a' });
    expect(result.current[0]).toBe('edited');

    rerender({ source: 'b' });
    expect(result.current[0]).toBe('B');
  });

  it('renders the new seed in the same update a dependency changes in', () => {
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ source }) => {
        const [value] = useSeededState(() => `from ${source}`, [source]);
        seen.push(value);
        return value;
      },
      { initialProps: { source: 'a' } },
    );
    seen.length = 0;
    rerender({ source: 'b' });
    // The render with the stale value is thrown away and re-run at once.
    expect(seen[seen.length - 1]).toBe('from b');
  });

  it('hands the seed the current state, so it can keep it', () => {
    const { result, rerender } = renderHook(
      ({ data }: { data: string[] | undefined }) => useSeededState<string[]>((current) => data ?? current ?? [], [data]),
      { initialProps: { data: ['x'] as string[] | undefined } },
    );
    expect(result.current[0]).toEqual(['x']);
    act(() => result.current[1](['x', 'local']));
    rerender({ data: undefined }); // loading again: keep what is shown
    expect(result.current[0]).toEqual(['x', 'local']);
    rerender({ data: ['y'] });
    expect(result.current[0]).toEqual(['y']);
  });
});
