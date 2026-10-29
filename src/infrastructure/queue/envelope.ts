import { z } from 'zod';

/** `{domain}.{noun}.{verb}`, such as `wa.delivery.send` (CONVENTIONS → Naming). */
const MESSAGE_TYPE = /^[a-z][a-z\d]*(\.[a-z][a-zA-Z\d]*){2}$/;

/** Every queue message, whoever sends it (ADR-0006). Producers and consumers both validate it. */
export const envelopeSchema = z.strictObject({
  /** Envelope version. A breaking change to this shape adds a new version. */
  v: z.literal(1),
  /** Unique per message: the deduplication key for FIFO queues and idempotent consumers. */
  id: z.uuid(),
  type: z.string().regex(MESSAGE_TYPE),
  /** When it was published (ISO 8601, UTC). */
  ts: z.iso.datetime(),
  /** The service that published it. */
  producer: z.string().min(1),
  /** The request or message that caused it, so logs can follow work across processes. */
  correlationId: z.string().min(1).max(128),
  /** The payload, validated by the message type's own schema. */
  data: z.unknown(),
});

export type Envelope<T = unknown> = Omit<z.infer<typeof envelopeSchema>, 'data'> & { data: T };

/** A kind of message: its type name and the schema of its `data`. Declared once, used by producer and consumer. */
export interface MessageType<T> {
  readonly type: string;
  readonly schema: z.ZodType<T>;
}

/**
 * Declares a message type, next to the module that owns it:
 * `export const deliverySend = defineMessage('wa.delivery.send', z.strictObject({ deliveryId: z.string() }))`.
 */
export function defineMessage<T>(type: string, schema: z.ZodType<T>): MessageType<T> {
  if (!MESSAGE_TYPE.test(type)) throw new Error(`Message types are domain.noun.verb: "${type}"`);
  return { type, schema };
}

/** A message that doesn't match its schema. Nothing is sent. */
export class InvalidMessageError extends Error {
  override readonly name = 'InvalidMessageError';

  constructor(type: string, issues: readonly z.core.$ZodIssue[]) {
    super(
      `Invalid ${type} message: ${issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
}
