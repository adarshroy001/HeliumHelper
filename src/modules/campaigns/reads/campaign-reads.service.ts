import { Inject, Injectable } from '@nestjs/common';
import { whatsappConfig, type WhatsappConfig } from '../../../config/index.js';
import {
  CampaignCounters,
  CampaignInsights,
  DeliveryLedger,
  quickReplyButtons,
} from '../../messaging/index.js';
import type { CampaignDocument } from '../campaign.schema.js';
import type { ListDeliveriesQuery, ListRepliesQuery } from '../campaigns.schemas.js';
import { inFlight } from '../lifecycle/campaign-sweeper.service.js';

const COUNTED = [
  'total',
  'fed',
  'accepted',
  'sent',
  'delivered',
  'read',
  'failed',
  'skipped',
  'replied',
  'optedOut',
] as const;
const ratio = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0);

/**
 * What HeliumAdmin shows about a campaign (docs/modules/messaging/api.md#campaigns): live stats from the Redis
 * counters (the snapshot once closed), the recipients table, and replies with poll results.
 */
@Injectable()
export class CampaignReadsService {
  constructor(
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly counters: CampaignCounters,
    private readonly insights: CampaignInsights,
    private readonly ledger: DeliveryLedger,
  ) {}

  async stats(campaign: CampaignDocument) {
    const id = String(campaign._id);
    const raw = campaign.status === 'closed' ? (campaign.countsSnapshot ?? {}) : await this.counters.read(id);
    const counts = Object.fromEntries(COUNTED.map((field) => [field, raw[field] ?? 0])) as Record<
      (typeof COUNTED)[number],
      number
    >;
    counts.total = campaign.totals?.total ?? counts.total;
    const remaining = Math.max(0, counts.total - (counts.accepted + counts.failed + counts.skipped));
    const rate = Math.min(this.config.account.maxMps, campaign.options.maxMps ?? Number.POSITIVE_INFINITY);
    const { prices } = this.config;
    const price = (category: string) =>
      (prices as unknown as Record<string, number | undefined>)[category.toLowerCase()] ?? 0;
    const billed = Object.entries(raw).filter(([field]) => field.startsWith('billable:'));

    return {
      status: campaign.status,
      waiting: campaign.status === 'sending' ? await this.insights.waitingReason(id) : null,
      counts,
      inFlight: Math.max(0, inFlight(raw)),
      rates: {
        delivered: ratio(counts.delivered, counts.accepted),
        read: ratio(counts.read, counts.delivered),
        replied: ratio(counts.replied, counts.delivered),
        failed: ratio(counts.failed, counts.accepted + counts.failed),
      },
      etaSeconds: campaign.status === 'sending' && remaining > 0 ? Math.ceil(remaining / rate) : null,
      cost: {
        currency: prices.currency,
        estimated: Math.round(counts.total * price(campaign.template.category) * 100) / 100,
        actual:
          Math.round(
            billed.reduce((sum, [field, n]) => sum + n * price(field.slice('billable:'.length)), 0) * 100,
          ) / 100,
      },
      buttons: await this.buttons(campaign),
    };
  }

  async deliveries(campaign: CampaignDocument, query: ListDeliveriesQuery) {
    const rows = await this.ledger.listCampaign(
      String(campaign._id),
      {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.reply === undefined
          ? {}
          : {
              reply:
                query.reply === 'any' || query.reply === 'none'
                  ? query.reply
                  : { button: query.reply.slice('button:'.length) },
            }),
        ...(query.q === undefined ? {} : { phoneEndsWith: query.q }),
      },
      query.after,
      query.limit + 1,
    );
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((d) => ({
        id: String(d._id),
        seq: d.seq,
        phone: d.to,
        name: d.name ?? null,
        status: d.status,
        sentAt: d.sentAt ?? null,
        deliveredAt: d.deliveredAt ?? null,
        readAt: d.readAt ?? null,
        failedAt: d.failedAt ?? null,
        error: d.error ?? null,
        skipReason: d.skipReason ?? null,
        reply: d.reply ?? null,
      })),
      nextAfter: rows.length > query.limit ? (page.at(-1)?.seq ?? null) : null,
    };
  }

  async replies(campaign: CampaignDocument, query: ListRepliesQuery) {
    const rows = await this.insights.replies(String(campaign._id), query.before, query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      buttons: await this.buttons(campaign),
      items: page.map((m) => ({
        id: m._id,
        from: m.from,
        name: m.name ?? null,
        type: m.type,
        text: m.text ?? null,
        button: m.button ?? null,
        receivedAt: m.receivedAt,
      })),
      nextBefore: rows.length > query.limit ? (page.at(-1)?.receivedAt ?? null) : null,
    };
  }

  /** Poll results: every quick-reply button of the template (zero when untapped), plus any other button tapped. */
  private async buttons(campaign: CampaignDocument) {
    const tallies = await this.insights.buttonTallies(String(campaign._id));
    const options = quickReplyButtons(campaign.template.components);
    const all = [...new Set([...options, ...Object.keys(tallies)])];
    const total = Object.values(tallies).reduce((sum, n) => sum + n, 0);
    return {
      total,
      options: all.map((label) => ({
        label,
        votes: tallies[label] ?? 0,
        share: ratio(tallies[label] ?? 0, total),
      })),
    };
  }
}
