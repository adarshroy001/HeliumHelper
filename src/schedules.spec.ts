import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportSchedules } from './infrastructure/queue/index.js';
import { SCHEDULES } from './schedules.js';

describe('schedule registry', () => {
  it('matches deploy/schedules.json, which the CDK stack reads (run `pnpm schedules:export` after a change)', () => {
    const file = path.resolve(import.meta.dirname, '../deploy/schedules.json');

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(exportSchedules(SCHEDULES));
  });
});
