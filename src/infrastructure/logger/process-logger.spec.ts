import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createProcessLogger, exitOnUncaughtErrors } from './process-logger.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
      done();
    },
  });
  return { lines, logger: createProcessLogger(stream) };
}

function fakeProcess() {
  const events = new EventEmitter();
  const exit = vi.fn();
  return { events, exit, proc: { on: events.on.bind(events), exit } as unknown as NodeJS.Process };
}

describe('process logger', () => {
  it('writes the same JSON line format as the app logger, with redaction', () => {
    const { lines, logger } = capture();

    logger.setBindings({ service: 'helium-backend', env: 'staging' });
    logger.fatal({ token: 'abc' }, 'startup failed');

    expect(lines).toEqual([
      {
        level: 'fatal',
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
        service: 'helium-backend',
        env: 'staging',
        token: '[Redacted]',
        msg: 'startup failed',
      },
    ]);
  });

  it('logs an uncaught exception once, then exits with code 1', () => {
    const { lines, logger } = capture();
    const { events, exit, proc } = fakeProcess();
    exitOnUncaughtErrors(logger, proc);

    events.emit('uncaughtException', new Error('boom'));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'fatal', msg: 'uncaught exception', err: { message: 'boom' } });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('logs an unhandled rejection once, then exits with code 1', () => {
    const { lines, logger } = capture();
    const { events, exit, proc } = fakeProcess();
    exitOnUncaughtErrors(logger, proc);

    events.emit('unhandledRejection', new Error('nobody awaited me'));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: 'unhandled promise rejection',
      err: { message: 'nobody awaited me' },
    });
    expect(exit).toHaveBeenCalledWith(1);
  });
});
