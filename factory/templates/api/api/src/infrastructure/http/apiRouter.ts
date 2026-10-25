import { type RequestHandler, Router } from "express";
import type { RouteMount } from "./app.js";

export type RouteAccess = "public" | "protected";
export type RouteInfo = { method: string; path: string; access: RouteAccess };

export type ApiRouterOptions = {
	requireAuth: RequestHandler;
	publicMounts: readonly RouteMount[];
	protectedMounts: readonly RouteMount[];
	publicAllowlist: readonly string[];
};

type RouteLayer = { route?: { path: string; methods: Record<string, boolean> } };

const joinPath = (mount: string, route: string): string => `${mount}${route === "/" ? "" : route}`;

const describeMount = (mount: RouteMount, access: RouteAccess): RouteInfo[] => {
	const stack = (mount.router as unknown as { stack: RouteLayer[] }).stack;
	return stack.flatMap((layer) => {
		if (layer.route === undefined) {
			throw new Error(`Router at ${mount.path} must only contain flat routes`);
		}
		const path = joinPath(mount.path, layer.route.path);
		return Object.keys(layer.route.methods)
			.filter((method) => layer.route?.methods[method] === true)
			.map((method) => ({ method: method.toUpperCase(), path, access }));
	});
};

export const routeKey = (route: RouteInfo): string => `${route.method} ${route.path}`;

export const composeApiRouter = (
	options: ApiRouterOptions,
): { router: Router; routes: RouteInfo[] } => {
	const publicRoutes = options.publicMounts.flatMap((mount) => describeMount(mount, "public"));
	const protectedRoutes = options.protectedMounts.flatMap((mount) =>
		describeMount(mount, "protected"),
	);
	const allowed = new Set(options.publicAllowlist);
	const unlisted = publicRoutes.map(routeKey).filter((key) => !allowed.has(key));
	if (unlisted.length > 0) {
		throw new Error(`Public routes missing from the allowlist: ${unlisted.join(", ")}`);
	}
	const found = new Set(publicRoutes.map(routeKey));
	const stale = options.publicAllowlist.filter((key) => !found.has(key));
	if (stale.length > 0) {
		throw new Error(`Allowlisted routes that are not mounted: ${stale.join(", ")}`);
	}
	const router = Router();
	for (const mount of options.publicMounts) router.use(mount.path, mount.router);
	router.use(options.requireAuth);
	for (const mount of options.protectedMounts) router.use(mount.path, mount.router);
	return { router, routes: [...publicRoutes, ...protectedRoutes] };
};
