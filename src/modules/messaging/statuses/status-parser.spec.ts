import { describe, expect, it, vi } from 'vitest';
import { deliveryRef, parseDeliveryRef } from './delivery-ref.js';
import { parseStatuses } from './status-parser.js';
import { StatusConsumer } from './status.consumer.js';
import type { StatusService } from './status.service.js';

const campaign = '6650c1f2a1b2c3d4e5f60718';
const delivery = '6650c1f2a1b2c3d4e5f60719';

describe('delivery references', () => {
  it('round-trips with and without a campaign, with or without the d: prefix', () => {
    expect(parseDeliveryRef(deliveryRef(delivery, campaign))).toEqual({
      deliveryId: delivery,
      campaignId: campaign,
    });
    expect(parseDeliveryRef(deliveryRef('ar-0123abcd'))).toEqual({ deliveryId: 'ar-0123abcd' });
    expect(parseDeliveryRef(`${delivery}:${campaign}`)).toEqual({
      deliveryId: delivery,
      campaignId: campaign,
    });
  });

  it.each([null, undefined, '', 'order:123:456', 'd:a b'])('rejects %s', (value) => {
    expect(parseDeliveryRef(value)).toBeNull();
  });
});

describe('parseStatuses', () => {
  it('reads statuses with their time, reference, error and pricing', () => {
    const { statuses, ignored } = parseStatuses({
      statuses: [
        {
          id: 'wamid.1',
          status: 'sent',
          timestamp: '1761904800',
          biz_opaque_callback_data: `d:${delivery}:${campaign}`,
          pricing: { billable: true, category: 'marketing', pricing_model: 'PMP' },
        },
        {
          id: 'wamid.2',
          status: 'failed',
          timestamp: '1761904801',
          errors: [
            { code: 131026, title: 'Message undeliverable', error_data: { details: 'Not on WhatsApp' } },
          ],
        },
        { id: 'wamid.3', status: 'deleted', timestamp: '1761904802' },
        { status: 'read' },
      ],
    });

    expect(ignored).toBe(2);
    expect(statuses).toEqual([
      expect.objectContaining({
        wamid: 'wamid.1',
        status: 'sent',
        at: new Date(1761904800_000),
        ref: { deliveryId: delivery, campaignId: campaign },
        pricing: { billable: true, category: 'marketing' },
      }),
      expect.objectContaining({
        wamid: 'wamid.2',
        status: 'failed',
        ref: null,
        error: { code: 131026, title: 'Not on WhatsApp', at: new Date(1761904801_000) },
      }),
    ]);
  });

  it('copes with a change without statuses', () => {
    expect(parseStatuses({ messages: [] })).toEqual({ statuses: [], ignored: 0 });
  });
});

describe('StatusConsumer', () => {
  const unmatchedStatus = { wamid: 'wamid.x', status: 'sent' as const, at: new Date(), ref: null, raw: {} };
  const recordUnmatched = vi.fn(() => Promise.resolve());
  const service = () =>
    ({
      correlate: vi.fn(() => Promise.resolve({ matched: [], unmatched: [unmatchedStatus] })),
      apply: vi.fn(() => Promise.resolve()),
      recordUnmatched,
    }) as unknown as StatusService;
  const logger = { setContext: vi.fn(), debug: vi.fn(), info: vi.fn() };
  const data = {
    receivedAt: new Date().toISOString(),
    wabaId: '1',
    field: 'messages',
    value: { statuses: [] },
  };
  const envelope = {} as never;

  it('retries an unmatched status in 30 s, a few times', async () => {
    recordUnmatched.mockClear();
    const statuses = service();
    const consumer = new StatusConsumer(statuses, logger as never);

    expect(await consumer.handle(data, { envelope, receiveCount: 4 })).toEqual({
      action: 'retry',
      delaySeconds: 30,
    });
    expect(recordUnmatched).not.toHaveBeenCalled();
  });

  it('then records it as unmatched and acks', async () => {
    const statuses = service();
    const consumer = new StatusConsumer(statuses, logger as never);

    expect(await consumer.handle(data, { envelope, receiveCount: 5 })).toEqual({ action: 'ack' });
    expect(recordUnmatched).toHaveBeenCalledWith([unmatchedStatus], undefined);
  });
});
