import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Stored files: CSV audiences, header media, exports (ADR-0015). Keys are paths such as `uploads/<id>.csv`.
 * Code depends on this class; a store is chosen per environment (local disk now, S3 when deployed).
 */
export abstract class BlobStore {
  /** Stores a file, streaming it; returns its size in bytes. */
  abstract put(key: string, source: Readable | Buffer): Promise<{ size: number }>;
  /** Reads a stored file as a stream. */
  abstract open(key: string): Readable;
  abstract delete(key: string): Promise<void>;
}

const KEY = /^[a-z][a-z0-9-]*(\/[A-Za-z0-9._-]+)+$/;

/** Files on the local disk, under `BLOB_DIR`. For development and tests. */
export class LocalDiskBlobStore extends BlobStore {
  constructor(private readonly root: string) {
    super();
  }

  async put(key: string, source: Readable | Buffer): Promise<{ size: number }> {
    const file = this.path(key);
    await mkdir(path.dirname(file), { recursive: true });
    await pipeline(Buffer.isBuffer(source) ? Readable.from([source]) : source, createWriteStream(file));
    return { size: (await stat(file)).size };
  }

  open(key: string): Readable {
    return createReadStream(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  /** The file for a key; keys can't climb out of the root. */
  private path(key: string): string {
    if (!KEY.test(key) || key.includes('..')) throw new RangeError(`Invalid blob key: ${key}`);
    return path.resolve(this.root, key);
  }
}
