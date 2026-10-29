import { Writable } from 'node:stream';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { LOG_DESTINATION } from '../../src/infrastructure/logger/logger.module.js';

export type LogLine = Record<string, unknown> & { msg?: string; level?: string; requestId?: string };

/** Collects the app's log lines in memory. Pass `capture.override` to `createTestApp({ override })`. */
export class LogCapture {
  readonly lines: LogLine[] = [];

  readonly stream = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) this.lines.push(JSON.parse(line) as LogLine);
      }
      done();
    },
  });

  readonly override = (builder: TestingModuleBuilder): TestingModuleBuilder =>
    builder.overrideProvider(LOG_DESTINATION).useValue(this.stream);

  /** All captured output as one string, for "never contains" checks. */
  get text(): string {
    return JSON.stringify(this.lines);
  }

  find(predicate: (line: LogLine) => boolean): LogLine | undefined {
    return this.lines.find(predicate);
  }
}
