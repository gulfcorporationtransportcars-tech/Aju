import { z } from "zod";

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().min(1).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const skipTake = (p: { page: number; pageSize: number }) => ({ skip: (p.page - 1) * p.pageSize, take: p.pageSize });

export const toPage = <T>(items: T[], total: number, p: { page: number; pageSize: number }): Page<T> => ({
  items,
  total,
  page: p.page,
  pageSize: p.pageSize,
});

/** Common schema pieces. */
export const Money = z.union([z.number(), z.string().regex(/^-?\d+(\.\d{1,2})?$/)]).transform(String);
export const Id = z.string().min(1);
export const DateStr = z.coerce.date();
