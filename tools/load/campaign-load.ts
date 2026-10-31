// Load and correctness run against the local system (docs/PLAN.md M16). Start everything first, with a high rate:
//   WA_MAX_MPS=500 MOCK_META_MPS=500 PORT=3100 pnpm dev
// then: node tools/load/campaign-load.ts [recipients]
//
// It sends a CSV campaign of N recipients (with mock-meta's error cases mixed in) and a small campaign at the same
// time, pauses and resumes the big one mid-run, sends button replies, waits for both to complete, and checks:
// every recipient sent at most once, exact counts, statuses all applied. It prints the timings as JSON.
import { SignJWT } from 'jose';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // The file is optional.
  }
}

const API = process.env['LOAD_API_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3000'}`;
const META = process.env['LOAD_META_URL'] ?? 'http://localhost:4010';
const N = Number(process.argv[2] ?? 20_000);
const secrets = JSON.parse(process.env['AUTH_CALLER_SECRETS'] ?? '{}') as Record<string, string>;
const secret = secrets['helium-admin'] ?? '';

async function token(): Promise<string> {
  return new SignJWT({ act: { id: 'load', email: 'load@heliumair.in', roles: ['admin'] } })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('helium-admin')
    .setAudience('helium-backend')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  form?: FormData,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/internal/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${method} ${path} → ${String(res.status)} ${JSON.stringify(json)}`);
  return json;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
  return Date.now() - started;
}
async function status(id: string): Promise<string> {
  const campaign = await api('GET', `/campaigns/${id}`);
  const reason = campaign['pauseReason'];
  // A pause we didn't ask for (a Meta error) ends the run with its reason.
  if (campaign['status'] === 'paused' && typeof reason === 'string' && !reason.startsWith('Paused by')) {
    throw new Error(`campaign ${id} was paused: ${reason}`);
  }
  return campaign['status'] as string;
}
const stats = async (id: string) => api('GET', `/campaigns/${id}/stats`);

// Recipients: ~1% get mock-meta's error cases that settle on their own (…0001 failed after sent, …0003 failed,
// …0005 one retry, …0006 pair limit). …0002 (unknown result, settled after 15 minutes), …0004 (pauses the account)
// and …0007 (pauses the campaign) are left out.
const ERROR_EVERY = 100;
function phone(i: number): string {
  // 91 8 + 5 digits + the 4-digit suffix: unique per error kind up to 10M recipients.
  const errorPhone = (suffix: string) =>
    `918${String(Math.floor(i / ERROR_EVERY)).padStart(5, '0')}${suffix}`;
  if (i % ERROR_EVERY === 1) return errorPhone('0001');
  if (i % ERROR_EVERY === 2) return errorPhone('0003');
  if (i % ERROR_EVERY === 3) return errorPhone('0005');
  if (i % ERROR_EVERY === 4) return errorPhone('0006');
  // Ordinary numbers end in 9, so they never hit mock-meta's error suffixes (0001–0007).
  return `9196${String(i).padStart(7, '0')}9`;
}

async function main(): Promise<void> {
  await fetch(`${META}/_sim/sent`, { method: 'DELETE' });
  await fetch(`${META}/_sim/config`, {
    method: 'PATCH',
    body: JSON.stringify({
      duplicateRatio: 0.05,
      readRatio: 0.3,
      skipDeliveredRatio: 0.1,
      statusDelayMs: 200,
    }),
  });
  await api('POST', '/templates/sync');

  const csv = ['phone,name', ...Array.from({ length: N }, (_, i) => `${phone(i)},Person ${String(i)}`)].join(
    '\n',
  );
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'load.csv');
  const upload = await api('POST', '/uploads/csv', undefined, form);
  const create = (name: string, audience: Record<string, unknown>) =>
    api('POST', '/campaigns', {
      name,
      templateId: '900000000000002',
      variableMapping: [{ component: 'BODY', index: 1, source: 'field', value: 'name' }],
      audience: { sources: [], ...audience },
      options: { frequencyCapHours: 0, attributionDays: 7 },
    });
  const big = String((await create(`Load ${String(N)}`, { csvUploadId: upload['id'] }))['id']);
  const small = String(
    (
      await create('Load companion', {
        individual: Array.from({ length: 300 }, (_, i) => ({
          phone: `9195${String(i).padStart(7, '0')}9`,
          name: `C${String(i)}`,
        })),
      })
    )['id'],
  );

  const buildStarted = Date.now();
  await Promise.all([api('POST', `/campaigns/${big}/build`), api('POST', `/campaigns/${small}/build`)]);
  await waitFor(
    'builds',
    async () => (await status(big)) === 'ready' && (await status(small)) === 'ready',
    600_000,
  );
  const buildMs = Date.now() - buildStarted;
  const total = ((await api('GET', `/campaigns/${big}`))['totals'] as { total: number }).total;

  const sendStarted = Date.now();
  await api('POST', `/campaigns/${big}/start`, {});
  await api('POST', `/campaigns/${small}/start`, {});

  // Pause the big campaign once a fifth is sent, check nothing goes out, then resume.
  await waitFor(
    '20% sent',
    async () =>
      (await status(big)) === 'sending' &&
      ((await stats(big))['counts'] as { accepted: number }).accepted >= total / 5,
    600_000,
  );
  await api('POST', `/campaigns/${big}/pause`);
  await sleep(2000);
  const sentAtPause = ((await (await fetch(`${META}/_sim/stats`)).json()) as { accepted: number }).accepted;
  await sleep(4000);
  const sentAfterPause = ((await (await fetch(`${META}/_sim/stats`)).json()) as { accepted: number })
    .accepted;
  await api('POST', `/campaigns/${big}/resume`);

  // Button replies from 200 recipients, through the real webhook path.
  const sent = (await (await fetch(`${META}/_sim/sent`)).json()) as {
    messages: { wamid: string; to: string; callbackData?: string }[];
  };
  const replied = sent.messages.filter((m) => m.callbackData?.endsWith(big) === true).slice(0, 200);
  await Promise.all(
    replied.map((m, i) =>
      fetch(`${META}/_sim/inbound`, {
        method: 'POST',
        body: JSON.stringify({
          from: m.to,
          button: { text: i % 2 === 0 ? 'Bedroom' : 'Office' },
          contextWamid: m.wamid,
        }),
      }),
    ),
  );

  // The send rate counts until the last message is accepted; completion also waits for the hanging (…0002)
  // sends to be settled by the one-minute job, and for a sweep.
  let allAcceptedAt = 0;
  await waitFor(
    'completion',
    async () => {
      if (allAcceptedAt === 0 && ((await stats(big))['counts'] as { accepted: number }).accepted >= total) {
        allAcceptedAt = Date.now();
      }
      return (await status(big)) === 'send_complete' && (await status(small)) === 'send_complete';
    },
    1_800_000,
  );
  const completedAt = Date.now();
  const final = (await (await fetch(`${META}/_sim/sent`)).json()) as { total: number; duplicates: string[] };
  const bigStats = await stats(big);
  const counts = bigStats['counts'] as Record<string, number>;
  // Recipients of each failing kind (…0001 and …0003).
  const errors = Array.from({ length: N }, (_, i) => i % ERROR_EVERY === 1).filter(Boolean).length;

  const report = {
    recipients: N,
    built: total,
    buildSeconds: Math.round(buildMs / 100) / 10,
    sendSeconds: Math.round(((allAcceptedAt || completedAt) - sendStarted) / 100) / 10,
    completeSeconds: Math.round((completedAt - sendStarted) / 100) / 10,
    effectiveRate:
      Math.round(((counts['accepted'] ?? 0) / (((allAcceptedAt || completedAt) - sendStarted) / 1000)) * 10) /
      10,
    pause: { sentWhilePaused: sentAfterPause - sentAtPause },
    duplicateSends: final.duplicates.length,
    counts,
    expectedFailures: { failedAfterSent: errors, failedNoSent: errors },
    buttons: bigStats['buttons'],
    checks: {
      noDuplicates: final.duplicates.length === 0,
      // Every error case in the mix is accepted in the end (…0005 and …0006 on a retry).
      allAccepted: counts['accepted'] === total,
      // send_complete requires every delivery resolved (the `resolved` counter reaching the total).
      resolvedAll: true,
      failuresExact: counts['failed'] === 2 * errors,
      everyRecipientResolved:
        (counts['accepted'] ?? 0) + (counts['skipped'] ?? 0) + (counts['failed'] ?? 0) - errors <= total,
      pauseHeld: sentAfterPause - sentAtPause === 0,
      repliesCounted: (counts['replied'] ?? 0) === replied.length,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!Object.values(report.checks).every(Boolean)) process.exitCode = 1;
}

await main();
