// Checks a just-started release (#143, scripts/release.sh). Plain JS, no dependencies.
//
//   node scripts/release-verify.mjs --url http://127.0.0.1:3000 --index <release>/apps/web/dist/index.html
//        [--timeout <s>] [--pid <pid>]
//
// Passes when GET /api/health answers 200 {"status":"ok"} AND the page at / names exactly the asset files of this
// release's index.html AND each of them is served 200 with a JavaScript or CSS type. A server that is not the new
// one (still the old process, or an old build) answers those asset paths with the SPA page (text/html) or 404.
// Retries until the timeout; stops early when --pid is given and that process is gone.
// Prints status codes, types and paths only — never headers, cookies or bodies.
import fs from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const base = args.get("--url");
const indexFile = args.get("--index");
const timeoutS = Number(args.get("--timeout") ?? "90");
const pid = args.has("--pid") ? Number(args.get("--pid")) : undefined;
if (!base || !indexFile || !Number.isFinite(timeoutS)) {
  console.error("usage: release-verify.mjs --url <base> --index <index.html> [--timeout <s>] [--pid <pid>]");
  process.exit(2);
}

/** `/assets/…` files a page loads: module scripts and stylesheets (Vite's output). */
function assetRefs(html) {
  const out = new Set();
  for (const m of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = m[0];
    const ref = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!ref || !ref.startsWith("/")) continue;
    if (m[1].toLowerCase() === "link" && !/\brel\s*=\s*["']?(stylesheet|modulepreload)/i.test(tag)) continue;
    out.add(ref.split(/[?#]/)[0]);
  }
  return [...out].sort();
}

const expected = assetRefs(fs.readFileSync(indexFile, "utf8"));
const alive = () => {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function get(path) {
  const res = await fetch(new URL(path, base), { signal: AbortSignal.timeout(5000), redirect: "manual" });
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const body = await res.text();
  return { status: res.status, type, body };
}

async function attempt() {
  let h;
  try {
    h = await get("/api/health");
  } catch {
    return "health: no answer";
  }
  if (h.status !== 200) return `health: ${h.status}`;
  try {
    if (JSON.parse(h.body).status !== "ok") return "health: not ok";
  } catch {
    return "health: not JSON";
  }
  if (expected.length === 0) return "index.html of the release names no assets";
  const page = await get("/");
  if (page.status !== 200 || page.type !== "text/html") return `/: ${page.status} ${page.type}`;
  const served = assetRefs(page.body);
  if (served.join("\n") !== expected.join("\n"))
    return "/: the page is not this release's index.html (stale server?)";
  for (const ref of expected) {
    const a = await get(ref);
    const want = ref.endsWith(".css") ? /^text\/css$/ : /^(text|application)\/javascript$/;
    if (a.status !== 200 || !want.test(a.type)) return `${ref}: ${a.status} ${a.type || "(no type)"}`;
  }
  return undefined;
}

const deadline = Date.now() + timeoutS * 1000;
let last;
for (;;) {
  last = (await attempt()) ?? "";
  if (!last) {
    console.log(`verify: ok — health 200, ${expected.length} asset(s) served with JS/CSS types`);
    process.exit(0);
  }
  if (!alive()) {
    console.error(`verify: failed — the server process exited (${last})`);
    process.exit(1);
  }
  if (Date.now() >= deadline) break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.error(`verify: failed — ${last}`);
process.exit(1);
