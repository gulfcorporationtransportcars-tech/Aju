import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ApprovalRequest, ApprovalType, Prisma } from "@luxora/db";
import { APPROVAL_LABELS, hasPermission, needsApproval, resolveDelegate } from "@luxora/shared";
import { AuthUser } from "../../common/auth/auth-user";
import { PrismaService, Tx } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";

/**
 * What happens when a request is decided. Each module registers one handler per
 * entityType (e.g. "StockAdjustment", "Campaign", "PurchaseOrder"). The handler runs
 * inside the same transaction as the decision, so either both happen or neither does.
 */
export interface ApprovalHandler {
  onApproved(tx: Tx, request: ApprovalRequest, deciderId: string): Promise<void>;
  onRejected?(tx: Tx, request: ApprovalRequest, deciderId: string): Promise<void>;
}

export interface RequestApprovalInput {
  type: ApprovalType;
  entityType: string;
  entityId: string;
  title: string;
  details?: unknown;
  amountAed?: number;
  requestedById: string;
}

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);
  private readonly handlers = new Map<string, ApprovalHandler>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  registerHandler(entityType: string, handler: ApprovalHandler) {
    this.handlers.set(entityType, handler);
  }

  /** Does this action need approval, given the rule's AED threshold? */
  async isRequired(type: ApprovalType, amountAed?: number, tx?: Tx): Promise<boolean> {
    const rule = await (tx ?? this.prisma).approvalRule.findUnique({ where: { type } });
    if (rule && !rule.isActive) return false;
    return needsApproval(rule?.thresholdAed == null ? null : Number(rule.thresholdAed), amountAed);
  }

  /** Find who should approve: the rule's role (the Manager by default), or his active delegate. */
  async resolveApprover(type: ApprovalType, tx?: Tx): Promise<string> {
    const db = tx ?? this.prisma;
    const rule = await db.approvalRule.findUnique({ where: { type } });
    const approver = await db.user.findFirst({
      where: { status: "ACTIVE", type: "STAFF", role: { key: rule?.approverRoleKey ?? "SUPER_ADMIN" } },
      orderBy: [{ isSignatory: "desc" }, { createdAt: "asc" }],
    });
    if (!approver) throw new BadRequestException(`No active approver found for ${type}`);

    const delegations = await db.approvalDelegation.findMany({ where: { fromUserId: approver.id, revokedAt: null } });
    return resolveDelegate(approver.id, type, delegations);
  }

  /**
   * Create a pending request and notify the approver (in-app + push + WhatsApp + email).
   * If the requester IS the approver (e.g. the Manager adjusting stock himself), the
   * request is recorded as approved straight away and its handler runs, so there is
   * still a full record of who approved what.
   */
  async request(input: RequestApprovalInput, tx?: Tx): Promise<ApprovalRequest> {
    if (!tx) return this.prisma.$transaction((t) => this.request(input, t));

    const open = await tx.approvalRequest.findFirst({
      where: { entityType: input.entityType, entityId: input.entityId, type: input.type, status: "PENDING" },
    });
    if (open) throw new ConflictException("An approval request is already pending for this item");

    const assignedToId = await this.resolveApprover(input.type, tx);
    const selfApproved = assignedToId === input.requestedById;
    const request = await tx.approvalRequest.create({
      data: {
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
        title: input.title,
        details: input.details === undefined ? undefined : (JSON.parse(JSON.stringify(input.details)) as Prisma.InputJsonValue),
        amountAed: input.amountAed,
        requestedById: input.requestedById,
        assignedToId,
        ...(selfApproved
          ? { status: "APPROVED" as const, decidedById: assignedToId, decidedAt: new Date(), decisionNote: "Approved by the approver's own action" }
          : {}),
      },
    });
    await this.audit.log({ userId: input.requestedById, action: selfApproved ? "APPROVE" : "REQUEST_APPROVAL", entityType: input.entityType, entityId: input.entityId, after: request }, tx);

    if (selfApproved) {
      await this.handlers.get(input.entityType)?.onApproved(tx, request, assignedToId);
      return request;
    }

    await this.notifications.notify(
      {
        userId: assignedToId,
        title: `Approval needed: ${APPROVAL_LABELS[input.type].en}`,
        body: input.title,
        link: `/approvals/${request.id}`,
        channels: ["IN_APP", "PUSH", "WHATSAPP", "EMAIL"],
      },
      tx,
    );
    return request;
  }

  async decide(id: string, user: AuthUser, approve: boolean, note?: string): Promise<ApprovalRequest> {
    return this.prisma.$transaction(async (tx) => {
      const req = await tx.approvalRequest.findUnique({ where: { id } });
      if (!req) throw new NotFoundException("Approval request not found");
      if (req.status !== "PENDING") throw new ConflictException(`Already ${req.status.toLowerCase()}`);

      const isSuperAdmin = hasPermission(user.permissions, "*");
      if (req.assignedToId !== user.id && !isSuperAdmin) throw new ForbiddenException("This approval is assigned to someone else");
      if (req.requestedById === user.id && !isSuperAdmin) throw new ForbiddenException("You cannot approve your own request");

      // Guard against two people deciding at the same moment
      const claimed = await tx.approvalRequest.updateMany({
        where: { id, status: "PENDING" },
        data: { status: approve ? "APPROVED" : "REJECTED", decidedById: user.id, decisionNote: note, decidedAt: new Date() },
      });
      if (claimed.count !== 1) throw new ConflictException("Already decided");
      const decided = await tx.approvalRequest.findUniqueOrThrow({ where: { id } });

      const handler = this.handlers.get(req.entityType);
      if (!handler) this.logger.warn(`No approval handler registered for ${req.entityType}`);
      else if (approve) await handler.onApproved(tx, decided, user.id);
      else await handler.onRejected?.(tx, decided, user.id);

      await this.audit.log({ userId: user.id, action: approve ? "APPROVE" : "REJECT", entityType: req.entityType, entityId: req.entityId, before: req, after: decided }, tx);
      await this.notifications.notify(
        {
          userId: req.requestedById,
          title: approve ? "Approved" : "Rejected",
          body: `${req.title}${note ? `: ${note}` : ""}`,
          link: `/approvals/${req.id}`,
        },
        tx,
      );
      return decided;
    });
  }

  async cancel(id: string, user: AuthUser) {
    const req = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException();
    if (req.requestedById !== user.id && !hasPermission(user.permissions, "*")) throw new ForbiddenException();
    const res = await this.prisma.approvalRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "CANCELLED" } });
    if (res.count !== 1) throw new ConflictException("Only pending requests can be cancelled");
    const handler = this.handlers.get(req.entityType);
    if (handler?.onRejected) await this.prisma.$transaction((tx) => handler.onRejected!(tx, { ...req, status: "CANCELLED" }, user.id));
    return { ok: true };
  }
}
