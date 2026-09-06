import type { Window } from './types';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Start and end (exclusive) of the fixed window containing `now`. */
export function windowBounds(window: Window, now: number): { start: number; end: number } {
  if (window === 'month') {
    const d = new Date(now);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    return { start, end };
  }
  const length = window === 'hour' ? HOUR : window === 'day' ? DAY : window;
  if (!Number.isFinite(length) || length <= 0) {
    throw new RangeError(`invalid window: ${String(window)}`);
  }
  const start = Math.floor(now / length) * length;
  return { start, end: start + length };
}

/** A stable identifier for the window, used in store keys. */
export function windowKey(window: Window, now: number): string {
  const { start } = windowBounds(window, now);
  return window === 'month' ? new Date(start).toISOString().slice(0, 7) : String(start);
}
