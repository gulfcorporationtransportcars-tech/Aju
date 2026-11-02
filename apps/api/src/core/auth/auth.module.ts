import { Body, Controller, Get, HttpCode, Injectable, Module, Post, Req, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Throttle } from "@nestjs/throttler";
import * as argon2 from "argon2";
import { createHash, randomBytes } from "crypto";
import type { Request } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser, Public } from "../../common/auth/decorators";
import { zod } from "../../common/http/zod.pipe";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const LoginBody = z.object({ email: z.string().email().toLowerCase(), password: z.string().min(1) });
const RefreshBody = z.object({ refreshToken: z.string().min(20) });

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, meta: { ip?: string; userAgent?: string }): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Same message for unknown email and wrong password, so emails can't be discovered.
    const ok = user?.passwordHash ? await argon2.verify(user.passwordHash, password) : false;
    if (!user || !ok) throw new UnauthorizedException("Email or password is incorrect");
    if (user.status !== "ACTIVE") throw new UnauthorizedException("Account is not active");

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log({ userId: user.id, action: "LOGIN", entityType: "User", entityId: user.id, ipAddress: meta.ip });
    return this.issue(user.id, meta);
  }

  /** Refresh tokens rotate: each one works once, then it is revoked. */
  async refresh(refreshToken: string, meta: { ip?: string; userAgent?: string }): Promise<TokenPair> {
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: sha256(refreshToken) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.user.status !== "ACTIVE") {
      throw new UnauthorizedException("Session expired, please log in again");
    }
    await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return this.issue(session.userId, meta);
  }

  async logout(refreshToken: string) {
    await this.prisma.session.updateMany({
      where: { refreshTokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issue(userId: string, meta: { ip?: string; userAgent?: string }): Promise<TokenPair> {
    const { JWT_ACCESS_TTL_SECONDS, REFRESH_TTL_DAYS } = env();
    const refreshToken = randomBytes(48).toString("base64url");
    await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash: sha256(refreshToken),
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000),
      },
    });
    const accessToken = await this.jwt.signAsync({ sub: userId });
    return { accessToken, refreshToken, expiresIn: JWT_ACCESS_TTL_SECONDS };
  }
}

const meta = (req: Request) => ({ ip: req.ip, userAgent: req.headers["user-agent"] });

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) // 10 login attempts per minute per IP
  @Post("login")
  @HttpCode(200)
  login(@Body(zod(LoginBody)) body: z.infer<typeof LoginBody>, @Req() req: Request) {
    return this.auth.login(body.email, body.password, meta(req));
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  refresh(@Body(zod(RefreshBody)) body: z.infer<typeof RefreshBody>, @Req() req: Request) {
    return this.auth.refresh(body.refreshToken, meta(req));
  }

  @Public()
  @Post("logout")
  @HttpCode(200)
  async logout(@Body(zod(RefreshBody)) body: z.infer<typeof RefreshBody>) {
    await this.auth.logout(body.refreshToken);
    return { ok: true };
  }

  @Get("me")
  async me(@CurrentUser() user: AuthUser) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { id: true, type: true, email: true, phone: true, fullName: true, title: true, locale: true, isSignatory: true, customerId: true, adClientId: true },
    });
    return { ...u, roleKey: user.roleKey, permissions: user.permissions };
  }
}

@Module({ providers: [AuthService], controllers: [AuthController] })
export class AuthModule {}
