# MAX：工具执行 Harness

整批调用先校验，再执行；上下文由服务器注入，销售读取要求审计端口。阅读请求级去重、AbortController 超时及错误输出边界。超时并不证明底层工作已经停止，executor 仍应配合 signal。普通工具 trace 的 best-effort 与销售读审计的硬约束属于不同层。

**阅读型源码节选：** 下列代码来自实际项目，保留原符号及关键逻辑。它们依赖原 NestJS 容器、shared 契约或数据库，本文件不作为独立可执行程序，也不纳入本仓库的样例测试通过数量。

## 完整执行器

原项目路径：`apps/api/src/modules/assistant/assistant-tool-harness.ts`；范围：完整文件。

```ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  assistantToolCallSchema,
  assistantToolNameSchema,
  type AssistantToolCall,
  type AssistantJsonObject,
  type AssistantToolName,
} from '@ai-crm/shared';
import {
  AssistantToolError,
  canonicalJson,
  isAssistantToolAllowedForRole,
  validateAssistantToolContext,
  validateToolInput,
  validateToolOutput,
  type AssistantToolContext,
  type AssistantToolDefinition,
  type AssistantToolErrorCode,
} from './assistant-tool-registry';
import type { AssistantToolRegistry } from './assistant-tool-registry';
import { buildToolEvidence, type ToolEvidence } from './assistant-tool-evidence';

// ---------------------------------------------------------------------------
// Outcome types
// ---------------------------------------------------------------------------

export type AssistantToolOutcome =
  | { readonly ok: true; readonly callId: string; readonly evidence: ToolEvidence }
  | {
      readonly ok: false;
      readonly callId: string;
      readonly code: AssistantToolErrorCode;
      readonly message: string;
    };

export type AssistantToolBatchResult = Readonly<{
  outcomes: readonly AssistantToolOutcome[];
}>;

export type AssistantSalesReadAuditPort = Readonly<{
  beforeSalesRead(
    input: Readonly<{
      context: AssistantToolContext;
      toolCallId: string;
      toolName: AssistantToolName;
    }>,
  ): Promise<string>;
  afterSalesEvidence(
    input: Readonly<{
      token: string;
      evidence: ToolEvidence;
    }>,
  ): Promise<void>;
}>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CALL_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const CALL_ID_MAX_LENGTH = 128;
const BATCH_MIN = 1;
const BATCH_MAX = 4;

const OUTCOME_MESSAGES: Readonly<Record<AssistantToolErrorCode, string>> = {
  INVALID_TOOL_BATCH: 'Tool batch is invalid.',
  DUPLICATE_TOOL_CALL_ID: 'Duplicate tool call ID in batch.',
  INVALID_TOOL_CONTEXT: 'Tool context is invalid.',
  FORBIDDEN_TOOL_CONTEXT: 'Forbidden context key in tool input.',
  UNKNOWN_TOOL: 'Unknown tool.',
  INVALID_TOOL_INPUT: 'Tool input is invalid.',
  TOOL_TIMEOUT: 'Tool execution timed out.',
  TOOL_EXECUTION_FAILED: 'Tool execution failed.',
  QUERY_REFERENCE_UNAVAILABLE:
    '查询引用已不可用。请按原条件重新查询，不要修改引用或拼接不同查询的结果。',
  INVALID_TOOL_OUTPUT: 'Tool output is invalid.',
  TOOL_OUTPUT_TOO_LARGE: 'Tool output exceeds size limit.',
  TOOL_REGISTRY_MISMATCH: 'Tool registry does not match capabilities.',
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export class AssistantToolHarness {
  private readonly registry: AssistantToolRegistry;

  constructor(
    registry: AssistantToolRegistry,
    private readonly salesReadAudit?: AssistantSalesReadAuditPort,
  ) {
    this.registry = registry;
  }

  async executeBatch(
    calls: readonly AssistantToolCall[],
    rawContext: unknown,
  ): Promise<AssistantToolBatchResult> {
    // 1. Validate context (server-injected, fail-closed)
    const context = validateAssistantToolContext(rawContext);

    // 2. Validate batch structure
    if (!Array.isArray(calls) || calls.length < BATCH_MIN || calls.length > BATCH_MAX) {
      throw new AssistantToolError('INVALID_TOOL_BATCH');
    }

    // 3. R3-D02: shared assistantToolCallSchema validation per call
    const callStructureSchema = z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        arguments: z.unknown(),
      })
      .strict();
    for (const c of calls) {
      if (!assistantToolCallSchema.safeParse(c).success) {
        if (!callStructureSchema.safeParse(c).success) {
          throw new AssistantToolError('INVALID_TOOL_BATCH');
        }
        // Structure OK — check if name is the issue (let registry.resolve handle it)
        if (!assistantToolNameSchema.safeParse((c as Record<string, unknown>).name).success) {
          continue;
        }
        throw new AssistantToolError('INVALID_TOOL_INPUT');
      }
    }

    // 4. Validate call IDs (format + uniqueness)
    const seenIds = new Set<string>();
    for (const c of calls) {
      if (
        typeof c.id !== 'string' ||
        c.id.length === 0 ||
        c.id.length > CALL_ID_MAX_LENGTH ||
        !CALL_ID_PATTERN.test(c.id)
      ) {
        throw new AssistantToolError('INVALID_TOOL_BATCH');
      }
      if (seenIds.has(c.id)) {
        throw new AssistantToolError('DUPLICATE_TOOL_CALL_ID');
      }
      seenIds.add(c.id);
    }

    // 5. Resolve definitions and validate inputs — all before any executor
    const prepared = calls.map((c) => {
      const definition = this.registry.resolve(c.name);
      if (!isAssistantToolAllowedForRole(definition.name, context.role)) {
        throw new AssistantToolError('UNKNOWN_TOOL');
      }
      const input = validateToolInput(definition, c.arguments);
      return { call: c, definition, input };
    });

    // 6. Execute in parallel with request-scoped cache
    const cache = new Map<string, Promise<unknown>>();

    const outcomePromises = prepared.map(({ call: c, definition, input }) =>
      this.executeCall(c.id, definition, input, context, cache),
    );

    const outcomes = await Promise.all(outcomePromises);
    return { outcomes };
  }

  // -------------------------------------------------------------------------
  // Per-call execution
  // -------------------------------------------------------------------------

  private async executeCall(
    callId: string,
    definition: AssistantToolDefinition,
    input: AssistantJsonObject,
    context: AssistantToolContext,
    cache: Map<string, Promise<unknown>>,
  ): Promise<AssistantToolOutcome> {
    try {
      let salesAuditToken: string | null = null;
      if (context.role === 'sales') {
        if (!this.salesReadAudit) throw new AssistantToolError('TOOL_EXECUTION_FAILED');
        salesAuditToken = await this.salesReadAudit.beforeSalesRead({
          context,
          toolCallId: callId,
          toolName: definition.name,
        });
        if (
          typeof salesAuditToken !== 'string' ||
          salesAuditToken.length === 0 ||
          salesAuditToken.length > 256
        ) {
          throw new AssistantToolError('TOOL_EXECUTION_FAILED');
        }
      }
      const raw = await this.getOrExecute(definition, input, context, cache);
      const output = validateToolOutput(definition, raw);
      const evidenceInput = definition.mapToEvidence(output, context);
      const effectiveMaxRows = Math.min(context.maxRows, definition.maxRows);
      const evidence = buildToolEvidence({
        evidenceId: generateEvidenceId(callId),
        toolCallId: callId,
        toolName: definition.name,
        toolVersion: definition.version,
        asOf: context.asOf,
        effectiveMaxRows,
        input: evidenceInput,
      });
      if (salesAuditToken !== null) {
        await this.salesReadAudit!.afterSalesEvidence({ token: salesAuditToken, evidence });
      }
      return { ok: true, callId, evidence };
    } catch (error) {
      const code: AssistantToolErrorCode =
        error instanceof AssistantToolError ? error.code : 'TOOL_EXECUTION_FAILED';
      return { ok: false, callId, code, message: OUTCOME_MESSAGES[code] };
    }
  }

  // -------------------------------------------------------------------------
  // Request-scoped cache
  // -------------------------------------------------------------------------

  private getOrExecute(
    definition: AssistantToolDefinition,
    input: AssistantJsonObject,
    context: AssistantToolContext,
    cache: Map<string, Promise<unknown>>,
  ): Promise<unknown> {
    if (definition.cachePolicy === 'none') {
      return this.executeWithTimeout(definition, input, context);
    }
    const key = buildCacheKey(definition, input, context);
    let promise = cache.get(key);
    if (!promise) {
      promise = this.executeWithTimeout(definition, input, context);
      cache.set(key, promise);
    }
    return promise;
  }

  // -------------------------------------------------------------------------
  // Timeout with independent AbortController and late-settle absorption
  // -------------------------------------------------------------------------

  private executeWithTimeout(
    definition: AssistantToolDefinition,
    input: AssistantJsonObject,
    context: AssistantToolContext,
  ): Promise<unknown> {
    const deadlineMs = Math.min(context.timeoutMs, definition.timeoutMs);

    return new Promise<unknown>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        reject(new AssistantToolError('TOOL_TIMEOUT'));
      }, deadlineMs);

      let executePromise: Promise<unknown>;
      try {
        executePromise = definition.execute(input, context, controller.signal);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        reject(safeExecutionFailure(error));
        return;
      }

      executePromise.then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(safeExecutionFailure(error));
        },
      );
    });
  }
}

function safeExecutionFailure(error: unknown): AssistantToolError {
  // Only this server-owned, non-identifying recovery signal may cross execution.
  // Reconstruct it so arbitrary exception messages or details never escape.
  return new AssistantToolError(
    error instanceof AssistantToolError && error.code === 'QUERY_REFERENCE_UNAVAILABLE'
      ? 'QUERY_REFERENCE_UNAVAILABLE'
      : 'TOOL_EXECUTION_FAILED',
  );
}

// ---------------------------------------------------------------------------
// Deterministic evidence identity
// ---------------------------------------------------------------------------

function generateEvidenceId(callId: string): string {
  // A 128-bit reference keeps exact validation while reducing model transcription errors.
  // The full call identity and evidence payload remain in the run audit.
  return `ev_${createHash('sha256').update(callId, 'utf8').digest('hex').slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Cache key — covers all identity / scope dimensions
// ---------------------------------------------------------------------------

function buildCacheKey(
  definition: AssistantToolDefinition,
  input: AssistantJsonObject,
  context: AssistantToolContext,
): string {
  const effectiveMaxRows = Math.min(context.maxRows, definition.maxRows);
  return [
    definition.name,
    String(definition.version),
    canonicalJson(input),
    context.user.id,
    context.role,
    context.runId,
    context.requestId,
    context.asOf,
    context.businessRuleFingerprint,
    String(effectiveMaxRows),
  ].join('\x00');
}
```
