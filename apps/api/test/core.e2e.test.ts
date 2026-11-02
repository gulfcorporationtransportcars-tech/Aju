import { NumberingService } from "../src/core/numbering/numbering.service";
import { MANAGER, setup, teardown, TestContext } from "./helpers";

let ctx: TestContext;
beforeAll(async () => (ctx = await setup()));
afterAll(() => teardown(ctx));

describe("login and sessions", () => {
  it("logs the Manager in and returns his profile and permissions", async () => {
    const token = await ctx.login(MANAGER.email);
    const me = await ctx.http().get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ fullName: "Althaf Najeeb", title: "Manager", isSignatory: true, roleKey: "SUPER_ADMIN", permissions: ["*"] });
  });

  it("rejects a wrong password with a generic message", async () => {
    const res = await ctx.http().post("/api/v1/auth/login").send({ email: MANAGER.email, password: "nope" });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Email or password is incorrect");
  });

  it("requires a login for private routes", async () => {
    expect((await ctx.http().get("/api/v1/auth/me")).status).toBe(401);
    expect((await ctx.http().get("/api/v1/health")).status).toBe(200);
  });

  it("rotates refresh tokens: each one works only once", async () => {
    const login = await ctx.http().post("/api/v1/auth/login").send({ email: MANAGER.email, password: MANAGER.password });
    const first = await ctx.http().post("/api/v1/auth/refresh").send({ refreshToken: login.body.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(login.body.refreshToken);
    const reused = await ctx.http().post("/api/v1/auth/refresh").send({ refreshToken: login.body.refreshToken });
    expect(reused.status).toBe(401);
  });

  it("blocks a suspended user immediately", async () => {
    const admin = await ctx.login(MANAGER.email);
    const salesToken = await ctx.login("sales@luxora.ae");
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: "sales@luxora.ae" } });
    await ctx.http().patch(`/api/v1/users/${user.id}`).set("Authorization", `Bearer ${admin}`).send({ status: "SUSPENDED" }).expect(200);
    expect((await ctx.http().get("/api/v1/auth/me").set("Authorization", `Bearer ${salesToken}`)).status).toBe(401);
    await ctx.http().patch(`/api/v1/users/${user.id}`).set("Authorization", `Bearer ${admin}`).send({ status: "ACTIVE" }).expect(200);
  });
});

describe("permissions", () => {
  it("lets sales read the catalogue but not manage users or settings", async () => {
    const token = await ctx.login("sales@luxora.ae");
    const auth = { Authorization: `Bearer ${token}` };
    expect((await ctx.http().get("/api/v1/catalogue/brands").set(auth)).status).toBe(200);
    expect((await ctx.http().get("/api/v1/users").set(auth)).status).toBe(403);
    expect((await ctx.http().put("/api/v1/settings/company.profile").set(auth).send({})).status).toBe(403);
  });

  it("shows the company profile publicly (storefront footer)", async () => {
    const res = await ctx.http().get("/api/v1/settings/public/company.profile");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ licenceNumber: "2541889.01", manager: { name: "Althaf Najeeb" } });
  });
});

describe("document numbers", () => {
  it("never repeats a number, even with 25 saves at the same moment", async () => {
    const numbering = ctx.app.get(NumberingService);
    const numbers = await Promise.all(Array.from({ length: 25 }, () => numbering.next("TST")));
    expect(new Set(numbers).size).toBe(25);
    expect(numbers.every((n) => /^LUX-TST-\d{4}-\d{4}$/.test(n))).toBe(true);
  });
});
