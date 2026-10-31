// Starts mock-meta for local development: `pnpm mock-meta` (pnpm dev starts it too).
// Reads the same .env as the app, so its app secret and IDs match WA_* there.
import { startMockMeta } from './mock-meta.ts';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // The file is optional.
  }
}

const env = process.env;
const appSecret = (env['WA_APP_SECRETS'] ?? '').split(',')[0]?.trim() ?? '';
if (appSecret === '') {
  process.stderr.write('mock-meta: WA_APP_SECRETS is not set. Copy .env.example to .env.\n');
  process.exit(1);
}

const meta = await startMockMeta({
  port: Number(env['MOCK_META_PORT'] ?? 4010),
  webhookUrl: env['MOCK_META_WEBHOOK_URL'] ?? `http://localhost:${env['PORT'] ?? '3000'}/webhooks/whatsapp`,
  appSecret,
  ...(env['WA_ACCESS_TOKEN'] === undefined ? {} : { accessToken: env['WA_ACCESS_TOKEN'] }),
  ...(env['WA_WABA_ID'] === undefined ? {} : { wabaId: env['WA_WABA_ID'] }),
  mps: Number(env['MOCK_META_MPS'] ?? env['WA_MAX_MPS'] ?? 80),
});
process.stdout.write(`mock-meta on ${meta.url} (simulator: ${meta.url}/_sim/stats)\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void meta.close().then(() => process.exit(0));
  });
}
