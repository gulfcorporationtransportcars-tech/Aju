import { Controller, Get, Global, Injectable, Module, Param, Post, Query } from "@nestjs/common";
import { NotificationChannel } from "@luxora/db";
import { z } from "zod";
import { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/decorators";
import { PageQuery, skipTake, toPage } from "../../common/http/pagination";
import { zod } from "../../common/http/zod.pipe";
import { PrismaService, Tx } from "../../common/prisma/prisma.service";

export interface NotifyInput {
  userId: string;
  title: string;
  body: string;
  link?: string;
  channels?: NotificationChannel[];
}

/**
 * Stores notifications. IN_APP rows show in the bell menu; EMAIL / WHATSAPP / PUSH rows
 * are picked up and sent by the worker (Step 3C / worker app), which sets `sentAt`.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async notify(input: NotifyInput, tx?: Tx) {
    const channels = input.channels ?? ["IN_APP"];
    await (tx ?? this.prisma).notification.createMany({
      data: channels.map((channel) => ({
        userId: input.userId,
        channel,
        title: input.title,
        body: input.body,
        link: input.link,
        sentAt: channel === "IN_APP" ? new Date() : null,
      })),
    });
  }
}

const NotificationQuery = PageQuery.extend({ unread: z.coerce.boolean().optional() });

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async mine(@CurrentUser() user: AuthUser, @Query(zod(NotificationQuery)) q: z.infer<typeof NotificationQuery>) {
    const where = { userId: user.id, channel: "IN_APP" as const, ...(q.unread ? { readAt: null } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, ...skipTake(q) }),
      this.prisma.notification.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  @Post(":id/read")
  async markRead(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.prisma.notification.updateMany({ where: { id, userId: user.id }, data: { readAt: new Date() } });
    return { ok: true };
  }
}

@Global()
@Module({ providers: [NotificationsService], controllers: [NotificationsController], exports: [NotificationsService] })
export class NotificationsModule {}
