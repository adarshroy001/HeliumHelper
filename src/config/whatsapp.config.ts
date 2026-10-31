import { registerAs, type ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { loadConfig, type RawEnv } from './config.loader.js';

const digits = z.string().regex(/^\d{5,20}$/, 'must be a numeric Meta ID');
const list = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== ''),
);
const price = z.coerce.number().min(0).max(100);

/** Variables for WhatsApp through Meta's Graph API (ADR-0015). Locally they point at mock-meta. */
export const whatsappEnvSchema = z.object({
  /** Graph API origin. Locally mock-meta (`http://localhost:4010`). */
  WA_GRAPH_URL: z.url({ protocol: /^https?$/ }).default('https://graph.facebook.com'),
  /** Graph API version for sends and webhooks; raised by config after testing. */
  WA_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'must look like v26.0')
    .default('v26.0'),
  /** System User access token. In AWS it comes from Secrets Manager. */
  WA_ACCESS_TOKEN: z.string().min(1),
  /** App secrets that sign webhooks, comma-separated: the current one, plus the old one while rotating. */
  WA_APP_SECRETS: list.pipe(
    z.array(z.string().min(16, 'each app secret needs 16 characters or more')).min(1).max(2),
  ),
  /** Token Meta sends when verifying the webhook URL. */
  WA_VERIFY_TOKEN: z.string().min(16),
  /** The WhatsApp Business Account, its phone number and its business portfolio. */
  WA_WABA_ID: digits,
  WA_PHONE_NUMBER_ID: digits,
  WA_PORTFOLIO_ID: digits,
  /** Where marketing templates go: `marketing_messages` once the account is onboarded to it. */
  WA_MARKETING_ENDPOINT: z.enum(['messages', 'marketing_messages']).default('messages'),
  /** The number's allowed throughput, messages per second (Meta: 80 by default, up to 1,000). */
  WA_MAX_MPS: z.coerce.number().int().min(1).max(1000).default(80),
  /** Inbound texts that opt a number out, comma-separated, matched ignoring case and spaces at the ends. */
  WA_OPT_OUT_KEYWORDS: list.default(['STOP', 'UNSUBSCRIBE']),
  /** Button payloads that opt a number out, comma-separated. */
  WA_OPT_OUT_PAYLOADS: list.default([]),
  /** Meta's price per message by category, for cost estimates. Update from Meta's rate card. */
  WA_PRICE_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('INR'),
  WA_PRICE_MARKETING: price.default(0.86),
  WA_PRICE_UTILITY: price.default(0.12),
  WA_PRICE_AUTHENTICATION: price.default(0.12),
});

/** Typed WhatsApp config, built from the validated variables. */
export function parseWhatsappConfig(env: RawEnv) {
  const vars = loadConfig('whatsapp', whatsappEnvSchema, env);
  return {
    graphUrl: vars.WA_GRAPH_URL.replace(/\/+$/, ''),
    graphVersion: vars.WA_GRAPH_VERSION,
    accessToken: vars.WA_ACCESS_TOKEN,
    appSecrets: vars.WA_APP_SECRETS,
    verifyToken: vars.WA_VERIFY_TOKEN,
    account: {
      wabaId: vars.WA_WABA_ID,
      phoneNumberId: vars.WA_PHONE_NUMBER_ID,
      portfolioId: vars.WA_PORTFOLIO_ID,
      marketingEndpoint: vars.WA_MARKETING_ENDPOINT,
      maxMps: vars.WA_MAX_MPS,
    },
    optOut: {
      keywords: vars.WA_OPT_OUT_KEYWORDS.map((keyword) => keyword.toUpperCase()),
      payloads: vars.WA_OPT_OUT_PAYLOADS,
    },
    prices: {
      currency: vars.WA_PRICE_CURRENCY,
      marketing: vars.WA_PRICE_MARKETING,
      utility: vars.WA_PRICE_UTILITY,
      authentication: vars.WA_PRICE_AUTHENTICATION,
    },
  };
}

/** Inject with `@Inject(whatsappConfig.KEY) private readonly whatsapp: WhatsappConfig`. */
export const whatsappConfig = registerAs('whatsapp', () => parseWhatsappConfig(process.env));
export type WhatsappConfig = ConfigType<typeof whatsappConfig>;
