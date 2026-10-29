import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, nextMigrationFile } from './loader.js';

const VALID = 'export default { async up() {} };';

describe('migration loader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
    // Plain .js files in the folder are ES modules, like the compiled migrations.
    await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const add = (file: string, code = VALID) => writeFile(path.join(dir, file), code);

  it('loads migrations in number order, named after their files', async () => {
    await add('0002-add-index.js');
    await add('0001-create-collection.js');
    await add('0001-create-collection.js.map', '{}');

    const migrations = await loadMigrations(dir);

    expect(migrations.map((m) => m.id)).toEqual(['0001-create-collection', '0002-add-index']);
    expect(typeof migrations[0]?.up).toBe('function');
  });

  it('has no migrations when the folder does not exist', async () => {
    expect(await loadMigrations(path.join(dir, 'missing'))).toEqual([]);
  });

  it.each([
    ['a badly named file', [['1-add-index.js', VALID]], /named NNNN-what-it-does/],
    [
      'a number used twice',
      [
        ['0001-a.js', VALID],
        ['0001-b.js', VALID],
      ],
      /used twice/,
    ],
    ['a file without up()', [['0001-a.js', 'export default {};']], /must default-export/],
  ] as const)('fails on %s', async (_case, files, problem) => {
    for (const [file, code] of files) await add(file, code);

    await expect(loadMigrations(dir)).rejects.toThrow(problem);
  });

  it('names a new migration with the next number', async () => {
    expect(await nextMigrationFile(dir, 'Create campaigns')).toBe('0001-create-campaigns.ts');

    await add('0007-something.js');
    expect(await nextMigrationFile(dir, 'add index: status/_id')).toBe('0008-add-index-status-id.ts');
    await expect(nextMigrationFile(dir, '!!!')).rejects.toThrow(/Give the migration a name/);
  });
});
