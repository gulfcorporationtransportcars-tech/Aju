import { Controller, Get, Global, Injectable, Module, Query } from "@nestjs/common";
import { Prisma } from "@luxora/db";
import { PERMISSIONS } from "@luxora/shared";
import { z } from "zod";
import { RequirePermissions } from "../../common/auth/decorators";
import { PageQuery, skipTake, toPage } from "../../common/http/pagination";
import { zod } from "../../common/http/zod.pipe";
import { PrismaService, Tx } from "../../common/prisma/prisma.service";

export interface AuditEntry {
  userId?: string | null;
  action: string; // CREATE, UPDATE, DELETE, APPROVE, REJECT, LOGIN...
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
}

const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Write an audit row. Pass `tx` to make it part of the caller's transaction. */
  log(entry: AuditEntry, tx?: Tx) {
    return (tx ?? this.prisma).auditLog.create({
      data: {
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: json(entry.before),
        after: json(entry.after),
        ipAddress: entry.ipAddress ?? null,
      },
    });
  }
}

const AuditQuery = PageQuery.extend({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  userId: z.string().optional(),
});

@Controller("audit")
@RequirePermissions(PERMISSIONS.AUDIT_READ)
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query(zod(AuditQuery)) q: z.infer<typeof AuditQuery>) {
    const where = { entityType: q.entityType, entityId: q.entityId, userId: q.userId };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: { user: { select: { id: true, fullName: true } } },
        ...skipTake(q),
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return toPage(items, total, q);
  }
}

@Global()
@Module({ providers: [AuditService], controllers: [AuditController], exports: [AuditService] })
export class AuditModule {}
