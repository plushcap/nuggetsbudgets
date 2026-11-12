import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyedDebounce } from '../useKeyedDebounce';

describe('useKeyedDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs only the last run scheduled for a key, after the delay', () => {
    const { result } = renderHook(() => useKeyedDebounce(500));
    const first = vi.fn();
    const second = vi.fn();
    result.current.schedule('a', first);
    vi.advanceTimersByTime(300);
    result.current.schedule('a', second);
    vi.advanceTimersByTime(499);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps keys apart', () => {
    const { result } = renderHook(() => useKeyedDebounce(500));
    const a = vi.fn();
    const b = vi.fn();
    result.current.schedule('a', a);
    result.current.schedule('b', b);
    vi.advanceTimersByTime(500);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a key can be scheduled again after its run', () => {
    const { result } = renderHook(() => useKeyedDebounce(100));
    const run = vi.fn();
    result.current.schedule('a', run);
    vi.advanceTimersByTime(100);
    result.current.schedule('a', run);
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cancel drops the waiting run of that key only', () => {
    const { result } = renderHook(() => useKeyedDebounce(100));
    const a = vi.fn();
    const b = vi.fn();
    result.current.schedule('a', a);
    result.current.schedule('b', b);
    result.current.cancel('a');
    result.current.cancel('nothing waiting');
    vi.advanceTimersByTime(100);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('runs what is still waiting at once on unmount, once (an edit made just before leaving is saved)', () => {
    const { result, unmount } = renderHook(() => useKeyedDebounce(500));
    const run = vi.fn();
    const cancelled = vi.fn();
    result.current.schedule('a', run);
    result.current.schedule('b', cancelled);
    result.current.cancel('b');
    unmount();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('cancelAll drops every waiting run, so unmounting runs none (a cancelled edit)', () => {
    const { result, unmount } = renderHook(() => useKeyedDebounce(500));
    const a = vi.fn();
    const b = vi.fn();
    result.current.schedule('a', a);
    result.current.schedule('b', b);
    result.current.cancelAll();
    unmount();
    vi.advanceTimersByTime(1000);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  // A save that covers the waiting runs holds them; if it fails, they go back.
  describe('takeAll and putBack', () => {
    it('takeAll stops the waiting runs and hands them over; dropped, they never run', () => {
      const { result, unmount } = renderHook(() => useKeyedDebounce(500));
      const a = vi.fn();
      result.current.schedule('a', a);
      const held = result.current.takeAll();
      expect([...held.keys()]).toEqual(['a']);
      vi.advanceTimersByTime(1000);
      unmount();
      expect(a).not.toHaveBeenCalled();
    });

    it('putBack puts them on their timers again', () => {
      const { result } = renderHook(() => useKeyedDebounce(500));
      const a = vi.fn();
      result.current.schedule('a', a);
      const held = result.current.takeAll();
      result.current.putBack(held);
      vi.advanceTimersByTime(499);
      expect(a).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(a).toHaveBeenCalledTimes(1);
    });

    it("putBack leaves a key scheduled again meanwhile to the newer run", () => {
      const { result } = renderHook(() => useKeyedDebounce(500));
      const older = vi.fn();
      const newer = vi.fn();
      const other = vi.fn();
      result.current.schedule('a', older);
      result.current.schedule('b', other);
      const held = result.current.takeAll();
      result.current.schedule('a', newer);
      result.current.putBack(held);
      vi.advanceTimersByTime(500);
      expect(older).not.toHaveBeenCalled();
      expect(newer).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(1);
    });

    it('putBack leaves a key to a newer run that has already run', () => {
      const { result } = renderHook(() => useKeyedDebounce(500));
      const calls: string[] = [];
      result.current.schedule('notes', () => { calls.push('a'); });
      const held = result.current.takeAll();
      result.current.schedule('notes', () => { calls.push('ab'); });
      vi.advanceTimersByTime(500);
      result.current.putBack(held);
      vi.advanceTimersByTime(1000);
      expect(calls).toEqual(['ab']);
    });

    it('putBack leaves a key cancelled meanwhile, and puts back nothing after cancelAll', () => {
      const { result } = renderHook(() => useKeyedDebounce(500));
      const a = vi.fn();
      const b = vi.fn();
      result.current.schedule('a', a);
      result.current.schedule('b', b);
      const held = result.current.takeAll();
      result.current.cancel('a');
      result.current.putBack(held);
      vi.advanceTimersByTime(500);
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledTimes(1);

      const c = vi.fn();
      result.current.schedule('c', c);
      const heldAgain = result.current.takeAll();
      result.current.cancelAll();
      result.current.putBack(heldAgain);
      vi.advanceTimersByTime(1000);
      expect(c).not.toHaveBeenCalled();
    });

    it('after unmount, putBack leaves a key to the newer run the unmount ran', () => {
      const { result, unmount } = renderHook(() => useKeyedDebounce(500));
      const calls: string[] = [];
      result.current.schedule('notes', () => { calls.push('a'); });
      const held = result.current.takeAll();
      result.current.schedule('notes', () => { calls.push('ab'); });
      unmount();
      result.current.putBack(held);
      expect(calls).toEqual(['ab']);
    });

    it('the same held runs put back twice after unmount run once', () => {
      const { result, unmount } = renderHook(() => useKeyedDebounce(500));
      const a = vi.fn();
      result.current.schedule('a', a);
      const held = result.current.takeAll();
      unmount();
      result.current.putBack(held);
      result.current.putBack(held);
      expect(a).toHaveBeenCalledTimes(1);
    });

    it('a held run put back after unmount runs at once, as a waiting run does then', () => {
      const { result, unmount } = renderHook(() => useKeyedDebounce(500));
      const a = vi.fn();
      result.current.schedule('a', a);
      const held = result.current.takeAll();
      unmount();
      expect(a).not.toHaveBeenCalled();
      result.current.putBack(held);
      expect(a).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps its functions across renders', () => {
    const { result, rerender } = renderHook(() => useKeyedDebounce(500));
    const before = result.current;
    rerender();
    expect(result.current.schedule).toBe(before.schedule);
    expect(result.current.cancel).toBe(before.cancel);
    expect(result.current.cancelAll).toBe(before.cancelAll);
    expect(result.current.takeAll).toBe(before.takeAll);
    expect(result.current.putBack).toBe(before.putBack);
  });
});
