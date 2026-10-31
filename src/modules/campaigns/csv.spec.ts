import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { guessPhoneColumn, readCsv } from './csv.js';

async function rows(...chunks: string[]): Promise<string[][]> {
  const out: string[][] = [];
  for await (const row of readCsv(Readable.from(chunks.map((c) => Buffer.from(c))))) out.push(row);
  return out;
}

describe('readCsv', () => {
  it('reads rows and fields, with CRLF or LF line ends and blank lines skipped', async () => {
    expect(await rows('phone,name\r\n9876543210,Asha\n\n9876500000,Ravi\n')).toEqual([
      ['phone', 'name'],
      ['9876543210', 'Asha'],
      ['9876500000', 'Ravi'],
    ]);
  });

  it('handles quoted fields with commas, quotes and line breaks, even across chunks', async () => {
    expect(await rows('a,b\n"Delhi, India","He said ""hi""', '","line\nbreak"\n')).toEqual([
      ['a', 'b'],
      ['Delhi, India', 'He said "hi"', 'line\nbreak'],
    ]);
  });

  it("drops Excel's byte-order mark and reads a last row without a line end", async () => {
    expect(await rows('﻿phone\n9876543210')).toEqual([['phone'], ['9876543210']]);
  });

  it('keeps empty fields', async () => {
    expect(await rows('a,b,c\n1,,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });
});

describe('guessPhoneColumn', () => {
  it.each([
    [['Name', 'Phone'], 'Phone'],
    [['mobile number', 'city'], 'mobile number'],
    [['name', 'WhatsApp No'], 'WhatsApp No'],
    [['name', 'city'], undefined],
  ])('%j → %s', (columns, expected) => {
    expect(guessPhoneColumn(columns)).toBe(expected);
  });
});
