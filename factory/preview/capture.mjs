import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { shotName } from "./names.mjs";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const BASE_URL = process.env.BASE_URL ?? "";
const ROUTES = JSON.parse(process.env.ROUTES ?? '[{"path":"/","as":null}]');
const AUTH = process.env.AUTH ? JSON.parse(process.env.AUTH) : null;
const WAIT_URLS = JSON.parse(process.env.WAIT_URLS ?? "[]");
const OUT_DIR = process.env.OUT_DIR ?? "/out";
const VIEWPORTS = [
	{ name: "mobile", width: 390, height: 844 },
	{ name: "desktop", width: 1440, height: 900 },
];
const WAIT_TIMEOUT_MS = 90_000;
const NAV_TIMEOUT_MS = 30_000;
const FOCUS_STEPS = 10;
const EXIT_UNREACHABLE = 3;
const LOGIN_TIMEOUT_MS = 8000;
const MAX_CONSOLE_ERRORS = 20;
const MAX_CONSOLE_ERROR_CHARS = 300;
const MAX_FOCUS_LABELS = 20;
const MAX_FOCUS_LABEL_CHARS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const reachable = async (url) => {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
		return response.status < 500;
	} catch {
		return false;
	}
};

const waitForAll = async () => {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	for (const url of WAIT_URLS) {
		while (!(await reachable(url))) {
			if (Date.now() > deadline) return url;
			await sleep(500);
		}
	}
	return null;
};

const describeElement = () => {
	const el = document.activeElement;
	if (!el || el === document.body) return null;
	const style = getComputedStyle(el);
	const outline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
	const shadow = style.boxShadow !== "none";
	const label = (el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "")).slice(0, 100);
	return { label, indicator: outline || shadow };
};

const checkFocus = async (page) => {
	const withoutIndicator = [];
	let checked = 0;
	for (let step = 0; step < FOCUS_STEPS; step += 1) {
		await page.keyboard.press("Tab");
		const info = await page.evaluate(describeElement);
		if (info === null) break;
		checked += 1;
		if (!info.indicator && withoutIndicator.length < MAX_FOCUS_LABELS) {
			withoutIndicator.push(info.label.slice(0, MAX_FOCUS_LABEL_CHARS));
		}
	}
	return { checked, withoutIndicator };
};

const runAxe = async (page) => {
	await page.evaluate(axeSource);
	const results = await page.evaluate(async () => {
		const outcome = await window.axe.run(document);
		return outcome.violations.map((v) => ({
			id: v.id,
			impact: v.impact ?? null,
			help: v.help,
			nodes: v.nodes.length,
		}));
	});
	return { violations: results };
};

const normalizePath = (path) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

const unavailableEntry = (entry, viewport, reason) => ({
	status: "unavailable",
	route: entry.path,
	as: entry.as,
	authenticated: false,
	viewport,
	reason: reason.slice(0, 300),
});

const login = async (browser, role) => {
	const account = AUTH?.accounts?.[role];
	if (!account) return { ok: false, reason: `no account is declared for role ${role}` };
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	try {
		const page = await context.newPage();
		await page.goto(new URL(AUTH.loginPath, BASE_URL).toString(), {
			waitUntil: "load",
			timeout: NAV_TIMEOUT_MS,
		});
		await page.getByLabel(AUTH.fields.username, { exact: true }).fill(account.username);
		await page.getByLabel(AUTH.fields.password, { exact: true }).fill(account.password);
		await page.getByRole("button", { name: AUTH.submit, exact: true }).click();
		const left = await page
			.waitForURL((url) => normalizePath(url.pathname) !== normalizePath(AUTH.loginPath), {
				timeout: LOGIN_TIMEOUT_MS,
			})
			.then(() => true)
			.catch(() => false);
		if (!left) return { ok: false, reason: `login failed for role ${role}: still on the login page` };
		await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
		const alerts = await page.locator('[role="alert"]').filter({ visible: true }).count();
		if (alerts > 0) return { ok: false, reason: `login failed for role ${role}: an alert is visible` };
		return { ok: true, state: await context.storageState() };
	} catch {
		return { ok: false, reason: `login failed for role ${role}: the login form could not be used` };
	} finally {
		await context.close();
	}
};

const capturePage = async (browser, entry, index, viewport, state) => {
	const context = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height },
		...(state ? { storageState: state } : {}),
	});
	try {
		const page = await context.newPage();
		const consoleErrors = [];
		const remember = (text) => {
			if (consoleErrors.length < MAX_CONSOLE_ERRORS) {
				consoleErrors.push(text.slice(0, MAX_CONSOLE_ERROR_CHARS));
			}
		};
		page.on("console", (message) => {
			if (message.type() === "error") remember(message.text());
		});
		page.on("pageerror", (error) => remember(String(error.message)));
		await page.goto(new URL(entry.path, BASE_URL).toString(), {
			waitUntil: "load",
			timeout: NAV_TIMEOUT_MS,
		});
		await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
		if (
			entry.as !== null &&
			normalizePath(new URL(page.url()).pathname) !== normalizePath(entry.path)
		) {
			return unavailableEntry(entry, viewport, `route redirected away from ${entry.path} as ${entry.as}`);
		}
		const shot = shotName({ index, route: entry.path, role: entry.as, viewport });
		await page.screenshot({ path: join(OUT_DIR, shot), fullPage: true });
		const axe = await runAxe(page);
		const sizes = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth,
		}));
		const focus = await checkFocus(page);
		return {
			status: "captured",
			route: entry.path,
			as: entry.as,
			authenticated: entry.as !== null,
			viewport,
			screenshot: { path: shot },
			axe,
			overflow: { ...sizes, overflows: sizes.scrollWidth > sizes.clientWidth },
			focus,
			consoleErrors,
		};
	} finally {
		await context.close();
	}
};

const main = async () => {
	const missing = await waitForAll();
	if (missing !== null) {
		console.error(`unreachable: ${missing}`);
		process.exit(EXIT_UNREACHABLE);
	}
	mkdirSync(join(OUT_DIR, "shots"), { recursive: true });
	const browser = await chromium.launch({ args: ["--no-sandbox"] });
	const pages = [];
	try {
		const sessions = new Map();
		for (const role of new Set(ROUTES.flatMap((entry) => (entry.as === null ? [] : [entry.as])))) {
			sessions.set(role, await login(browser, role));
		}
		for (const [index, entry] of ROUTES.entries()) {
			for (const viewport of VIEWPORTS) {
				if (entry.as === null) {
					pages.push(await capturePage(browser, entry, index, viewport, null));
					continue;
				}
				const session = sessions.get(entry.as);
				if (!session?.ok) {
					pages.push(unavailableEntry(entry, viewport, session?.reason ?? "no session"));
					continue;
				}
				const captured = await capturePage(browser, entry, index, viewport, session.state).catch(
					() => unavailableEntry(entry, viewport, `the route could not be captured as ${entry.as}`),
				);
				pages.push(captured);
			}
		}
	} finally {
		await browser.close();
	}
	writeFileSync(join(OUT_DIR, "raw-capture.json"), JSON.stringify({ pages }, null, 1));
};

main().catch((error) => {
	console.error(String(error?.stack ?? error).slice(0, 2000));
	process.exit(1);
});
