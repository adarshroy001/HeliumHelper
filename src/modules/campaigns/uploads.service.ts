import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/index.js';
import { BlobStore } from '../../infrastructure/blob/index.js';
import type { CsvUploadDocument } from './campaign.schema.js';
import { CsvInvalidError } from './campaigns.errors.js';
import { UploadsRepository } from './campaigns.repository.js';
import { guessPhoneColumn, readCsv } from './csv.js';

/** The most rows an audience CSV may have, and the most columns. */
export const MAX_CSV_ROWS = 1_000_000;
const MAX_COLUMNS = 50;

export interface ReceivedFile {
  readonly buffer: Buffer;
  readonly originalname: string;
  readonly size: number;
}

/** A CSV upload as the API returns it. */
export function uploadView(u: CsvUploadDocument) {
  return {
    id: String(u._id),
    filename: u.filename,
    rows: u.rows,
    columns: u.columns,
    phoneColumn: u.phoneColumn,
    createdAt: u.createdAt,
  };
}

/**
 * Audience and exclusion CSVs: checked (a phone column, a header, a size limit), stored in the blob store, and
 * read again by the audience build. Extra columns become variables (`csv:<column>`).
 */
@Injectable()
export class UploadsService {
  constructor(
    private readonly uploads: UploadsRepository,
    private readonly blobs: BlobStore,
  ) {}

  async storeCsv(file: ReceivedFile, actor: Actor): Promise<CsvUploadDocument> {
    let columns: string[] | undefined;
    let rows = 0;
    for await (const row of readCsv(Readable.from([file.buffer]))) {
      if (columns === undefined) {
        columns = row.map((c) => c.trim());
        continue;
      }
      rows += 1;
      if (rows > MAX_CSV_ROWS)
        throw new CsvInvalidError(`it has more than ${MAX_CSV_ROWS.toLocaleString('en-IN')} rows.`);
    }
    if (columns === undefined) throw new CsvInvalidError('it is empty.');
    if (columns.length > MAX_COLUMNS)
      throw new CsvInvalidError(`it has more than ${String(MAX_COLUMNS)} columns.`);
    if (columns.some((c) => c === '') || new Set(columns).size !== columns.length) {
      throw new CsvInvalidError('every column needs a name, and names must be different.');
    }
    const phoneColumn = guessPhoneColumn(columns);
    if (phoneColumn === undefined)
      throw new CsvInvalidError('no column looks like phone numbers (name one "phone").');
    if (rows === 0) throw new CsvInvalidError('it has no rows.');

    const blobKey = `uploads/${String(Date.now())}-${file.originalname.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)}`;
    await this.blobs.put(blobKey, file.buffer);
    return this.uploads.create({
      blobKey,
      filename: file.originalname.slice(0, 200),
      size: file.size,
      rows,
      columns,
      phoneColumn,
      createdBy: {
        service: actor.service,
        ...(actor.user === undefined ? {} : { userId: actor.user.id, email: actor.user.email }),
      },
    });
  }
}
