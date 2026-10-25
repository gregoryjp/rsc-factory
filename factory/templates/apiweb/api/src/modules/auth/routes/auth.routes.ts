import { type RequestHandler, Router } from "express";
import type { AuthController } from "../controllers/auth.controller.js";

export const createAuthPublicRoutes = (
	controller: AuthController,
	middleware: { authLimiter: RequestHandler; csrf: RequestHandler },
): Router =>
	Router()
		.post("/register", middleware.authLimiter, controller.register)
		.post("/login", middleware.authLimiter, controller.login)
		.post("/refresh", middleware.authLimiter, middleware.csrf, controller.refresh)
		.post("/logout", middleware.csrf, controller.logout);

export const createAuthProtectedRoutes = (controller: AuthController): Router =>
	Router().get("/me", controller.me);
