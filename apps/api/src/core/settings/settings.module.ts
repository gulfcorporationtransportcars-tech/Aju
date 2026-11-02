import { Body, Controller, Get, Module, NotFoundException, Param, Put } from "@nestjs/common";
import { Prisma } from "@luxora/db";
import { PERMISSIONS } from "@luxora/shared";
import { z } from "zod";
import { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser, Public, RequirePermissions } from "../../common/auth/decorators";
import { zod } from "../../common/http/zod.pipe";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

/** Settings that the public storefront may read (footer, contact details). */
const PUBLIC_KEYS = new Set(["company.profile"]);

@Controller("settings")
export class SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Get("public/:key")
  async publicSetting(@Param("key") key: string) {
    if (!PUBLIC_KEYS.has(key)) throw new NotFoundException();
    const s = await this.prisma.setting.findUnique({ where: { key } });
    if (!s) throw new NotFoundException();
    return s.value;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  all() {
    return this.prisma.setting.findMany({ orderBy: { key: "asc" } });
  }

  @Put(":key")
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  async put(@CurrentUser() me: AuthUser, @Param("key") key: string, @Body(zod(z.record(z.unknown()))) value: Record<string, unknown>) {
    const before = await this.prisma.setting.findUnique({ where: { key } });
    const saved = await this.prisma.setting.upsert({
      where: { key },
      update: { value: value as Prisma.InputJsonValue },
      create: { key, value: value as Prisma.InputJsonValue },
    });
    await this.audit.log({ userId: me.id, action: "UPDATE", entityType: "Setting", entityId: key, before: before?.value, after: value });
    return saved;
  }
}

@Module({ controllers: [SettingsController] })
export class SettingsModule {}
