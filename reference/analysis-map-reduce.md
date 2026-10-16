# AI 分析管道：长上下文 Map / Reduce

该片段来自原项目的单次/增量/重建分析链路。它与综合评估 V2 是需要区分的代码路径，不代表所有当前客户评估都经过 Map/Reduce。阅读分块计划、并发 map、分层 reduce、预算与消息轮次边界；所引用的周边类和状态不在本节复制。

**阅读型源码节选：** 下列代码来自实际项目，保留原符号及关键逻辑。它们依赖原 NestJS 容器、shared 契约或数据库，本文件不作为独立可执行程序，也不纳入本仓库的样例测试通过数量。

## 选择 single 或分块分析

原项目路径：`apps/api/src/modules/ai/ai.service.ts`；范围：3688–3756 行。

```ts
  private async runProviderAnalysis(
    context: LoadedAnalysisContext,
    providerAttemptPolicy?: MediaImportOwnedProviderAttemptPolicy,
    whatsappInboundAttemptPolicy?: WhatsappInboundProviderAttemptPolicy,
    scoringProviderAttemptTracker?: ScoringRecalculationProviderAttemptTracker,
  ): Promise<AnalysisRun> {
    const productCatalogInput = JSON.stringify({
      productCatalogSnapshot: context.productCatalogSnapshot,
      productCatalogFingerprint: context.productCatalogFingerprint,
    });
    const productCatalogTokenCount = providerAttemptPolicy
      ? mediaImportEstimateTokensV1(productCatalogInput)
      : this.provider.estimateTokens(productCatalogInput);
    if (providerAttemptPolicy) {
      if (productCatalogTokenCount >= providerAttemptPolicy.frozenPipeline.inputBudgetTokenLimit) {
        throw inputBudgetExhausted(
          productCatalogTokenCount,
          providerAttemptPolicy.frozenPipeline.inputBudgetTokenLimit,
          '目录固定开销',
        );
      }
    } else {
      this.assertFixedInputBudget(productCatalogTokenCount);
    }

    if (
      providerAttemptPolicy
        ? providerAttemptPolicy.frozenPipeline.initialMode === 'map_reduce'
        : context.needsChunking
    ) {
      return this.runMapReduce(
        context,
        providerAttemptPolicy,
        whatsappInboundAttemptPolicy,
        scoringProviderAttemptTracker,
      );
    }

    try {
      return {
        providerResult: await this.callProviderWithRetry(
          { ...context, analysisMode: 'single' },
          providerAttemptPolicy,
          { stage: 'single', stageIndex: 0, predecessorResultHash: null },
          whatsappInboundAttemptPolicy,
          scoringProviderAttemptTracker,
        ),
        analysisMode: 'single',
        chunkCount: 1,
      };
    } catch (error) {
      if (
        providerAttemptPolicy
          ? !(
              error instanceof MediaImportReceiverTerminalError &&
              error.receiverCode === 'context_length_exceeded'
            )
          : !isContextLengthError(error)
      ) {
        throw error;
      }
      return this.runMapReduce(
        { ...context, needsChunking: true },
        providerAttemptPolicy,
        whatsappInboundAttemptPolicy,
        scoringProviderAttemptTracker,
      );
    }
  }
```

## Map 执行与结果收集

原项目路径：`apps/api/src/modules/ai/ai.service.ts`；范围：3758–3924 行。

```ts
  private async runMapReduce(
    context: LoadedAnalysisContext,
    providerAttemptPolicy?: MediaImportOwnedProviderAttemptPolicy,
    whatsappInboundAttemptPolicy?: WhatsappInboundProviderAttemptPolicy,
    scoringProviderAttemptTracker?: ScoringRecalculationProviderAttemptTracker,
  ): Promise<AnalysisRun> {
    let chunks = providerAttemptPolicy
      ? materializeFrozenChunkPlan(context, providerAttemptPolicy.frozenPipeline)
      : this.buildMapChunks(context, context.messages, [], context.previousAnalysis);
    refreshRootMessageOmissionBudget(context, chunks, providerAttemptPolicy?.frozenPipeline);
    const chunkResults: AnalyzeCustomerChunkResult[] = [];
    let carry = context.previousAnalysis;
    let model = 'unknown';
    let promptVersion = 'map-reduce';
    let tokensIn = 0;
    let tokensOut = 0;
    let predecessorResultHash: string | null = null;

    for (let index = 0; index < chunks.length; index += 1) {
      let chunk = chunks[index]!;
      let chunkBudget = this.estimateContextBudget(
        {
          customer: context.customer,
          previousAnalysis: carry,
          messages: chunk.messages,
          overlapMessages: chunk.overlapMessages,
          manualNotes: context.manualNotes,
          strategicDimensions: context.strategicDimensions,
          configFingerprint: context.configFingerprint,
          productCatalogSnapshot: context.productCatalogSnapshot,
          productCatalogFingerprint: context.productCatalogFingerprint,
          ...(context.semanticImpactObserve
            ? { semanticImpactObserve: context.semanticImpactObserve }
            : {}),
        },
        providerAttemptPolicy ? mediaImportEstimateTokensV1 : undefined,
        providerAttemptPolicy
          ? frozenBudgetProvider(providerAttemptPolicy.frozenPipeline)
          : undefined,
        providerAttemptPolicy?.frozenPipeline.inputBudgetTokenLimit,
      );
      if (providerAttemptPolicy) {
        chunkBudget.omittedMessageCount =
          providerAttemptPolicy.frozenPipeline.operationPlan.omittedMessageCount;
        chunkBudget.omittedMediaCount +=
          providerAttemptPolicy.frozenPipeline.operationPlan.omittedMediaCount;
      }
      let chunkContext: AnalyzeCustomerContext = {
        ...context,
        messages: chunk.messages,
        overlapMessages: chunk.overlapMessages,
        previousAnalysis: carry,
        chunkResults: [],
        analysisMode: 'map',
        chunkIndex: index,
        chunkCount: chunks.length,
        estimatedTokenCount: chunkBudget.estimatedTotalTokens,
        contextBudget: chunkBudget,
        needsChunking: false,
      };
      if (
        chunkContext.estimatedTokenCount >
        (providerAttemptPolicy
          ? providerAttemptPolicy.frozenPipeline.inputBudgetTokenLimit
          : inputBudgetTokenLimit(this.provider))
      ) {
        if (providerAttemptPolicy) {
          throw inputBudgetExhausted(
            chunkContext.estimatedTokenCount,
            providerAttemptPolicy.frozenPipeline.inputBudgetTokenLimit,
            `冻结 map[${index}]`,
          );
        }
        const remainingMessages = chunks
          .slice(index)
          .flatMap((remainingChunk) => remainingChunk.messages);
        const rebuiltChunks = this.buildMapChunks(
          context,
          remainingMessages,
          chunks[index - 1]?.messages ?? [],
          carry,
          this.pipelineOptions,
          inputBudgetTokenLimit(this.provider),
        );
        chunks = [...chunks.slice(0, index), ...rebuiltChunks];
        refreshRootMessageOmissionBudget(context, chunks);
        chunk = chunks[index]!;
        chunkBudget = this.estimateContextBudget({
          customer: context.customer,
          previousAnalysis: carry,
          messages: chunk.messages,
          overlapMessages: chunk.overlapMessages,
          manualNotes: context.manualNotes,
          strategicDimensions: context.strategicDimensions,
          configFingerprint: context.configFingerprint,
          productCatalogSnapshot: context.productCatalogSnapshot,
          productCatalogFingerprint: context.productCatalogFingerprint,
          ...(context.semanticImpactObserve
            ? { semanticImpactObserve: context.semanticImpactObserve }
            : {}),
        });
        chunkContext = {
          ...context,
          messages: chunk.messages,
          overlapMessages: chunk.overlapMessages,
          previousAnalysis: carry,
          chunkResults: [],
          analysisMode: 'map',
          chunkIndex: index,
          chunkCount: chunks.length,
          estimatedTokenCount: chunkBudget.estimatedTotalTokens,
          contextBudget: chunkBudget,
          needsChunking: false,
        };
      }
      const mapResult = await this.callProviderWithRetry(
        chunkContext,
        providerAttemptPolicy,
        { stage: 'map', stageIndex: index, predecessorResultHash },
        whatsappInboundAttemptPolicy,
        scoringProviderAttemptTracker,
      );
      model = mapResult.model;
      promptVersion = mapResult.promptVersion;
      tokensIn += mapResult.tokensIn;
      tokensOut += mapResult.tokensOut;
      const chunkResult = toChunkResult(
        mapResult.output,
        chunk.messages,
        providerAttemptPolicy ? context.inputWindowStartedAt : undefined,
        mapResult.semanticObserve?.kind === 'observation'
          ? mapResult.semanticObserve.observation
          : undefined,
      );
      chunkResults.push(chunkResult);
      carry = toCarryForwardFromChunk(chunkResult);
      predecessorResultHash = canonicalReceiverRequestHash(mapResult);
    }

    const reduceResult = await this.reduceChunkResults(
      context,
      chunkResults.map((chunk) => ({ ...chunk, signals: [] })),
      chunks.length,
      providerAttemptPolicy,
      whatsappInboundAttemptPolicy,
      scoringProviderAttemptTracker,
    );
    const mergedSignals = validateMergedSignals(
      dedupeSignals(chunkResults.flatMap((chunk) => chunk.signals)),
    );

    return {
      providerResult: {
        ...reduceResult,
        model: reduceResult.model || model,
        promptVersion: reduceResult.promptVersion || promptVersion,
        tokensIn: tokensIn + reduceResult.totalTokensIn,
        tokensOut: tokensOut + reduceResult.totalTokensOut,
        output: {
          ...reduceResult.output,
          signals: mergedSignals,
        },
      },
      analysisMode: 'map_reduce',
      chunkCount: chunks.length,
    };
  }
```

## 分层 Reduce

原项目路径：`apps/api/src/modules/ai/ai.service.ts`；范围：3926–4030 行。

```ts
  private async reduceChunkResults(
    context: LoadedAnalysisContext,
    initialResults: AnalyzeCustomerChunkResult[],
    originalChunkCount: number,
    providerAttemptPolicy?: MediaImportOwnedProviderAttemptPolicy,
    whatsappInboundAttemptPolicy?: WhatsappInboundProviderAttemptPolicy,
    scoringProviderAttemptTracker?: ScoringRecalculationProviderAttemptTracker,
  ): Promise<
    ValidatedCustomerAnalysisProviderResult & {
      totalTokensIn: number;
      totalTokensOut: number;
    }
  > {
    let pending = initialResults;
    let stageIndex = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;

    while (true) {
      const fullContext = this.createReduceContext(
        context,
        pending,
        originalChunkCount,
        providerAttemptPolicy,
      );
      if (fullContext.estimatedTokenCount <= fullContext.contextBudget!.inputTokenLimit) {
        const finalResult = await this.callProviderWithRetry(
          fullContext,
          providerAttemptPolicy,
          {
            stage: 'reduce',
            stageIndex,
            predecessorResultHash: canonicalReceiverRequestHash(toCanonicalJsonValue(pending)),
          },
          whatsappInboundAttemptPolicy,
          scoringProviderAttemptTracker,
        );
        return {
          ...finalResult,
          totalTokensIn: totalTokensIn + finalResult.tokensIn,
          totalTokensOut: totalTokensOut + finalResult.tokensOut,
        };
      }

      if (pending.length === 1 && !pending[0]!.omittedForBudget) {
        // A frozen one-map plan must stay completable even when a valid map output reaches
        // every schema maximum. Compact only the provider input copy, retain the message
        // range, and surface the omission through the standard context budget/result contract.
        pending = [compactChunkResultForBudget(pending[0]!)];
        continue;
      }

      const batches = this.buildReduceBatches(
        context,
        pending,
        originalChunkCount,
        providerAttemptPolicy,
      );
      const next: AnalyzeCustomerChunkResult[] = [];
      for (const batch of batches) {
        if (batch.length === 1) {
          next.push(batch[0]!);
          continue;
        }
        const batchContext = this.createReduceContext(
          context,
          batch,
          originalChunkCount,
          providerAttemptPolicy,
        );
        const result = await this.callProviderWithRetry(
          batchContext,
          providerAttemptPolicy,
          {
            stage: 'reduce',
            stageIndex,
            predecessorResultHash: canonicalReceiverRequestHash(toCanonicalJsonValue(batch)),
          },
          whatsappInboundAttemptPolicy,
          scoringProviderAttemptTracker,
        );
        stageIndex += 1;
        totalTokensIn += result.tokensIn;
        totalTokensOut += result.tokensOut;
        next.push(
          toReducedChunkResult(
            result.output,
            batch,
            context.inputWindowStartedAt,
            result.semanticObserve?.kind === 'candidate'
              ? candidateAsObservation(result.semanticObserve.candidate)
              : undefined,
          ),
        );
      }
      if (next.length >= pending.length) {
        throw inputBudgetExhausted(
          fullContext.estimatedTokenCount,
          fullContext.contextBudget!.inputTokenLimit,
          'reduce 分层合并',
        );
      }
      pending = next;
    }
  }
```

## 按预算和轮次构造消息分块

原项目路径：`apps/api/src/modules/ai/ai.service.ts`；范围：7173–7238 行。

```ts
function buildMessageChunks(
  messages: AnalyzeCustomerContext['messages'],
  options: AiPipelineOptions,
  inputTokenLimit: number,
  estimateChunkTokens: (
    messages: AnalyzeCustomerContext['messages'],
    overlapMessages: AnalyzeCustomerContext['messages'],
  ) => number,
  previousPrimaryMessages: AnalyzeCustomerContext['messages'] = [],
  onMessageTruncated?: (
    message: AnalyzeCustomerContext['messages'][number],
    truncatedMessage: AnalyzeCustomerContext['messages'][number],
  ) => void,
): MessageChunk[] {
  const pendingUnits = groupChronologicalTurns(messages);
  const chunks: MessageChunk[] = [];
  let currentMessages: AnalyzeCustomerContext['messages'] = [];
  let currentOverlap: AnalyzeCustomerContext['messages'] = [];

  while (pendingUnits.length > 0) {
    const unit = pendingUnits.shift()!;
    if (currentMessages.length > 0) {
      const combined = [...currentMessages, ...unit];
      const staysInConversation = currentMessages[0]?.conversationId === unit[0]?.conversationId;
      if (staysInConversation && estimateChunkTokens(combined, currentOverlap) <= inputTokenLimit) {
        currentMessages = combined;
        continue;
      }
      chunks.push({ messages: currentMessages, overlapMessages: currentOverlap });
      currentMessages = [];
      currentOverlap = [];
      pendingUnits.unshift(unit);
      continue;
    }

    const previousMessages = chunks.at(-1)?.messages ?? previousPrimaryMessages;
    const overlapMessages = fittingOverlap(
      previousMessages,
      unit,
      options.chunkOverlapMessages,
      inputTokenLimit,
      estimateChunkTokens,
    );
    if (estimateChunkTokens(unit, overlapMessages) <= inputTokenLimit) {
      currentMessages = unit;
      currentOverlap = overlapMessages;
      continue;
    }
    if (unit.length > 1) {
      const midpoint = Math.ceil(unit.length / 2);
      pendingUnits.unshift(unit.slice(0, midpoint), unit.slice(midpoint));
      continue;
    }

    const message = unit[0]!;
    const truncatedMessage = truncateMessageToBudget(message, inputTokenLimit, estimateChunkTokens);
    onMessageTruncated?.(message, truncatedMessage);
    currentMessages = [truncatedMessage];
    currentOverlap = [];
  }

  if (currentMessages.length > 0) {
    chunks.push({ messages: currentMessages, overlapMessages: currentOverlap });
  }
  return chunks;
}
```
