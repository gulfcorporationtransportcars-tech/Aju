import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Global, HttpCode, Module, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { APPROVAL_TYPES, hasPermission, PERMISSIONS } from "@luxora/shared";
import { z } from "zod";
import { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser, RequirePermissions } from "../../common/auth/decorators";
import { PageQuery, skipTake, toPage } from "../../common/http/pagination";
import { zod } from "../../common/http/zod.pipe";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { ApprovalsService } from "./approvals.service";

const ListQuery = PageQuery.extend({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
  type: z.enum(APPROVAL_TYPES).optional(),
  scope: z.enum(["assigned", "requested", "all"]).default("assigned"),
});
const DecideBody = z.object({ note: z.string().max(1000).optional() });
const DelegationBody = z
  .object({
    toUserId: z.string(),
    types: z.array(z.enum(APPROVAL_TYPES)).default([]), // empty = all types
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    reason: z.string().optional(),
  })
  .refine((d) => d.endsAt > d.startsAt, { message: "End must be after start", path: ["endsAt"] });

const WITH_PEOPLE = {
  requestedBy: { select: { id: true, fullName: true } },
  assignedTo: { select: { id: true, fullName: true } },
  decidedBy: { select: { id: true, fullName: true } },
} as const;

/** The approval inbox. Anyone can decide what is assigned to them (including delegates). */
@Controller("approvals")
@RequirePermissions(PERMISSIONS.APPROVAL_READ)
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query(zod(ListQuery)) q: z.infer<typeof ListQuery>) {
    const isAdmin = hasPermission(user.permissions, "*");
    const scope =
      q.scope === "all" && isAdmin ? {} : q.scope === "requested" ? { requestedById: user.id } : { assignedToId: user.id };
    const where = { ...scope, status: q.status, type: q.type };
    const [items, total] = await Promise.all([
      this.prisma.approvalRequest.findMany({ where, include: WITH_PEOPLE, orderBy: { createdAt: "desc" }, ...skipTake(q) }),
      this.prisma.approvalRequest.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  /** Count for the Manager dashboard badge. */
  @Get("pending-count")
  async pendingCount(@CurrentUser() user: AuthUser) {
    return { count: await this.prisma.approvalRequest.count({ where: { assignedToId: user.id, status: "PENDING" } }) };
  }

  // Delegation routes come before ":id" so they are not read as an id.
  @Get("delegations")
  delegations(@CurrentUser() user: AuthUser) {
    return this.prisma.approvalDelegation.findMany({
      where: { OR: [{ fromUserId: user.id }, { toUserId: user.id }] },
      include: { fromUser: { select: { id: true, fullName: true } }, toUser: { select: { id: true, fullName: true } } },
      orderBy: { startsAt: "desc" },
    });
  }

  @Post("delegations")
  @RequirePermissions(PERMISSIONS.APPROVAL_DELEGATE)
  async delegate(@CurrentUser() user: AuthUser, @Body(zod(DelegationBody)) body: z.infer<typeof DelegationBody>) {
    if (body.toUserId === user.id) throw new BadRequestException("Choose another user to delegate to");
    const to = await this.prisma.user.findUnique({ where: { id: body.toUserId } });
    if (!to || to.type !== "STAFF" || to.status !== "ACTIVE") throw new BadRequestException("Delegate must be an active staff member");
    const delegation = await this.prisma.approvalDelegation.create({ data: { ...body, fromUserId: user.id } });
    await this.audit.log({ userId: user.id, action: "DELEGATE", entityType: "ApprovalDelegation", entityId: delegation.id, after: delegation });
    return delegation;
  }

  @Delete("delegations/:id")
  @RequirePermissions(PERMISSIONS.APPROVAL_DELEGATE)
  async revoke(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const res = await this.prisma.approvalDelegation.updateMany({ where: { id, fromUserId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count !== 1) throw new NotFoundException();
    await this.audit.log({ userId: user.id, action: "REVOKE", entityType: "ApprovalDelegation", entityId: id });
    return { ok: true };
  }

  @Get(":id")
  async get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const req = await this.prisma.approvalRequest.findUnique({ where: { id }, include: WITH_PEOPLE });
    if (!req) throw new NotFoundException();
    if (!hasPermission(user.permissions, "*") && req.assignedToId !== user.id && req.requestedById !== user.id) throw new ForbiddenException();
    return req;
  }

  @Post(":id/approve")
  @HttpCode(200)
  approve(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(zod(DecideBody)) body: z.infer<typeof DecideBody>) {
    return this.approvals.decide(id, user, true, body.note);
  }

  @Post(":id/reject")
  @HttpCode(200)
  reject(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(zod(DecideBody)) body: z.infer<typeof DecideBody>) {
    return this.approvals.decide(id, user, false, body.note);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.approvals.cancel(id, user);
  }
}

@Global()
@Module({ providers: [ApprovalsService], controllers: [ApprovalsController], exports: [ApprovalsService] })
export class ApprovalsModule {}
