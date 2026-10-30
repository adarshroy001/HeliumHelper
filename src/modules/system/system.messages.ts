import { z } from 'zod';
import { defineMessage } from '../../infrastructure/queue/index.js';

/** The queue for the system's own scheduled jobs. */
export const SYSTEM_JOBS_QUEUE = 'system-jobs';

/** A tick from the scheduler, proving the path scheduler → queue → worker works end to end. */
export const heartbeatTick = defineMessage('system.heartbeat.tick', z.strictObject({}));
