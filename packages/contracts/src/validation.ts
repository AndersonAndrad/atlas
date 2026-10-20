import { AtlasError, type FieldIssue } from '@atlas/shared';
import type { z } from 'zod';

/** Parses untrusted input, converting Zod failures into a VALIDATION_FAILED AtlasError. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  const issues: FieldIssue[] = result.error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '_',
    message: issue.message,
  }));
  throw new AtlasError('VALIDATION_FAILED', 'Input validation failed.', { issues });
}
