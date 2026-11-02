import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient, seedCore } from "@luxora/db";
import * as argon2 from "argon2";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/bootstrap";

export const MANAGER = { email: "althaf@luxora.ae", password: "Manager-Pass-2026" };
export const PASSWORD = "Staff-Pass-2026!";

/** Empty every table (keeps the migration history). */
export async function resetDatabase(prisma: PrismaClient) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export async function createStaff(prisma: PrismaClient, roleKey: string, email: string, fullName: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.user.create({ data: { type: "STAFF", email, fullName, roleId: role.id, passwordHash: await argon2.hash(PASSWORD) } });
}

export interface TestContext {
  app: INestApplication;
  prisma: PrismaClient;
  http: () => ReturnType<typeof request>;
  login: (email: string, password?: string) => Promise<string>;
}

export async function setup(): Promise<TestContext> {
  const prisma = new PrismaClient();
  await resetDatabase(prisma);
  await seedCore(prisma, { managerEmail: MANAGER.email, managerPassword: MANAGER.password });
  await createStaff(prisma, "SALES", "sales@luxora.ae", "Sara Sales");
  await createStaff(prisma, "WAREHOUSE", "store@luxora.ae", "Wasim Warehouse");
  await createStaff(prisma, "ACCOUNTANT", "accounts@luxora.ae", "Asha Accounts");
  await createStaff(prisma, "MARKETING", "marketing@luxora.ae", "Maya Marketing");

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();

  const http = () => request(app.getHttpServer());
  // Reuse one token per user: the login route is rate-limited (10/min), as in production.
  const tokens = new Map<string, string>();
  const login = async (email: string, password = email === MANAGER.email ? MANAGER.password : PASSWORD) => {
    if (tokens.has(email)) return tokens.get(email)!;
    const res = await http().post("/api/v1/auth/login").send({ email, password });
    if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    tokens.set(email, res.body.accessToken);
    return res.body.accessToken as string;
  };
  return { app, prisma, http, login };
}

export async function teardown(ctx: TestContext) {
  await ctx.app.close();
  await ctx.prisma.$disconnect();
}
