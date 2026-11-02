import { BadRequestException, Body, Controller, Get, Module, Param, Patch, Post, Query } from "@nestjs/common";
import { PERMISSIONS } from "@luxora/shared";
import * as argon2 from "argon2";
import { z } from "zod";
import { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser, RequirePermissions } from "../../common/auth/decorators";
import { PageQuery, skipTake, toPage } from "../../common/http/pagination";
import { zod } from "../../common/http/zod.pipe";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

const PUBLIC_USER = {
  id: true, type: true, status: true, email: true, phone: true, fullName: true, title: true, locale: true,
  isSignatory: true, customerId: true, adClientId: true, lastLoginAt: true, createdAt: true,
  role: { select: { key: true, name: true } },
} as const;

const CreateUser = z.object({
  type: z.enum(["STAFF", "B2B_CUSTOMER", "AD_CLIENT", "RETAIL_CUSTOMER"]),
  email: z.string().email().toLowerCase(),
  phone: z.string().optional(),
  fullName: z.string().min(2),
  title: z.string().optional(),
  roleKey: z.string(),
  password: z.string().min(10, "Password must be at least 10 characters"),
  locale: z.enum(["EN", "AR"]).default("EN"),
  customerId: z.string().optional(),
  adClientId: z.string().optional(),
  isSignatory: z.boolean().default(false),
});

const UpdateUser = z.object({
  fullName: z.string().min(2).optional(),
  phone: z.string().optional(),
  title: z.string().optional(),
  roleKey: z.string().optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  locale: z.enum(["EN", "AR"]).optional(),
  isSignatory: z.boolean().optional(),
  password: z.string().min(10).optional(),
});

const UserQuery = PageQuery.extend({ type: z.enum(["STAFF", "B2B_CUSTOMER", "AD_CLIENT", "RETAIL_CUSTOMER"]).optional() });

@Controller()
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get("users")
  @RequirePermissions(PERMISSIONS.USER_READ)
  async list(@Query(zod(UserQuery)) q: z.infer<typeof UserQuery>) {
    const where = {
      type: q.type,
      ...(q.q ? { OR: [{ fullName: { contains: q.q, mode: "insensitive" as const } }, { email: { contains: q.q, mode: "insensitive" as const } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({ where, select: PUBLIC_USER, orderBy: { fullName: "asc" }, ...skipTake(q) }),
      this.prisma.user.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  @Post("users")
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  async create(@CurrentUser() me: AuthUser, @Body(zod(CreateUser)) body: z.infer<typeof CreateUser>) {
    const role = await this.prisma.role.findUnique({ where: { key: body.roleKey } });
    if (!role) throw new BadRequestException(`Unknown role ${body.roleKey}`);
    if (body.type === "B2B_CUSTOMER" && !body.customerId) throw new BadRequestException("B2B users must be linked to a customer");
    if (body.type === "AD_CLIENT" && !body.adClientId) throw new BadRequestException("Ad client users must be linked to an ad client");
    const { password, roleKey: _r, ...rest } = body;
    const user = await this.prisma.user.create({
      data: { ...rest, roleId: role.id, passwordHash: await argon2.hash(password) },
      select: PUBLIC_USER,
    });
    await this.audit.log({ userId: me.id, action: "CREATE", entityType: "User", entityId: user.id, after: user });
    return user;
  }

  @Patch("users/:id")
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  async update(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(UpdateUser)) body: z.infer<typeof UpdateUser>) {
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id }, select: PUBLIC_USER });
    if (id === me.id && (body.status === "SUSPENDED" || (body.roleKey && body.roleKey !== "SUPER_ADMIN" && me.roleKey === "SUPER_ADMIN"))) {
      throw new BadRequestException("You cannot suspend yourself or remove your own Super Admin role");
    }
    const { password, roleKey, ...rest } = body;
    const role = roleKey ? await this.prisma.role.findUniqueOrThrow({ where: { key: roleKey } }) : undefined;
    const user = await this.prisma.user.update({
      where: { id },
      data: { ...rest, ...(role ? { roleId: role.id } : {}), ...(password ? { passwordHash: await argon2.hash(password) } : {}) },
      select: PUBLIC_USER,
    });
    if (body.status === "SUSPENDED") {
      await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await this.audit.log({ userId: me.id, action: "UPDATE", entityType: "User", entityId: id, before, after: user });
    return user;
  }

  @Get("roles")
  @RequirePermissions(PERMISSIONS.USER_READ)
  roles() {
    return this.prisma.role.findMany({
      orderBy: { name: "asc" },
      include: { permissions: { select: { permission: { select: { key: true } } } } },
    });
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
