# MAX：有界的工具证据封装

观察 untrusted_data 标记、指标与明细行的区别、条数和字节约束，以及发生裁剪后如何同步修正 coverage。证据 ID 只提供引用身份，不单独证明内容正确。

**阅读型源码节选：** 下列代码来自实际项目，保留原符号及关键逻辑。它们依赖原 NestJS 容器、shared 契约或数据库，本文件不作为独立可执行程序，也不纳入本仓库的样例测试通过数量。

## 证据类型、构造、截断与严格校验

原项目路径：`apps/api/src/modules/assistant/assistant-tool-evidence.ts`；范围：完整文件。

```ts
import { z } from 'zod';
import { compactAssistantCustomerLabels } from './assistant-customer-label';
import { assistantReadCoverageSchema, type AssistantReadCoverage } from '@ai-crm/shared';
import { TOOL_EVIDENCE_MAX_BYTES } from './assistant-agent-policy';
import {
  assistantCustomerLinkSchema,
  assistantJsonObjectSchema,
  assistantToolNameSchema,
  type AssistantCustomerLink,
  type AssistantJsonObject,
  type AssistantToolName,
} from '@ai-crm/shared';
import {
  AssistantToolError,
  canonicalJson,
  deepFreeze,
  type ToolEvidenceInput,
} from './assistant-tool-registry';

// ---------------------------------------------------------------------------
// ToolEvidence — bounded, deterministic, deeply frozen
// ---------------------------------------------------------------------------

export type ToolEvidence = Readonly<{
  kind: 'crm_evidence';
  trust: 'untrusted_data';
  evidenceId: string;
  toolCallId: string;
  toolName: AssistantToolName;
  toolVersion: number;
  status: 'complete' | 'partial' | 'no_data';
  total: number;
  truncated: boolean;
  asOf: string;
  warnings: readonly string[];
  links: readonly AssistantCustomerLink[];
  facts: readonly AssistantJsonObject[];
  coverage?: AssistantReadCoverage;
}>;

export { TOOL_EVIDENCE_MAX_BYTES } from './assistant-agent-policy';
export const TOOL_EVIDENCE_MAX_WARNINGS = 20;
export const TOOL_EVIDENCE_MAX_WARNING_LENGTH = 256;
export const TOOL_EVIDENCE_MAX_LINKS = 20;

// Facts with a string `metric` field are aggregate KPIs: exempt from row-count
// capping and from the `total >= facts.length` check. Row facts must not use a
// `metric` key; a future violation would silently bypass the row cap.
function isMetricFact(fact: AssistantJsonObject): boolean {
  return typeof fact.metric === 'string';
}

// ---------------------------------------------------------------------------
// Second-pass strict schema for the final evidence object
// ---------------------------------------------------------------------------

const toolEvidenceSchema = z
  .object({
    kind: z.literal('crm_evidence'),
    trust: z.literal('untrusted_data'),
    evidenceId: z.string().min(1),
    toolCallId: z.string().min(1),
    toolName: assistantToolNameSchema,
    toolVersion: z.number().int().positive(),
    status: z.enum(['complete', 'partial', 'no_data']),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
    asOf: z.string().min(1),
    warnings: z
      .array(z.string().max(TOOL_EVIDENCE_MAX_WARNING_LENGTH))
      .max(TOOL_EVIDENCE_MAX_WARNINGS),
    links: z.array(assistantCustomerLinkSchema).max(TOOL_EVIDENCE_MAX_LINKS),
    facts: z.array(assistantJsonObjectSchema),
    coverage: assistantReadCoverageSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildToolEvidence(params: {
  evidenceId: string;
  toolCallId: string;
  toolName: AssistantToolName;
  toolVersion: number;
  asOf: string;
  effectiveMaxRows: number;
  input: ToolEvidenceInput;
  /** Structural validation of persisted evidence must preserve its original labels. */
  compactCustomerLabels?: boolean;
}): ToolEvidence {
  const { evidenceId, toolCallId, toolName, toolVersion, asOf, effectiveMaxRows } = params;

  let input: ToolEvidenceInput = structuredClone(params.input);

  // --- validate status ---
  if (input.status !== 'complete' && input.status !== 'partial' && input.status !== 'no_data') {
    throw new AssistantToolError('INVALID_TOOL_OUTPUT');
  }

  // --- D03: validate optional upstream truncated ---
  if (input.truncated !== undefined && typeof input.truncated !== 'boolean') {
    throw new AssistantToolError('INVALID_TOOL_OUTPUT');
  }

  // --- validate total ---
  if (!Number.isSafeInteger(input.total) || input.total < 0) {
    throw new AssistantToolError('INVALID_TOOL_OUTPUT');
  }

  // --- validate facts array ---
  if (!Array.isArray(input.facts)) {
    throw new AssistantToolError('INVALID_TOOL_OUTPUT');
  }
  const rowFactCount = input.facts.filter((fact) => !isMetricFact(fact)).length;
  if (input.total < rowFactCount) {
    throw new AssistantToolError('INVALID_TOOL_OUTPUT');
  }

  // --- no_data constraints ---
  if (input.status === 'no_data' && (input.total !== 0 || input.facts.length !== 0)) {
    throw new AssistantToolError('INVALID_TOOL_OUTPUT');
  }

  // --- validate warnings ---
  if (!Array.isArray(input.warnings)) {
    throw new AssistantToolError('INVALID_TOOL_OUTPUT');
  }
  if (input.warnings.length > TOOL_EVIDENCE_MAX_WARNINGS) {
    throw new AssistantToolError('INVALID_TOOL_OUTPUT');
  }
  for (const warning of input.warnings) {
    if (typeof warning !== 'string' || warning.length > TOOL_EVIDENCE_MAX_WARNING_LENGTH) {
      throw new AssistantToolError('INVALID_TOOL_OUTPUT');
    }
  }

  // --- validate links ---
  if (!Array.isArray(input.links)) {
    throw new AssistantToolError('INVALID_TOOL_OUTPUT');
  }
  if (input.links.length > TOOL_EVIDENCE_MAX_LINKS) {
    throw new AssistantToolError('INVALID_TOOL_OUTPUT');
  }
  for (const link of input.links) {
    if (!assistantCustomerLinkSchema.safeParse(link).success) {
      throw new AssistantToolError('INVALID_TOOL_OUTPUT');
    }
  }

  // --- validate facts are plain JSON objects ---
  for (const fact of input.facts) {
    if (!assistantJsonObjectSchema.safeParse(fact).success) {
      throw new AssistantToolError('INVALID_TOOL_OUTPUT');
    }
  }

  // --- D03: upstream truncated + row-limit trimming (stable prefix) ---
  if (params.compactCustomerLabels !== false) {
    input = compactAssistantCustomerLabels(input, new Set(input.links.map((link) => link.label)));
  }
  const upstreamTruncated = typeof input.truncated === 'boolean' ? input.truncated : false;
  const metricFacts = input.facts.filter(isMetricFact);
  let rowFacts: readonly AssistantJsonObject[] = input.facts.filter((fact) => !isMetricFact(fact));
  let rowTrimmed = false;
  if (rowFacts.length > effectiveMaxRows) {
    rowFacts = rowFacts.slice(0, effectiveMaxRows);
    rowTrimmed = true;
  }
  const facts: readonly AssistantJsonObject[] = [...metricFacts, ...rowFacts];
  // truncated only promotes to true, never demotes
  let truncated =
    upstreamTruncated || (rowFacts.length > 0 && input.total > rowFacts.length) || rowTrimmed;

  // --- assemble evidence ---
  let evidence: ToolEvidence = {
    kind: 'crm_evidence',
    trust: 'untrusted_data',
    evidenceId,
    toolCallId,
    toolName,
    toolVersion,
    status: input.status,
    total: input.total,
    truncated,
    asOf,
    warnings: [...input.warnings],
    links: [...input.links],
    facts: [...facts],
    ...(input.coverage ? { coverage: input.coverage } : {}),
  };

  // --- byte-limit enforcement: tail reduction ---
  if (evidenceByteLength(evidence) > TOOL_EVIDENCE_MAX_BYTES) {
    const mutableFacts = [...facts];
    while (mutableFacts.length > 0) {
      mutableFacts.pop();
      truncated = true;
      evidence = { ...evidence, facts: [...mutableFacts], truncated };
      if (evidenceByteLength(evidence) <= TOOL_EVIDENCE_MAX_BYTES) break;
    }

    if (mutableFacts.length === 0 && evidenceByteLength(evidence) > TOOL_EVIDENCE_MAX_BYTES) {
      throw new AssistantToolError('TOOL_OUTPUT_TOO_LARGE');
    }
  }

  if (evidence.coverage && (rowTrimmed || evidence.facts.length < facts.length)) {
    evidence = {
      ...evidence,
      coverage: {
        ...evidence.coverage,
        completeness: 'unknown',
        stopReason: 'envelope_limit',
        ...(evidence.coverage.returnedRecords === undefined
          ? {}
          : { returnedRecords: evidence.facts.filter((fact) => !isMetricFact(fact)).length }),
      },
    };
  }
  // The receipt change itself can add bytes at the boundary; enforce the final envelope too.
  while (evidenceByteLength(evidence) > TOOL_EVIDENCE_MAX_BYTES && evidence.facts.length > 0) {
    const remainingFacts = evidence.facts.slice(0, -1);
    evidence = {
      ...evidence,
      facts: remainingFacts,
      truncated: true,
      ...(evidence.coverage
        ? {
            coverage: {
              ...evidence.coverage,
              ...(evidence.coverage.returnedRecords === undefined
                ? {}
                : { returnedRecords: remainingFacts.filter((fact) => !isMetricFact(fact)).length }),
            },
          }
        : {}),
    };
  }
  if (evidenceByteLength(evidence) > TOOL_EVIDENCE_MAX_BYTES)
    throw new AssistantToolError('TOOL_OUTPUT_TOO_LARGE');
  // --- second strict validation ---
  const validated = toolEvidenceSchema.safeParse(evidence);
  if (!validated.success) {
    throw new AssistantToolError('INVALID_TOOL_OUTPUT');
  }

  return deepFreeze(validated.data) as ToolEvidence;
}

export function parseToolEvidence(value: unknown): ToolEvidence {
  const normalized = normalizeLegacyEvidenceEnvelope(value);
  const validated = toolEvidenceSchema.safeParse(normalized);
  if (!validated.success) throw new AssistantToolError('INVALID_TOOL_OUTPUT');
  let evidence = structuredClone(validated.data) as ToolEvidence;
  if (evidenceByteLength(evidence) > TOOL_EVIDENCE_MAX_BYTES) {
    evidence = buildToolEvidence({
      evidenceId: evidence.evidenceId,
      toolCallId: evidence.toolCallId,
      toolName: evidence.toolName,
      toolVersion: evidence.toolVersion,
      asOf: evidence.asOf,
      effectiveMaxRows: evidence.facts.length,
      input: {
        status: evidence.status,
        total: evidence.total,
        truncated: evidence.truncated,
        warnings: evidence.warnings,
        links: evidence.links,
        facts: evidence.facts,
        ...(evidence.coverage ? { coverage: evidence.coverage } : {}),
      },
    });
  }
  return deepFreeze(evidence) as ToolEvidence;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function evidenceByteLength(evidence: ToolEvidence): number {
  return Buffer.byteLength(canonicalJson(evidence), 'utf8');
}

function normalizeLegacyEvidenceEnvelope(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  if (Object.hasOwn(value, 'kind') || Object.hasOwn(value, 'trust')) return value;
  return { kind: 'crm_evidence', trust: 'untrusted_data', ...value };
}
```
