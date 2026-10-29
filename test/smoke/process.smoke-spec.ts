import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mongoUri } from '../global-setup.js';

/**
 * Runs the built app (`dist/main.js`, `dist/migrate.js`) as real processes, for what an in-process test can't
 * show: real signals, exit codes and what reaches stdout before the process exits. Run `pnpm build` first.
 */
const MAIN = resolve('dist/main.js');
const MIGRATE = resolve('dist/migrate.js');
const WORKER = resolve('dist/worker.js');

type LogLine = Record<string, unknown> & { level?: string; msg?: string };

interface RunningApp {
  child: ChildProcess;
  lines: LogLine[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(env: Record<string, string>, args: string[] = [MAIN]): RunningApp {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, NODE_ENV: 'production', APP_ENV: 'staging', LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: LogLine[] = [];
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    const complete = buffered.split('\n');
    buffered = complete.pop() ?? '';
    for (const line of complete) if (line.trim()) lines.push(JSON.parse(line) as LogLine);
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.on('exit', (code, signal) => {
      done({ code, signal });
    });
  });
  return { child, lines, exit };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, done));
  const address = server.address();
  await new Promise<void>((done) => {
    server.close(() => {
      done();
    });
  });
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('the built app as a process', () => {
  beforeAll(() => {
    if (!existsSync(MAIN)) throw new Error(`${MAIN} not found: run "pnpm build" first`);
  });

  it('logs a failed start once, as JSON, and exits with code 1', async () => {
    const app = start({ PORT: '99999' });

    const { code } = await app.exit;

    expect(code).toBe(1);
    expect(app.lines).toHaveLength(1);
    expect(app.lines[0]).toMatchObject({
      level: 'fatal',
      msg: 'startup failed',
      err: { type: 'ConfigValidationError' },
    });
  });

  // Windows has no SIGTERM: `kill('SIGTERM')` ends the process without running its handlers. CI runs Linux.
  it.skipIf(process.platform === 'win32')('serves, then shuts down cleanly on SIGTERM', async () => {
    const port = await freePort();
    const app = start({ PORT: String(port) });
    await vi.waitFor(
      () => {
        if (!app.lines.some((l) => l.msg?.includes('listening on port')))
          throw new Error('not listening yet');
      },
      { timeout: 10_000 },
    );
    expect((await fetch(`http://127.0.0.1:${String(port)}/health/ready`)).status).toBe(200);

    app.child.kill('SIGTERM');
    const { code, signal } = await app.exit;

    // Nest closes the app, then re-raises the signal, so the process ends by SIGTERM.
    expect(signal === 'SIGTERM' || code === 0).toBe(true);
    const messages = app.lines.map((l) => l.msg);
    expect(messages).toContain('shutting down');
    expect(messages.at(-1)).toBe('shutdown complete');
    expect(app.lines.filter((l) => l.level === 'error' || l.level === 'fatal')).toEqual([]);
  });
});

describe('the built migration command', () => {
  const env = { MONGO_MESSAGING_URI: mongoUri(process.env['MONGO_TEST_URI'] ?? '', 'smoke_migrations') };
  const migrate = async (command: string) => {
    const run = start(env, [MIGRATE, command]);
    return { ...(await run.exit), messages: run.lines.map((l) => l.msg) };
  };

  it('applies pending migrations, then has nothing left to apply', async () => {
    expect(await migrate('up')).toMatchObject({ code: 0 });

    const second = await migrate('up');
    expect(second).toMatchObject({ code: 0 });
    expect(second.messages).toContain('no pending migrations');
  });

  it('reports status, and fails on an unknown command', async () => {
    expect(await migrate('status')).toMatchObject({ code: 0 });
    expect(await migrate('sideways')).toMatchObject({ code: 1, messages: ['migration command failed'] });
  });
});

describe('the built worker as a process', () => {
  // Windows has no SIGTERM (see above). CI runs Linux.
  it.skipIf(process.platform === 'win32')('serves health, then shuts down cleanly on SIGTERM', async () => {
    const port = await freePort();
    const worker = start({ WORKER_HEALTH_PORT: String(port), WORKER_QUEUES: '' }, [WORKER]);
    await vi.waitFor(
      () => {
        if (!worker.lines.some((l) => l.msg?.includes('worker health on port')))
          throw new Error('not up yet');
      },
      { timeout: 10_000 },
    );
    expect((await fetch(`http://127.0.0.1:${String(port)}/health/ready`)).status).toBe(200);

    worker.child.kill('SIGTERM');
    const { code, signal } = await worker.exit;

    expect(signal === 'SIGTERM' || code === 0).toBe(true);
    const messages = worker.lines.map((l) => l.msg);
    expect(messages).toContain('consumers stopped');
    expect(messages.at(-1)).toBe('shutdown complete');
  });
});
