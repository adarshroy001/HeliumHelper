import { describe, expect, it } from 'vitest';
import { inFlight } from '../lifecycle/campaign-sweeper.service.js';
import { indiaMinutes, insideWindow, lastDayHours } from './feed-rules.js';

const at = (iso: string) => new Date(iso);

describe('feed rules', () => {
  it('reads the time of day in India', () => {
    expect(indiaMinutes(at('2026-10-31T04:30:00Z'))).toBe(10 * 60);
    expect(indiaMinutes(at('2026-10-31T20:00:00Z'))).toBe(90);
  });

  it.each([
    ['2026-10-31T04:30:00Z', true], // 10:00 IST, the start
    ['2026-10-31T15:29:00Z', true], // 20:59 IST
    ['2026-10-31T15:30:00Z', false], // 21:00 IST, the end
    ['2026-10-31T02:00:00Z', false], // 07:30 IST
  ])('a 10:00–21:00 window at %s: %s', (time, inside) => {
    expect(insideWindow({ start: '10:00', end: '21:00' }, at(time))).toBe(inside);
  });

  it('handles a window across midnight', () => {
    const window = { start: '20:00', end: '02:00' };
    expect(insideWindow(window, at('2026-10-31T15:00:00Z'))).toBe(true); // 20:30 IST
    expect(insideWindow(window, at('2026-10-31T19:00:00Z'))).toBe(true); // 00:30 IST
    expect(insideWindow(window, at('2026-10-31T21:00:00Z'))).toBe(false); // 02:30 IST
  });

  it('lists the last 24 hourly keys, newest first', () => {
    const hours = lastDayHours(at('2026-10-31T10:15:00Z'));
    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe('2026103110');
    expect(hours[23]).toBe('2026103011');
  });

  it('counts sends in flight as fed minus resolved deliveries', () => {
    expect(inFlight({ fed: 100, resolved: 70, accepted: 65, failed: 5 })).toBe(30);
    expect(inFlight({})).toBe(0);
  });
});
