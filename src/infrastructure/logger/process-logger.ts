import { destination, pino, type DestinationStream, type Logger } from 'pino';
import { LOG_LINE_OPTIONS } from './http-logger.options.js';

/**
 * Logger for when the app's logger doesn't exist or can't be trusted: a failed start, and crashes outside any
 * request. Same JSON line format as the app logger. Writes synchronously, so the line is out before the
 * process exits. `main.ts` adds `service` and `env` once config has loaded.
 */
export function createProcessLogger(
  stream: DestinationStream = destination({ dest: 1, sync: true }),
): Logger {
  return pino({ ...LOG_LINE_OPTIONS, base: null }, stream);
}

type ProcessEvents = Pick<NodeJS.Process, 'on' | 'exit'>;

/**
 * A crash we didn't catch leaves the process in an unknown state. Log it as one line, then exit with code 1
 * so the platform starts a fresh process.
 */
export function exitOnUncaughtErrors(logger: Logger, proc: ProcessEvents = process): void {
  proc.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    proc.exit(1);
  });
  proc.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    proc.exit(1);
  });
}
