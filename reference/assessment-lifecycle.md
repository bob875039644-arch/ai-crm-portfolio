# 综合评估 V2：准备、调用、发布与过期结果

这是独立综合评估链路：冻结输入和请求身份，读取已持久化回执，验证输出；必要时使用带 predecessor identity 的修复阶段。发布采用客户锁、来源代次、合同和模式检查，过期或被超越的结果保留历史，不能刷新为当前结果。真实运行与费用状态未在本展示中核验。

**阅读型源码节选：** 下列代码来自实际项目，保留原符号及关键逻辑。它们依赖原 NestJS 容器、shared 契约或数据库，本文件不作为独立可执行程序，也不纳入本仓库的样例测试通过数量。

## 分析与失败分类

原项目路径：`apps/api/src/modules/customer-assessment-v2/customer-assessment-v2.service.ts`；范围：96–272 行。

```ts
  async analyze(
    customerId: string,
    request: { manual?: boolean } = {},
  ): Promise<CustomerAssessmentV2Snapshot | null> {
    if (this.mode === 'off') return null;
    let prepared: PreparedAssessment | null;
    try {
      prepared = await this.prepare(customerId, request);
    } catch (error) {
      if (!(error instanceof AssessmentInputPreparationError)) throw error;
      // prepare's repeatable-read transaction has rolled back. Record only if
      // the source/request/contract/run still describe the same failed cut.
      if (await this.recordPreparationInputBlock(customerId, error.block)) {
        this.logInputBlock(customerId, error.block);
      }
      throw new CustomerAssessmentV2ExecutionError(error.block.errorCode);
    }
    if (!prepared) return null;
    const { run } = prepared;
    const existing = await this.prisma.customerAssessmentV2Snapshot.findUnique({
      where: { runId: run.id },
    });
    if (existing) {
      if (request.manual) await this.assertManualRequestSettled(run, existing);
      return existing;
    }
    const context = readFrozenContext(run);
    let published: CustomerAssessmentV2Snapshot;
    try {
      let result = prepared.recoveredResult;
      if (!result) {
        const receipt = await this.executor.execute(run.id, context, undefined, request);
        try {
          result = parseCustomerAssessmentV2Result(receipt, context);
        } catch (error) {
          if (!(error instanceof ZodError)) throw error;
          const repaired = await this.executor.execute(
            run.id,
            context,
            {
              predecessorResultHash: canonicalReceiverRequestHash(
                JSON.parse(JSON.stringify(receipt)),
              ),
              fieldErrors: assessmentValidationFeedback(error),
            },
            request,
          );
          result = parseCustomerAssessmentV2Result(repaired, context);
        }
      }
      published = await this.publish(run, context, result);
    } catch (error) {
      if (
        error instanceof CustomerAssessmentV2ExecutionError &&
        [
          'ASSESSMENT_V2_EXECUTION_PAUSED',
          'ASSESSMENT_V2_RELEASE_INPUT_REFRESH_REQUIRED',
          'ASSESSMENT_V2_INPUT_REFRESH_REQUIRED',
          'ASSESSMENT_V2_BACKFILL_WINDOW_CLOSED',
          'ASSESSMENT_V2_ARCHIVE_INACTIVE',
          'ASSESSMENT_V2_ARCHIVE_IMPORT_PENDING',
        ].includes(error.code)
      ) {
        // This temporary scheduling hold must not replace budget/cooldown
        // notBefore or block a later source update. The five-minute scan resumes it.
        return null;
      }
      if (
        error instanceof CustomerAssessmentV2ExecutionError &&
        error.code === 'ASSESSMENT_V2_OPERATION_IN_PROGRESS'
      ) {
        if (request.manual) throw error;
        return null;
      }
      const code =
        error instanceof CustomerAssessmentV2ExecutionError
          ? error.code
          : error instanceof ZodError
            ? 'ASSESSMENT_V2_VALIDATION_FAILED'
            : 'ASSESSMENT_V2_RUN_FAILED';
      const retryAt =
        error instanceof CustomerAssessmentV2ExecutionError && error.retryAt
          ? error.retryAt
          : new Date(Date.now() + 15 * 60_000);
      let effectiveCode = code;
      const budgetDay = new Date(retryAt.getTime() - 86_400_000).toISOString().slice(0, 10);
      const tracksHeadTransition =
        isAssessmentInputBudgetCode(code) || code === 'ASSESSMENT_V2_DAILY_BUDGET_EXCEEDED';
      const enteredWait = await this.prisma.$transaction(async (tx) => {
        // Serialize the new head-bound transitions only. A terminal failure's
        // generation CAS must still allow funds recovery to fence the old catch.
        if (tracksHeadTransition) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${customerId}, 0))`;
          await tx.$queryRaw`SELECT "id" FROM "customers" WHERE "id" = ${customerId} FOR UPDATE`;
          await tx.$queryRaw`SELECT "customer_id" FROM "customer_assessment_review_states" WHERE "customer_id" = ${customerId} FOR UPDATE`;
        }
        const head = tracksHeadTransition
          ? await tx.customerAssessmentReviewState.findUnique({ where: { customerId } })
          : null;
        const operations = await tx.aiProviderOperation.findMany({
          where: { runId: run.id, receiverScope: CUSTOMER_ASSESSMENT_V2_PROVIDER_SCOPE },
          select: { status: true },
        });
        const terminalCode = operations.some((operation) => operation.status === 'outcome_unknown')
          ? 'ASSESSMENT_V2_OUTCOME_UNKNOWN'
          : operations.some((operation) => operation.status === 'terminal_failed')
            ? 'ASSESSMENT_V2_TERMINAL_PROVIDER_FAILURE'
            : error instanceof ZodError
              ? 'ASSESSMENT_V2_TERMINAL_VALIDATION_FAILURE'
              : null;
        effectiveCode = terminalCode ?? code;
        await tx.aiAnalysisRun.updateMany({
          where: { id: run.id, status: { notIn: ['complete', 'superseded'] } },
          data: { status: 'failed', failedAt: new Date(), failureMessage: terminalCode ?? code },
        });
        const inputFailure = !terminalCode && isAssessmentInputBudgetCode(code);
        const inputBlock: AssessmentInputBlock | null =
          inputFailure &&
          run.assessmentContractFingerprint &&
          (await resolveCustomerAssessmentV2CurrentContract(this.config, tx)) ===
            run.assessmentContractFingerprint
            ? {
                schemaVersion: 1,
                errorCode: code as AssessmentInputBlock['errorCode'],
                sourceGeneration: run.assessmentSourceGeneration ?? -1,
                requestGeneration: run.assessmentRequestGeneration ?? -1,
                contractFingerprint: run.assessmentContractFingerprint,
                activeRunId: run.id,
              }
            : null;
        const updated = await tx.customerAssessmentReviewState.updateMany({
          where: {
            customerId,
            activeRunId: run.id,
            sourceGeneration: run.assessmentSourceGeneration ?? -1,
            requestGeneration: run.assessmentRequestGeneration ?? -1,
          },
          data: {
            lastFailure: terminalCode ?? code,
            notBefore: terminalCode ? null : inputFailure ? head?.notBefore : retryAt,
            ...(inputBlock ? { inputBlock: json(inputBlock) } : {}),
            ...(!terminalCode && code === 'ASSESSMENT_V2_DAILY_BUDGET_EXCEEDED'
              ? { budgetWaitDate: new Date(`${budgetDay}T00:00:00Z`) }
              : {}),
          },
        });
        if (updated.count === 0) return false;
        if (inputBlock) {
          const prior = currentAssessmentInputBlock(head?.inputBlock, inputBlock);
          return prior?.errorCode !== inputBlock.errorCode;
        }
        if (inputFailure) return false;
        if (!terminalCode && code === 'ASSESSMENT_V2_DAILY_BUDGET_EXCEEDED')
          return head?.budgetWaitDate?.toISOString().slice(0, 10) !== budgetDay;
        return true;
      });
      if (isAssessmentInputBudgetCode(effectiveCode)) {
        if (enteredWait) this.logInputBlock(customerId, { errorCode: effectiveCode });
      } else if (effectiveCode === 'ASSESSMENT_V2_DAILY_BUDGET_EXCEEDED') {
        if (enteredWait)
          this.logger.log({
            event: 'assessment_budget_wait',
            customerId,
            errorCode: code,
            budgetDayUtc: budgetDay,
            retryAt: retryAt.toISOString(),
          });
      } else {
        this.logger.warn(`Unified assessment deferred: ${effectiveCode}.`);
      }
      throw error;
    }
    // Publication is durable before asking the same manual queue job to resume a
    // newer source/request. This continuation must not mark the old run failed.
    if (request.manual) await this.assertManualRequestSettled(run, published);
    return published;
  }
```

## 短事务内发布与版本复核

原项目路径：`apps/api/src/modules/customer-assessment-v2/customer-assessment-v2.service.ts`；范围：811–929 行。

```ts
  private async publish(
    run: AiAnalysisRun,
    context: CustomerAssessmentV2Context,
    result: CustomerAssessmentV2Output,
  ): Promise<CustomerAssessmentV2Snapshot> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${run.customerId}, 0))`;
        await tx.$queryRaw`SELECT "id" FROM "customers" WHERE "id" = ${run.customerId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "customer_id" FROM "customer_assessment_review_states" WHERE "customer_id" = ${run.customerId} FOR UPDATE`;
        const existing = await tx.customerAssessmentV2Snapshot.findUnique({
          where: { runId: run.id },
        });
        if (existing) return existing;
        const head = await tx.customerAssessmentReviewState.findUniqueOrThrow({
          where: { customerId: run.customerId },
        });
        const options = resolveCustomerAssessmentV2Options(this.config);
        const currentContract = await resolveCustomerAssessmentV2CurrentContract(this.config, tx);
        const [{ now }] = await tx.$queryRaw<
          Array<{ now: Date }>
        >`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
        // A paid receipt describes its frozen asOf. Delayed publication/recovery
        // must never grant it a fresh validity window or a newer business date.
        const asOfMs = Date.parse(context.asOf);
        const requestedReview = result.nextReviewAt
          ? Date.parse(result.nextReviewAt)
          : asOfMs + ASSESSMENT_V2_MAX_VALIDITY_MS;
        const nextReviewAt = new Date(
          Math.max(
            asOfMs + 30_000,
            Math.min(requestedReview, asOfMs + ASSESSMENT_V2_MAX_VALIDITY_MS),
          ),
        );
        const expired = nextReviewAt <= now;
        const current =
          !expired &&
          head.sourceGeneration === run.assessmentSourceGeneration &&
          currentContract === run.assessmentContractFingerprint &&
          options.mode === run.assessmentMode &&
          head.activeRunId === run.id;
        const publication = !current
          ? 'superseded'
          : options.mode === 'active'
            ? 'published'
            : 'shadow';
        const thresholdsRow = await tx.setting.findUnique({
          where: { key: GRADE_THRESHOLD_OVERRIDE_SETTING_KEY },
          select: { value: true },
        });
        const override = gradeThresholdOverrideSchema.safeParse(thresholdsRow?.value);
        const thresholds = resolveGradeThresholds(override.success ? override.data : null);
        const finalGrade = result.score === null ? null : gradeForScore(result.score, thresholds);
        const content = {
          customerId: run.customerId,
          runId: run.id,
          sourceGeneration: run.assessmentSourceGeneration!,
          sourceFingerprint: context.sourceFingerprint,
          contractFingerprint: run.assessmentContractFingerprint!,
          asOf: new Date(context.asOf),
          nextReviewAt,
          publication,
          result: json(result),
          finalScore: result.score,
          finalGrade,
        };
        const contentHash = assessmentV2Hash(content);
        const snapshot = await tx.customerAssessmentV2Snapshot.create({
          data: { id: `assessment_v2_${contentHash}`, ...content, contentHash },
        });
        await tx.aiAnalysisRun.update({
          where: { id: run.id },
          data: {
            status: current ? 'complete' : 'superseded',
            completedAt: now,
            failureMessage: null,
          },
        });
        if (current) {
          await tx.customerAssessmentReviewState.updateMany({
            where: { customerId: run.customerId, activeRunId: run.id },
            data: {
              activeRunId: null,
              pendingSince:
                head.requestGeneration === run.assessmentRequestGeneration
                  ? null
                  : (head.pendingSince ?? now),
              notBefore: null,
              lastFailure: null,
              inputBlock: Prisma.DbNull,
              lastCompletedGeneration: run.assessmentSourceGeneration,
              lastContractFingerprint: currentContract,
              nextReviewAt,
              ...(publication === 'published' ? { currentSnapshotId: snapshot.id } : {}),
            },
          });
        } else {
          await tx.customerAssessmentReviewState.updateMany({
            where: { customerId: run.customerId, activeRunId: run.id },
            data: {
              activeRunId: null,
              pendingSince: head.pendingSince ?? now,
              inputBlock: Prisma.DbNull,
              notBefore: null,
              // A due marker yields a new request fingerprint after resume;
              // otherwise the expired completed run would suppress fresh work.
              ...(expired ? { nextReviewAt } : {}),
            },
          });
        }
        if (publication === 'published') {
          await projectPublished(tx, run.customerId, result, finalGrade);
          await recordPaymentAlerts(tx, context, result, snapshot.id);
        }
        return snapshot;
      },
      { maxWait: 5_000, timeout: 15_000 },
    );
  }
```
