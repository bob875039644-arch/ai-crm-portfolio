# 综合评估 V2：持久操作与付费调用边界

execute 方法展示冻结请求身份、预算准入、已完成回执复用、在途与结果未知分类，以及先持久化响应再由上层校验的处理。此处仅公开代码，不提供实际请求内容、凭据、限额取值或历史付费记录。

**阅读型源码节选：** 下列代码来自实际项目，保留原符号及关键逻辑。它们依赖原 NestJS 容器、shared 契约或数据库，本文件不作为独立可执行程序，也不纳入本仓库的样例测试通过数量。

## Provider operation 执行主体

原项目路径：`apps/api/src/modules/customer-assessment-v2/customer-assessment-v2-executor.service.ts`；范围：86–482 行。

```ts
  async execute(
    runId: string,
    context: CustomerAssessmentV2Context,
    repair?: CustomerAssessmentV2Repair,
    invocation: { manual?: boolean } = {},
  ): Promise<CustomerAssessmentV2Envelope> {
    const options = resolveCustomerAssessmentV2Options(this.config);
    if (options.mode === 'off')
      throw new CustomerAssessmentV2ExecutionError('ASSESSMENT_V2_DISABLED');
    if (this.provider.maxOutputTokens !== options.maxOutputTokens) {
      throw new CustomerAssessmentV2ExecutionError('ASSESSMENT_V2_PROVIDER_BUDGET_MISMATCH');
    }
    const providerRequest = this.provider.buildRequest(context, repair);
    // UTF-8 bytes plus framing allowance deliberately bound input exposure; this
    // is a reservation, not reported provider usage or a monetary invoice.
    const estimatedInputTokens = customerAssessmentV2RequestExposure(providerRequest);
    const request: FrozenRequest = {
      contract: CONTRACT,
      contractFingerprint: options.contractFingerprint,
      context,
      repair: repair ?? null,
      providerRequest,
      budget: {
        estimatedInputTokens,
        maxOutputTokens: options.maxOutputTokens,
        exposureTokens: estimatedInputTokens + options.maxOutputTokens,
      },
    };
    const requestPayload = canonicalJson(request);
    const requestHash = canonicalReceiverRequestHash(requestPayload);
    const stageAttempt = repair ? 1 : 0;
    const stage = repair ? 'validation-repair' : 'assessment';
    const operationKey = createHash('sha256')
      .update(`${CONTRACT}:${runId}:${stageAttempt}`)
      .digest('hex');
    const claim = await this.prisma.$transaction(
      async (transaction): Promise<Claim> => {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.customer.id}, 0))`;
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${BUDGET_LOCK}, 0))`;
        const now = await databaseNow(transaction);
        const run = await transaction.aiAnalysisRun.findUnique({ where: { id: runId } });
        if (!run || run.customerId !== context.customer.id) {
          return { kind: 'error', code: 'ASSESSMENT_V2_RUN_IDENTITY_CONFLICT' };
        }
        // A waiting repeatable-read prepare must refresh its cut after this
        // claim commits, before it can decide there is no unresolved dispatch.
        await transaction.customerAssessmentReviewState.updateMany({
          where: { customerId: run.customerId },
          data: { updatedAt: now },
        });
        let operation = await transaction.aiProviderOperation.findUnique({
          where: { operationKey },
        });
        if (operation) {
          // A previous release may have frozen another supported model or feedback.
          // Verify that exact historical request against the same context and
          // predecessor; never replace an already paid stage with new feedback.
          const stored = operation.requestPayload as unknown as FrozenRequest;
          const originalRepair =
            repair && stored?.repair
              ? { ...repair, fieldErrors: stored.repair.fieldErrors }
              : repair;
          if (!isCustomerAssessmentV2ReceiptContract(operation.model, operation.promptRevision)) {
            throw new CustomerAssessmentV2ExecutionError('ASSESSMENT_V2_PROVIDER_PAYLOAD_CONFLICT');
          }
          const originalProviderRequest = {
            ...this.provider.buildRequest(context, originalRepair, operation.promptRevision),
            model: operation.model,
          };
          const originalInput = customerAssessmentV2RequestExposure(originalProviderRequest);
          const originalRequest = canonicalJson({
            ...request,
            repair: originalRepair ?? null,
            providerRequest: originalProviderRequest,
            budget: {
              ...request.budget,
              estimatedInputTokens: originalInput,
              exposureTokens: originalInput + this.provider.maxOutputTokens,
            },
          });
          assertIdentity(
            operation,
            canonicalReceiverRequestHash(originalRequest),
            runId,
            stage,
            stageAttempt,
          );
          if (operation.status === 'succeeded') return { kind: 'replay', operation };
          if (operation.status === 'outcome_unknown')
            return { kind: 'error', code: 'ASSESSMENT_V2_OUTCOME_UNKNOWN' };
          if (operation.status === 'terminal_failed') {
            return { kind: 'error', code: 'ASSESSMENT_V2_PROVIDER_TERMINAL_FAILURE' };
          }
          if (operation.status === 'running') {
            if (operation.ownerLeaseExpiresAt && operation.ownerLeaseExpiresAt > now) {
              return {
                kind: 'error',
                code: 'ASSESSMENT_V2_OPERATION_IN_PROGRESS',
                retryAt: operation.ownerLeaseExpiresAt,
              };
            }
            await transaction.aiProviderOperation.updateMany({
              where: { id: operation.id, status: 'running', ownerToken: operation.ownerToken },
              data: {
                status: 'outcome_unknown',
                chargeStatus: 'charge_unknown',
                ownerToken: null,
                ownerLeaseExpiresAt: null,
                terminalAt: now,
                lastError: 'Dispatch lease expired without a durable provider receipt.',
              },
            });
            // Returning (rather than throwing in the transaction) commits quarantine.
            return { kind: 'error', code: 'ASSESSMENT_V2_OUTCOME_UNKNOWN' };
          }
          if (operation.status !== 'prepared')
            return { kind: 'error', code: 'ASSESSMENT_V2_OPERATION_CORRUPT' };
          // Historical receipts may replay, but a prepared request must never
          // start a new paid Pro call after the model policy switches to Flash.
          if (operation.model !== this.provider.model)
            return { kind: 'error', code: 'ASSESSMENT_V2_FROZEN_MODEL_POLICY_CHANGED' };
          if (operation.promptRevision !== this.provider.promptVersion)
            return { kind: 'error', code: 'ASSESSMENT_V2_FROZEN_PROMPT_POLICY_CHANGED' };
        }
        if (run.status !== 'pending')
          return { kind: 'error', code: 'ASSESSMENT_V2_RUN_NOT_PENDING' };
        // One lock domain for every V2 paid attempt, including manual/backfill/repair.
        // Read after the lock at READ COMMITTED so a waiting claim sees a committed pause.
        // Successful receipts and unknown-outcome quarantine above never spend again.
        const releaseConfigured = await readAssessmentReleaseCohort(transaction);
        const release = releaseConfigured
          ? await activeAssessmentReleaseCohort(transaction, this.config, now)
          : null;
        const releaseAllowed = await assessmentReleaseCustomerAllowed(
          transaction,
          release,
          run.customerId,
        );
        if (
          (releaseConfigured && !releaseAllowed) ||
          ((await readAssessmentExecutionControl(transaction))?.paused && !releaseAllowed)
        )
          return { kind: 'error', code: 'ASSESSMENT_V2_EXECUTION_PAUSED' };
        // A grant may commit between prepare and claim. Keep its one-time fresh
        // input requirement authoritative under the paid lock as well.
        if (
          releaseAllowed &&
          release &&
          !operation &&
          Date.parse(context.asOf) < Date.parse(release.createdAt) &&
          (await transaction.aiProviderOperation.count({ where: { runId } })) === 0
        )
          return { kind: 'error', code: 'ASSESSMENT_V2_RELEASE_INPUT_REFRESH_REQUIRED' };
        // Replays/unknown outcomes above retain their original semantics. Every NEW archive
        // dispatch, including manual entry and repairs, must pass the same server-owned gate.
        if (options.mode === 'active') {
          const archivePolicy = (
            await readArchiveCustomerPolicies(transaction, [run.customerId], now)
          ).get(run.customerId);
          const archiveHold =
            archivePolicy?.archiveOnly &&
            archiveAnalysisHold(archivePolicy.active, now, archivePolicy.ready);
          if (archiveHold) return { kind: 'error', code: archiveHold };
          if (context.archiveNightOnly && !isAssessmentBackfillWindow(now))
            return { kind: 'error', code: 'ASSESSMENT_V2_BACKFILL_WINDOW_CLOSED' };
        }
        // Durable successful receipts were returned above. Every new dispatch,
        // including repair and an already-prepared operation, observes the window.
        const backfill = await readAssessmentBackfill(transaction);
        if (backfill?.status === 'active') {
          const head = await transaction.customerAssessmentReviewState.findUnique({
            where: { customerId: run.customerId },
          });
          if (
            assessmentBackfillBlocks(
              backfill,
              {
                customerId: run.customerId,
                sourceGeneration: run.assessmentSourceGeneration ?? -1,
                requestGeneration: run.assessmentRequestGeneration ?? -1,
                currentSnapshotId: head?.currentSnapshotId,
              },
              now,
              invocation.manual,
            )
          ) {
            return { kind: 'error', code: 'ASSESSMENT_V2_BACKFILL_WINDOW_CLOSED' };
          }
        }
        const availability = await transaction.aiProviderAvailability.findUnique({
          where: { key: CUSTOMER_ANALYSIS_AVAILABILITY_KEY },
        });
        // A known 402 never expires just because time passed. An operator must
        // explicitly clear this dependency after restoring funds.
        if (availability?.lastStatus === 402 && !releaseAllowed)
          return { kind: 'error', code: 'ASSESSMENT_V2_PROVIDER_FUNDS_UNAVAILABLE' };
        if (availability?.blockedUntil && availability.blockedUntil > now) {
          return {
            kind: 'error',
            code: 'ASSESSMENT_V2_PROVIDER_COOLDOWN',
            retryAt: availability.blockedUntil,
          };
        }
        if (repair) {
          const predecessor = await transaction.aiProviderOperation.findFirst({
            where: {
              runId,
              receiverScope: CUSTOMER_ASSESSMENT_V2_PROVIDER_SCOPE,
              stage: 'assessment',
              stageAttempt: 0,
              status: 'succeeded',
            },
          });
          if (!predecessor || predecessor.resultHash !== repair.predecessorResultHash) {
            return { kind: 'error', code: 'ASSESSMENT_V2_REPAIR_IDENTITY_CONFLICT' };
          }
          readReceipt(predecessor);
        }
        if (!operation) {
          // Preparation can wait across the validity boundary. Under the same
          // customer lock, stop before creating any paid identity; the next normal
          // prepare may refresh only a run with no operations in any scope.
          // Prior admission/funds gates retain their original failure semantics.
          if (
            assessmentV2InputExpired(context, now) &&
            (await transaction.aiProviderOperation.count({ where: { runId } })) === 0
          )
            return { kind: 'error', code: 'ASSESSMENT_V2_INPUT_REFRESH_REQUIRED' };
          if (estimatedInputTokens > options.maxInputTokens)
            return { kind: 'error', code: 'ASSESSMENT_V2_INPUT_BUDGET_EXCEEDED' };
          const head =
            options.mode === 'active'
              ? await transaction.customerAssessmentReviewState.findUnique({
                  where: { customerId: run.customerId },
                })
              : null;
          const nightGrant =
            options.mode === 'active'
              ? await checkNightAllowance(transaction, run.customerId, head?.currentSnapshotId, now)
              : null;
          if (nightGrant?.blocked)
            return {
              kind: 'error',
              code: 'ASSESSMENT_V2_NIGHT_CUSTOMER_LIMIT',
              retryAt: nightGrant.retryAt,
            };
          const [usage] = await transaction.$queryRaw<
            Array<{ calls: number; customerCalls: number; tokens: string }>
          >`
          SELECT COUNT(*)::int AS "calls",
            COUNT(*) FILTER (WHERE run."customer_id" = ${context.customer.id})::int AS "customerCalls",
            COALESCE(SUM(CASE
              WHEN operation."charge_status" = 'rejected' THEN 0
              WHEN operation."input_tokens" IS NOT NULL AND operation."output_tokens" IS NOT NULL
                THEN operation."input_tokens"::bigint + operation."output_tokens"::bigint
              ELSE (operation."request_payload" #>> '{budget,exposureTokens}')::bigint
            END), 0)::text AS "tokens"
          FROM "ai_provider_operations" AS operation
          JOIN "ai_analysis_runs" AS run ON run."id" = operation."run_id"
          WHERE operation."receiver_scope" = ${CUSTOMER_ASSESSMENT_V2_PROVIDER_SCOPE}
            AND operation."night_allowance_date" IS NULL
            AND operation."created_at" >= date_trunc('day', ${now}::timestamp)
        `;
          if (!usage)
            throw new CustomerAssessmentV2ExecutionError('ASSESSMENT_V2_BUDGET_UNAVAILABLE');
          if (
            !nightGrant &&
            (usage.calls >= options.maxDailyCalls ||
              usage.customerCalls >= options.maxCallsPerCustomerDay ||
              BigInt(usage.tokens) + BigInt(request.budget.exposureTokens) >
                BigInt(options.maxDailyTokens))
          ) {
            return {
              kind: 'error',
              code: 'ASSESSMENT_V2_DAILY_BUDGET_EXCEEDED',
              retryAt: new Date(
                Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
              ),
            };
          }
          const open = await transaction.aiProviderOperation.findFirst({
            where: {
              runId,
              status: {
                in: [
                  'prepared',
                  'accepted',
                  'running',
                  'succeeded_pending_ack',
                  'terminal_failed_pending_ack',
                ],
              },
            },
          });
          if (open) return { kind: 'error', code: 'ASSESSMENT_V2_OPERATION_IN_PROGRESS' };
          operation = await transaction.aiProviderOperation.create({
            data: {
              runId,
              paidOrdinal: stageAttempt + 1,
              stage,
              stageIndex: 0,
              stageAttempt,
              operationKey,
              receiverScope: CUSTOMER_ASSESSMENT_V2_PROVIDER_SCOPE,
              nightAllowanceDate: nightGrant?.night ?? null,
              provider: 'deepseek',
              model: this.provider.model,
              promptRevision: this.provider.promptVersion,
              contractRevision: CONTRACT,
              requestPayload,
              requestHash,
              predecessorResultHash: repair?.predecessorResultHash ?? null,
              status: 'prepared',
              chargeStatus: 'not_sent',
              createdAt: now,
            },
          });
        }
        if (
          operation.nightAllowanceDate &&
          (!isAssessmentBackfillWindow(now) || operation.nightAllowanceDate !== allowanceNight(now))
        )
          return { kind: 'error', code: 'ASSESSMENT_V2_BACKFILL_WINDOW_CLOSED' };
        const ownerToken = randomUUID();
        const started = await transaction.aiProviderOperation.updateMany({
          where: { id: operation.id, status: 'prepared' },
          data: {
            status: 'running',
            chargeStatus: 'exposed',
            ownerToken,
            ownerLeaseExpiresAt: new Date(now.getTime() + options.requestTimeoutMs + 60_000),
            firstSubmittedAt: now,
          },
        });
        if (started.count !== 1)
          return { kind: 'error', code: 'ASSESSMENT_V2_OPERATION_IN_PROGRESS' };
        return { kind: 'execute', operation, ownerToken };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 5_000,
        timeout: 15_000,
      },
    );
    if (claim.kind === 'error')
      throw new CustomerAssessmentV2ExecutionError(claim.code, claim.retryAt);
    if (claim.kind === 'replay') return readReceipt(claim.operation);

    const frozen = claim.operation.requestPayload as unknown as FrozenRequest;
    const fundsIdentity = this.provider.fundsIdentity ?? null;
    let receipt: CustomerAssessmentV2Envelope;
    try {
      receipt = await this.provider.requestFrozen(frozen.providerRequest);
    } catch (error) {
      await this.persistFailure(claim.operation, claim.ownerToken, error, fundsIdentity);
      throw error;
    }
    // Only receipt capture is retried. The provider request is never repeated here.
    const resultPayload = canonicalJson(receipt);
    const resultHash = canonicalReceiverRequestHash(resultPayload);
    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
      try {
        const saved = await this.prisma.aiProviderOperation.updateMany({
          where: { id: claim.operation.id, status: 'running', ownerToken: claim.ownerToken },
          data: {
            status: 'succeeded',
            resultPayload,
            resultHash,
            ownerToken: null,
            ownerLeaseExpiresAt: null,
            terminalAt: await databaseNow(this.prisma),
            chargeStatus: receipt.usage ? 'charged_estimated' : 'charge_unknown',
            providerRequestId: receipt.providerRequestId ?? null,
            inputTokens: receipt.usage?.inputTokens ?? null,
            outputTokens: receipt.usage?.outputTokens ?? null,
            inputCacheHitTokens: receipt.usage?.inputCacheHitTokens ?? null,
            inputCacheMissTokens: receipt.usage?.inputCacheMissTokens ?? null,
            reasoningTokens: receipt.usage?.reasoningTokens ?? null,
            rawUsage: receipt.usage?.raw ? canonicalJson(receipt.usage.raw) : Prisma.DbNull,
          },
        });
        if (saved.count === 1) return receipt;
        const stored = await this.prisma.aiProviderOperation.findUnique({
          where: { id: claim.operation.id },
        });
        if (stored?.status === 'succeeded' && stored.resultHash === resultHash)
          return readReceipt(stored);
        throw new CustomerAssessmentV2ExecutionError('ASSESSMENT_V2_RESULT_CAPTURE_FENCED');
      } catch (error) {
        if (error instanceof CustomerAssessmentV2ExecutionError) throw error;
        if (attempt === CAPTURE_ATTEMPTS - 1) {
          throw new CustomerAssessmentV2ExecutionError('ASSESSMENT_V2_RESULT_CAPTURE_FAILED');
        }
      }
    }
    throw new CustomerAssessmentV2ExecutionError('ASSESSMENT_V2_RESULT_CAPTURE_FAILED');
  }
```
