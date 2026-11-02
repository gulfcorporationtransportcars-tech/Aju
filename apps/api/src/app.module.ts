import { Controller, Get, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { JwtAuthGuard, PermissionsGuard } from "./common/auth/auth.guards";
import { Public } from "./common/auth/decorators";
import { AppExceptionFilter } from "./common/http/exception.filter";
import { PrismaModule, PrismaService } from "./common/prisma/prisma.service";
import { env } from "./config/env";
import { ApprovalsModule } from "./core/approvals/approvals.module";
import { AuditModule } from "./core/audit/audit.service";
import { AuthModule } from "./core/auth/auth.module";
import { NotificationsModule } from "./core/notifications/notifications.service";
import { NumberingModule } from "./core/numbering/numbering.service";
import { SettingsModule } from "./core/settings/settings.module";
import { UsersModule } from "./core/users/users.module";
import { CatalogueModule } from "./trading/catalogue/catalogue.module";
import { InventoryModule } from "./trading/inventory/inventory.module";
import { FinanceModule } from "./finance/finance.module";
import { LedgerModule } from "./finance/ledger/ledger.service";
import { PurchasingModule } from "./purchasing/purchasing.module";
import { SalesModule } from "./sales/sales.module";

@Controller("health")
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: "ok", time: new Date().toISOString() };
  }
}

@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({ secret: env().JWT_ACCESS_SECRET, signOptions: { expiresIn: env().JWT_ACCESS_TTL_SECONDS } }),
    }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 300 }]), // 300 requests/min per IP
    PrismaModule,
    // core
    AuditModule,
    NumberingModule,
    NotificationsModule,
    ApprovalsModule,
    AuthModule,
    UsersModule,
    SettingsModule,
    LedgerModule,
    // trading
    CatalogueModule,
    InventoryModule,
    PurchasingModule,
    SalesModule,
    FinanceModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: rate limit → login check → permission check
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class AppModule {}
