import type { Readable } from 'node:stream';

/**
 * Reads CSV rows from a stream, one array of fields per row, without holding the file in memory. Handles quoted
 * fields with commas, quotes ("") and line breaks, CRLF or LF line ends, and a UTF-8 BOM (Excel's exports).
 * Blank lines are skipped.
 */
export async function* readCsv(source: Readable): AsyncGenerator<string[]> {
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let afterQuote = false;
  let first = true;

  const endRow = function* (): Generator<string[]> {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') yield row;
    row = [];
  };

  for await (const chunk of source) {
    let text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    if (first) {
      text = text.replace(/^\uFEFF/, '');
      first = false;
    }
    for (let i = 0; i < text.length; i += 1) {
      const char = text.charAt(i);
      if (quoted) {
        if (char !== '"') field += char;
        else if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
        continue;
      }
      if (char === '"' && field === '' && !afterQuote) quoted = true;
      else if (char === ',') {
        row.push(field);
        field = '';
        afterQuote = false;
      } else if (char === '\n') {
        yield* endRow();
        afterQuote = false;
      } else if (char !== '\r') field += char;
    }
  }
  if (field !== '' || row.length > 0) yield* endRow();
}

/** Header names that hold phone numbers, best first. */
const PHONE_HEADERS = ['phone', 'mobile', 'whatsapp', 'phone number', 'mobile number', 'number', 'contact'];

/** The column most likely to hold phone numbers, or `undefined`. */
export function guessPhoneColumn(columns: readonly string[]): string | undefined {
  const normalized = columns.map((c) => c.trim().toLowerCase());
  for (const name of PHONE_HEADERS) {
    const index = normalized.indexOf(name);
    if (index !== -1) return columns[index];
  }
  return columns.find((c) => /phone|mobile|whatsapp/i.test(c));
}
