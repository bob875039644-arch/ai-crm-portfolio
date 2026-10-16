# MAX：工具编排与最终回答校验

第一段展示运行快照如何转成服务器拥有的工具上下文，以及工具执行记录；第二段展示引用、客户列表窗口、销售统计和文档意图怎样在最终输出前校验。工具 trace 写入是 best-effort，不能把它描述成“任何审计失败都会阻断全部查询”。

**阅读型源码节选：** 下列代码来自实际项目，保留原符号及关键逻辑。它们依赖原 NestJS 容器、shared 契约或数据库，本文件不作为独立可执行程序，也不纳入本仓库的样例测试通过数量。

## 工具调用与证据返回

原项目路径：`apps/api/src/modules/assistant/assistant-agent-orchestrator.ts`；范围：1352–1511 行。

```ts
  private async executeTool(
    snapshot: AssistantRunExecutionSnapshot,
    requestId: string,
    sequence: number,
    callId: string,
    name: string,
    args: AssistantJsonObject,
    remainingMs: number,
    budget: ToolBudgetState,
    customerListContinuation?: AssistantToolContext['customerListContinuation'],
  ): Promise<
    | Readonly<{
        ok: true;
        auditExecutionId: string | null;
        rawEvidence: ToolEvidence;
        publicResult: Extract<AssistantMcpToolResult, { ok: true }>;
      }>
    | Readonly<{
        ok: false;
        auditExecutionId: string | null;
        publicResult: Extract<AssistantMcpToolResult, { ok: false }>;
      }>
  > {
    let definition;
    try {
      definition = this.registryFor(snapshot).resolve(name);
    } catch {
      return {
        ok: false,
        auditExecutionId: null,
        publicResult: { ok: false, code: 'UNKNOWN_TOOL', message: '未知查询工具。' },
      };
    }

    const executionId = randomUUID();
    let auditExecutionId: string | null = null;
    let executionVersion: number | null = null;
    try {
      const created = await this.repository.addToolExecution({
        id: executionId,
        runId: snapshot.id,
        sequence,
        toolName: definition.name,
        toolVersion: definition.version,
        toolCallId: callId,
        scopeKind: snapshot.actorRole === 'sales' ? 'owner' : 'global',
        cacheStatus: 'miss',
        budgetSnapshot: toolBudgetSnapshot(budget, this.budgetFor(snapshot)),
        input: args,
      });
      if (created.created) {
        auditExecutionId = executionId;
        const running = await this.repository.transitionToolToRunning(executionId, 0);
        if (running.applied) executionVersion = running.version;
      }
    } catch {
      // Trace persistence is deliberately best-effort and never blocks the boss's query.
    }

    const startedAt = Date.now();
    let outcome;
    try {
      // Rollback context modes keep the same server-owned batch cursor. Ordinary
      // reads also carry it so omitting the new presentation flag cannot bypass a window.
      if (name === 'read_customer_query' && !customerListContinuation) {
        try {
          customerListContinuation = await this.threadContextAssembler.loadCustomerListContinuation(
            snapshot.id,
          );
        } catch {
          // A batch snapshot rejects a cross-run read without this authorized cursor.
          // A failed restoration never grants access or falls back to a guessed offset.
        }
      }
      const batch = await this.harnessFor(snapshot).executeBatch(
        [{ id: callId, name: definition.name, arguments: args }],
        {
          user: { id: snapshot.createdById },
          role: snapshot.actorRole,
          runId: snapshot.id,
          requestId,
          asOf: snapshot.asOf,
          timeoutMs: Math.max(
            1,
            Math.min(
              TOOL_CONTEXT_TIMEOUT_MS,
              selectAssistantPrimaryRoute(
                this.routes,
                executionProfileForSnapshot(snapshot).deepRequested,
              ).config.timeoutMs,
              remainingMs,
            ),
          ),
          maxRows: this.budgetFor(snapshot).defaultRows,
          businessRuleFingerprint:
            snapshot.businessRulesVersion ?? 'assistant-agent-business-rules',
          retrievalProfile: executionProfileForSnapshot(snapshot).retrievalProfile,
          assessmentToolSurfaceMode:
            executionProfileForSnapshot(snapshot).assessmentToolSurfaceMode,
          ...(customerListContinuation ? { customerListContinuation } : {}),
        },
      );
      outcome = batch.outcomes[0];
    } catch {
      outcome = undefined;
    }
    const durationMs = Math.max(0, Date.now() - startedAt);
    if (!outcome || !outcome.ok) {
      const code = outcome?.code ?? 'TOOL_EXECUTION_FAILED';
      if (executionVersion !== null) {
        try {
          await this.repository.transitionToolToFailed(
            executionId,
            'running',
            executionVersion,
            code,
            durationMs,
            {
              budgetSnapshot: toolBudgetSnapshot(budget, this.budgetFor(snapshot)),
              terminationReason: code,
            },
          );
        } catch {
          // Best-effort trace only.
        }
      }
      return {
        ok: false,
        auditExecutionId,
        publicResult: {
          ok: false,
          code,
          message: outcome?.message ?? '查询失败，可以改用其他查询或根据已有结果回答。',
        },
      };
    }

    if (executionVersion !== null) {
      try {
        await this.repository.transitionToolToCompleted(
          executionId,
          executionVersion,
          outcome.evidence,
          durationMs,
          { budgetSnapshot: toolBudgetSnapshot(budget, this.budgetFor(snapshot)) },
        );
      } catch {
        // Best-effort trace only.
      }
    }
    const publicEvidence = structuredClone(
      snapshot.mode === 'work' ? redactWorkEvidenceForModel(outcome.evidence) : outcome.evidence,
    ) as unknown as AssistantJsonObject;
    return {
      ok: true,
      auditExecutionId,
      rawEvidence: outcome.evidence,
      publicResult: { ok: true, evidence: publicEvidence },
    };
  }
```

## 最终候选回答处理

原项目路径：`apps/api/src/modules/assistant/assistant-agent-orchestrator.ts`；范围：2215–2387 行。

```ts
export function finalizeAgentCandidate(
  candidate: AssistantAgentFinalCandidate,
  evidence: readonly ToolEvidence[],
  budgetLimited: boolean,
  signedUrls: readonly string[],
  runId?: string,
  mode: 'chat' | 'work' = 'chat',
  onValidationFailure?: (codes: readonly string[]) => void,
  failedQueries: readonly string[] = [],
  history: AssistantAgentThreadHistory = [],
): Readonly<{
  answer: ValidatedAssistantAnswer;
  usedFallback: boolean;
  documentMutation: AssistantDocumentMutationCandidate | null;
}> {
  const listPage = runId ? projectCustomerListPage(evidence, runId) : null;
  if (listPage) {
    const checked = validateAssistantAnswer({ candidate: listPage, evidence });
    if (checked.ok) return { answer: checked.answer, usedFallback: false, documentMutation: null };
    onValidationFailure?.(checked.violations.map((item) => item.code));
    throw new Error('ASSISTANT_CUSTOMER_LIST_WINDOW_INVALID');
  }
  // A model may classify a requested rewrite, but it cannot supply its source or
  // turn it into current tool evidence. History readers bind its original refs
  // before this point; the normal completion CAS still enforces revocation.
  const conversationRequested =
    candidate.kind === 'answer' && candidate.responseBasis === 'conversation';
  const conversationInput =
    conversationRequested &&
    mode === 'chat' &&
    evidence.length === 0 &&
    failedQueries.length === 0 &&
    candidate.evidenceIds.length === 0 &&
    !candidate.citations?.length &&
    !candidate.entityReferences?.length &&
    !candidate.actionSuggestions?.length &&
    !candidate.documentMutation &&
    hasAssistantHistoryAnswer(history);
  const conversationCodes =
    conversationRequested && !conversationInput ? ['CONVERSATION_BASIS_UNAVAILABLE'] : [];
  const documentMutation =
    candidate.kind === 'answer' && !conversationRequested
      ? (candidate.documentMutation ?? null)
      : null;
  const citations =
    candidate.kind === 'answer'
      ? materializeAssistantMessageCitations(
          candidate.citations?.filter((citation) =>
            candidate.evidenceIds.includes(citation.evidenceId),
          ),
          evidence,
        )
      : [];
  const citationIds = new Set(citations.map((citation) => citation.id));
  const salesAnswer =
    candidate.kind === 'answer'
      ? renderAssistantSalesAnswer(candidate.text, candidate.evidenceIds, evidence)
      : { text: '', codes: [] };
  const draft: AssistantAnswerDraft =
    candidate.kind === 'clarification'
      ? {
          text: scrubTechnicalSecrets(candidate.question, signedUrls),
          dataStatus: 'needs_clarification',
          evidenceIds: [...(candidate.evidenceIds ?? [])],
          clarification: {
            question: scrubTechnicalSecrets(candidate.question, signedUrls),
            options: (candidate.options ?? []).map((option) => ({
              ...option,
              label: scrubTechnicalSecrets(option.label, signedUrls),
              answer: scrubTechnicalSecrets(option.answer, signedUrls),
            })),
          },
          ...(candidate.continuation
            ? {
                continuation: {
                  ...structuredClone(candidate.continuation),
                  sourceRunId: requireContinuationRunId(runId),
                },
              }
            : {}),
        }
      : {
          text: sanitizeAssistantCitationMarkers(
            scrubTechnicalSecrets(
              conversationInput ? `按刚才的回答，${salesAnswer.text}` : salesAnswer.text,
              signedUrls,
            ),
            citationIds,
          ),
          dataStatus: conversationInput
            ? 'partial'
            : dataStatus(
                evidence.filter((item) => candidate.evidenceIds.includes(item.evidenceId)),
                budgetLimited,
              ),
          evidenceIds: [...candidate.evidenceIds],
          ...(citations.length > 0
            ? { citations: citations.map((citation) => ({ ...citation })) }
            : {}),
          ...(candidate.entityReferences
            ? { entityReferences: candidate.entityReferences.map((item) => ({ ...item })) }
            : {}),
          ...(candidate.actionSuggestions
            ? {
                actionSuggestions: candidate.actionSuggestions.map((suggestion, index) => ({
                  ...suggestion,
                  id: `suggestion_${index + 1}`,
                  evidenceIds: [...suggestion.evidenceIds],
                })),
              }
            : {}),
        };
  // Signed URLs come only from this run's verified image attachments. Visual
  // interpretation is advisory input, not a CRM tool read or authority to write.
  // Keep entity/citation/action/schema checks; do not fabricate tool evidence.
  const directImageInput = candidate.kind === 'answer' && signedUrls.length > 0;
  if (
    directImageInput &&
    (draft.dataStatus === 'no_data' || draft.dataStatus === 'needs_clarification')
  )
    draft.dataStatus = 'partial';
  const validated = validateAssistantAnswer(
    { candidate: draft, evidence },
    { directImageInput, conversationInput },
  );
  const documentCodes =
    validated.ok && documentMutation
      ? validateAssistantFileDocumentTables(documentMutation, evidence)
      : [];
  if (
    validated.ok &&
    documentCodes.length === 0 &&
    salesAnswer.codes.length === 0 &&
    conversationCodes.length === 0
  )
    return {
      answer: validated.answer,
      usedFallback: false,
      documentMutation,
    };

  onValidationFailure?.(
    [
      ...new Set([
        ...(!validated.ok ? validated.violations.map((item) => item.code) : []),
        ...documentCodes,
        ...salesAnswer.codes,
        ...conversationCodes,
      ]),
    ].slice(0, 20),
  );
  const fallback =
    mode === 'work'
      ? buildSafeWorkAnswerFallback(evidence, budgetLimited)
      : buildAssistantPartialAnswer(
          evidence,
          signedUrls,
          failedQueries,
          budgetLimited ? 'budget' : 'validation',
        );
  if (!budgetLimited || evidence.length === 0 || fallback.draft.dataStatus === 'partial') {
    return { answer: fallback, usedFallback: true, documentMutation };
  }
  const partialFallback = validateAssistantAnswer({
    candidate: { ...fallback.draft, dataStatus: 'partial' },
    evidence,
  });
  return {
    answer: partialFallback.ok ? partialFallback.answer : fallback,
    usedFallback: true,
    documentMutation,
  };
}
```
