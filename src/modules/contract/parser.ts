/**
 * Contract Parser – uses Claude to extract structured billing terms from
 * free-form contract text (typed or PDF-derived).
 *
 * Claude's role is STRICTLY interpretive: it reads natural language and
 * returns a validated JSON object.  All downstream invoice logic is
 * deterministic and does not call Claude.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import type {
  ContractTerms,
  BillingType,
  ScheduleBillingType,
  MilestoneDefinition,
  HybridScheduleDefinition,
} from '../../types/billing';
import { logger } from '../audit/logger';

const VALID_BILLING_TYPES: BillingType[] = [
  'monthly',
  'quarterly',
  'annual',
  'one_time',
  'milestone',
  'hybrid',
];

const VALID_SCHEDULE_TYPES: ScheduleBillingType[] = [
  'monthly',
  'quarterly',
  'annual',
  'one_time',
  'milestone',
];

// System prompt pinned to extraction-only behaviour
const SYSTEM_PROMPT = `You are a contract billing extractor. Your ONLY task is to extract billing terms from contract text and return them as a single valid JSON object with no other commentary.

Return exactly this JSON shape (omit optional fields if not present):
{
  "billingType": "monthly"|"quarterly"|"annual"|"one_time"|"milestone"|"hybrid",
  "amount": <positive number – total contract value>,
  "currency": "<3-letter ISO code, default USD>",
  "startDate": "<YYYY-MM-DD>",
  "endDate": "<YYYY-MM-DD or omit>",
  "paymentTermsDays": <integer days until payment due, default 30>,
  "milestones": [
    { "name": "string", "amount": <number>, "dueDate": "<YYYY-MM-DD>", "description": "string (optional)" }
  ],
  "hybridSchedules": [
    { "billingType": "monthly"|"quarterly"|"annual"|"one_time"|"milestone", "amount": <number>, "startDate": "<YYYY-MM-DD>", "endDate": "<YYYY-MM-DD or omit>" }
  ],
  "notes": "string (optional)"
}

Rules:
- billingType "hybrid" means the contract has multiple billing streams.
- milestones array is only required when billingType is "milestone" or "hybrid".
- hybridSchedules array is only required when billingType is "hybrid".
- If you cannot determine a field, use the stated default or omit it.
- Return ONLY the JSON object, no markdown, no explanation.`;

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: config.claude.apiKey,
    });
  }
  return anthropicClient;
}

export async function parseContractTerms(
  contractText: string,
): Promise<ContractTerms> {
  if (!contractText.trim()) {
    throw new ContractParseError('Contract text is empty');
  }

  logger.info('Parsing contract terms via Claude', {
    model: config.claude.model,
    textLength: contractText.length,
  });

  let rawJson: string;

  try {
    const response = await getClient().messages.create({
      model: config.claude.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Extract billing terms from this contract:\n\n${contractText}`,
        },
      ],
    });

    // Find the first text block in the response (SDK union type ContentBlock)
    const textBlock = response.content.find((c) => c.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new ContractParseError('Unexpected non-text response from Claude');
    }
    rawJson = (textBlock as { type: 'text'; text: string }).text.trim();
  } catch (err) {
    if (err instanceof ContractParseError) throw err;
    throw new ContractParseError(
      `Claude API call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parseAndValidate(rawJson);
}

// ─── Parsing and Validation ────────────────────────────────────────────────

export function parseAndValidate(rawJson: string): ContractTerms {
  let parsed: unknown;

  // Strip any accidental markdown code fences
  const cleaned = rawJson.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ContractParseError(
      `Claude returned non-JSON output: ${cleaned.slice(0, 200)}`,
    );
  }

  return validateTerms(parsed);
}

function validateTerms(raw: unknown): ContractTerms {
  if (!raw || typeof raw !== 'object') {
    throw new ContractParseError('Parsed value is not an object');
  }
  const r = raw as Record<string, unknown>;

  // billingType
  if (!VALID_BILLING_TYPES.includes(r['billingType'] as BillingType)) {
    throw new ContractParseError(
      `Invalid billingType: "${r['billingType']}". Must be one of: ${VALID_BILLING_TYPES.join(', ')}`,
    );
  }
  const billingType = r['billingType'] as BillingType;

  // amount
  if (typeof r['amount'] !== 'number' || r['amount'] <= 0) {
    throw new ContractParseError(
      `Invalid amount: "${r['amount']}". Must be a positive number`,
    );
  }

  // startDate
  if (!isValidDate(r['startDate'])) {
    throw new ContractParseError(
      `Invalid or missing startDate: "${r['startDate']}"`,
    );
  }

  // endDate (optional)
  if (r['endDate'] !== undefined && !isValidDate(r['endDate'])) {
    throw new ContractParseError(`Invalid endDate: "${r['endDate']}"`);
  }

  // milestones
  let milestones: MilestoneDefinition[] | undefined;
  if (Array.isArray(r['milestones'])) {
    milestones = r['milestones'].map((m, i) => validateMilestone(m, i));
  }

  // hybridSchedules
  let hybridSchedules: HybridScheduleDefinition[] | undefined;
  if (Array.isArray(r['hybridSchedules'])) {
    hybridSchedules = r['hybridSchedules'].map((s, i) =>
      validateHybridSchedule(s, i),
    );
  }

  // Semantic cross-checks
  if (billingType === 'milestone' && (!milestones || milestones.length === 0)) {
    throw new ContractParseError(
      'Milestone billing type requires at least one milestone entry',
    );
  }
  if (billingType === 'hybrid' && (!hybridSchedules || hybridSchedules.length === 0)) {
    throw new ContractParseError(
      'Hybrid billing type requires at least one hybridSchedule entry',
    );
  }

  return {
    billingType,
    amount: r['amount'] as number,
    currency: typeof r['currency'] === 'string' && r['currency'].length === 3
      ? r['currency'].toUpperCase()
      : 'USD',
    startDate: r['startDate'] as string,
    ...(r['endDate'] ? { endDate: r['endDate'] as string } : {}),
    paymentTermsDays:
      typeof r['paymentTermsDays'] === 'number' && r['paymentTermsDays'] > 0
        ? r['paymentTermsDays']
        : 30,
    ...(milestones ? { milestones } : {}),
    ...(hybridSchedules ? { hybridSchedules } : {}),
    ...(typeof r['notes'] === 'string' ? { notes: r['notes'] } : {}),
  };
}

function validateMilestone(m: unknown, index: number): MilestoneDefinition {
  if (!m || typeof m !== 'object') {
    throw new ContractParseError(`milestones[${index}] is not an object`);
  }
  const ms = m as Record<string, unknown>;
  if (typeof ms['name'] !== 'string' || !ms['name']) {
    throw new ContractParseError(`milestones[${index}].name is required`);
  }
  if (typeof ms['amount'] !== 'number' || ms['amount'] <= 0) {
    throw new ContractParseError(
      `milestones[${index}].amount must be a positive number`,
    );
  }
  if (!isValidDate(ms['dueDate'])) {
    throw new ContractParseError(
      `milestones[${index}].dueDate must be YYYY-MM-DD`,
    );
  }
  return {
    name: ms['name'] as string,
    amount: ms['amount'] as number,
    dueDate: ms['dueDate'] as string,
    ...(typeof ms['description'] === 'string'
      ? { description: ms['description'] }
      : {}),
  };
}

function validateHybridSchedule(
  s: unknown,
  index: number,
): HybridScheduleDefinition {
  if (!s || typeof s !== 'object') {
    throw new ContractParseError(
      `hybridSchedules[${index}] is not an object`,
    );
  }
  const sc = s as Record<string, unknown>;
  if (!VALID_SCHEDULE_TYPES.includes(sc['billingType'] as ScheduleBillingType)) {
    throw new ContractParseError(
      `hybridSchedules[${index}].billingType is invalid: "${sc['billingType']}"`,
    );
  }
  if (typeof sc['amount'] !== 'number' || sc['amount'] <= 0) {
    throw new ContractParseError(
      `hybridSchedules[${index}].amount must be a positive number`,
    );
  }
  if (!isValidDate(sc['startDate'])) {
    throw new ContractParseError(
      `hybridSchedules[${index}].startDate must be YYYY-MM-DD`,
    );
  }
  return {
    billingType: sc['billingType'] as ScheduleBillingType,
    amount: sc['amount'] as number,
    startDate: sc['startDate'] as string,
    ...(sc['endDate'] && isValidDate(sc['endDate'])
      ? { endDate: sc['endDate'] as string }
      : {}),
  };
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

export class ContractParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractParseError';
  }
}
