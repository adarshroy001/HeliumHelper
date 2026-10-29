/**
 * Masks a phone number for logs, keeping the country code (when written with `+`) and the last 4 digits:
 * `+919876543210` → `+91******3210`, `9876543210` → `******3210`. Anything too short to mask safely
 * becomes `****`. Use it whenever a phone number would otherwise appear in a log line (CONVENTIONS R13).
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '****';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) return '****';

  const last4 = digits.slice(-4);
  if (phone.trim().startsWith('+') && digits.length > 10) {
    const country = digits.slice(0, digits.length - 10);
    return `+${country}${'*'.repeat(6)}${last4}`;
  }
  return `${'*'.repeat(digits.length - 4)}${last4}`;
}
