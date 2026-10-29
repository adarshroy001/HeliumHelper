import {
  type ArgumentMetadata,
  Injectable,
  StandardSchemaValidationPipe,
  type StandardSchemaValidationPipeOptions,
} from '@nestjs/common';
import { ValidationError } from '../errors/index.js';

/** One Standard Schema issue (`{ message, path? }`), taken from Nest's types rather than a direct dependency. */
type Issue = Parameters<NonNullable<StandardSchemaValidationPipeOptions['exceptionFactory']>>[0][number];

/** Zod reports unknown keys of a strict object as one issue on the object, listing the keys. */
function unknownKeysOf(issue: Issue): readonly string[] {
  const { code, keys } = issue as { code?: unknown; keys?: unknown };
  return code === 'unrecognized_keys' && Array.isArray(keys) ? keys.map(String) : [];
}

/**
 * Turns schema issues into `{ 'items.0.phone': 'Invalid input: ...' }`, keeping the first message per field.
 * Each unknown key gets its own entry. `property` names the value when a route validates a single one, as in
 * `@Param('id', { schema })`. An issue on the whole value is reported under `(root)`.
 */
export function issuesToFields(issues: readonly Issue[], property?: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const add = (path: readonly PropertyKey[], message: string) => {
    const key = [property, ...path.map(String)].filter((part) => part !== undefined).join('.') || '(root)';
    fields[key] ??= message;
  };

  for (const issue of issues) {
    const path = (issue.path ?? []).map((segment) => (typeof segment === 'object' ? segment.key : segment));
    const unknownKeys = unknownKeysOf(issue);
    if (unknownKeys.length === 0) add(path, issue.message);
    for (const key of unknownKeys) add([...path, key], 'Unknown field.');
  }
  return fields;
}

/**
 * NestJS 12's Standard Schema pipe, registered globally in `configureApp`. A route attaches a zod schema with
 * `@Body({ schema })`, `@Query({ schema })` or `@Param('id', { schema })`, and receives the parsed value.
 * Invalid input is a 400 `VALIDATION_FAILED` with `details.fields` (ADR-0008, ADR-0009).
 */
@Injectable()
export class SchemaValidationPipe extends StandardSchemaValidationPipe {
  override async transform<T>(value: T, metadata: ArgumentMetadata): Promise<T> {
    const { schema } = metadata;
    if (!schema || !this.toValidate(metadata)) return value;

    this.stripProtoKeys(value);
    const result = await this.validate<T>(value, schema);
    if (result.issues) throw new ValidationError(issuesToFields(result.issues, metadata.data));
    return result.value;
  }
}
