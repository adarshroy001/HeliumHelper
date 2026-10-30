// pnpm dev: everything a developer needs, in one terminal.
//   1. local dependencies (docker compose: MongoDB, Valkey, ElasticMQ), waiting until they are healthy;
//   2. one build, then pending migrations;
//   3. one TypeScript watcher, the API (port 3000) and the worker (health on 3001), restarted on every change.
// Ctrl+C stops all three; the containers keep running (`docker compose down` stops them).
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const node = process.execPath;
const nest = path.resolve('node_modules/@nestjs/cli/bin/nest.js');
const tsc = path.resolve('node_modules/typescript/bin/tsc');

function step(title: string, command: string, args: string[], hint: string): void {
  process.stdout.write(`\n> ${title}\n`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write(`\n${title} failed. ${hint}\n`);
    process.exit(1);
  }
}

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  process.stdout.write('Created .env from .env.example.\n');
}

step(
  'Starting MongoDB, Valkey and ElasticMQ',
  'docker',
  ['compose', 'up', '-d', '--wait'],
  'Is Docker running?',
);
step('Building', node, [nest, 'build'], 'Fix the compile errors above.');
step('Applying migrations', node, ['--enable-source-maps', 'dist/migrate.js', 'up'], 'See the error above.');

const children: ChildProcess[] = [];

/** Runs a long-lived process, prefixing each output line with its name. */
function run(name: string, args: string[]): void {
  const child = spawn(node, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => `[${name}] ${line}\n`)
      .join('');
  child.stdout.on('data', (chunk: Buffer) => process.stdout.write(prefix(chunk)));
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(prefix(chunk)));
  children.push(child);
}

run('tsc', [tsc, '--watch', '--preserveWatchOutput', '-p', 'tsconfig.build.json']);
run('api', ['--watch', '--enable-source-maps', 'dist/main.js']);
run('worker', ['--watch', '--enable-source-maps', 'dist/worker.js']);
process.stdout.write(
  '\nAPI on http://localhost:3000 (docs at /docs), worker health on http://localhost:3001\n\n',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const child of children) child.kill();
    process.exit(0);
  });
}
