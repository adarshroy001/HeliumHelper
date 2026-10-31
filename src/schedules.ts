import type { Schedule } from './infrastructure/queue/index.js';
import { campaignSweepSchedule } from './modules/campaigns/index.js';
import {
  suppressionsReloadSchedule,
  templatesSyncSchedule,
  unconfirmedSettleSchedule,
} from './modules/messaging/index.js';
import { heartbeatSchedule } from './modules/system/index.js';

/**
 * Every scheduled job (ADR-0006). A module declares its schedules with `defineSchedule()` and adds them here.
 * After a change, run `pnpm schedules:export`: the CDK stack creates the schedules from `deploy/schedules.json`,
 * and a test fails while that file is out of date.
 */
export const SCHEDULES: readonly Schedule<unknown>[] = [
  heartbeatSchedule,
  templatesSyncSchedule,
  suppressionsReloadSchedule,
  unconfirmedSettleSchedule,
  campaignSweepSchedule,
];
