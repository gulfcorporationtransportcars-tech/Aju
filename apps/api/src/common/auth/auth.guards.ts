import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { hasAllPermissions } from "@luxora/shared";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuthUser } from "./auth-user";
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from "./decorators";

export interface AccessTokenPayload {
  sub: string;
}

/**
 * Global guard 1: checks the Bearer access token and loads the user with their
 * role permissions. The user is re-read on every request, so suspending a user
 * or changing a role takes effect immediately.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];

    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException("Login required");
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      if (isPublic) return true;
      throw new UnauthorizedException("Session expired, please log in again");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    if (!user || user.status !== "ACTIVE") throw new UnauthorizedException("Account is not active");

    const authUser: AuthUser = {
      id: user.id,
      type: user.type,
      email: user.email,
      fullName: user.fullName,
      roleKey: user.role?.key ?? null,
      permissions: user.role?.permissions.map((rp) => rp.permission.key) ?? [],
      customerId: user.customerId,
      adClientId: user.adClientId,
    };
    req.user = authUser;
    return true;
  }
}

/** Global guard 2: enforces @RequirePermissions(...) on the server for every route. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;
    const user = ctx.switchToHttp().getRequest<Request>().user;
    if (!user) throw new UnauthorizedException("Login required");
    if (!hasAllPermissions(user.permissions, required)) {
      throw new ForbiddenException(`Missing permission: ${required.join(", ")}`);
    }
    return true;
  }
}
