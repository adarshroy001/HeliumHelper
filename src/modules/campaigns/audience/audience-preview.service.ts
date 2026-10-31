import { Injectable } from '@nestjs/common';
import {
  extractTemplateVariables,
  normalizePhone,
  renderTemplate,
  resolveParams,
  type TemplateComponent,
  TemplatesService,
  type VariableMapping,
} from '../../messaging/index.js';
import type { CampaignAudience } from '../campaigns.schemas.js';
import { UploadsRepository } from '../campaigns.repository.js';
import { AudienceSourcesRepository } from './audience-sources.repository.js';

/** How long each count may take before it is reported as unknown. */
const COUNT_MS = 5_000;

/** HeliumAdmin's fixed filter values (`src/lib/whatsapp/types.ts`). */
const FIXED_OPTIONS = {
  orderStatuses: [
    'pending',
    'confirmed',
    'processing',
    'shipped',
    'delivered',
    'cancelled',
    'refunded',
    'notManifested',
    'manifested',
    'intransit',
    'orderCancelled',
    'replacement',
  ],
  paymentStatuses: ['pending', 'paid', 'failed', 'refund_initiated', 'refunded'],
  paymentMethods: ['razorpay', 'gokwik', 'snapmint'],
  channels: ['d2c', 'dealer', 'amazon'],
  deliveryPartners: ['delhivery', 'shadowfax'],
};

/**
 * A quick look at an audience before building it: how many each source matches (an upper bound: people in
 * several sources are counted in each; the build gives the exact total), and one sample message.
 */
@Injectable()
export class AudiencePreviewService {
  constructor(
    private readonly sources: AudienceSourcesRepository,
    private readonly uploads: UploadsRepository,
    private readonly templates: TemplatesService,
  ) {}

  async preview(
    audience: CampaignAudience,
    template?: { templateId: string; variableMapping: VariableMapping[] },
  ) {
    const counts = await Promise.all(
      audience.sources.map(async (s) => [s.type, await this.sources.count(s, COUNT_MS)] as const),
    );
    const csv = audience.csvUploadId === undefined ? null : await this.uploads.findById(audience.csvUploadId);
    const breakdown: Record<string, number | null> = {
      ...Object.fromEntries(counts),
      ...(csv === null ? {} : { csv: csv.rows }),
      ...(audience.individual.length > 0 ? { individual: audience.individual.length } : {}),
    };
    const known = Object.values(breakdown).filter((n): n is number => n !== null);
    return {
      breakdown,
      /** At most this many before de-duplication, exclusions, suppressions and the frequency cap. */
      upperBound: known.reduce((sum, n) => sum + n, 0),
      complete: known.length === Object.keys(breakdown).length,
      excluded: audience.exclusions?.phones?.length ?? 0,
      sample: template === undefined ? null : await this.sample(audience, template),
    };
  }

  options() {
    return this.sources.options(COUNT_MS).then((found) => ({ ...FIXED_OPTIONS, ...found }));
  }

  /** The message one recipient would get: the first person of the first source, or a placeholder. */
  private async sample(
    audience: CampaignAudience,
    { templateId, variableMapping }: { templateId: string; variableMapping: VariableMapping[] },
  ) {
    const template = await this.templates.findById(templateId);
    if (template === null) return null;
    const components = template.components as TemplateComponent[];
    let person: { phone: string; name?: string; email?: string; city?: string } = {
      phone: '919876543210',
      name: 'Customer',
    };
    const first =
      audience.individual[0] ??
      (audience.sources[0] === undefined ? undefined : await this.firstOf(audience.sources[0]));
    const phone = first === undefined ? null : normalizePhone(first.phone);
    if (first !== undefined && phone !== null) person = { ...first, phone };
    const params = resolveParams(extractTemplateVariables(components), variableMapping, person);
    return { phone: person.phone, name: person.name ?? null, ...renderTemplate(components, params) };
  }

  private async firstOf(source: CampaignAudience['sources'][number]) {
    for await (const record of this.sources.stream(source)) {
      return {
        phone: String(record.phone),
        ...(record.name === undefined ? {} : { name: record.name }),
        ...(record.email === undefined ? {} : { email: record.email }),
        ...(record.city === undefined ? {} : { city: record.city }),
      };
    }
    return undefined;
  }
}
