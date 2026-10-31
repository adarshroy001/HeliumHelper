/**
 * Indian WhatsApp numbers, as HeliumAdmin normalizes them: the canonical form is `91` + 10 digits starting 6–9,
 * with no `+` (`919876543210`). Every phone stored or sent by the messaging module is in this form.
 */

const MOBILE = /^[6-9]\d{9}$/;

/** `+91 98765-43210`, `09876543210`, `9876543210` → `919876543210`; anything else → `null`. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = raw.replace(/\D/g, '');
  let ten: string | null = null;
  if (digits.length === 10) ten = digits;
  else if (digits.length === 11 && digits.startsWith('0')) ten = digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('91')) ten = digits.slice(2);
  else if (digits.length === 13 && digits.startsWith('091')) ten = digits.slice(3);
  return ten !== null && MOBILE.test(ten) ? `91${ten}` : null;
}

/** The forms a number may be stored in, in the main database's users and orders, for lookups. */
export function phoneLookupVariants(normalized: string): string[] {
  const ten = normalized.slice(-10);
  return [...new Set([normalized, ten, `+${normalized}`, `+91${ten}`, `0${ten}`])];
}

/**
 * Splits pasted text or a one-column CSV into unique normalized phones. A `phone` header is ignored;
 * anything that isn't a valid number is returned in `invalid`.
 */
export function parsePhoneList(raw: string): { phones: string[]; invalid: string[] } {
  const phones = new Set<string>();
  const invalid: string[] = [];
  for (const token of raw.split(/[\s,;|]+/)) {
    if (token === '' || /^phone$/i.test(token)) continue;
    const phone = normalizePhone(token);
    if (phone === null) invalid.push(token);
    else phones.add(phone);
  }
  return { phones: [...phones], invalid };
}
