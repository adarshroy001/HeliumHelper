import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CONFIG_SCHEMAS } from './index.js';

const example = parseEnv(readFileSync(path.resolve(import.meta.dirname, '../../.env.example'), 'utf8'));
const schemaKeys = Object.values(CONFIG_SCHEMAS).flatMap((schema) => Object.keys(schema.shape));

describe('.env.example', () => {
  it('documents every variable the config schemas read', () => {
    const missing = schemaKeys.filter((key) => !(key in example));
    expect(missing, 'add these to .env.example').toEqual([]);
  });

  it('contains no variable that no schema reads', () => {
    const unknown = Object.keys(example).filter((key) => !schemaKeys.includes(key));
    expect(unknown, 'remove these from .env.example or add them to a schema').toEqual([]);
  });

  it.each(Object.entries(CONFIG_SCHEMAS))('is a valid local setup for the %s area', (_area, schema) => {
    expect(schema.safeParse(example).success).toBe(true);
  });
});
