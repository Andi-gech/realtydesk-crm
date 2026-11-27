import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface VirtualRange {
  start: number;
  end: number;
  paddingTop: number;
  paddingBottom: number;
}

/**
 * Fixed-height row virtualizer for long scroll lists (e.g. the chat sidebar).
 * Only rows inside the viewport plus `overscan` are mounted, so a 1,000-chat
 * inbox keeps a tiny DOM and stays responsive on low-end devices.
 */
export function useVirtualRows(
  containerRef: RefObject<HTMLElement | null>,
  itemCount: number,
  itemHeight: number,
  overscan = 6
): VirtualRange {
  const [range, setRange] = useState<{ start: number; end: number }>(() => ({
    start: 0,
    end: Math.min(itemCount, overscan * 2 + 1),
  }));
  const rafRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const compute = () => {
      const scrollTop = el.scrollTop;
      const viewport = el.clientHeight || itemHeight;
      const visible = Math.ceil(viewport / itemHeight);
      const rawStart = Math.floor(scrollTop / itemHeight) - overscan;
      const maxStart = Math.max(0, itemCount - visible - overscan);
      const start = Math.max(0, Math.min(maxStart, rawStart));
      const end = Math.min(itemCount, start + visible + overscan * 2);
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };

    compute();

    const onScroll = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        compute();
      });
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    let observer: ResizeObserver | null = null;
    try {
      observer = new ResizeObserver(compute);
      observer.observe(el);
    } catch {}

    return () => {
      el.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [containerRef, itemCount, itemHeight, overscan]);

  return {
    start: range.start,
    end: range.end,
    paddingTop: range.start * itemHeight,
    paddingBottom: Math.max(0, (itemCount - range.end) * itemHeight),
  };
}
