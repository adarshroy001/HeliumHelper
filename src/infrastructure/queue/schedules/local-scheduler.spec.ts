import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppConfig } from '../../../config/index.js';
import { defineMessage } from '../envelope.js';
import type { QueuePublisher } from '../queue-publisher.js';
import { LocalScheduler } from './local-scheduler.js';
import { defineSchedule, type Schedule } from './schedule.js';

const tick = defineMessage('test.clock.tick', z.strictObject({}));
const schedule = defineSchedule({
  name: 'every-minute',
  description: 'test',
  cron: '* * * * *',
  timezone: 'Asia/Kolkata',
  queue: 'jobs',
  message: tick,
  data: {},
}) as Schedule<unknown>;

function scheduler(app: Partial<AppConfig>) {
  const publish = vi.fn().mockResolvedValue('id');
  const logger = { setContext: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;
  const local = new LocalScheduler(
    [schedule],
    app as AppConfig,
    { publish } as unknown as QueuePublisher,
    logger,
  );
  return { local, publish };
}

describe('LocalScheduler', () => {
  it("publishes the schedule's message when it fires", async () => {
    const { local, publish } = scheduler({ appEnv: 'local', nodeEnv: 'development' });
    const job = local.start(schedule);

    await job.trigger();
    const next = job.nextRun();
    job.stop();

    expect(publish).toHaveBeenCalledWith('jobs', tick, {});
    expect(next).toBeInstanceOf(Date);
  });

  it.each([
    ['deployed environments', { appEnv: 'staging', nodeEnv: 'production' }],
    ['tests', { appEnv: 'local', nodeEnv: 'test' }],
  ] as const)('starts nothing in %s', (_case, app) => {
    const { local } = scheduler(app);
    const start = vi.spyOn(local, 'start');

    local.onApplicationBootstrap();

    expect(start).not.toHaveBeenCalled();
  });
});
