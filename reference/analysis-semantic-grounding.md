# AI 分析管道：结构契约与证据准入

模型观察、候选影响和服务端系统字段分阶段处理；即便 schema 正确，引用还要属于当前冻结上下文。asOf 之后的消息，以及未允许参与 AI 的备注，不能进入允许集合。来源上下文本身必须先由领域层授权，不能把此处的集合校验当作完整权限系统。

**阅读型源码节选：** 下列代码来自实际项目，保留原符号及关键逻辑。它们依赖原 NestJS 容器、shared 契约或数据库，本文件不作为独立可执行程序，也不纳入本仓库的样例测试通过数量。

## 观察与候选结果解析

原项目路径：`apps/api/src/modules/ai/ai-semantic-impact-observe.ts`；范围：完整文件。

```ts
import {
  insufficientSemanticImpactCandidateV1,
  materializeSemanticImpactV1,
  semanticImpactCandidateV1Schema,
  semanticObservationEvidenceV1,
  semanticObservationV1Schema,
  type AnalyzeCustomerContext,
  type SemanticImpactCandidateV1,
  type SemanticImpactV1,
  type SemanticModelEvidenceRefV1,
  type SemanticObservationV1,
} from '@ai-crm/shared';

export const SEMANTIC_MODEL_OBSERVATION_FIELD = 'semantic_observation' as const;
export const SEMANTIC_MODEL_CANDIDATE_FIELD = 'semantic_impact_candidate' as const;

export type SemanticObserveRejectionReason =
  | 'missing'
  | 'invalid_schema'
  | 'wrong_stage_contract'
  | 'evidence_not_allowed';

export type ParsedSemanticObserveExtra =
  | {
      kind: 'observation';
      observation: SemanticObservationV1;
      degraded: boolean;
      rejectionReason: SemanticObserveRejectionReason | null;
      rejectedEvidenceCount: number;
    }
  | {
      kind: 'candidate';
      candidate: SemanticImpactCandidateV1;
      impact: SemanticImpactV1;
      degraded: boolean;
      rejectionReason: SemanticObserveRejectionReason | null;
      rejectedEvidenceCount: number;
    };

export function parseSemanticObserveExtra(
  rawOutput: unknown,
  context: AnalyzeCustomerContext,
): ParsedSemanticObserveExtra {
  const semantic = context.semanticImpactObserve;
  if (!semantic) throw new Error('Semantic observe parsing requires an observe context.');
  const record = objectRecord(rawOutput);
  if (context.analysisMode === 'map') {
    if (record && SEMANTIC_MODEL_CANDIDATE_FIELD in record) {
      return degradedObservation('wrong_stage_contract');
    }
    const parsed = semanticObservationV1Schema.safeParse(
      record?.[SEMANTIC_MODEL_OBSERVATION_FIELD],
    );
    if (!parsed.success) {
      return degradedObservation(
        record && SEMANTIC_MODEL_OBSERVATION_FIELD in record ? 'invalid_schema' : 'missing',
      );
    }
    const evidence = semanticObservationEvidenceV1(parsed.data);
    const rejectedEvidenceCount = countRejectedEvidence(evidence, context);
    if (rejectedEvidenceCount > 0) {
      return degradedObservation('evidence_not_allowed', rejectedEvidenceCount);
    }
    return {
      kind: 'observation',
      observation: parsed.data,
      degraded: false,
      rejectionReason: null,
      rejectedEvidenceCount: 0,
    };
  }

  if (record && SEMANTIC_MODEL_OBSERVATION_FIELD in record) {
    return degradedCandidate('wrong_stage_contract', context);
  }
  const parsed = semanticImpactCandidateV1Schema.safeParse(
    record?.[SEMANTIC_MODEL_CANDIDATE_FIELD],
  );
  if (!parsed.success) {
    return degradedCandidate(
      record && SEMANTIC_MODEL_CANDIDATE_FIELD in record ? 'invalid_schema' : 'missing',
      context,
    );
  }
  const evidence = semanticObservationEvidenceV1(parsed.data);
  const rejectedEvidenceCount = countRejectedEvidence(evidence, context);
  if (rejectedEvidenceCount > 0) {
    return degradedCandidate('evidence_not_allowed', context, rejectedEvidenceCount);
  }
  return candidateResult(parsed.data, context, false, null, 0);
}

export function semanticObserveSafeMetric(input: {
  parsed: ParsedSemanticObserveExtra;
  context: AnalyzeCustomerContext;
  estimatedInputTokenIncrement: number;
}): Record<string, string | number | boolean | null> {
  const { parsed, context } = input;
  if (parsed.kind === 'observation') {
    return {
      code: 'AI_SEMANTIC_IMPACT_OBSERVED',
      version: context.semanticImpactObserve?.version ?? null,
      analysisMode: context.analysisMode,
      state: 'observation',
      impactDirection: null,
      saturated: false,
      insufficient: false,
      conflict: false,
      evidenceRejected: parsed.rejectedEvidenceCount,
      coverageOverlap: coverageOverlap(parsed.observation, context),
      estimatedInputTokenIncrement: Math.max(0, input.estimatedInputTokenIncrement),
      degraded: parsed.degraded,
      rejectionReason: parsed.rejectionReason,
    };
  }
  const impact = parsed.candidate.impact;
  return {
    code: 'AI_SEMANTIC_IMPACT_OBSERVED',
    version: context.semanticImpactObserve?.version ?? null,
    analysisMode: context.analysisMode,
    state: parsed.candidate.state,
    impactDirection:
      impact === null ? null : impact < 0 ? 'negative' : impact > 0 ? 'positive' : 'zero',
    saturated: impact === -20 || impact === 20,
    insufficient: parsed.candidate.state === 'insufficient',
    conflict: parsed.candidate.state === 'conflict',
    evidenceRejected: parsed.rejectedEvidenceCount,
    coverageOverlap: coverageOverlap(parsed.candidate, context),
    estimatedInputTokenIncrement: Math.max(0, input.estimatedInputTokenIncrement),
    degraded: parsed.degraded,
    rejectionReason: parsed.rejectionReason,
  };
}

function degradedObservation(
  rejectionReason: SemanticObserveRejectionReason,
  rejectedEvidenceCount = 0,
): ParsedSemanticObserveExtra {
  return {
    kind: 'observation',
    observation: {
      summary: '当前分块没有形成可验证的语义观察。',
      factors: [],
      missingInformation: ['需要更多可验证证据。'],
      contradictions: [],
    },
    degraded: true,
    rejectionReason,
    rejectedEvidenceCount,
  };
}

function degradedCandidate(
  rejectionReason: SemanticObserveRejectionReason,
  context: AnalyzeCustomerContext,
  rejectedEvidenceCount = 0,
): ParsedSemanticObserveExtra {
  return candidateResult(
    insufficientSemanticImpactCandidateV1(),
    context,
    true,
    rejectionReason,
    rejectedEvidenceCount,
  );
}

function candidateResult(
  candidate: SemanticImpactCandidateV1,
  context: AnalyzeCustomerContext,
  degraded: boolean,
  rejectionReason: SemanticObserveRejectionReason | null,
  rejectedEvidenceCount: number,
): ParsedSemanticObserveExtra {
  const semantic = context.semanticImpactObserve;
  if (!semantic) throw new Error('Semantic observe candidate requires an observe context.');
  return {
    kind: 'candidate',
    candidate,
    impact: materializeSemanticImpactV1({
      candidate,
      rubricVersion: semantic.rubricVersion,
      programCoverageFingerprint: semantic.programCoverage.programCoverageFingerprint,
    }),
    degraded,
    rejectionReason,
    rejectedEvidenceCount,
  };
}

function countRejectedEvidence(
  evidence: readonly SemanticModelEvidenceRefV1[],
  context: AnalyzeCustomerContext,
): number {
  const allowed = allowedEvidenceIdentities(context);
  return evidence.filter((reference) => !allowed.has(evidenceIdentity(reference))).length;
}

function allowedEvidenceIdentities(context: AnalyzeCustomerContext): Set<string> {
  const asOfMillis = Date.parse(context.semanticImpactObserve?.asOf ?? '');
  const allowed = new Set<string>();
  if (context.analysisMode === 'reduce') {
    for (const chunk of context.chunkResults) {
      if (!chunk.semanticObservation) continue;
      for (const reference of semanticObservationEvidenceV1(chunk.semanticObservation)) {
        allowed.add(evidenceIdentity(reference));
      }
    }
  } else {
    for (const message of context.messages) {
      const occurredAt = new Date(message.ts).getTime();
      if (Number.isFinite(occurredAt) && occurredAt <= asOfMillis) {
        allowed.add(evidenceIdentity({ sourceKind: 'message', sourceId: message.id }));
      }
    }
  }
  for (const note of context.manualNotes) {
    const occurredAt = new Date(note.createdAt).getTime();
    if (note.includeInAi && Number.isFinite(occurredAt) && occurredAt <= asOfMillis) {
      allowed.add(evidenceIdentity({ sourceKind: 'note', sourceId: note.id }));
    }
  }
  return allowed;
}

function coverageOverlap(
  value: Pick<SemanticObservationV1, 'factors' | 'contradictions'>,
  context: AnalyzeCustomerContext,
): number {
  const coverage = context.semanticImpactObserve?.programCoverage;
  if (!coverage) return 0;
  const effectiveLineageIds = new Set(
    coverage.effectiveCoveredFacts.flatMap((fact) => fact.lineageIds),
  );
  const coveredEvidence = new Set(
    coverage.evidenceLineage
      .filter((lineage) => effectiveLineageIds.has(lineage.lineageId))
      .map((lineage) => evidenceIdentity(lineage)),
  );
  return semanticObservationEvidenceV1(value).filter((reference) =>
    coveredEvidence.has(evidenceIdentity(reference)),
  ).length;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function evidenceIdentity(reference: { sourceKind: string; sourceId: string }): string {
  return `${reference.sourceKind}\u0000${reference.sourceId}`;
}
```
