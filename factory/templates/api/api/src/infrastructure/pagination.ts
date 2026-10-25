import { z } from "zod";

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
export const MAX_PAGE_OFFSET = 100_000;

const PageQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
	offset: z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).default(0),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;
export type PageInfo = { limit: number; offset: number; hasMore: boolean };
export type Page<T> = { items: T[]; page: PageInfo };

export const parsePageQuery = (query: unknown): PageQuery => PageQuerySchema.parse(query);

export const pageWindow = (query: PageQuery): { take: number; skip: number } => ({
	take: query.limit + 1,
	skip: query.offset,
});

export const toPage = <T>(rows: readonly T[], query: PageQuery): Page<T> => ({
	items: rows.slice(0, query.limit),
	page: { limit: query.limit, offset: query.offset, hasMore: rows.length > query.limit },
});
