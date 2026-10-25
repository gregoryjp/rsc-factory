import type { PrismaClient } from "@prisma/client";
import type { RequestHandler, Router } from "express";
import type { Authenticate } from "../../infrastructure/http/auth.js";
import { createAuthController } from "./controllers/auth.controller.js";
import { createAuthRepository } from "./repositories/auth.repository.js";
import { createAuthProtectedRoutes, createAuthPublicRoutes } from "./routes/auth.routes.js";
import { createAuthService } from "./services/auth.service.js";

export type AuthModule = {
	publicRouter: Router;
	protectedRouter: Router;
	authenticate: Authenticate;
};

export const createAuthModule = (deps: {
	prisma: PrismaClient;
	authLimiter: RequestHandler;
	csrf: RequestHandler;
	secureCookies: boolean;
}): AuthModule => {
	const service = createAuthService(createAuthRepository(deps.prisma));
	const controller = createAuthController(service, { secureCookies: deps.secureCookies });
	return {
		publicRouter: createAuthPublicRoutes(controller, {
			authLimiter: deps.authLimiter,
			csrf: deps.csrf,
		}),
		protectedRouter: createAuthProtectedRoutes(controller),
		authenticate: service.authenticate,
	};
};
