import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { BlobStore } from '../../../infrastructure/blob/index.js';
import {
  buildTemplatePayload,
  type CampaignRecipient,
  DeliveryLedger,
  extractTemplateVariables,
  normalizePhone,
  type RecipientFields,
  resolveParams,
  SuppressionsService,
} from '../../messaging/index.js';
import type { CampaignDocument, CampaignTotals } from '../campaign.schema.js';
import { UploadNotFoundError } from '../campaigns.errors.js';
import { CampaignsRepository, UploadsRepository } from '../campaigns.repository.js';
import { readCsv } from '../csv.js';
import { AudienceSourcesRepository, type SourceRecord } from './audience-sources.repository.js';

/** Recipients written per round trip, and the fastest the main database is read (documents a second). */
const BATCH = 1000;
const MAX_READS_PER_SECOND = 5000;
const HEARTBEAT_MS = 30_000;

/** Someone a source names, before their phone is checked, with what their message is personalized with. */
interface Candidate {
  readonly phone: unknown;
  readonly name?: string;
  readonly email?: string;
  readonly city?: string;
  readonly csv?: Readonly<Record<string, string>>;
  readonly userId?: string;
}

/**
 * Turns a campaign's audience into pending deliveries (design.md#build). Sources are read in HeliumAdmin's
 * priority order (CSV, users, orders, carts, waitlist, individual, then an earlier campaign); the first source to
 * name a phone gives its details, because the ledger keeps one delivery per phone. Exclusions, suppressions and
 * the frequency cap are applied per batch. Running it again after a crash adds only what's missing.
 */
@Injectable()
export class AudienceBuilder {
  constructor(
    private readonly sources: AudienceSourcesRepository,
    private readonly uploads: UploadsRepository,
    private readonly campaigns: CampaignsRepository,
    private readonly ledger: DeliveryLedger,
    private readonly suppressions: SuppressionsService,
    private readonly blobs: BlobStore,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(AudienceBuilder.name);
  }

  /** Builds the audience; returns the totals and skipped counts. */
  async build(campaign: CampaignDocument): Promise<CampaignTotals> {
    const id = String(campaign._id);
    const { options, template, variableMapping } = campaign;
    const variables = extractTemplateVariables(template.components);
    const excluded = await this.exclusions(campaign);
    const capSince =
      options.frequencyCapHours > 0 ? new Date(Date.now() - options.frequencyCapHours * 3_600_000) : null;
    const skipped = { invalid: 0, suppressed: 0, duplicate: 0, frequency: 0, excluded: 0 };
    let valid = 0;
    let processed = 0;
    let lastBeat = Date.now();
    let batch: (Candidate & RecipientFields & { phone: string })[] = [];

    const flush = async () => {
      const phones = [...new Set(batch.map((c) => c.phone))];
      const suppressed = await this.suppressions.suppressedAmong(phones);
      const recent =
        capSince === null ? new Set<string>() : await this.ledger.recentlyMessaged(phones, capSince);
      const seen = new Set<string>();
      const recipients: CampaignRecipient[] = [];
      for (const c of batch) {
        if (suppressed.has(c.phone)) skipped.suppressed += 1;
        else if (recent.has(c.phone)) skipped.frequency += 1;
        else if (seen.has(c.phone)) skipped.duplicate += 1;
        else {
          seen.add(c.phone);
          const params = resolveParams(variables, variableMapping, c);
          recipients.push({
            to: c.phone,
            ...(c.name ? { name: c.name } : {}),
            ...(c.userId === undefined ? {} : { userId: c.userId }),
            template: buildTemplatePayload({ name: template.name, language: template.language, params }),
          });
        }
      }
      if (recipients.length > 0) {
        valid += recipients.length;
        const first = await this.campaigns.reserveSeq(id, recipients.length);
        await this.ledger.addCampaignRecipients(id, first, recipients);
      }
      batch = [];
      if (Date.now() - lastBeat > HEARTBEAT_MS) {
        lastBeat = Date.now();
        await this.campaigns.heartbeat(id, processed);
      }
    };

    for await (const candidate of this.candidates(campaign)) {
      processed += 1;
      // Stored as text, sometimes as a number.
      const raw = candidate.phone;
      const phone = normalizePhone(
        typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : null,
      );
      if (phone === null) skipped.invalid += 1;
      else if (excluded.has(phone)) skipped.excluded += 1;
      else batch.push({ ...candidate, phone });
      if (batch.length >= BATCH) await flush();
    }
    await flush();

    const total = await this.ledger.countCampaign(id);
    // Duplicates across batches are refused by the ledger: whatever valid rows didn't become deliveries.
    skipped.duplicate += Math.max(0, valid - total);
    this.logger.info({ campaignId: id, total, skipped, processed }, 'audience built');
    return { total, skipped };
  }

  /** Every candidate, source by source, in priority order. */
  private async *candidates(campaign: CampaignDocument): AsyncGenerator<Candidate> {
    const { audience } = campaign;
    if (audience.csvUploadId !== undefined) yield* this.csvRows(audience.csvUploadId);
    for (const type of ['users', 'orders', 'abandoned_carts', 'waitlist'] as const) {
      const source = audience.sources.find((s) => s.type === type);
      if (source !== undefined) yield* this.throttled(this.sources.stream(source));
    }
    for (const contact of audience.individual) {
      yield {
        phone: contact.phone,
        name: contact.name,
        ...(contact.email === undefined ? {} : { email: contact.email }),
      };
    }
    if (audience.retarget !== undefined) {
      const { campaignId, outcome, button } = audience.retarget;
      for await (const r of this.ledger.campaignRecipients(campaignId, outcome, button)) {
        yield {
          phone: r.to,
          ...(r.name === undefined ? {} : { name: r.name }),
          ...(r.userId === undefined ? {} : { userId: r.userId }),
        };
      }
    }
  }

  /** Reads from the main database no faster than MAX_READS_PER_SECOND, so checkout never feels a campaign. */
  private async *throttled(records: AsyncGenerator<SourceRecord>): AsyncGenerator<Candidate> {
    let count = 0;
    let windowStart = Date.now();
    for await (const record of records) {
      yield record;
      count += 1;
      if (count % 1000 === 0) {
        const minimum = (1000 / MAX_READS_PER_SECOND) * 1000;
        const elapsed = Date.now() - windowStart;
        if (elapsed < minimum) await new Promise((resolve) => setTimeout(resolve, minimum - elapsed));
        windowStart = Date.now();
      }
    }
  }

  /** CSV rows: the phone column, name/email/city when present, and every column as a `csv:` variable. */
  private async *csvRows(uploadId: string): AsyncGenerator<Candidate> {
    const upload = await this.uploads.findById(uploadId);
    if (upload === null) throw new UploadNotFoundError(uploadId);
    let header: string[] | undefined;
    for await (const row of readCsv(this.blobs.open(upload.blobKey))) {
      if (header === undefined) {
        header = row.map((c) => c.trim());
        continue;
      }
      const csv = Object.fromEntries(header.map((column, i) => [column, (row[i] ?? '').trim()]));
      const field = (name: string) => {
        const column = header?.find((c) => c.toLowerCase() === name);
        const value = column === undefined ? '' : (csv[column] ?? '');
        return value === '' ? undefined : value;
      };
      const name = field('name');
      const email = field('email');
      const city = field('city');
      yield {
        phone: csv[upload.phoneColumn] ?? '',
        csv,
        ...(name === undefined ? {} : { name }),
        ...(email === undefined ? {} : { email }),
        ...(city === undefined ? {} : { city }),
      };
    }
  }

  /** Phones to leave out: the pasted list and the exclusion CSV's phone column. */
  private async exclusions(campaign: CampaignDocument): Promise<Set<string>> {
    const { exclusions } = campaign.audience;
    // Each entry is one phone, possibly written with spaces (`98700 00002`): normalize it as it is.
    const phones = new Set(
      (exclusions?.phones ?? []).map((p) => normalizePhone(p)).filter((p): p is string => p !== null),
    );
    if (exclusions?.uploadId !== undefined) {
      const upload = await this.uploads.findById(exclusions.uploadId);
      if (upload === null) throw new UploadNotFoundError(exclusions.uploadId);
      let header: string[] | undefined;
      for await (const row of readCsv(this.blobs.open(upload.blobKey))) {
        if (header === undefined) {
          header = row;
          continue;
        }
        const phone = normalizePhone(row[header.indexOf(upload.phoneColumn)] ?? '');
        if (phone !== null) phones.add(phone);
      }
    }
    return phones;
  }
}
