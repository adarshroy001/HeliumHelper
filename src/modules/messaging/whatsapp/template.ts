/**
 * Template helpers, ported from HeliumAdmin's `src/lib/whatsapp/template.ts`: find the `{{N}}` placeholders,
 * resolve each recipient's values from the variable mapping, and build the `template` object Meta expects.
 * Pure functions: the API (validation, previews) and the audience build use the same rules.
 */

/** A component of a Meta template, as synced from `/message_templates`. Unknown fields are kept. */
export interface TemplateComponent {
  readonly type?: string;
  readonly format?: string;
  readonly text?: string;
  readonly example?: {
    readonly header_text?: readonly string[] | readonly (readonly string[])[];
    readonly body_text?: readonly (readonly string[])[];
  };
  readonly buttons?: readonly {
    readonly type?: string;
    readonly text?: string;
    readonly url?: string;
    readonly example?: readonly string[];
  }[];
}

export type MappedComponent = 'HEADER' | 'BODY' | 'BUTTONS';

/** One `{{N}}` placeholder of a template. `buttonIndex` is the 0-based button, for URL buttons. */
export interface TemplateVariable {
  readonly component: MappedComponent;
  readonly index: number;
  readonly buttonIndex?: number;
  readonly example?: string;
  readonly label: string;
}

/**
 * Where a placeholder's value comes from (HeliumAdmin's shape): a recipient field (`name`, `phone`, `email`,
 * `city`), a CSV column (`csv:<column>`), or static text.
 */
export interface VariableMapping {
  readonly index: number;
  readonly component: MappedComponent;
  readonly buttonIndex?: number;
  readonly source: 'field' | 'static';
  readonly value: string;
}

export const MAPPING_FIELDS = ['name', 'phone', 'email', 'city'] as const;
export type MappingField = (typeof MAPPING_FIELDS)[number];

/** What is known about one recipient when resolving values. */
export interface RecipientFields {
  readonly name?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly city?: string | null;
  readonly csv?: Readonly<Record<string, string>>;
}

export type HeaderMediaType = 'image' | 'video' | 'document';

/** The `template` object of a Meta send request. */
export interface TemplatePayload {
  readonly name: string;
  readonly language: { readonly code: string };
  readonly components?: readonly Record<string, unknown>[];
}

/** Used when a value is missing, as in HeliumAdmin. */
export const FALLBACK_VALUE = 'Customer';

const PLACEHOLDER = /\{\{(\d+)\}\}/g;

function upper(value: string | undefined): string {
  return (value ?? '').toUpperCase();
}

function placeholderIndices(text: string | undefined): number[] {
  if (text === undefined) return [];
  const found = [...text.matchAll(PLACEHOLDER)].map((match) => Number(match[1]));
  return [...new Set(found)].sort((a, b) => a - b);
}

function headerExample(component: TemplateComponent): string | undefined {
  const example = component.example?.header_text;
  const first = example?.[0];
  return typeof first === 'string' ? first : first?.[0];
}

/** Every placeholder in a text header, the body and URL buttons, in order. */
export function extractTemplateVariables(
  components: readonly TemplateComponent[] | undefined,
): TemplateVariable[] {
  const variables: TemplateVariable[] = [];
  for (const component of components ?? []) {
    const type = upper(component.type);
    if (type === 'HEADER' && upper(component.format || 'TEXT') === 'TEXT') {
      for (const index of placeholderIndices(component.text)) {
        variables.push({
          component: 'HEADER',
          index,
          example: headerExample(component),
          label: `Header {{${String(index)}}}`,
        });
      }
    } else if (type === 'BODY') {
      for (const index of placeholderIndices(component.text)) {
        const example = component.example?.body_text?.[0]?.[index - 1];
        variables.push({ component: 'BODY', index, example, label: `Body {{${String(index)}}}` });
      }
    } else if (type === 'BUTTONS') {
      (component.buttons ?? []).forEach((button, buttonIndex) => {
        for (const index of placeholderIndices(button.url)) {
          variables.push({
            component: 'BUTTONS',
            index,
            buttonIndex,
            example: button.example?.[index - 1],
            label: `Button ${String(buttonIndex + 1)} {{${String(index)}}}`,
          });
        }
      });
    }
  }
  return variables;
}

/** The media a template's header needs, or `null` for a text header or none. */
export function headerMediaType(
  components: readonly TemplateComponent[] | undefined,
): HeaderMediaType | null {
  const header = components?.find((component) => upper(component.type) === 'HEADER');
  const format = upper(header?.format);
  return format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT'
    ? (format.toLowerCase() as HeaderMediaType)
    : null;
}

/** The labels of quick-reply buttons: the options of a poll. */
export function quickReplyButtons(components: readonly TemplateComponent[] | undefined): string[] {
  const buttons = components?.find((component) => upper(component.type) === 'BUTTONS')?.buttons ?? [];
  return buttons
    .filter(
      (button) =>
        upper(button.type) === 'QUICK_REPLY' || (button.type === undefined && button.url === undefined),
    )
    .map((button) => (button.text ?? '').trim())
    .filter((text) => text !== '');
}

export function mappingKey(variable: Pick<TemplateVariable, 'component' | 'index' | 'buttonIndex'>): string {
  const button = variable.component === 'BUTTONS' ? String(variable.buttonIndex ?? 0) : '';
  return `${variable.component}:${button}:${String(variable.index)}`;
}

/** The first problem with a mapping, or `null` when every placeholder has a valid source. */
export function mappingProblem(
  variables: readonly TemplateVariable[],
  mappings: readonly VariableMapping[],
): string | null {
  const byKey = new Map(mappings.map((mapping) => [mappingKey(mapping), mapping]));
  for (const variable of variables) {
    const mapping = byKey.get(mappingKey(variable));
    if (mapping === undefined) return `${variable.label} is not mapped`;
    if (mapping.source === 'static' && mapping.value.trim() === '')
      return `${variable.label} has an empty value`;
    if (mapping.source === 'field') {
      const isCsv = mapping.value.startsWith('csv:') && mapping.value.length > 4;
      if (!isCsv && !(MAPPING_FIELDS as readonly string[]).includes(mapping.value)) {
        return `${variable.label} uses an unknown field`;
      }
    }
  }
  return null;
}

function resolveValue(mapping: VariableMapping | undefined, fields: RecipientFields): string {
  if (mapping === undefined) return FALLBACK_VALUE;
  if (mapping.source === 'static') return mapping.value.trim() || FALLBACK_VALUE;
  const raw = mapping.value.startsWith('csv:')
    ? fields.csv?.[mapping.value.slice(4)]
    : fields[mapping.value as MappingField];
  return raw?.trim() || FALLBACK_VALUE;
}

/** One recipient's values, per component, dense from `{{1}}`. */
export interface ResolvedParams {
  readonly header: readonly string[];
  readonly body: readonly string[];
  readonly buttons: readonly { readonly index: number; readonly parameters: readonly string[] }[];
}

export function resolveParams(
  variables: readonly TemplateVariable[],
  mappings: readonly VariableMapping[],
  fields: RecipientFields,
): ResolvedParams {
  const byKey = new Map(mappings.map((mapping) => [mappingKey(mapping), mapping]));
  const header: string[] = [];
  const body: string[] = [];
  const buttons = new Map<number, string[]>();
  for (const variable of variables) {
    let target = variable.component === 'HEADER' ? header : body;
    if (variable.component === 'BUTTONS') {
      const buttonIndex = variable.buttonIndex ?? 0;
      target = buttons.get(buttonIndex) ?? [];
      buttons.set(buttonIndex, target);
    }
    target[variable.index - 1] = resolveValue(byKey.get(mappingKey(variable)), fields);
  }
  // Meta wants {{1}}..{{N}} with no gaps: fill any with the fallback.
  const dense = (values: string[]) => Array.from(values, (value) => value || FALLBACK_VALUE);
  return {
    header: dense(header),
    body: dense(body),
    buttons: [...buttons.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, parameters]) => ({ index, parameters: dense(parameters) })),
  };
}

/** The `template` object to send: header media or text parameters, body parameters, URL button parameters. */
export function buildTemplatePayload(input: {
  readonly name: string;
  readonly language: string;
  readonly params: ResolvedParams;
  readonly headerMedia?: { readonly type: HeaderMediaType; readonly id: string };
}): TemplatePayload {
  const text = (values: readonly string[]) => values.map((value) => ({ type: 'text', text: value }));
  const components: Record<string, unknown>[] = [];
  if (input.headerMedia !== undefined) {
    const { type, id } = input.headerMedia;
    components.push({ type: 'header', parameters: [{ type, [type]: { id } }] });
  } else if (input.params.header.length > 0) {
    components.push({ type: 'header', parameters: text(input.params.header) });
  }
  if (input.params.body.length > 0) components.push({ type: 'body', parameters: text(input.params.body) });
  for (const button of input.params.buttons) {
    if (button.parameters.length === 0) continue;
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(button.index),
      parameters: text(button.parameters),
    });
  }
  return {
    name: input.name,
    language: { code: input.language },
    ...(components.length > 0 ? { components } : {}),
  };
}

/** The template's header and body with one recipient's values filled in, for previews. */
export function renderTemplate(
  components: readonly TemplateComponent[] | undefined,
  params: ResolvedParams,
): { header?: string; body: string } {
  const fill = (text: string, values: readonly string[]) =>
    text.replace(PLACEHOLDER, (placeholder, n: string) => values[Number(n) - 1] ?? placeholder);
  const find = (type: string) => components?.find((component) => upper(component.type) === type);
  const header = find('HEADER');
  const headerText =
    header !== undefined && upper(header.format || 'TEXT') === 'TEXT' ? header.text : undefined;
  return {
    ...(headerText ? { header: fill(headerText, params.header) } : {}),
    body: fill(find('BODY')?.text ?? '', params.body),
  };
}
