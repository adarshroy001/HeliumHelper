import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineMessage } from '../envelope.js';
import { defineSchedule, exportSchedules, type Schedule, toEventBridgeCron } from './schedule.js';

const tick = defineMessage('test.clock.tick', z.strictObject({ scope: z.string() }));
const base = {
  name: 'nightly-report',
  description: 'test',
  cron: '0 2 * * *',
  timezone: 'Asia/Kolkata',
  queue: 'jobs',
  message: tick,
  data: { scope: 'all' },
};

describe('defineSchedule', () => {
  it('accepts a valid schedule', () => {
    expect(defineSchedule(base).name).toBe('nightly-report');
    expect(defineSchedule({ ...base, cron: '30 9 * * MON-FRI' }).cron).toBe('30 9 * * MON-FRI');
  });

  it.each([
    ['a bad name', { name: 'Nightly_Report' }, /kebab-case/],
    ['six fields', { cron: '0 0 2 * * *' }, /5 fields/],
    ['numeric days of week', { cron: '0 2 * * 1-5' }, /names/],
    ['both day fields', { cron: '0 2 1 * MON' }, /not both/],
    ['an invalid field', { cron: '99 2 * * *' }, /./],
    ['an unknown time zone', { timezone: 'Mars/Olympus' }, /./],
    ['data that does not match the message', { data: { scope: 1 } }, /doesn't match/],
  ])('rejects %s', (_case, change, problem) => {
    expect(() => defineSchedule<unknown>({ ...base, ...change })).toThrow(problem);
  });
});

describe('toEventBridgeCron', () => {
  it.each([
    ['0 2 * * *', 'cron(0 2 * * ? *)'],
    ['*/5 * * * *', 'cron(0/5 * * * ? *)'],
    ['30 9 * * MON-FRI', 'cron(30 9 ? * MON-FRI *)'],
    ['0 0 */2 * *', 'cron(0 0 1/2 * ? *)'],
  ])('converts %s to %s', (cron, expected) => {
    expect(toEventBridgeCron(cron)).toBe(expected);
  });
});

describe('exportSchedules', () => {
  it('builds the EventBridge input with a fresh id and time per run', () => {
    const [exported] = exportSchedules([defineSchedule(base)]);

    expect(exported).toMatchObject({
      name: 'nightly-report',
      scheduleExpression: 'cron(0 2 * * ? *)',
      queue: 'jobs',
    });
    expect(JSON.parse(exported?.input ?? '')).toMatchObject({
      v: 1,
      id: '<aws.scheduler.execution-id>',
      ts: '<aws.scheduler.scheduled-time>',
      type: 'test.clock.tick',
      data: { scope: 'all' },
    });
  });

  it('refuses two schedules with one name', () => {
    const schedule = defineSchedule(base) as Schedule<unknown>;

    expect(() => exportSchedules([schedule, schedule])).toThrow(/Two schedules/);
  });
});
