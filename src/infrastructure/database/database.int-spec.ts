import { type Connection, type Model, Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDatabase } from '../../../test/helpers/mongo.js';
import { ValidationError } from '../../common/errors/index.js';
import { findPage, withTransaction } from './index.js';

interface Note {
  owner: string;
  text: string;
}

const noteSchema = new Schema<Note>({
  owner: { type: String, required: true },
  text: { type: String, required: true },
});

describe('database helpers (real MongoDB)', () => {
  let db: Connection & { dropAndClose: () => Promise<void> };
  let notes: Model<Note>;

  beforeAll(async () => {
    db = await connectTestDatabase();
    notes = db.model<Note>('Note', noteSchema);
    await notes.createCollection();
  });

  afterAll(async () => {
    await db.dropAndClose();
  });

  beforeEach(async () => {
    await notes.deleteMany({});
  });

  it('writes and reads documents', async () => {
    await notes.create({ owner: 'asha', text: 'hello' });

    expect(await notes.findOne({ owner: 'asha' }).lean()).toMatchObject({ owner: 'asha', text: 'hello' });
  });

  it('rejects a filter on a field the schema does not have', async () => {
    await expect(notes.find({ ownr: 'asha' }).lean()).rejects.toThrow(/ownr/);
  });

  describe('findPage', () => {
    beforeEach(async () => {
      // Inserted one by one so their _ids increase in this order.
      for (const text of ['n1', 'n2', 'n3', 'n4', 'n5']) await notes.create({ owner: 'asha', text });
      await notes.create({ owner: 'ravi', text: 'other' });
    });

    it('walks every match once, newest first, with a cursor', async () => {
      const first = await findPage(notes, { owner: 'asha' }, { limit: 2 });
      const second = await findPage(notes, { owner: 'asha' }, { limit: 2, cursor: first.nextCursor ?? '' });
      const third = await findPage(notes, { owner: 'asha' }, { limit: 2, cursor: second.nextCursor ?? '' });

      expect([first, second, third].map((page) => page.items.map((n) => n.text))).toEqual([
        ['n5', 'n4'],
        ['n3', 'n2'],
        ['n1'],
      ]);
      expect(first.nextCursor).toMatch(/^[\w-]+$/);
      expect(third.nextCursor).toBeNull();
    });

    it('returns plain objects', async () => {
      const { items } = await findPage(notes, {}, { limit: 1 });

      expect(items[0]?.constructor).toBe(Object);
    });

    it('rejects a cursor it did not issue', async () => {
      await expect(findPage(notes, {}, { limit: 2, cursor: 'dG9vLXNob3J0' })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe('withTransaction', () => {
    it('commits every write together', async () => {
      await withTransaction(db, async (session) => {
        await notes.create([{ owner: 'asha', text: 'a' }], { session });
        await notes.create([{ owner: 'asha', text: 'b' }], { session });
      });

      expect(await notes.countDocuments({ owner: 'asha' })).toBe(2);
    });

    it('rolls back every write when the work fails', async () => {
      const failing = withTransaction(db, async (session) => {
        await notes.create([{ owner: 'asha', text: 'a' }], { session });
        throw new Error('second step failed');
      });

      await expect(failing).rejects.toThrow('second step failed');
      expect(await notes.countDocuments({})).toBe(0);
    });
  });
});
