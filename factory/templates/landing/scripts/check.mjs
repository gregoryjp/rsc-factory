import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootFlag = process.argv.indexOf("--root");
const root =
  rootFlag === -1 ? fileURLToPath(new URL("..", import.meta.url)) : resolve(process.argv[rootFlag + 1]);
const publicDir = existsSync(resolve(root, "public")) ? resolve(root, "public") : root;
const webLayout = publicDir !== root;
const problems = [];
const rel = (path) => relative(root, path).split("\\").join("/");
const read = (path) => readFileSync(path, "utf8");

const LEGAL_PAGES = ["aviso-legal", "politica-privacidad", "politica-cookies"];
const MIN_CONTRAST = 4.5;
const MIN_TARGET_PX = 24;
const CONTRAST_PAIRS = [
  ["--color-text", "--color-bg"],
  ["--color-text", "--color-surface"],
  ["--color-muted", "--color-bg"],
  ["--color-link", "--color-bg"],
  ["--color-on-primary", "--color-primary"],
];

const walk = (dir, extensions) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) return walk(path, extensions);
    return extensions.some((ext) => name.endsWith(ext)) ? [path] : [];
  });
};

const hexToRgb = (hex) => {
  const digits = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16) / 255);
};
const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const parseTokens = (css) =>
  Object.fromEntries(
    [...css.matchAll(/(--[a-z0-9-]+)\s*:\s*#([0-9a-f]{3}|[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]),
  );

const checkPage = (file, html, bases) => {
  const name = rel(file);
  if (!/<html[^>]*\slang=/i.test(html)) problems.push(`${name}: <html> has no lang attribute`);
  if (!/<title>[^<]+<\/title>/i.test(html)) problems.push(`${name}: missing non-empty <title>`);
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) problems.push(`${name}: missing viewport meta`);

  const cspMeta = html.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*content=(?:"([^"]*)"|'([^']*)')/i);
  const csp = cspMeta === null ? null : [cspMeta[0], cspMeta[1] ?? cspMeta[2]];
  if (csp === null) problems.push(`${name}: missing Content-Security-Policy meta`);
  else {
    if (/'unsafe-(?:inline|eval)'/.test(csp[1])) problems.push(`${name}: CSP must not allow 'unsafe-inline' or 'unsafe-eval'`);
    if (!/default-src\s+'self'/.test(csp[1]) || !/script-src\s+'self'/.test(csp[1]))
      problems.push(`${name}: CSP must set default-src 'self' and script-src 'self'`);
  }

  for (const tag of html.matchAll(/<script\b([^>]*)>/gi)) {
    if (!/\ssrc=/i.test(` ${tag[1]}`)) problems.push(`${name}: inline <script> without src is blocked by the CSP`);
  }
  if (/<style\b/i.test(html)) problems.push(`${name}: inline <style> element is blocked by the CSP`);
  if (/<[a-z][^>]*\sstyle\s*=/i.test(html)) problems.push(`${name}: inline style attribute is blocked by the CSP`);
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) problems.push(`${name}: inline event handler attribute (onclick=, ...) is not allowed`);

  for (const tag of html.matchAll(/<a\b([^>]*)>/gi)) {
    if (!/\starget=["']_blank["']/i.test(` ${tag[1]}`)) continue;
    const relValue = (tag[1].match(/\srel=["']([^"']*)["']/i) ?? [, ""])[1].toLowerCase();
    if (!relValue.includes("noopener") || !relValue.includes("noreferrer"))
      problems.push(`${name}: target="_blank" requires rel="noopener noreferrer"`);
  }

  for (const match of html.matchAll(/\b(?:src|href|action|poster|data)=["']\s*(http:\/\/[^"']*)["']/gi)) {
    problems.push(`${name}: insecure http:// URL "${match[1]}" (mixed content)`);
  }
  for (const tag of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attrs = tag[2];
    const url = (attrs.match(/\s(?:src|href)=["']([^"']+)["']/i) ?? [, ""])[1];
    const isAsset = tag[1].toLowerCase() === "script" || /\srel=["'][^"']*(?:stylesheet|preload|modulepreload)/i.test(attrs);
    if (isAsset && /^(?:https?:)?\/\//i.test(url)) problems.push(`${name}: external ${tag[1].toLowerCase()} "${url}" is not allowed`);
  }

  for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
    const link = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link)) continue;
    const path = link.split(/[?#]/)[0];
    const candidates = path.startsWith("/")
      ? bases.map((base) => resolve(base, `.${path}`))
      : [resolve(dirname(file), path)];
    if (!candidates.some((candidate) => existsSync(candidate))) problems.push(`${name}: link "${link}" does not resolve`);
  }
};

const entry = resolve(root, "index.html");
const pages = [];
if (!existsSync(entry)) {
  problems.push("index.html does not exist");
} else {
  pages.push({ file: entry, bases: [publicDir, root] });
  const dist = resolve(root, "dist", "index.html");
  if (existsSync(dist)) pages.push({ file: dist, bases: [resolve(root, "dist")] });
}

const legalDir = resolve(publicDir, "legal");
const legalFiles = LEGAL_PAGES.map((page) => resolve(legalDir, `${page}.html`));
for (const file of legalFiles) {
  if (existsSync(file)) pages.push({ file, bases: [publicDir, root] });
  else problems.push(`${rel(file)} does not exist`);
}

let pending = 0;
for (const { file, bases } of pages) {
  const html = read(file);
  checkPage(file, html, bases);
  if (legalFiles.includes(file)) pending += (html.match(/\[PENDIENTE/g) ?? []).length;
}

if (existsSync(entry)) {
  const sources = webLayout ? [entry, ...walk(resolve(root, "src"), [".tsx", ".ts"])] : [entry];
  const sourceText = sources.map(read).join("\n");
  const label = webLayout ? "index.html or src/" : "index.html";
  for (const page of LEGAL_PAGES) {
    if (!sourceText.includes(`legal/${page}.html`)) problems.push(`${label} does not link legal/${page}.html`);
  }
  if (!sourceText.includes('href="#main"')) problems.push(`${label} has no skip link (href="#main")`);
  if (!/<main\b/.test(sourceText)) problems.push(`${label} has no <main> landmark`);
  if (webLayout) {
    for (const file of walk(resolve(root, "src"), [".tsx"])) {
      if (/\sstyle=\{/.test(read(file))) problems.push(`${rel(file)}: inline style prop is blocked by the CSP; use CSS Modules`);
    }
  }
}

const tokensFile = resolve(publicDir, "tokens.css");
if (!existsSync(tokensFile)) {
  problems.push(`${rel(tokensFile)} does not exist`);
} else {
  const tokensCss = read(tokensFile);
  const allCss = readdirSync(publicDir)
    .filter((name) => name.endsWith(".css"))
    .map((name) => read(resolve(publicDir, name)))
    .join("\n");
  if (!/prefers-color-scheme:\s*dark/.test(tokensCss)) problems.push("tokens.css: missing prefers-color-scheme: dark overrides");
  if (!/prefers-reduced-motion/.test(allCss)) problems.push("stylesheets: missing prefers-reduced-motion handling");
  if (!/:focus-visible/.test(allCss)) problems.push("stylesheets: missing :focus-visible styles");

  const target = tokensCss.match(/--target-min\s*:\s*([\d.]+)(px|rem)\s*;/);
  const targetPx = target === null ? 0 : Number.parseFloat(target[1]) * (target[2] === "rem" ? 16 : 1);
  if (targetPx < MIN_TARGET_PX) problems.push(`tokens.css: --target-min must be at least ${MIN_TARGET_PX}px (WCAG 2.2 2.5.8)`);

  const darkAt = tokensCss.search(/prefers-color-scheme:\s*dark/);
  const light = parseTokens(darkAt === -1 ? tokensCss : tokensCss.slice(0, darkAt));
  const themes = { light, dark: { ...light, ...(darkAt === -1 ? {} : parseTokens(tokensCss.slice(darkAt))) } };
  for (const [theme, tokens] of Object.entries(themes)) {
    for (const [fg, bg] of CONTRAST_PAIRS) {
      if (!tokens[fg] || !tokens[bg]) {
        problems.push(`tokens.css: contrast ${theme}: ${fg} or ${bg} is not defined as a hex color`);
        continue;
      }
      const ratio = contrast(tokens[fg], tokens[bg]);
      if (ratio < MIN_CONTRAST)
        problems.push(`tokens.css: contrast ${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1 (minimum ${MIN_CONTRAST}:1)`);
    }
  }
}

if (problems.length > 0) {
  console.error("Static landing check failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
if (pending > 0) {
  console.warn(
    `WARN: legal pages still contain [PENDIENTE markers: ${pending} (complete them with the owner's data before publishing)`,
  );
}
console.log("Static landing check OK");
