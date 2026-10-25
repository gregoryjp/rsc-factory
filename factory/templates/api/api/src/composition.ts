import { env } from "./config/env.js";
import { prisma } from "./infrastructure/database.js";
import { composeApiRouter, type RouteInfo } from "./infrastructure/http/apiRouter.js";
import { createApp, type RouteMount } from "./infrastructure/http/app.js";
import { createRequireAuth } from "./infrastructure/http/auth.js";
import { createCsrfProtection } from "./infrastructure/http/csrf.js";
import { createRateLimiters, type RateLimitConfig } from "./infrastructure/http/rateLimit.js";
import { createLifecycle, type Lifecycle } from "./infrastructure/lifecycle.js";
import { logger } from "./infrastructure/logger.js";
import { createAuditModule } from "./modules/audit/index.js";
import { createAuthModule } from "./modules/auth/index.js";
import { createHealthModule } from "./modules/health/index.js";
import { createIdempotencyModule } from "./modules/idempotency/index.js";

export const API_PREFIX = "/api/v1";

export const PUBLIC_API_ROUTES: readonly string[] = [
	"POST /auth/register",
	"POST /auth/login",
	"POST /auth/refresh",
	"POST /auth/logout",
];

export type ProductAppOverrides = {
	rateLimit?: Partial<RateLimitConfig>;
	requestTimeoutMs?: number;
	extraProtectedMounts?: readonly RouteMount[];
	lifecycle?: Lifecycle;
};

export const buildProduct = (overrides: ProductAppOverrides = {}) => {
	const limiters = createRateLimiters({
		windowMs: env.RATE_LIMIT_WINDOW_MS,
		max: env.RATE_LIMIT_MAX,
		authMax: env.RATE_LIMIT_AUTH_MAX,
		...overrides.rateLimit,
	});
	const lifecycle = overrides.lifecycle ?? createLifecycle();
	const audit = createAuditModule({ prisma, logger });
	const idempotency = createIdempotencyModule({
		prisma,
		logger,
		ttlMs: env.IDEMPOTENCY_TTL_MS,
	});
	const auth = createAuthModule({
		prisma,
		authLimiter: limiters.auth,
		csrf: createCsrfProtection(env.CORS_ORIGINS),
		secureCookies: env.NODE_ENV === "production",
		audit: audit.record,
	});
	const api = composeApiRouter({
		requireAuth: createRequireAuth(auth.authenticate),
		publicMounts: [{ path: "/auth", router: auth.publicRouter }],
		protectedMounts: [
			{ path: "/auth", router: auth.protectedRouter },
			{ path: "/audit", router: audit.router },
			...(overrides.extraProtectedMounts ?? []),
		],
		publicAllowlist: PUBLIC_API_ROUTES,
	});
	const app = createApp({
		logger,
		corsOrigins: env.CORS_ORIGINS,
		production: env.NODE_ENV === "production",
		trustProxy: env.TRUST_PROXY,
		rateLimiter: limiters.global,
		requestTimeoutMs: overrides.requestTimeoutMs ?? env.REQUEST_TIMEOUT_MS,
		bodyLimits: [{ path: `${API_PREFIX}/auth`, limit: "10kb" }],
		mounts: [
			{ path: "/health", router: createHealthModule({ prisma, lifecycle }) },
			{ path: API_PREFIX, router: api.router },
		],
	});
	const routes: RouteInfo[] = api.routes.map((route) => ({
		...route,
		path: `${API_PREFIX}${route.path}`,
	}));
	return { app, routes, lifecycle, audit: audit.record, idempotency };
};

export const createProductApp = (overrides: ProductAppOverrides = {}) =>
	buildProduct(overrides).app;
