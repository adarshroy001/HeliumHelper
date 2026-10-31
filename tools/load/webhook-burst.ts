// Webhook intake under a burst (docs/PLAN.md M16): posts signed status webhooks to the local API as fast as
// `concurrency` allows and reports the response times. Start the API first (pnpm dev), then:
//   node tools/load/webhook-burst.ts [requests] [concurrency]
// The statuses match no delivery, so the status consumer records them as unmatched after its retries.
import { createHmac, randomUUID } from 'node:crypto';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // The file is optional.
  }
}

const URL = process.env['LOAD_API_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3000'}`;
const REQUESTS = Number(process.argv[2] ?? 5000);
const CONCURRENCY = Number(process.argv[3] ?? 50);
const SECRET = (process.env['WA_APP_SECRETS'] ?? '').split(',')[0]?.trim() ?? '';

function body(): string {
  const statuses = Array.from({ length: 3 }, () => ({
    id: `wamid.burst.${randomUUID()}`,
    status: 'delivered',
    timestamp: String(Math.floor(Date.now() / 1000)),
    recipient_id: '919999999999',
  }));
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: process.env['WA_WABA_ID'] ?? '1',
        changes: [
          {
            field: 'messages',
            value: { metadata: { phone_number_id: process.env['WA_PHONE_NUMBER_ID'] ?? '1' }, statuses },
          },
        ],
      },
    ],
  });
}

async function main(): Promise<void> {
  const times: number[] = [];
  let failures = 0;
  let next = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < REQUESTS) {
        next += 1;
        const raw = body();
        const at = performance.now();
        const res = await fetch(`${URL}/webhooks/whatsapp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`,
          },
          body: raw,
        }).catch(() => null);
        times.push(performance.now() - at);
        if (res?.status !== 200) failures += 1;
      }
    }),
  );
  times.sort((a, b) => a - b);
  const pct = (p: number) =>
    Math.round((times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))] ?? 0) * 10) / 10;
  const seconds = (Date.now() - started) / 1000;
  process.stdout.write(
    `${JSON.stringify({ requests: REQUESTS, concurrency: CONCURRENCY, perSecond: Math.round(REQUESTS / seconds), failures, ms: { p50: pct(50), p95: pct(95), p99: pct(99), max: pct(100) } }, null, 2)}\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

await main();
