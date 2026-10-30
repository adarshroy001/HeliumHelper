import { writeFile } from 'node:fs/promises';
import { exportSchedules } from './infrastructure/queue/index.js';
import { SCHEDULES } from './schedules.js';

// Writes deploy/schedules.json from the schedule registry, for the CDK stack (F24). Run: pnpm schedules:export
await writeFile('deploy/schedules.json', `${JSON.stringify(exportSchedules(SCHEDULES), null, 2)}\n`);
