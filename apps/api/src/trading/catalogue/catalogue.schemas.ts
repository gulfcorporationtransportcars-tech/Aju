import { z } from "zod";
import { Money, PageQuery } from "../../common/http/pagination";

export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const BrandBody = z.object({
  name: z.string().min(1),
  category: z.enum(["DESIGNER", "NICHE"]),
  originCountryCode: z.string().length(2).optional(),
  logoUrl: z.string().url().optional(),
  descriptionEn: z.string().optional(),
  descriptionAr: z.string().optional(),
  website: z.string().url().optional(),
  isActive: z.boolean().optional(),
  adLogoPermission: z.boolean().optional(),
  adPermissionNote: z.string().optional(),
});

export const NamedBody = z.object({ nameEn: z.string().min(1), nameAr: z.string().optional() });

export const PRICE_FIELDS = [
  "costAed",
  "wholesaleAAed",
  "wholesaleBAed",
  "wholesaleCAed",
  "exportPriceUsd",
  "retailPriceAed",
  "compareAtPriceAed",
  "minSellingPriceAed",
] as const;

export const VariantBody = z.object({
  sku: z.string().min(1),
  barcode: z.string().optional(),
  sizeMl: z.number().int().positive().optional(),
  packType: z.enum(["RETAIL_BOX", "TESTER", "MINIATURE", "SAMPLE", "UNBOXED", "GIFT_SET"]).default("RETAIL_BOX"),
  isSealed: z.boolean().default(true),
  hsCode: z.string().optional(),
  weightGrams: z.number().int().positive().optional(),
  originCountryCode: z.string().length(2).optional(),
  reorderLevel: z.number().int().min(0).default(0),
  reorderQty: z.number().int().min(0).default(0),
  isActive: z.boolean().optional(),
  costAed: Money.optional(),
  wholesaleAAed: Money.optional(),
  wholesaleBAed: Money.optional(),
  wholesaleCAed: Money.optional(),
  exportPriceUsd: Money.optional(),
  retailPriceAed: Money.optional(),
  compareAtPriceAed: Money.optional(),
  minSellingPriceAed: Money.optional(),
});

export const NoteRef = z.object({ noteId: z.string(), layer: z.enum(["TOP", "HEART", "BASE"]) });

export const ProductBody = z.object({
  brandId: z.string(),
  kind: z.enum(["FRAGRANCE", "COSMETIC", "SKINCARE", "SOAP", "ACCESSORY", "GIFT_SET", "WATCH", "JEWELLERY"]).default("FRAGRANCE"),
  nameEn: z.string().min(1),
  nameAr: z.string().optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  gender: z.enum(["MEN", "WOMEN", "UNISEX"]).optional(),
  concentration: z.enum(["PARFUM", "EXTRAIT", "EDP", "EDT", "EDC", "BODY_MIST", "OIL", "OTHER"]).optional(),
  fragranceFamilyId: z.string().optional(),
  descriptionEn: z.string().optional(),
  descriptionAr: z.string().optional(),
  launchYear: z.number().int().min(1700).max(2100).optional(),
  perfumer: z.string().optional(),
  isActive: z.boolean().optional(),
  isPublishedOnline: z.boolean().optional(),
  isPublishedB2b: z.boolean().optional(),
  seoTitleEn: z.string().optional(),
  seoTitleAr: z.string().optional(),
  seoDescriptionEn: z.string().optional(),
  seoDescriptionAr: z.string().optional(),
  notes: z.array(NoteRef).optional(),
  images: z.array(z.object({ url: z.string().url(), altEn: z.string().optional(), altAr: z.string().optional() })).optional(),
});

export const CreateProductBody = ProductBody.extend({ variants: z.array(VariantBody).min(1) });

export const ProductQuery = PageQuery.extend({
  brandId: z.string().optional(),
  kind: ProductBody.shape.kind.removeDefault().optional(),
  gender: z.enum(["MEN", "WOMEN", "UNISEX"]).optional(),
  fragranceFamilyId: z.string().optional(),
  active: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

export const PriceListBody = z.object({
  name: z.string().min(1),
  tier: z.enum(["A", "B", "C", "EXPORT", "RETAIL", "CUSTOM"]),
  currencyCode: z.string().length(3).default("AED"),
  validFrom: z.coerce.date().optional(),
  validTo: z.coerce.date().optional(),
});

export const PriceListItemsBody = z.object({
  items: z.array(z.object({ variantId: z.string(), price: Money, minQty: z.number().int().min(1).default(1) })).min(1),
});
