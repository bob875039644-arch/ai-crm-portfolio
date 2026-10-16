# MAX：结构化查询与语义候选读取工具

观察 query_customers / read_customer_query 的 schema、只读标记、工具到领域服务的委派及结果映射。结构化条件总数与语义发现候选数分别表达，不把候选池当作已经验证的语义匹配集合。

**阅读型源码节选：** 下列代码来自实际项目，保留原符号及关键逻辑。它们依赖原 NestJS 容器、shared 契约或数据库，本文件不作为独立可执行程序，也不纳入本仓库的样例测试通过数量。

## 查询工具定义

原项目路径：`apps/api/src/modules/assistant/assistant-customer-query-tools.ts`；范围：完整文件。

```ts
import {
  queryCustomersInputSchema,
  readCustomerQueryInputSchema,
  customerQueryOutputSchema,
} from '@ai-crm/shared';
import { BadRequestException } from '@nestjs/common';
import {
  AssistantToolError,
  defineAssistantTool,
  type ToolEvidenceInput,
} from './assistant-tool-registry';
import { ASSISTANT_CAPABILITIES } from './assistant-capabilities';
import type { CustomerQueryService } from './customer-query.service';
export function createAssistantCustomerQueryTools(service?: CustomerQueryService) {
  const map = (raw: unknown): ToolEvidenceInput => {
    const output = customerQueryOutputSchema.parse(raw);
    const receipt = output.receipt;
    // A requested batch is a complete answer window even when later batches exist.
    // The full frozen count remains authoritative in the receipt and metric fact.
    const windowCount = receipt.displayWindow
      ? Math.min(
          receipt.displayWindow.pageSize,
          Math.max(0, receipt.structuredCount - receipt.offset),
        )
      : null;
    return {
      status: receipt.mode === 'structured' ? 'complete' : 'partial',
      total: windowCount ?? receipt.candidateCount,
      truncated:
        windowCount === null ? receipt.nextOffset !== null : output.customers.length < windowCount,
      warnings:
        receipt.mode === 'structured'
          ? []
          : ['这是发现候选；尚未逐客核实组合条件，不能据此给出语义匹配总数。'],
      facts: [
        ...(receipt.mode === 'structured'
          ? [
              {
                metric: 'structuredCustomerCount',
                value: receipt.structuredCount,
                filters: receipt.filters,
                asOf: receipt.asOf,
                definition: '档案条件的精确客户总数，包含成功查询得到的零值；名单分页不改变总数。',
              },
            ]
          : []),
        ...output.customers,
      ],
      links: output.customers.map((c) => ({
        kind: 'customer' as const,
        id: c.customerId,
        label: c.customerLabel,
        href: `/customers/${encodeURIComponent(c.customerId)}`,
      })),
      coverage: {
        schemaVersion: 1,
        scope: 'customer_candidates',
        customerIds: output.customers.map((c) => c.customerId),
        sourceAsOf: receipt.asOf,
        timeSemantics: 'source_cutoff_current_content',
        selection: receipt.mode === 'lexical_candidates' ? 'lexical' : receipt.mode,
        completeness: 'page',
        stopReason: receipt.candidatePoolCapped
          ? 'candidate_limit'
          : receipt.nextOffset
            ? 'record_limit'
            : 'source_end',
        from: receipt.from,
        to: receipt.asOf,
        sourceKinds: ['message', 'note'],
        indexCoverageKnown: false,
        preSimilarityCapped: false,
        query: receipt,
        totalRecords: windowCount ?? receipt.candidateCount,
        returnedRecords: output.customers.length,
      },
    };
  };
  return [
    defineAssistantTool({
      name: 'query_customers',
      version: ASSISTANT_CAPABILITIES[0]!.version,
      readOnly: true,
      inputSchema: queryCustomersInputSchema,
      outputSchema: customerQueryOutputSchema,
      timeoutMs: 60_000,
      maxRows: 20,
      cachePolicy: 'none',
      execute: async (raw, context, signal) => {
        signal.throwIfAborted();
        if (!service) throw new Error('ASSISTANT_QUERY_SERVICE_UNAVAILABLE');
        return withReferenceRecovery(() =>
          service.query(queryCustomersInputSchema.parse(raw), context, signal),
        );
      },
      mapToEvidence: map,
    }),
    defineAssistantTool({
      name: 'read_customer_query',
      version: ASSISTANT_CAPABILITIES[0]!.version,
      readOnly: true,
      inputSchema: readCustomerQueryInputSchema,
      outputSchema: customerQueryOutputSchema,
      timeoutMs: 30_000,
      maxRows: 20,
      cachePolicy: 'none',
      execute: async (raw, context, signal) => {
        if (!service) throw new Error('ASSISTANT_QUERY_SERVICE_UNAVAILABLE');
        return withReferenceRecovery(() =>
          service.read(readCustomerQueryInputSchema.parse(raw), context, signal),
        );
      },
      mapToEvidence: map,
    }),
  ];
}

async function withReferenceRecovery<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const response = error instanceof BadRequestException ? error.getResponse() : null;
    if (
      response &&
      typeof response === 'object' &&
      'code' in response &&
      response.code === 'WORKSPACE_SNAPSHOT_INVALID'
    ) {
      // Unknown, expired and no-longer-authorized references intentionally share one response.
      throw new AssistantToolError('QUERY_REFERENCE_UNAVAILABLE');
    }
    throw error;
  }
}
```
