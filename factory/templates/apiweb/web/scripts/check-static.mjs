import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

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
const KIB = 1024;
const BUDGET = {
  rawJs: 30 * KIB,
  rawCss: 60 * KIB,
  gzipJs: 200 * KIB,
  gzipCss: 40 * KIB,
  image: 300 * KIB,
  legacyRaster: 100 * KIB,
};
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".npm-cache", "scripts", "test", "docs", "dist"]);
const LEGACY_RASTER = /\.(png|jpe?g|gif|bmp|tiff?)$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|bmp|tiff?|webp|avif|svg|ico)$/i;
const SKIPPED_CONTROL_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);
const FOCUSABLE_TAGS = new Set(["a", "button", "input", "select", "textarea"]);
const ARIA_ROLES = new Set(
  "alert alertdialog application article banner button cell checkbox columnheader combobox complementary contentinfo definition dialog directory document feed figure form grid gridcell group heading img link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status switch tab table tablist tabpanel term textbox timer toolbar tooltip tree treegrid treeitem".split(
    " ",
  ),
);
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

const walkAssets = (dir, test) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) return SKIPPED_DIRS.has(name) ? [] : walkAssets(path, test);
    return test(name) ? [path] : [];
  });
};
const tagAttrs = (attrs, name) => (attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, "i")) ?? [])[1];
const hasAttr = (attrs, name) => new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|$)`, "i").test(attrs);

const checkAccessibility = (name, rawHtml) => {
  const html = rawHtml.replace(/<!--[\s\S]*?-->/g, "").replace(/<script\b[\s\S]*?<\/script>/gi, "");
  const isShell = /<div[^>]+id=["']root["']/i.test(html);
  if (!isShell) {
    const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
    const h1 = levels.filter((level) => level === 1).length;
    if (h1 !== 1) problems.push(`${name}: page needs exactly one <h1> (found ${h1})`);
    levels.reduce((previous, level) => {
      if (previous > 0 && level > previous + 1)
        problems.push(`${name}: heading level jumps from h${previous} to h${level}`);
      return level;
    }, 0);
  }

  for (const tag of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = tag[1];
    if (!hasAttr(attrs, "alt")) problems.push(`${name}: <img> without alt attribute (use alt="" for decorative images)`);
    if (!hasAttr(attrs, "width") || !hasAttr(attrs, "height")) problems.push(`${name}: <img> needs width and height to avoid layout shift`);
    if (!["lazy", "eager"].includes(tagAttrs(attrs, "loading") ?? ""))
      problems.push(`${name}: <img> needs loading="lazy" or loading="eager" (eager only for the first screen)`);
  }

  const labels = [...html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/gi)].map((m) => [m.index, m.index + m[0].length]);
  const labelFor = new Set([...html.matchAll(/<label\b[^>]*\sfor=["']([^"']+)["']/gi)].map((m) => m[1]));
  for (const tag of html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const attrs = tag[2];
    if (SKIPPED_CONTROL_TYPES.has((tagAttrs(attrs, "type") ?? "").toLowerCase())) continue;
    const named = hasAttr(attrs, "aria-label") || hasAttr(attrs, "aria-labelledby");
    const id = tagAttrs(attrs, "id");
    const wrapped = labels.some(([start, end]) => tag.index > start && tag.index < end);
    if (!named && !wrapped && !(id !== undefined && labelFor.has(id)))
      problems.push(`${name}: form control without an accessible label (<label for>, wrapping <label> or aria-label)`);
  }

  for (const tag of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    const element = tag[1].toLowerCase();
    const attrs = tag[2];
    const tabindex = tagAttrs(attrs, "tabindex");
    if (tabindex !== undefined && Number(tabindex) > 0) problems.push(`${name}: <${element}> has a positive tabindex`);
    if (tagAttrs(attrs, "aria-hidden") === "true" && FOCUSABLE_TAGS.has(element))
      problems.push(`${name}: aria-hidden="true" on focusable <${element}>`);
    const role = tagAttrs(attrs, "role");
    if (role === undefined) continue;
    if (!ARIA_ROLES.has(role)) problems.push(`${name}: unknown ARIA role "${role}"`);
    if (role === "button" && !["button", "input"].includes(element) && tabindex === undefined)
      problems.push(`${name}: <${element} role="button"> is not keyboard focusable (add tabindex="0" or use <button>)`);
  }

  for (const link of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const text = link[2].replace(/<img[^>]+alt=["']([^"']+)["'][^>]*>/gi, "$1").replace(/<[^>]*>/g, "").trim();
    if (text === "" && !hasAttr(link[1], "aria-label") && !hasAttr(link[1], "aria-labelledby"))
      problems.push(`${name}: link without an accessible name`);
  }
};

const decodeEntities = (text) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");

const checkStringTable = (name, html) => {
  const entries = [...html.matchAll(/<([a-z0-9]+)\b[^>]*\sdata-i18n=["']([^"']+)["'][^>]*>([^<]*)<\/\1>/gi)];
  if (entries.length === 0) return;
  const lang = (html.match(/<html[^>]*\slang=["']([^"']+)["']/i) ?? [, ""])[1];
  const tablePath = resolve(root, "i18n", `${lang}.json`);
  if (!existsSync(tablePath)) {
    problems.push(`${name}: i18n/${lang}.json does not exist`);
    return;
  }
  let table = {};
  try {
    table = JSON.parse(read(tablePath));
  } catch {
    problems.push(`i18n/${lang}.json is not valid JSON`);
    return;
  }
  for (const [, , key, text] of entries) {
    if (typeof table[key] !== "string") problems.push(`${name}: data-i18n key "${key}" is not in i18n/${lang}.json`);
    else if (table[key] !== decodeEntities(text.trim()))
      problems.push(`${name}: data-i18n "${key}" text differs from i18n/${lang}.json`);
  }
};

const checkSourceControls = (file, text) => {
  const labels = [...text.matchAll(/<label\b[\s\S]*?<\/label>/g)].map((m) => [m.index, m.index + m[0].length]);
  for (const tag of text.matchAll(/<(input|select|textarea)\b((?:=>|[^>])*)>/g)) {
    const attrs = tag[2];
    if (/\stype=["']hidden["']/.test(attrs)) continue;
    const named = /aria-label(?:ledby)?=/.test(attrs);
    const linked = /\sid=/.test(attrs) && /htmlFor=/.test(text);
    const wrapped = labels.some(([start, end]) => tag.index > start && tag.index < end);
    if (!named && !linked && !wrapped)
      problems.push(`${rel(file)}: form control without an accessible label (htmlFor, wrapping <label> or aria-label)`);
  }
};

const checkStylesheets = (files) => {
  for (const file of files) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const block of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const selector = block[1].trim();
      if (/outline(?:-style)?\s*:\s*(?:none|0)\b/.test(block[2]) && !selector.includes(":focus-visible"))
        problems.push(`${rel(file)}: "${selector}" removes the focus outline; style :focus-visible instead`);
    }
    for (const face of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      if (!/font-display\s*:\s*(?:swap|optional|fallback)/.test(face[1]))
        problems.push(`${rel(file)}: @font-face needs font-display: swap, optional or fallback`);
      if (/url\(\s*["']?(?:https?:)?\/\//i.test(face[1]))
        problems.push(`${rel(file)}: @font-face must load fonts from the same origin`);
    }
  }
  const all = files.map(read).join("\n");
  const motion = /(?:^|[\s;{])(?:transition|animation)(?:-[a-z]+)?\s*:|scroll-behavior\s*:\s*smooth/.test(all);
  const reduced = all.match(/@media[^{]*prefers-reduced-motion[^{]*\{([\s\S]*?\})\s*\}/);
  if (motion && reduced !== null && !/transition|animation/.test(reduced[1]))
    problems.push("stylesheets: prefers-reduced-motion must neutralize transition and animation");
};

const checkBudgets = () => {
  const assetRoots = webLayout ? [resolve(root, "dist")] : [root];
  const isCss = (name) => name.endsWith(".css");
  const isJs = (name) => /\.(?:m|c)?js$/.test(name);
  const sizeOf = (path) => (webLayout ? gzipSync(readFileSync(path)).length : statSync(path).size);
  const unit = webLayout ? "gzip" : "raw";
  const total = (test) => assetRoots.flatMap((dir) => walkAssets(dir, test)).reduce((sum, path) => sum + sizeOf(path), 0);
  const limits = webLayout ? [BUDGET.gzipJs, BUDGET.gzipCss] : [BUDGET.rawJs, BUDGET.rawCss];
  const jsBytes = total(isJs);
  const cssBytes = total(isCss);
  if (jsBytes > limits[0]) problems.push(`performance budget: JS is ${jsBytes} bytes ${unit} (maximum ${limits[0]})`);
  if (cssBytes > limits[1]) problems.push(`performance budget: CSS is ${cssBytes} bytes ${unit} (maximum ${limits[1]})`);
  const imageRoots = webLayout ? [publicDir, resolve(root, "dist")] : [root];
  for (const file of imageRoots.flatMap((dir) => walkAssets(dir, (name) => IMAGE_FILE.test(name)))) {
    const size = statSync(file).size;
    if (size > BUDGET.image) problems.push(`${rel(file)}: image is larger than ${BUDGET.image / KIB} KiB`);
    else if (LEGACY_RASTER.test(file) && size > BUDGET.legacyRaster)
      problems.push(`${rel(file)}: raster image larger than ${BUDGET.legacyRaster / KIB} KiB; use webp or avif`);
  }
};

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

  checkAccessibility(name, html);
  checkStringTable(name, html);
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

const styleFiles = webLayout
  ? [...walkAssets(publicDir, (name) => name.endsWith(".css")), ...walk(resolve(root, "src"), [".css"])]
  : walkAssets(root, (name) => name.endsWith(".css"));
checkStylesheets(styleFiles);
if (webLayout) {
  for (const file of walk(resolve(root, "src"), [".tsx"])) {
    if (!file.endsWith(".test.tsx")) checkSourceControls(file, read(file));
  }
}
checkBudgets();

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
