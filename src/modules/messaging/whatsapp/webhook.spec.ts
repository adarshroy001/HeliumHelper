import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isValidSignature, splitWebhook } from './webhook.js';

const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
const sign = (secret: string, bytes = body) =>
  `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;

describe('isValidSignature', () => {
  const secrets = ['current-secret-0123456789', 'previous-secret-0123456789'];

  it('accepts a signature from the current or the previous secret', () => {
    expect(isValidSignature(body, sign(secrets[0] ?? ''), secrets)).toBe(true);
    expect(isValidSignature(body, sign(secrets[1] ?? ''), secrets)).toBe(true);
    expect(
      isValidSignature(
        body,
        sign(secrets[0] ?? '')
          .toUpperCase()
          .replace('SHA256=', 'sha256='),
        secrets,
      ),
    ).toBe(true);
  });

  it.each([
    ['a missing header', undefined],
    ['another secret', sign('some-other-secret-0123456789')],
    ['a changed body', sign('current-secret-0123456789', Buffer.from(`${body.toString()} `))],
    ['no prefix', createHmac('sha256', 'current-secret-0123456789').update(body).digest('hex')],
    ['a short digest', 'sha256=abcd'],
  ])('rejects %s', (_case, header) => {
    expect(isValidSignature(body, header, secrets)).toBe(false);
  });
});

const at = new Date('2026-10-31T10:00:00.000Z');
const metadata = { display_phone_number: '15550001111', phone_number_id: '222' };

describe('splitWebhook', () => {
  it('routes statuses, inbound messages and account fields to their queues', () => {
    const result = splitWebhook(
      {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'waba-1',
            changes: [
              { field: 'messages', value: { metadata, statuses: [{ id: 'wamid.1', status: 'sent' }] } },
              {
                field: 'messages',
                value: { metadata, messages: [{ id: 'wamid.in', from: '919876543210' }] },
              },
              { field: 'message_template_status_update', value: { event: 'PAUSED', message_template_id: 9 } },
            ],
          },
        ],
      },
      at,
    );

    expect(result).toEqual({
      ok: true,
      changes: [
        {
          route: 'status',
          change: {
            receivedAt: '2026-10-31T10:00:00.000Z',
            wabaId: 'waba-1',
            phoneNumberId: '222',
            field: 'messages',
            value: { metadata, statuses: [{ id: 'wamid.1', status: 'sent' }] },
          },
        },
        {
          route: 'inbound',
          change: expect.objectContaining({ phoneNumberId: '222', field: 'messages' }) as unknown,
        },
        {
          route: 'account',
          change: {
            receivedAt: '2026-10-31T10:00:00.000Z',
            wabaId: 'waba-1',
            field: 'message_template_status_update',
            value: { event: 'PAUSED', message_template_id: 9 },
          },
        },
      ],
    });
  });

  it('sends a change with both statuses and messages to both queues', () => {
    const result = splitWebhook(
      {
        object: 'whatsapp_business_account',
        entry: [
          { id: 'w', changes: [{ field: 'messages', value: { metadata, statuses: [], messages: [] } }] },
        ],
      },
      at,
    );

    expect(result.ok && result.changes.map((c) => c.route)).toEqual(['status', 'inbound']);
  });

  it.each([
    ['not an object', 'hello'],
    ['another product', { object: 'page', entry: [] }],
    ['entries without changes', { object: 'whatsapp_business_account', entry: [{ id: 'w' }] }],
  ])('refuses %s', (_case, payload) => {
    expect(splitWebhook(payload, at)).toMatchObject({ ok: false });
  });
});
