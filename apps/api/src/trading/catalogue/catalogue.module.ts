import { Body, Controller, ForbiddenException, Get, HttpCode, Module, NotFoundException, OnModuleInit, Param, Patch, Post, Query } from "@nestjs/common";
import { Prisma } from "@luxora/db";
import { hasPermission, PERMISSIONS } from "@luxora/shared";
import { z } from "zod";
import { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser, RequirePermissions } from "../../common/auth/decorators";
import { PageQuery, skipTake, toPage } from "../../common/http/pagination";
import { zod } from "../../common/http/zod.pipe";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ApprovalsService } from "../../core/approvals/approvals.service";
import { AuditService } from "../../core/audit/audit.service";
import {
  BrandBody,
  CreateProductBody,
  NamedBody,
  PRICE_FIELDS,
  PriceListBody,
  PriceListItemsBody,
  ProductBody,
  ProductQuery,
  slugify,
  VariantBody,
} from "./catalogue.schemas";

const PRODUCT_DETAIL = {
  brand: { select: { id: true, name: true, slug: true, category: true } },
  fragranceFamily: true,
  variants: { orderBy: [{ sizeMl: "desc" as const }, { sku: "asc" as const }] },
  notes: { include: { note: true } },
  images: { orderBy: { sortOrder: "asc" as const } },
} satisfies Prisma.ProductInclude;

/** Hide cost prices from users without price:read_cost (e.g. sales staff). */
function stripCost<T>(user: AuthUser, value: T): T {
  if (hasPermission(user.permissions, PERMISSIONS.PRICE_READ_COST)) return value;
  return JSON.parse(JSON.stringify(value, (k, v) => (k === "costAed" || k === "unitCostAed" ? undefined : v)));
}

@Controller("catalogue")
export class CatalogueController implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  onModuleInit() {
    // A new or changed price list only goes live once the Manager approves it.
    this.approvals.registerHandler("PriceList", {
      onApproved: async (tx, req) => {
        await tx.priceList.update({ where: { id: req.entityId }, data: { isApproved: true } });
      },
    });
  }

  // ---------- Brands ----------
  @Get("brands")
  @RequirePermissions(PERMISSIONS.CATALOGUE_READ)
  brands(@Query(zod(PageQuery)) q: PageQuery) {
    return this.prisma.brand.findMany({
      where: q.q ? { name: { contains: q.q, mode: "insensitive" } } : {},
      orderBy: { name: "asc" },
      include: { _count: { select: { products: true } } },
    });
  }

  @Post("brands")
  @RequirePermissions(PERMISSIONS.CATALOGUE_MANAGE)
  async createBrand(@CurrentUser() me: AuthUser, @Body(zod(BrandBody)) body: z.infer<typeof BrandBody>) {
    const brand = await this.prisma.brand.create({ data: { ...body, slug: slugify(body.name) } });
    await this.audit.log({ userId: me.id, action: "CREATE", entityType: "Brand", entityId: brand.id, after: brand });
    return brand;
  }

  @Patch("brands/:id")
  @RequirePermissions(PERMISSIONS.CATALOGUE_MANAGE)
  async updateBrand(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(BrandBody.partial())) body: Partial<z.infer<typeof BrandBody>>) {
    const before = await this.prisma.brand.findUniqueOrThrow({ where: { id } });
    const brand = await this.prisma.brand.update({ where: { id }, data: { ...body, ...(body.name ? { slug: slugify(body.name) } : {}) } });
    await this.audit.log({ userId: me.id, action: "UPDATE", entityType: "Brand", entityId: id, before, after: brand });
    return brand;
  }

  // ---------- Fragrance families & notes ----------
  @Get("families")
  @RequirePermissions(PERMISSIONS.CATALOGUE_READ)
  families() {
    return this.prisma.fragranceFamily.findMany({ orderBy: { nameEn: "asc" } });
  }

  @Post("families")
  @RequirePermissions(PERMISSIONS.CATALOGUE_MANAGE)
  createFamily(@Body(zod(NamedBody)) body: z.infer<typeof NamedBody>) {
    return this.prisma.fragranceFamily.create({ data: body });
  }

  @Get("notes")
  @RequirePermissions(PERMISSIONS.CATALOGUE_READ)
  notes() {
    return this.prisma.note.findMany({ orderBy: { nameEn: "asc" } });
  }

  @Post("notes")
  @RequirePermissions(PERMISSIONS.CATALOGUE_MANAGE)
  createNote(@Body(zod(NamedBody)) body: z.infer<typeof NamedBody>) {
    return this.prisma.note.create({ data: body });
  }

  // ---------- Products ----------
  @Get("products")
  @RequirePermissions(PERMISSIONS.CATALOGUE_READ)
  async products(@CurrentUser() me: AuthUser, @Query(zod(ProductQuery)) q: z.infer<typeof ProductQuery>) {
    const where: Prisma.ProductWhereInput = {
      brandId: q.brandId,
      kind: q.kind,
      gender: q.gender,
      fragranceFamilyId: q.fragranceFamilyId,
      isActive: q.active,
      ...(q.q
        ? {
            OR: [
              { nameEn: { contains: q.q, mode: "insensitive" } },
              { nameAr: { contains: q.q } },
              { brand: { name: { contains: q.q, mode: "insensitive" } } },
              { variants: { some: { OR: [{ sku: { contains: q.q, mode: "insensitive" } }, { barcode: q.q }] } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({ where, include: PRODUCT_DETAIL, orderBy: [{ brand: { name: "asc" } }, { nameEn: "asc" }], ...skipTake(q) }),
      this.prisma.product.count({ where }),
    ]);
    return stripCost(me, toPage(items, total, q));
  }

  @Get("products/:id")
  @RequirePermissions(PERMISSIONS.CATALOGUE_READ)
  async product(@CurrentUser() me: AuthUser, @Param("id") id: string) {
    const p = await this.prisma.product.findUnique({ where: { id }, include: PRODUCT_DETAIL });
    if (!p) throw new NotFoundException("Product not found");
    return stripCost(me, p);
  }

  @Post("products")
  @RequirePermissions(PERMISSIONS.CATALOGUE_MANAGE)
  async createProduct(@CurrentUser() me: AuthUser, @Body(zod(CreateProductBody)) body: z.infer<typeof CreateProductBody>) {
    this.assertCanSetPrices(me, body.variants);
    const { variants, notes, images, ...data } = body;
    const brand = await this.prisma.brand.findUniqueOrThrow({ where: { id: body.brandId } });
    const product = await this.prisma.product.create({
      data: {
        ...data,
        slug: data.slug ?? slugify(`${brand.name} ${data.nameEn} ${data.concentration ?? ""}`),
        variants: { create: variants },
        notes: notes ? { create: notes } : undefined,
        images: images ? { create: images.map((img, i) => ({ ...img, sortOrder: i })) } : undefined,
      },
      include: PRODUCT_DETAIL,
    });
    await this.audit.log({ userId: me.id, action: "CREATE", entityType: "Product", entityId: product.id, after: product });
    return product;
  }

  @Patch("products/:id")
  @RequirePermissions(PERMISSIONS.CATALOGUE_MANAGE)
  async updateProduct(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(ProductBody.partial())) body: Partial<z.infer<typeof ProductBody>>) {
    const before = await this.prisma.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_DETAIL });
    const { notes, images, ...data } = body;
    const product = await this.prisma.$transaction(async (tx) => {
      if (notes) {
        await tx.productNote.deleteMany({ where: { productId: id } });
        await tx.productNote.createMany({ data: notes.map((n) => ({ ...n, productId: id })) });
      }
      if (images) {
        await tx.productImage.deleteMany({ where: { productId: id } });
        await tx.productImage.createMany({ data: images.map((img, i) => ({ ...img, productId: id, sortOrder: i })) });
      }
      return tx.product.update({ where: { id }, data, include: PRODUCT_DETAIL });
    });
    await this.audit.log({ userId: me.id, action: "UPDATE", entityType: "Product", entityId: id, before, after: product });
    return product;
  }

  // ---------- Variants ----------
  @Post("products/:id/variants")
  @RequirePermissions(PERMISSIONS.CATALOGUE_MANAGE)
  async addVariant(@CurrentUser() me: AuthUser, @Param("id") productId: string, @Body(zod(VariantBody)) body: z.infer<typeof VariantBody>) {
    this.assertCanSetPrices(me, [body]);
    const v = await this.prisma.productVariant.create({ data: { ...body, productId } });
    await this.audit.log({ userId: me.id, action: "CREATE", entityType: "ProductVariant", entityId: v.id, after: v });
    return v;
  }

  @Get("variants/by-barcode/:code")
  @RequirePermissions(PERMISSIONS.CATALOGUE_READ)
  async byBarcode(@CurrentUser() me: AuthUser, @Param("code") code: string) {
    const v = await this.prisma.productVariant.findFirst({
      where: { OR: [{ barcode: code }, { sku: code }] },
      include: { product: { include: { brand: { select: { name: true } } } } },
    });
    if (!v) throw new NotFoundException("No product with this barcode or SKU");
    return stripCost(me, v);
  }

  /** Update a variant. Every price change is kept in PriceHistory. */
  @Patch("variants/:id")
  @RequirePermissions(PERMISSIONS.CATALOGUE_MANAGE)
  async updateVariant(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(VariantBody.partial())) body: Partial<z.infer<typeof VariantBody>>) {
    this.assertCanSetPrices(me, [body]);
    const before = await this.prisma.productVariant.findUniqueOrThrow({ where: { id } });
    const changes = PRICE_FIELDS.filter((f) => body[f] !== undefined && before[f]?.toString() !== new Prisma.Decimal(body[f]!).toString());
    const updated = await this.prisma.$transaction(async (tx) => {
      if (changes.length) {
        await tx.priceHistory.createMany({
          data: changes.map((f) => ({ variantId: id, field: f, oldValue: before[f] ?? 0, newValue: body[f]!, changedBy: me.id })),
        });
      }
      return tx.productVariant.update({ where: { id }, data: body });
    });
    await this.audit.log({ userId: me.id, action: "UPDATE", entityType: "ProductVariant", entityId: id, before, after: updated });
    return stripCost(me, updated);
  }

  @Get("variants/:id/price-history")
  @RequirePermissions(PERMISSIONS.PRICE_MANAGE)
  priceHistory(@Param("id") id: string) {
    return this.prisma.priceHistory.findMany({ where: { variantId: id }, orderBy: { createdAt: "desc" } });
  }

  // ---------- Price lists ----------
  @Get("price-lists")
  @RequirePermissions(PERMISSIONS.CATALOGUE_READ)
  priceLists() {
    return this.prisma.priceList.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { items: true, customers: true } } } });
  }

  @Get("price-lists/:id")
  @RequirePermissions(PERMISSIONS.CATALOGUE_READ)
  priceList(@Param("id") id: string) {
    return this.prisma.priceList.findUniqueOrThrow({
      where: { id },
      include: { items: { include: { variant: { select: { sku: true, sizeMl: true, product: { select: { nameEn: true } } } } } } },
    });
  }

  @Post("price-lists")
  @RequirePermissions(PERMISSIONS.PRICE_MANAGE)
  createPriceList(@Body(zod(PriceListBody)) body: z.infer<typeof PriceListBody>) {
    return this.prisma.priceList.create({ data: body });
  }

  /** Replace a price list's items. The list goes back to "not approved" until the Manager approves. */
  @Post("price-lists/:id/items")
  @RequirePermissions(PERMISSIONS.PRICE_MANAGE)
  @HttpCode(202)
  async setPriceListItems(@CurrentUser() me: AuthUser, @Param("id") id: string, @Body(zod(PriceListItemsBody)) body: z.infer<typeof PriceListItemsBody>) {
    return this.prisma.$transaction(async (tx) => {
      const list = await tx.priceList.findUniqueOrThrow({ where: { id } });
      await tx.priceList.update({ where: { id }, data: { isApproved: false } });
      await tx.priceListItem.deleteMany({ where: { priceListId: id } });
      await tx.priceListItem.createMany({ data: body.items.map((i) => ({ ...i, priceListId: id })) });
      const pending = await tx.approvalRequest.findFirst({ where: { entityType: "PriceList", entityId: id, status: "PENDING" } });
      const approval =
        pending ??
        (await this.approvals.request(
          { type: "PRICE_LIST_CHANGE", entityType: "PriceList", entityId: id, title: `Price list "${list.name}": ${body.items.length} prices`, details: body, requestedById: me.id },
          tx,
        ));
      return { status: approval.status === "APPROVED" ? "APPROVED" : "PENDING_APPROVAL", approval };
    });
  }

  private assertCanSetPrices(me: AuthUser, variants: Partial<Record<(typeof PRICE_FIELDS)[number], unknown>>[]) {
    const touchesPrice = variants.some((v) => PRICE_FIELDS.some((f) => v[f] !== undefined));
    if (touchesPrice && !hasPermission(me.permissions, PERMISSIONS.PRICE_MANAGE)) {
      throw new ForbiddenException("Changing prices needs the price:manage permission");
    }
  }
}

@Module({ controllers: [CatalogueController] })
export class CatalogueModule {}
