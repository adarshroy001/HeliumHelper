import { describe, expect, it } from 'vitest';
import {
  buildTemplatePayload,
  extractTemplateVariables,
  headerMediaType,
  mappingProblem,
  quickReplyButtons,
  renderTemplate,
  resolveParams,
  type TemplateComponent,
  type VariableMapping,
} from './template.js';

const offer: TemplateComponent[] = [
  { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}', example: { header_text: ['Asha'] } },
  {
    type: 'BODY',
    text: '{{1}}, your {{2}} offer ends soon. {{1}}!',
    example: { body_text: [['Asha', 'Diwali']] },
  },
  {
    type: 'BUTTONS',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Yes' },
      { type: 'URL', text: 'Shop', url: 'https://heliumair.in/{{1}}', example: ['sale'] },
      { type: 'QUICK_REPLY', text: ' No ' },
    ],
  },
];

// A CSV column is a `field` source with a `csv:` value, as HeliumAdmin stores it.
const mapping: VariableMapping[] = [
  { component: 'HEADER', index: 1, source: 'field', value: 'name' },
  { component: 'BODY', index: 1, source: 'field', value: 'name' },
  { component: 'BODY', index: 2, source: 'field', value: 'csv:offer' },
  { component: 'BUTTONS', buttonIndex: 1, index: 1, source: 'static', value: 'diwali' },
];

describe('extractTemplateVariables', () => {
  it('finds header, body and URL-button placeholders once each, with examples', () => {
    expect(extractTemplateVariables(offer)).toEqual([
      { component: 'HEADER', index: 1, example: 'Asha', label: 'Header {{1}}' },
      { component: 'BODY', index: 1, example: 'Asha', label: 'Body {{1}}' },
      { component: 'BODY', index: 2, example: 'Diwali', label: 'Body {{2}}' },
      { component: 'BUTTONS', index: 1, buttonIndex: 1, example: 'sale', label: 'Button 2 {{1}}' },
    ]);
  });

  it('ignores media headers and copes with no components', () => {
    expect(extractTemplateVariables([{ type: 'HEADER', format: 'IMAGE' }])).toEqual([]);
    expect(extractTemplateVariables(undefined)).toEqual([]);
  });
});

describe('mappingProblem', () => {
  const variables = extractTemplateVariables(offer);

  it('accepts a complete mapping', () => {
    expect(mappingProblem(variables, mapping)).toBeNull();
  });

  it.each([
    [mapping.slice(1), 'Header {{1}} is not mapped'],
    [
      [
        ...mapping.slice(0, 3),
        { component: 'BUTTONS', buttonIndex: 1, index: 1, source: 'static', value: ' ' },
      ],
      'Button 2 {{1}} has an empty value',
    ],
    [
      [{ component: 'HEADER', index: 1, source: 'field', value: 'orderId' }, ...mapping.slice(1)],
      'Header {{1}} uses an unknown field',
    ],
    [
      [{ component: 'HEADER', index: 1, source: 'field', value: 'csv:' }, ...mapping.slice(1)],
      'Header {{1}} uses an unknown field',
    ],
  ] as [VariableMapping[], string][])('reports %#', (mappings, problem) => {
    expect(mappingProblem(variables, mappings)).toBe(problem);
  });
});

describe('resolveParams', () => {
  const variables = extractTemplateVariables(offer);

  it('fills values from fields, CSV columns and static text', () => {
    expect(resolveParams(variables, mapping, { name: ' Asha ', csv: { offer: 'Diwali' } })).toEqual({
      header: ['Asha'],
      body: ['Asha', 'Diwali'],
      buttons: [{ index: 1, parameters: ['diwali'] }],
    });
  });

  it('falls back to "Customer" for missing values and unmapped placeholders', () => {
    expect(resolveParams(variables, mapping.slice(0, 1), {})).toEqual({
      header: ['Customer'],
      body: ['Customer', 'Customer'],
      buttons: [{ index: 1, parameters: ['Customer'] }],
    });
  });

  it('fills gaps when a template skips a number', () => {
    const gappy = extractTemplateVariables([{ type: 'BODY', text: '{{1}} and {{3}}' }]);
    const params = resolveParams(
      gappy,
      [{ component: 'BODY', index: 3, source: 'static', value: 'three' }],
      {},
    );
    expect(params.body).toEqual(['Customer', 'Customer', 'three']);
  });
});

describe('buildTemplatePayload', () => {
  const params = {
    header: ['Asha'],
    body: ['Asha', 'Diwali'],
    buttons: [{ index: 1, parameters: ['diwali'] }],
  };

  it('builds text header, body and URL button parameters', () => {
    expect(buildTemplatePayload({ name: 'offer', language: 'en', params })).toEqual({
      name: 'offer',
      language: { code: 'en' },
      components: [
        { type: 'header', parameters: [{ type: 'text', text: 'Asha' }] },
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Asha' },
            { type: 'text', text: 'Diwali' },
          ],
        },
        { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'diwali' }] },
      ],
    });
  });

  it('uses the media header instead of text parameters, and omits empty components', () => {
    expect(
      buildTemplatePayload({
        name: 'promo',
        language: 'en_US',
        params: { header: [], body: [], buttons: [] },
        headerMedia: { type: 'image', id: 'media-1' },
      }),
    ).toEqual({
      name: 'promo',
      language: { code: 'en_US' },
      components: [{ type: 'header', parameters: [{ type: 'image', image: { id: 'media-1' } }] }],
    });
    expect(
      buildTemplatePayload({ name: 'hello', language: 'en', params: { header: [], body: [], buttons: [] } }),
    ).toEqual({
      name: 'hello',
      language: { code: 'en' },
    });
  });
});

describe('template details', () => {
  it('renders a preview with the values filled in', () => {
    const params = { header: ['Asha'], body: ['Asha', 'Diwali'], buttons: [] };
    expect(renderTemplate(offer, params)).toEqual({
      header: 'Hi Asha',
      body: 'Asha, your Diwali offer ends soon. Asha!',
    });
  });

  it('reads the header media type and the quick-reply options', () => {
    expect(headerMediaType([{ type: 'HEADER', format: 'VIDEO' }])).toBe('video');
    expect(headerMediaType(offer)).toBeNull();
    expect(quickReplyButtons(offer)).toEqual(['Yes', 'No']);
  });
});
