# CRM 业务背景：可追溯的规则覆盖上下文

展示显式状态与推测性预计成交的来源区分，以及稳定指纹。具体评分阈值和客户值没有纳入本节。

**阅读型源码节选：** 下列代码来自实际项目，保留原符号及关键逻辑。它们依赖原 NestJS 容器、shared 契约或数据库，本文件不作为独立可执行程序，也不纳入本仓库的样例测试通过数量。

## 显式阶段绑定与覆盖指纹

原项目路径：`packages/shared/src/scoring-deal-progress-context.ts`；范围：完整文件。

```ts
import type { BusinessRules } from './business-rules';
import { sha256, stableJsonStringify } from './stable-hash';

export const SCORING_DEAL_PROGRESS_CONTEXT_SCHEMA_VERSION = 1 as const;
export const SCORING_DEAL_PROGRESS_EXPLICIT_SOURCE = 'explicit_status_binding' as const;
export const SCORING_DEAL_PROGRESS_EXPLICIT_VERSION =
  'scoring-deal-progress-explicit-status-v1' as const;
export const SCORING_DEAL_PROGRESS_LEGACY_SOURCE = 'legacy_expected_deal_projection' as const;
export const SCORING_DEAL_PROGRESS_LEGACY_VERSION =
  'scoring-deal-progress-legacy-expected-deal-v1' as const;

const EXPLICIT_BINDING_FINGERPRINT_DOMAIN = 'ai-crm/scoring-deal-progress-explicit-binding/v1\0';

export type ScoringDealProgressCoverageContextV1 = Readonly<{
  source: typeof SCORING_DEAL_PROGRESS_EXPLICIT_SOURCE;
  version: typeof SCORING_DEAL_PROGRESS_EXPLICIT_VERSION;
  bindingFingerprint: string;
}>;

export type ScoringDealProgressEvaluationContextV1 = Readonly<{
  source: typeof SCORING_DEAL_PROGRESS_LEGACY_SOURCE | typeof SCORING_DEAL_PROGRESS_EXPLICIT_SOURCE;
  version:
    | typeof SCORING_DEAL_PROGRESS_LEGACY_VERSION
    | typeof SCORING_DEAL_PROGRESS_EXPLICIT_VERSION;
  bindingFingerprint: string;
}>;

type ExplicitStageRules = Pick<BusinessRules, 'funnelStages' | 'funnelExcludedCustomerStatuses'>;

/**
 * 评分专用阶段事实：只认当前已发布、启用、非预期成交派生阶段的显式客户状态绑定。
 * 不读取 conversion probability、purchase timeline、最终评估或任何文本启发式。
 */
export function resolveExplicitScoringFunnelStageKeysV1(
  customer: Readonly<{ status: string }>,
  rules: ExplicitStageRules,
): readonly string[] {
  if (rules.funnelExcludedCustomerStatuses.includes(customer.status)) return Object.freeze([]);
  return Object.freeze(
    uniqueSorted(
      rules.funnelStages
        .filter(
          (stage) =>
            stage.lifecycle === 'published' &&
            stage.active &&
            stage.countsExpectedDeals !== true &&
            stage.customerStatuses.includes(customer.status),
        )
        .map((stage) => stage.key),
    ),
  );
}

export function buildExplicitScoringDealProgressCoverageContextV1(
  rules: ExplicitStageRules,
): ScoringDealProgressCoverageContextV1 {
  return Object.freeze({
    source: SCORING_DEAL_PROGRESS_EXPLICIT_SOURCE,
    version: SCORING_DEAL_PROGRESS_EXPLICIT_VERSION,
    bindingFingerprint: explicitScoringFunnelBindingFingerprintV1(rules),
  });
}

export function explicitScoringFunnelBindingFingerprintV1(rules: ExplicitStageRules): string {
  const explicitStages = rules.funnelStages
    .filter(
      (stage) =>
        stage.lifecycle === 'published' && stage.active && stage.countsExpectedDeals !== true,
    )
    .map((stage) => ({
      stageKey: stage.key,
      customerStatuses: uniqueSorted(stage.customerStatuses),
    }))
    .sort((left, right) => compareCodePoints(left.stageKey, right.stageKey));
  return sha256(
    `${EXPLICIT_BINDING_FINGERPRINT_DOMAIN}${stableJsonStringify({
      schemaVersion: SCORING_DEAL_PROGRESS_CONTEXT_SCHEMA_VERSION,
      explicitStages,
      excludedCustomerStatuses: uniqueSorted(rules.funnelExcludedCustomerStatuses),
    })}`,
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
```
