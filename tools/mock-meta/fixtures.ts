// Templates mock-meta serves from /{waba}/message_templates: one of each shape the campaign code handles.

export interface MockTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  quality_score: { score: string };
  components: Record<string, unknown>[];
}

export const DEFAULT_TEMPLATES: MockTemplate[] = [
  {
    id: '900000000000001',
    name: 'diwali_offer',
    language: 'en',
    status: 'APPROVED',
    category: 'MARKETING',
    quality_score: { score: 'GREEN' },
    components: [
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://example.test/h.jpg'] } },
      {
        type: 'BODY',
        text: 'Hi {{1}}, our Diwali sale is live: {{2}} off on Helium air purifiers.',
        example: { body_text: [['Asha', '20%']] },
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Shop now', url: 'https://heliumair.in/{{1}}', example: ['diwali'] },
          { type: 'QUICK_REPLY', text: 'Stop promotions' },
        ],
      },
    ],
  },
  {
    id: '900000000000002',
    name: 'purifier_poll',
    language: 'en',
    status: 'APPROVED',
    category: 'MARKETING',
    quality_score: { score: 'GREEN' },
    components: [
      { type: 'BODY', text: 'Hi {{1}}, which room needs cleaner air?', example: { body_text: [['Asha']] } },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Bedroom' },
          { type: 'QUICK_REPLY', text: 'Living room' },
          { type: 'QUICK_REPLY', text: 'Office' },
        ],
      },
    ],
  },
  {
    id: '900000000000003',
    name: 'service_reminder',
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    quality_score: { score: 'UNKNOWN' },
    components: [
      {
        type: 'HEADER',
        format: 'TEXT',
        text: 'Filter reminder for {{1}}',
        example: { header_text: ['Asha'] },
      },
      {
        type: 'BODY',
        text: 'Your filter was installed on {{1}}. Time for a change.',
        example: { body_text: [['1 May']] },
      },
    ],
  },
  {
    id: '900000000000004',
    name: 'thank_you',
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    quality_score: { score: 'UNKNOWN' },
    components: [{ type: 'BODY', text: 'Thank you for your reply!' }],
  },
  {
    id: '900000000000005',
    name: 'old_promo',
    language: 'en',
    status: 'PAUSED',
    category: 'MARKETING',
    quality_score: { score: 'RED' },
    components: [{ type: 'BODY', text: 'Last chance!' }],
  },
];
