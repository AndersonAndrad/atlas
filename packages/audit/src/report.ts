import {
  AUDIT_CATEGORIES,
  AUDIT_CONFIDENCES,
  AUDIT_EFFORTS,
  AUDIT_FINDING_KINDS,
  AUDIT_FINDINGS_MAX,
  AUDIT_SEVERITIES,
  AUDIT_TEXT_MAX,
  AuditReportFindingSchema,
  auditPlainText,
  type AuditReportFinding,
} from '@atlas/contracts';

const nullable = (type: string) => ({ type: [type, 'null'] });

/**
 * The JSON Schema given to the provider CLIs for their final answer (`--json-schema`,
 * `--output-schema`). Strict: every property is required and nothing else is allowed,
 * as structured outputs require; optional values are nullable instead.
 */
export const AUDIT_REPORT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title',
          'category',
          'severity',
          'confidence',
          'kind',
          'description',
          'evidence',
          'excerpt',
          'locations',
          'impact',
          'recommendation',
          'suggestedTaskTitle',
          'acceptanceCriteria',
          'effort',
        ],
        properties: {
          title: { type: 'string' },
          category: { type: 'string', enum: [...AUDIT_CATEGORIES] },
          severity: { type: 'string', enum: [...AUDIT_SEVERITIES] },
          confidence: { type: 'string', enum: [...AUDIT_CONFIDENCES] },
          kind: { type: 'string', enum: [...AUDIT_FINDING_KINDS] },
          description: { type: 'string' },
          evidence: { type: 'string' },
          excerpt: nullable('string'),
          locations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'startLine', 'endLine', 'symbol'],
              properties: {
                path: { type: 'string' },
                startLine: nullable('integer'),
                endLine: nullable('integer'),
                symbol: nullable('string'),
              },
            },
          },
          impact: { type: 'string' },
          recommendation: { type: 'string' },
          suggestedTaskTitle: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          effort: { type: ['string', 'null'], enum: [...AUDIT_EFFORTS, null] },
        },
      },
    },
  },
} as const;

export interface ParsedAuditReport {
  summary: string | null;
  /** Report order; at most AUDIT_FINDINGS_MAX. */
  findings: AuditReportFinding[];
  /** Entries that were not findings with the required fields, plus entries past the limit. */
  malformed: number;
}

/** JSON in a provider's text answer: as is, inside a Markdown fence, or between braces. */
function jsonFromText(text: string): unknown {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // The next candidate.
    }
  }
  return undefined;
}

/**
 * Validates a provider's answer (FR-007). Each finding is checked on its own: one entry
 * without the required fields does not discard the others, it is only counted. Returns
 * null when the answer is not an audit report at all.
 */
export function parseAuditReport(answer: unknown): ParsedAuditReport | null {
  const value = typeof answer === 'string' ? jsonFromText(answer) : answer;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { summary, findings } = value as { summary?: unknown; findings?: unknown };
  if (!Array.isArray(findings)) return null;
  const parsed: AuditReportFinding[] = [];
  let malformed = 0;
  for (const entry of findings) {
    const result = AuditReportFindingSchema.safeParse(entry);
    if (result.success && parsed.length < AUDIT_FINDINGS_MAX) parsed.push(result.data);
    else malformed += 1;
  }
  return {
    summary: typeof summary === 'string' ? auditPlainText(summary, AUDIT_TEXT_MAX) || null : null,
    findings: parsed,
    malformed,
  };
}
