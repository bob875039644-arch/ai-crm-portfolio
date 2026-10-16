# MAX：持久化模型调用 Attempt

阅读 reserve → markStarted → 调用 → settle 的身份和版本约束。回调在此不会自动重试。未知结果保留不确定状态，而非推断未收费或再次调用。本代码不包含实际 provider 凭据或运行配置。

**阅读型源码节选：** 下列代码来自实际项目，保留原符号及关键逻辑。它们依赖原 NestJS 容器、shared 契约或数据库，本文件不作为独立可执行程序，也不纳入本仓库的样例测试通过数量。

## 完整 Attempt executor

原项目路径：`apps/api/src/modules/assistant/assistant-agent-attempt.executor.ts`；范围：完整文件。

```ts
import { randomUUID } from 'node:crypto';
import type { AssistantModelAttemptPort } from './assistant-model-call.executor';
import type { AssistantModelAttemptRepository } from './assistant-model-attempt.repository';
import { withAssistantModelAttemptTiming } from './assistant-model-invocation-timing';

export type AssistantAgentUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  providerRequestId: string | null;
}>;

export type AssistantAgentAttemptValue<T> = Readonly<{
  value: T;
  usage: AssistantAgentUsage;
}>;

export type AssistantAgentAttemptResult<T> =
  | Readonly<{ kind: 'succeeded'; value: T }>
  | Readonly<{ kind: 'not_acquired' }>
  | Readonly<{ kind: 'failed'; code: string }>;

type EnabledAgentIdentity = Readonly<{
  providerId: 'openrouter' | 'deepseek' | 'ark';
  modelId: string;
}>;

type AttemptRepository = AssistantModelAttemptPort | AssistantModelAttemptRepository;

type AssistantAgentInvokeFailure = Readonly<{
  code: string;
  message: string;
}>;

const AGENT_ATTEMPT_LEASE_MS = 4 * 60 * 1000;

/**
 * One durable model-attempt row represents the complete LangChain agent run.
 * The callback is invoked once and is never retried here.
 */
export class AssistantAgentAttemptExecutor {
  readonly providerId: EnabledAgentIdentity['providerId'];
  readonly modelId: string;

  constructor(
    private readonly repository: AttemptRepository,
    identity: EnabledAgentIdentity,
    private readonly purpose: 'answer' | 'fallback' = 'answer',
  ) {
    this.providerId = identity.providerId;
    this.modelId = identity.modelId;
  }

  async execute<T>(
    runId: string,
    invoke: () => Promise<AssistantAgentAttemptValue<T>>,
    signal?: AbortSignal,
  ): Promise<AssistantAgentAttemptResult<T>> {
    const now = new Date();
    const attemptId = randomUUID();
    const leaseToken = randomUUID();
    let reservation;
    try {
      reservation = await this.repository.reserve({
        attemptId,
        runId,
        purpose: this.purpose,
        leaseToken,
        now,
        leaseDurationMs: AGENT_ATTEMPT_LEASE_MS,
        ...(this.purpose === 'fallback'
          ? { providerId: this.providerId, modelId: this.modelId }
          : {}),
      });
    } catch {
      return { kind: 'failed', code: 'ASSISTANT_AGENT_ATTEMPT_RESERVE_FAILED' };
    }
    if (reservation.kind === 'not_reserved') return { kind: 'not_acquired' };

    const attempt = reservation.attempt;
    if (
      attempt.providerId !== this.providerId ||
      attempt.modelId !== this.modelId ||
      attempt.status !== 'reserved' ||
      attempt.callOutcome !== null
    ) {
      return { kind: 'failed', code: 'ASSISTANT_AGENT_ATTEMPT_IDENTITY_MISMATCH' };
    }

    if (signal?.aborted) {
      const settlement = await this.settleNotStarted(attempt, attempt.version);
      return {
        kind: 'failed',
        code:
          settlement === 'applied'
            ? 'ASSISTANT_AGENT_ABORTED_BEFORE_START'
            : settlement === 'lost'
              ? 'ASSISTANT_AGENT_ATTEMPT_SETTLE_LOST'
              : 'ASSISTANT_AGENT_ATTEMPT_SETTLE_FAILED',
      };
    }

    let startedVersion: number;
    try {
      const started = await this.repository.markStarted({
        id: attempt.id,
        leaseToken: attempt.leaseToken,
        fence: attempt.fence,
        expectedVersion: attempt.version,
        now: new Date(),
      });
      if (!started.applied) return { kind: 'not_acquired' };
      startedVersion = started.version;
    } catch {
      return { kind: 'failed', code: 'ASSISTANT_AGENT_ATTEMPT_START_FAILED' };
    }

    if (signal?.aborted) {
      const settlement = await this.settleUnknown(attempt, startedVersion, {
        code: 'ASSISTANT_AGENT_ABORTED_BEFORE_CALL',
        message: 'Assistant agent was aborted before the provider call started.',
      });
      return {
        kind: 'failed',
        code:
          settlement === 'applied'
            ? 'ASSISTANT_AGENT_ABORTED_BEFORE_CALL'
            : settlement === 'lost'
              ? 'ASSISTANT_AGENT_ATTEMPT_SETTLE_LOST'
              : 'ASSISTANT_AGENT_ATTEMPT_SETTLE_FAILED',
      };
    }

    let output: AssistantAgentAttemptValue<T>;
    try {
      output = await waitForInvokeOrAbort(
        withAssistantModelAttemptTiming(
          {
            runId,
            attemptId: attempt.id,
            purpose: this.purpose,
            providerId: this.providerId,
            modelId: this.modelId,
            signal,
          },
          invoke,
        ),
        signal,
      );
    } catch (error) {
      const failure = classifyAssistantAgentInvokeError(error, signal);
      const settlement = await this.settleUnknown(attempt, startedVersion, failure);
      return {
        kind: 'failed',
        code:
          settlement === 'applied'
            ? failure.code
            : settlement === 'lost'
              ? 'ASSISTANT_AGENT_ATTEMPT_SETTLE_LOST'
              : 'ASSISTANT_AGENT_ATTEMPT_SETTLE_FAILED',
      };
    }

    const inputTokens = validTokenCount(output.usage.inputTokens);
    const outputTokens = validTokenCount(output.usage.outputTokens);
    const totalTokens =
      inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
    try {
      const settled = await this.repository.settle({
        id: attempt.id,
        leaseToken: attempt.leaseToken,
        fence: attempt.fence,
        expectedVersion: startedVersion,
        now: new Date(),
        callOutcome: 'responded',
        providerRequestId: boundedRequestId(output.usage.providerRequestId),
        inputTokens,
        outputTokens,
        totalTokens,
        errorCode: null,
        errorMessage: null,
      });
      if (!settled.applied) {
        return { kind: 'failed', code: 'ASSISTANT_AGENT_ATTEMPT_SETTLE_LOST' };
      }
    } catch {
      return { kind: 'failed', code: 'ASSISTANT_AGENT_ATTEMPT_SETTLE_FAILED' };
    }
    return { kind: 'succeeded', value: output.value };
  }

  private async settleUnknown(
    attempt: Readonly<{ id: string; leaseToken: string; fence: number }>,
    expectedVersion: number,
    failure: AssistantAgentInvokeFailure,
  ): Promise<'applied' | 'lost' | 'failed'> {
    try {
      const settled = await this.repository.settle({
        id: attempt.id,
        leaseToken: attempt.leaseToken,
        fence: attempt.fence,
        expectedVersion,
        now: new Date(),
        callOutcome: 'unknown',
        providerRequestId: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      return settled.applied ? 'applied' : 'lost';
    } catch {
      return 'failed';
    }
  }

  private async settleNotStarted(
    attempt: Readonly<{ id: string; leaseToken: string; fence: number }>,
    expectedVersion: number,
  ): Promise<'applied' | 'lost' | 'failed'> {
    try {
      const settled = await this.repository.settle({
        id: attempt.id,
        leaseToken: attempt.leaseToken,
        fence: attempt.fence,
        expectedVersion,
        now: new Date(),
        callOutcome: 'not_started',
        providerRequestId: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        errorCode: 'ASSISTANT_AGENT_ABORTED_BEFORE_START',
        errorMessage: 'Assistant agent was aborted before the provider call started.',
      });
      return settled.applied ? 'applied' : 'lost';
    } catch {
      return 'failed';
    }
  }
}

function waitForInvokeOrAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      operation();
    };
    const onAbort = (): void => {
      const error = new Error('ASSISTANT_AGENT_ABORTED_DURING_CALL');
      error.name = 'AbortError';
      finish(() => reject(error));
    };

    // Attach both handlers before observing the signal. If abort wins the race,
    // a provider that ignores cancellation may still settle later; these handlers
    // deliberately absorb that late resolve/reject without changing the attempt.
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function validTokenCount(value: number | null): number | null {
  return Number.isSafeInteger(value) && value !== null && value >= 0 ? value : null;
}

function boundedRequestId(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : null;
}

function classifyAssistantAgentInvokeError(
  error: unknown,
  signal?: AbortSignal,
): AssistantAgentInvokeFailure {
  const name = errorProperty(error, 'name');
  const message = errorProperty(error, 'message');
  const providerCode = errorProperty(error, 'code');
  const status = errorNumberProperty(error, 'status') ?? errorNumberProperty(error, 'statusCode');

  if (message === 'ASSISTANT_AGENT_EMPTY_RESPONSE') {
    return {
      code: 'ASSISTANT_AGENT_EMPTY_RESPONSE',
      message: 'Assistant agent returned no final answer text.',
    };
  }
  if (message === 'ASSISTANT_AGENT_OUTPUT_INVALID') {
    return {
      code: 'ASSISTANT_AGENT_OUTPUT_INVALID',
      message: 'Assistant agent returned an invalid final answer contract.',
    };
  }
  if (message === 'ASSISTANT_AGENT_MODEL_CALL_SAFETY_LIMIT_EXCEEDED') {
    return {
      code: 'ASSISTANT_AGENT_MODEL_CALL_SAFETY_LIMIT_EXCEEDED',
      message: 'Assistant agent reached the emergency model-call safety limit.',
    };
  }
  if (message === 'ASSISTANT_AGENT_EVIDENCE_REVISION_INVALID') {
    return {
      code: 'ASSISTANT_AGENT_EVIDENCE_REVISION_INVALID',
      message: 'Assistant agent received an invalid evidence revision.',
    };
  }
  if (
    name === 'ContextOverflowError' ||
    message.includes('context_length_exceeded') ||
    message.includes('exceeds the context window') ||
    message.includes('maximum context length')
  ) {
    return {
      code: 'ASSISTANT_AGENT_PROVIDER_CONTEXT_LIMIT',
      message: 'Assistant agent input reached the provider context limit.',
    };
  }
  if (signal?.aborted || name === 'AbortError') {
    return {
      code: 'ASSISTANT_AGENT_ABORTED_DURING_CALL',
      message: 'Assistant agent was aborted while the provider call was in progress.',
    };
  }
  if (status !== null && status >= 400 && status <= 599) {
    return {
      code: `ASSISTANT_AGENT_PROVIDER_HTTP_${status}`,
      message: `Assistant agent provider returned HTTP ${status}.`,
    };
  }
  if (
    name.toLowerCase().includes('timeout') ||
    providerCode === 'ETIMEDOUT' ||
    providerCode === 'ESOCKETTIMEDOUT'
  ) {
    return {
      code: 'ASSISTANT_AGENT_PROVIDER_TIMEOUT',
      message: 'Assistant agent provider request timed out.',
    };
  }
  if (
    providerCode === 'ECONNRESET' ||
    providerCode === 'ECONNREFUSED' ||
    providerCode === 'ENOTFOUND' ||
    providerCode === 'EAI_AGAIN'
  ) {
    return {
      code: 'ASSISTANT_AGENT_PROVIDER_NETWORK',
      message: 'Assistant agent provider network request failed.',
    };
  }
  return {
    code: 'ASSISTANT_AGENT_TRANSPORT_UNKNOWN',
    message: 'Assistant agent transport outcome is unknown.',
  };
}

function errorProperty(error: unknown, key: string): string {
  if (typeof error !== 'object' || error === null) return '';
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function errorNumberProperty(error: unknown, key: string): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as Record<string, unknown>)[key];
  return Number.isSafeInteger(value) ? (value as number) : null;
}
```
