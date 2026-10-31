/**
 * How each Meta error is handled (docs/modules/messaging/design.md#errors). Ported from HeliumAdmin's
 * `src/lib/whatsapp/errors.ts`, with rate limits split out and failures after the request was written
 * treated as ambiguous rather than retried.
 */

export type ErrorClass = 'retryable' | 'rate_limited' | 'permanent' | 'fatal' | 'ambiguous';

/** What a fatal error stops: the whole account (token, ban, payment) or the campaign (its template). */
export type FatalScope = 'account' | 'campaign';

export interface Classification {
  readonly class: ErrorClass;
  readonly fatalScope?: FatalScope;
  /** A code missing from every table: handled as retryable and logged, so the tables can grow. */
  readonly unknownCode?: true;
}

const RETRYABLE = new Set([1, 2, 4, 17, 80007, 131016, 133004]);
const RATE_LIMITED = new Set([130429, 131056, 131057]);
const PERMANENT = new Set([130403, 131026, 131047, 131049, 131050, 132000, 132012, 132015, 132016]);
const FATAL_ACCOUNT = new Set([0, 190, 368, 131031, 131042, 133010]);
const FATAL_CAMPAIGN = new Set([131048, 131064, 132001]);

/** Meta rate limits: the number's throughput (130429), one user (131056), the number upgrading (131057). */
export const META_THROUGHPUT_LIMITED = 130429;
export const META_PAIR_LIMITED = 131056;
export const META_NUMBER_UPGRADING = 131057;

/** Classifies a Meta error code from an error response. A missing code is a server problem: retryable. */
export function classifyMetaError(code: number | undefined): Classification {
  if (code === undefined) return { class: 'retryable' };
  if (RETRYABLE.has(code)) return { class: 'retryable' };
  if (RATE_LIMITED.has(code)) return { class: 'rate_limited' };
  if (PERMANENT.has(code)) return { class: 'permanent' };
  if (FATAL_ACCOUNT.has(code)) return { class: 'fatal', fatalScope: 'account' };
  if (FATAL_CAMPAIGN.has(code)) return { class: 'fatal', fatalScope: 'campaign' };
  return { class: 'retryable', unknownCode: true };
}

/** The error object of a Graph API error response. */
export interface MetaErrorBody {
  readonly code?: number;
  readonly title?: string;
  readonly message?: string;
  readonly error_data?: { readonly details?: string };
}

/** The code and a short description from a Graph error response, or `undefined` when it has none. */
export function readMetaError(body: unknown): { code: number | undefined; detail: string } {
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  if (typeof error !== 'object' || error === null)
    return { code: undefined, detail: 'Unknown Meta API error' };
  const { code, title, message, error_data: data } = error as MetaErrorBody;
  const numeric = typeof code === 'number' ? code : undefined;
  const detail =
    data?.details ??
    message ??
    title ??
    (numeric === undefined ? 'Unknown Meta API error' : `Meta error ${String(numeric)}`);
  return { code: numeric, detail: detail.slice(0, 500) };
}

/** Retry delays in seconds for retryable send errors: 30 s, 2 m, 8 m, 30 m, 2 h, with ±20% jitter. */
const RETRY_DELAYS = [30, 120, 480, 1800, 7200];

export function retryDelaySeconds(receiveCount: number, random: () => number = Math.random): number {
  const base = RETRY_DELAYS[Math.min(Math.max(receiveCount, 1), RETRY_DELAYS.length) - 1] ?? 30;
  return Math.round(base * (0.8 + 0.4 * random()));
}
