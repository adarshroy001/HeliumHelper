import { Cron } from 'croner';
import type { MessageType } from '../envelope.js';

/**
 * A job that runs on a timetable (ADR-0006). It doesn't run code itself: at each tick, a message is put on
 * `queue` and a normal consumer handles it. In AWS each schedule becomes an EventBridge Scheduler schedule
 * (`deploy/schedules.json`, F24); locally the worker's timer publishes the same message.
 */
export interface Schedule<T> {
  /** Unique, kebab-case: `campaign-sweeper`. */
  readonly name: string;
  readonly description: string;
  /**
   * Five fields: minute hour day-of-month month day-of-week. Day-of-week is `*` or names (`MON-FRI`), never
   * numbers: EventBridge counts days 1–7 from Sunday, standard cron 0–6.
   */
  readonly cron: string;
  /** IANA time zone the cron is read in: `Asia/Kolkata`. */
  readonly timezone: string;
  /** The queue's short name. */
  readonly queue: string;
  readonly message: MessageType<T>;
  readonly data: T;
}

const NAME = /^[a-z][a-z\d]*(-[a-z\d]+)*$/;
const DAYS = /^(\*|(SUN|MON|TUE|WED|THU|FRI|SAT)([-,](SUN|MON|TUE|WED|THU|FRI|SAT))*)$/;

/** Declares a schedule next to the module that owns it. Fails fast on a bad name, cron or message. */
export function defineSchedule<T>(schedule: Schedule<T>): Schedule<T> {
  if (!NAME.test(schedule.name)) throw new Error(`Schedule names are kebab-case: "${schedule.name}"`);
  const fields = schedule.cron.split(' ');
  const [, , dayOfMonth, , dayOfWeek] = fields;
  if (fields.length !== 5 || dayOfWeek === undefined || !DAYS.test(dayOfWeek)) {
    throw new Error(
      `Schedule ${schedule.name}: cron needs 5 fields with day-of-week * or names, got "${schedule.cron}"`,
    );
  }
  if (dayOfWeek !== '*' && dayOfMonth !== '*') {
    throw new Error(`Schedule ${schedule.name}: set day-of-month or day-of-week, not both`);
  }
  // Throws a RangeError for an unknown time zone; croner then validates every cron field.
  new Intl.DateTimeFormat('en', { timeZone: schedule.timezone });
  new Cron(schedule.cron, { timezone: schedule.timezone, paused: true }).stop();
  if (!schedule.message.schema.safeParse(schedule.data).success) {
    throw new Error(`Schedule ${schedule.name}: data doesn't match ${schedule.message.type}`);
  }
  return schedule;
}

/**
 * The same timetable in EventBridge's syntax: `cron(min hour dom month dow year)`, with `?` for the unused day,
 * and steps written from their first value: every 5 minutes is `0/5` (minutes and hours start at 0, days and
 * months at 1).
 */
export function toEventBridgeCron(cron: string): string {
  const step = (field: string, first: string) => field.replace(/^\*\//, `${first}/`);
  const [minute = '', hour = '', dayOfMonth = '', month = '', dayOfWeek = ''] = cron.split(' ');
  const min = step(minute, '0');
  const hr = step(hour, '0');
  const mon = step(month, '1');
  return dayOfWeek === '*'
    ? `cron(${min} ${hr} ${step(dayOfMonth, '1')} ${mon} ? *)`
    : `cron(${min} ${hr} ? ${mon} ${dayOfWeek} *)`;
}

/** One schedule as the CDK stack creates it (`deploy/schedules.json`). */
export interface ExportedSchedule {
  name: string;
  description: string;
  scheduleExpression: string;
  timezone: string;
  queue: string;
  /** The SQS message body. EventBridge Scheduler fills in the `<aws.scheduler.*>` placeholders at each run. */
  input: string;
}

/** What the CDK stack needs to create the schedules. A test keeps `deploy/schedules.json` equal to this. */
export function exportSchedules(schedules: readonly Schedule<unknown>[]): ExportedSchedule[] {
  const names = new Set<string>();
  return schedules.map((schedule) => {
    if (names.has(schedule.name)) throw new Error(`Two schedules are named ${schedule.name}`);
    names.add(schedule.name);
    return {
      name: schedule.name,
      description: schedule.description,
      scheduleExpression: toEventBridgeCron(schedule.cron),
      timezone: schedule.timezone,
      queue: schedule.queue,
      input: JSON.stringify({
        v: 1,
        id: '<aws.scheduler.execution-id>',
        type: schedule.message.type,
        ts: '<aws.scheduler.scheduled-time>',
        producer: 'eventbridge-scheduler',
        correlationId: '<aws.scheduler.execution-id>',
        data: schedule.data,
      }),
    };
  });
}
