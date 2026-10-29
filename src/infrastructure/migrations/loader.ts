import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Migration, MigrationError, type NamedMigration } from './migration.js';

/** `0001-create-campaign-indexes.ts` (source) or `.js` (compiled). */
const FILE = /^(\d{4}-[a-z\d]+(?:-[a-z\d]+)*)\.(?:ts|js)$/;

function isMigration(value: unknown): value is Migration {
  return typeof value === 'object' && value !== null && typeof (value as Migration).up === 'function';
}

/** File names in `dir`; none if it doesn't exist (the build skips an empty migrations folder). */
async function listFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return [];
    throw err;
  }
}

/** The migration files in `dir`, in order. Fails on a badly named file or a number used twice. */
export async function loadMigrations(dir: string): Promise<NamedMigration[]> {
  const files = (await listFiles(dir)).filter(
    (file) => /\.(ts|js)$/.test(file) && !/\.(d|spec|int-spec)\.ts$/.test(file),
  );
  const migrations: NamedMigration[] = [];
  const numbers = new Set<string>();

  for (const file of files.sort()) {
    const id = FILE.exec(file)?.[1];
    if (id === undefined) throw new MigrationError(`${file}: migration files are named NNNN-what-it-does.ts`);
    const number = id.slice(0, 4);
    if (numbers.has(number)) throw new MigrationError(`${file}: migration number ${number} is used twice`);
    numbers.add(number);

    const module = (await import(pathToFileURL(path.join(dir, file)).href)) as { default?: unknown };
    if (!isMigration(module.default)) throw new MigrationError(`${file}: must default-export { up(db) }`);
    migrations.push({ id, up: module.default.up.bind(module.default) });
  }
  return migrations;
}

/** The file name for a new migration: the next number, then `name` in kebab case. */
export async function nextMigrationFile(dir: string, name: string): Promise<string> {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z\d]+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug === '') throw new MigrationError('Give the migration a name, such as "add campaign indexes"');

  const highest = (await listFiles(dir))
    .map((file) => FILE.exec(file)?.[1]?.slice(0, 4))
    .filter((number) => number !== undefined)
    .map(Number)
    .reduce((max, n) => Math.max(max, n), 0);
  return `${String(highest + 1).padStart(4, '0')}-${slug}.ts`;
}
