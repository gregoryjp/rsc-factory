import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootFlag = process.argv.indexOf("--root");
const root =
  rootFlag === -1 ? fileURLToPath(new URL("..", import.meta.url)) : resolve(process.argv[rootFlag + 1]);
const problems = [];

const entry = resolve(root, "index.html");
if (!existsSync(entry)) {
  problems.push("index.html does not exist");
} else {
  const html = readFileSync(entry, "utf8");
  if (!/<html[^>]*\slang=/i.test(html)) problems.push("index.html: <html> has no lang attribute");
  if (!/<title>[^<]+<\/title>/i.test(html)) problems.push("index.html: missing non-empty <title>");
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) problems.push("index.html: missing viewport meta");
  for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
    const link = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link)) continue;
    const path = link.split(/[?#]/)[0];
    const target = path.startsWith("/") ? resolve(root, `.${path}`) : resolve(dirname(entry), path);
    if (!existsSync(target)) problems.push(`index.html: link "${link}" does not resolve`);
  }
}

if (problems.length > 0) {
  console.error("Static landing check failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("Static landing check OK");
