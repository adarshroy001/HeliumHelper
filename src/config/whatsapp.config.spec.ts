import { describe, expect, it } from 'vitest';
import { ConfigValidationError } from './config.loader.js';
import { parseWhatsappConfig } from './whatsapp.config.js';

const local = {
  WA_GRAPH_URL: 'http://localhost:4010/',
  WA_ACCESS_TOKEN: 'local-token',
  WA_APP_SECRETS: 'local-app-secret-0123456789',
  WA_VERIFY_TOKEN: 'local-verify-token-0123',
  WA_WABA_ID: '100000000000001',
  WA_PHONE_NUMBER_ID: '100000000000002',
  WA_PORTFOLIO_ID: '100000000000003',
};

describe('parseWhatsappConfig', () => {
  it('reads a local mock-meta setup with defaults', () => {
    expect(parseWhatsappConfig(local)).toEqual({
      graphUrl: 'http://localhost:4010',
      graphVersion: 'v26.0',
      accessToken: 'local-token',
      appSecrets: ['local-app-secret-0123456789'],
      verifyToken: 'local-verify-token-0123',
      account: {
        wabaId: '100000000000001',
        phoneNumberId: '100000000000002',
        portfolioId: '100000000000003',
        marketingEndpoint: 'messages',
        maxMps: 80,
      },
      optOut: { keywords: ['STOP', 'UNSUBSCRIBE'], payloads: [] },
      prices: { currency: 'INR', marketing: 0.86, utility: 0.12, authentication: 0.12 },
    });
  });

  it('accepts two app secrets while rotating, and custom opt-out words', () => {
    const config = parseWhatsappConfig({
      ...local,
      WA_APP_SECRETS: 'new-app-secret-0123456789, old-app-secret-0123456789',
      WA_OPT_OUT_KEYWORDS: 'stop, band karo',
      WA_OPT_OUT_PAYLOADS: 'OPT_OUT',
    });

    expect(config.appSecrets).toEqual(['new-app-secret-0123456789', 'old-app-secret-0123456789']);
    expect(config.optOut).toEqual({ keywords: ['STOP', 'BAND KARO'], payloads: ['OPT_OUT'] });
  });

  it.each([
    ['WA_ACCESS_TOKEN', undefined],
    ['WA_APP_SECRETS', 'short'],
    ['WA_APP_SECRETS', 'secret-one-0123456789,secret-two-0123456789,secret-three-0123456789'],
    ['WA_VERIFY_TOKEN', 'short'],
    ['WA_PHONE_NUMBER_ID', 'abc'],
    ['WA_GRAPH_VERSION', '26'],
    ['WA_MARKETING_ENDPOINT', 'mm-lite'],
    ['WA_MAX_MPS', '5000'],
    ['WA_PRICE_MARKETING', '-1'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => parseWhatsappConfig({ ...local, [key]: value })).toThrow(ConfigValidationError);
  });
});
