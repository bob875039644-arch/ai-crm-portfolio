# MAX：冻结执行策略与预算

运行时业务规则版本漂移会阻止沿旧快照执行。预算快照分别约束模型次数、工具轮次、并行度、证据量与期限；此处展示代码契约，不陈述线上实际配置。

**阅读型源码节选：** 下列代码来自实际项目，保留原符号及关键逻辑。它们依赖原 NestJS 容器、shared 契约或数据库，本文件不作为独立可执行程序，也不纳入本仓库的样例测试通过数量。

## 冻结策略与当前规则比对

原项目路径：`apps/api/src/modules/assistant/assistant-execution-policy.service.ts`；范围：完整文件。

```ts
import {
  businessRulesVersionSchema,
  type AppSettings,
  type AssistantPlan,
} from '@ai-crm/shared';
import type { SettingsService } from '../settings/settings.service';
import type { AssistantRunToolPolicy } from './assistant-run-orchestrator';
import type { AssistantRunExecutionSnapshot, AssistantRunRepository } from './assistant-run.repository';
import { AssistantPromptRegistry, AssistantPromptRegistryError } from './assistant-prompt-registry';

export type AssistantExecutionPolicy = Readonly<{
  toolPolicy: AssistantRunToolPolicy;
  fixedPlan?: AssistantPlan;
}>;

export interface AssistantExecutionPolicyRepositoryPort {
  getExecutionSnapshot(runId: string): Promise<
    | Pick<AssistantRunExecutionSnapshot, 'promptProvenance' | 'businessRulesVersion'>
    | null
  >;
}

export interface AssistantExecutionPolicySettingsPort {
  get(): Promise<Pick<AppSettings, 'businessRulesVersion'>>;
}

export class AssistantExecutionPolicyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'AssistantExecutionPolicyError';
    this.code = code;
  }
}

export class AssistantExecutionPolicyService {
  constructor(
    private readonly repository: AssistantExecutionPolicyRepositoryPort | AssistantRunRepository,
    private readonly settings: AssistantExecutionPolicySettingsPort | Pick<SettingsService, 'get'>,
    private readonly registry: AssistantPromptRegistry,
  ) {}

  async resolve(runId: string): Promise<AssistantExecutionPolicy> {
    if (typeof runId !== 'string' || runId.trim().length === 0 || Buffer.byteLength(runId, 'utf8') > 256) {
      throw new AssistantExecutionPolicyError('ASSISTANT_EXECUTION_POLICY_INVALID_RUN');
    }
    const snapshot = await this.repository.getExecutionSnapshot(runId);
    if (!snapshot) throw new AssistantExecutionPolicyError('ASSISTANT_RUN_NOT_FOUND');

    const frozenVersion = businessRulesVersionSchema.safeParse(snapshot.businessRulesVersion);
    if (!frozenVersion.success) {
      throw new AssistantExecutionPolicyError('ASSISTANT_BUSINESS_RULES_SNAPSHOT_INVALID');
    }
    const current = await this.settings.get();
    const currentVersion = businessRulesVersionSchema.safeParse(current.businessRulesVersion);
    if (!currentVersion.success) {
      throw new AssistantExecutionPolicyError('ASSISTANT_BUSINESS_RULES_UNAVAILABLE');
    }
    if (currentVersion.data !== frozenVersion.data) {
      throw new AssistantExecutionPolicyError('ASSISTANT_BUSINESS_RULES_DRIFT');
    }

    let promptPolicy: Readonly<{ fixedPlan?: AssistantPlan }>;
    try {
      promptPolicy = this.registry.resolveProvenance(snapshot.promptProvenance);
    } catch (error) {
      if (error instanceof AssistantPromptRegistryError) {
        throw new AssistantExecutionPolicyError(error.code);
      }
      throw error;
    }

    return deepFreeze({
      toolPolicy: {
        timeoutMs: 5000,
        maxRows: 20,
        businessRuleFingerprint: frozenVersion.data,
      },
      ...(promptPolicy.fixedPlan ? { fixedPlan: promptPolicy.fixedPlan } : {}),
    });
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
```

## 标准与 Deep 预算快照

原项目路径：`apps/api/src/modules/assistant/assistant-agent-policy.ts`；范围：完整文件。

```ts
export const ASSISTANT_AGENT_PROTOCOL_VERSION = 'max-agent-protocol-v1';

export const ASSISTANT_AGENT_RUN_TIMEOUT_MS = 180_000;
export const ASSISTANT_AGENT_TOOL_SOFT_DEADLINE_MS = 150_000;
export const ASSISTANT_AGENT_TOOL_EXECUTION_LIMIT = 32;
export const ASSISTANT_AGENT_TOTAL_EVIDENCE_MAX_BYTES = 65_536;
export const ASSISTANT_AGENT_DEFAULT_MAX_ROWS = 20;
export const ASSISTANT_AGENT_HISTORY_MAX_BYTES = 32_768;
export const ASSISTANT_AGENT_TOOL_ROUND_LIMIT = 8;
export const ASSISTANT_AGENT_MODEL_CALL_LIMIT = 9;
export const ASSISTANT_AGENT_TOOL_CONCURRENCY = 4;
export const TOOL_EVIDENCE_MAX_BYTES = 16_384;
export const ASSISTANT_AGENT_MAX_EXECUTIONS_PER_NORMALIZED_CALL = 2;
export const ASSISTANT_AGENT_TOOL_REQUEST_AUDIT_LIMIT = 128;

export type AssistantAgentBudgetSnapshot = Readonly<{
  profile: 'standard-v1' | 'deep-v1';
  version: 1;
  toolDecisionRounds: number;
  modelCalls: number;
  parallelToolsPerRound: number;
  toolExecutions: number;
  perToolEvidenceBytes: number;
  totalEvidenceBytes: number;
  totalEvidenceRows: number;
  defaultRows: number;
  historyBytes: number;
  querySoftDeadlineMs: number;
  runHardDeadlineMs: number;
  maxExecutionsPerNormalizedCall: number;
}>;

export const ASSISTANT_AGENT_BUDGET_SNAPSHOT: AssistantAgentBudgetSnapshot = Object.freeze({
  profile: 'standard-v1',
  version: 1,
  toolDecisionRounds: ASSISTANT_AGENT_TOOL_ROUND_LIMIT,
  modelCalls: ASSISTANT_AGENT_MODEL_CALL_LIMIT,
  parallelToolsPerRound: ASSISTANT_AGENT_TOOL_CONCURRENCY,
  toolExecutions: ASSISTANT_AGENT_TOOL_EXECUTION_LIMIT,
  perToolEvidenceBytes: TOOL_EVIDENCE_MAX_BYTES,
  totalEvidenceBytes: ASSISTANT_AGENT_TOTAL_EVIDENCE_MAX_BYTES,
  totalEvidenceRows: ASSISTANT_AGENT_TOOL_EXECUTION_LIMIT * ASSISTANT_AGENT_DEFAULT_MAX_ROWS,
  defaultRows: ASSISTANT_AGENT_DEFAULT_MAX_ROWS,
  historyBytes: ASSISTANT_AGENT_HISTORY_MAX_BYTES,
  querySoftDeadlineMs: ASSISTANT_AGENT_TOOL_SOFT_DEADLINE_MS,
  runHardDeadlineMs: ASSISTANT_AGENT_RUN_TIMEOUT_MS,
  maxExecutionsPerNormalizedCall: ASSISTANT_AGENT_MAX_EXECUTIONS_PER_NORMALIZED_CALL,
});

export const ASSISTANT_AGENT_DEEP_BUDGET_SNAPSHOT: AssistantAgentBudgetSnapshot = Object.freeze({
  ...ASSISTANT_AGENT_BUDGET_SNAPSHOT,
  profile: 'deep-v1',
  toolExecutions: 40,
  totalEvidenceBytes: 98_304,
  totalEvidenceRows: 800,
  defaultRows: ASSISTANT_AGENT_DEFAULT_MAX_ROWS,
});

export function resolveAssistantAgentBudgetSnapshot(
  profile: 'standard-v1' | 'deep-v1',
): AssistantAgentBudgetSnapshot {
  return profile === 'deep-v1'
    ? ASSISTANT_AGENT_DEEP_BUDGET_SNAPSHOT
    : ASSISTANT_AGENT_BUDGET_SNAPSHOT;
}
```
