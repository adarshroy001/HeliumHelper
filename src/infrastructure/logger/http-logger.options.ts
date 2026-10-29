import type { IncomingMessage, ServerResponse } from 'node:http';
import { stdTimeFunctions } from 'pino';
import type { Options } from 'pino-http';
import type { AppConfig } from '../../config/index.js';
import { resolveRequestId } from '../request-context/request-id.js';

/**
 * Removed from every log line wherever they appear (one level deep). Request headers are never logged at all,
 * but services may log objects that carry these fields.
 */
export const REDACTED_PATHS = [
  'authorization',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  '*.authorization',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.apiKey',
];

/** Path only: query strings can carry phone numbers or other personal data (CONVENTIONS R13). */
function pathOf(url: string | undefined): string {
  return (url ?? '').split('?')[0] ?? '';
}

/** Access log for every request (except health checks) plus the base settings of every app log line. */
export function httpLoggerOptions(app: AppConfig): Options {
  return {
    level: app.logLevel,
    base: { service: app.name, env: app.appEnv },
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACTED_PATHS, censor: '[Redacted]' },

    genReqId: (req: IncomingMessage, res: ServerResponse) => resolveRequestId(req, res),
    // App logs during a request carry only `requestId`, not the whole request.
    quietReqLogger: true,
    customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
    serializers: {
      req: (req: { method?: string; url?: string }) => ({ method: req.method, path: pathOf(req.url) }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },

    autoLogging: { ignore: (req) => pathOf(req.url).startsWith('/health') },
    customLogLevel: (_req, res, err) => {
      if (err !== undefined || res.statusCode >= 500) return 'error';
      return res.statusCode >= 400 ? 'warn' : 'info';
    },
    customSuccessMessage: () => 'request completed',
    customErrorMessage: () => 'request failed',
  };
}
