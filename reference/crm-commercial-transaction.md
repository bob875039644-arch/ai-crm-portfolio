# CRM 业务背景：人工成交与交付事务

一个相对完整的业务服务，说明 Agent 所访问的并非无约束数据表。读取和写入都校验客户权限；写入使用行锁、版本冲突检测及同事务活动与审计记录。该服务不是 MAX 模型可以直接任意调用的写接口。

**阅读型源码节选：** 下列代码来自实际项目，保留原符号及关键逻辑。它们依赖原 NestJS 容器、shared 契约或数据库，本文件不作为独立可执行程序，也不纳入本仓库的样例测试通过数量。

## 成交与交付领域服务

原项目路径：`apps/api/src/modules/customers/customer-commercial.service.ts`；范围：完整文件。

```ts
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Customer as DbCustomer } from '@prisma/client';
import type { CommercialOutcome, UpdateCommercialOutcomeInput } from '@ai-crm/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { assertCanAccessCustomer } from './customer-access';
import { SettingsService } from '../settings/settings.service';
import { latestAiAnalysisOrder } from './latest-analysis';

@Injectable()
export class CustomerCommercialService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  async read(customerId: string, user: AuthUser): Promise<CommercialOutcome> {
    this.assertRole(user);
    return this.prisma.$transaction(
      async (tx) => {
        const customer = await tx.customer.findUnique({ where: { id: customerId } });
        if (!customer) throw new NotFoundException('客户不存在');
        assertCanAccessCustomer(user, customer);
        return this.map(tx, customer);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async update(
    customerId: string,
    input: UpdateCommercialOutcomeInput,
    user: AuthUser,
  ): Promise<CommercialOutcome> {
    this.assertRole(user);
    return this.prisma.$transaction(async (tx) => {
      // Serialize against reassignment, old mark-won actions and concurrent confirmations.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM customers WHERE id = ${customerId} FOR UPDATE`);
      const before = await tx.customer.findUnique({ where: { id: customerId } });
      if (!before) throw new NotFoundException('客户不存在');
      assertCanAccessCustomer(user, before);
      if (before.commercialVersion !== input.version)
        throw new ConflictException({
          code: 'OUTCOME_CHANGED',
          message: '成交记录已更新，请查看最新记录后再操作。',
        });
      const now = new Date();
      let data: Prisma.CustomerUncheckedUpdateInput;
      if (input.action === 'confirm_sale') {
        if (before.wonConfirmedAt) {
          // Retried confirmation never moves the original sale date or duplicates metrics.
          if (
            before.wonPaymentStage === input.paymentStage &&
            (before.wonConfirmationNote ?? '') === input.note
          )
            return this.map(tx, before);
          throw new ConflictException('已有确认记录；如需更正，请先撤销并填写原因。');
        }
        data = {
          status: 'won',
          wonAt: before.status === 'won' && before.wonAt ? before.wonAt : now,
          wonConfirmedAt: now,
          wonConfirmedById: user.sub,
          wonSalesUserId: before.assignedUserId,
          wonPaymentStage: input.paymentStage,
          wonConfirmationNote: input.note || null,
        };
      } else if (input.action === 'confirm_delivery') {
        if (!before.wonConfirmedAt) throw new ConflictException('请先确认成交，再记录交付。');
        if (before.deliveredAt) return this.map(tx, before);
        data = { deliveredAt: now, deliveryConfirmedById: user.sub };
      } else if (input.action === 'undo_delivery') {
        if (!before.deliveredAt) throw new ConflictException('当前没有已确认的交付记录。');
        data = { deliveredAt: null, deliveryConfirmedById: null };
      } else {
        if (!before.wonConfirmedAt && before.status !== 'won')
          throw new ConflictException('当前没有成交记录。');
        data = {
          status: 'active',
          wonAt: null,
          wonConfirmedAt: null,
          wonConfirmedById: null,
          wonSalesUserId: null,
          wonPaymentStage: null,
          wonConfirmationNote: null,
          deliveredAt: null,
          deliveryConfirmedById: null,
        };
      }
      const after = await tx.customer.update({
        where: { id: customerId },
        data: { ...data, commercialVersion: { increment: 1 } },
      });
      const latestAnalysis = await tx.aiAnalysis.findFirst({
        where: { customerId },
        orderBy: latestAiAnalysisOrder(),
        select: { purchaseTimeline: true },
      });
      const stage = await this.settings.resolveCurrentFunnelStageBinding(tx, after, latestAnalysis);
      const action = `customer.commercial.${input.action}`;
      const diff = {
        before: snapshot(before),
        after: snapshot(after),
        reason: 'reason' in input ? input.reason : null,
      };
      await tx.activity.create({
        data: {
          customerId,
          userId: user.sub,
          type: 'status_change',
          ...stage,
          payload: { action, ...diff },
        },
      });
      await tx.auditLog.create({
        data: { userId: user.sub, action, entity: 'customer', entityId: customerId, diff },
      });
      return this.map(tx, after);
    });
  }

  private assertRole(user: AuthUser) {
    if (user.role !== 'admin' && user.role !== 'sales')
      throw new ForbiddenException('无权访问成交记录');
  }

  private async map(tx: Prisma.TransactionClient, c: DbCustomer): Promise<CommercialOutcome> {
    const ids = [c.wonConfirmedById, c.deliveryConfirmedById].filter((id): id is string => !!id);
    const names = new Map(
      (
        await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      ).map((u) => [u.id, u.name]),
    );
    return {
      customerId: c.id,
      version: c.commercialVersion,
      isWon: c.status === 'won',
      wonAt: c.wonAt?.toISOString() ?? null,
      paymentStage: c.wonPaymentStage as CommercialOutcome['paymentStage'],
      confirmedAt: c.wonConfirmedAt?.toISOString() ?? null,
      confirmedByName: names.get(c.wonConfirmedById ?? '') ?? null,
      note: c.wonConfirmationNote,
      deliveredAt: c.deliveredAt?.toISOString() ?? null,
      deliveryConfirmedByName: names.get(c.deliveryConfirmedById ?? '') ?? null,
    };
  }
}

function snapshot(c: DbCustomer) {
  return {
    status: c.status,
    wonAt: c.wonAt?.toISOString() ?? null,
    confirmedAt: c.wonConfirmedAt?.toISOString() ?? null,
    confirmedById: c.wonConfirmedById,
    salesUserId: c.wonSalesUserId,
    paymentStage: c.wonPaymentStage,
    note: c.wonConfirmationNote,
    deliveredAt: c.deliveredAt?.toISOString() ?? null,
    deliveryConfirmedById: c.deliveryConfirmedById,
    version: c.commercialVersion,
  };
}
```
