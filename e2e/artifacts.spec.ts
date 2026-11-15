import crypto from "node:crypto";
import { expect, test, type APIRequestContext, type Frame, type Page } from "@playwright/test";
import { MOM, SON, csrf, newConversation, useAccount } from "./helpers.js";

/**
 * Artifacts (#27, PRD FR-6.5): an HTML artifact made through the real MCP tool path (FakeRuntime `/artifact`
 * command → `artifact_create` with the run's token) really draws its chart in the `/a/:id` viewer, and from the
 * same document the app's cookies, API, parent page and top window are out of reach.
 */

const CHART_JS = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";

/** A self-contained chart (canvas + SVG, no network) and probes of everything the sandbox must refuse. */
const PROBE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>probe</title></head><body>
<canvas id="chart" width="300" height="150"></canvas>
<svg id="bars" xmlns="http://www.w3.org/2000/svg" width="300" height="100"></svg>
<pre id="out"></pre>
<script>
  const results = { violations: [] };
  document.addEventListener("securitypolicyviolation", (e) => {
    results.violations.push(e.effectiveDirective + " " + (e.blockedURI || ""));
    show();
  });
  function show() { document.getElementById("out").textContent = JSON.stringify(results); }
  const data = [3, 7, 5, 9];
  const ctx = document.getElementById("chart").getContext("2d");
  ctx.fillStyle = "rgb(47, 111, 176)";
  data.forEach((v, i) => ctx.fillRect(20 + i * 70, 150 - v * 15, 40, v * 15));
  const ns = "http://www.w3.org/2000/svg";
  data.forEach((v, i) => {
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("class", "bar");
    r.setAttribute("x", 20 + i * 70); r.setAttribute("y", 100 - v * 10);
    r.setAttribute("width", 40); r.setAttribute("height", v * 10);
    document.getElementById("bars").appendChild(r);
  });
  results.origin = String(self.origin);
  try { results.cookie = "value:" + document.cookie; } catch (e) { results.cookie = "threw:" + e.name; }
  try { results.storage = "value:" + localStorage.length; } catch (e) { results.storage = "threw:" + e.name; }
  try { results.parent = "value:" + typeof parent.document.body; } catch (e) { results.parent = "threw:" + e.name; }
  // In a frame: try to take over the app window. (Opened top-level, a document may navigate itself — not tested.)
  if (window !== top)
    try { top.location.href = "/?escaped=1"; results.top = "no-throw"; } catch (e) { results.top = "threw:" + e.name; }
  show();
  fetch("/api/conversations", { credentials: "include" })
    .then((r) => { results.fetch = "status:" + r.status; }, (e) => { results.fetch = "rejected:" + e.name; })
    .finally(() => { show(); document.body.dataset.done = "1"; });
</script>
<button id="inline" onclick="document.body.dataset.inline='ran'">inline handler</button>
<script src="https://evil.example.com/steal.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
</body></html>`;

type Probe = {
  origin: string;
  cookie: string;
  storage: string;
  parent: string;
  top: string;
  fetch?: string;
  violations: string[];
};

/** Sends a FakeRuntime command as `request`'s user and waits until the run has ended. */
async function runCommand(request: APIRequestContext, baseURL: string, conversationId: string, text: string) {
  const r = await request.post(`/api/conversations/${conversationId}/messages`, {
    data: { text },
    headers: { ...csrf(baseURL), "Idempotency-Key": `e2e-${Date.now()}-${Math.random()}` },
  });
  expect(r.status()).toBe(201);
  const { run } = (await r.json()) as { run: { id: string } };
  await expect
    .poll(
      async () => ((await (await request.get(`/api/runs/${run.id}`)).json()) as { status: string }).status,
    )
    .toBe("done");
}

async function makeArtifact(page: Page, baseURL: string, kind: string, title: string, body: string) {
  const conv = await newConversation(page.request, baseURL, `아티팩트 ${title}`);
  await runCommand(page.request, baseURL, conv.id, `/artifact ${kind} ${title}\n${body}`);
  const list = (await (await page.request.get(`/api/conversations/${conv.id}/artifacts`)).json()) as {
    items: { id: string; latestVersion: number }[];
  };
  expect(list.items).toHaveLength(1);
  return { conversationId: conv.id, id: list.items[0]!.id };
}

async function artifactFrame(page: Page): Promise<Frame> {
  const el = page.getByTestId("artifact-frame");
  await expect(el).toHaveAttribute("sandbox", "allow-scripts");
  const frame = await (await el.elementHandle())!.contentFrame();
  expect(frame).not.toBeNull();
  return frame!;
}

test("an HTML chart artifact really draws, and cannot reach cookies, the API, the parent or the top window", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  // A cookie script could read on the app's own origin (the session cookie is HttpOnly anyway).
  await page.context().addCookies([{ name: "al_probe", value: "visible", url: baseURL! }]);
  const { id } = await makeArtifact(page, baseURL!, "html", "보안 시험 차트", PROBE_HTML);

  const apiCalls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/conversations") && r.frame() !== page.mainFrame())
      apiCalls.push(r.url());
  });
  await page.goto(`/a/${id}`);
  await expect(page.getByTestId("artifact-kind")).toHaveText("HTML");
  // The app page itself can read its non-HttpOnly cookie — the artifact below must not.
  expect(await page.evaluate(() => document.cookie)).toContain("al_probe=visible");
  const frame = await artifactFrame(page);
  await expect(frame.locator("body[data-done='1']")).toBeAttached();

  // 1) It really rendered: a drawn canvas pixel (inside the first bar) and the SVG bars.
  const pixel = await frame.evaluate(() =>
    Array.from(
      (document.getElementById("chart") as HTMLCanvasElement).getContext("2d")!.getImageData(40, 140, 1, 1)
        .data,
    ),
  );
  expect(pixel).toEqual([47, 111, 176, 255]);
  const empty = await frame.evaluate(() =>
    Array.from(
      (document.getElementById("chart") as HTMLCanvasElement).getContext("2d")!.getImageData(5, 5, 1, 1).data,
    ),
  );
  expect(empty[3]).toBe(0);
  await expect(frame.locator("svg#bars rect.bar")).toHaveCount(4);

  // 2) The same document cannot reach anything of the app.
  const r = JSON.parse((await frame.locator("#out").textContent())!) as Probe;
  expect(r.origin).toBe("null"); // opaque origin
  expect(r.cookie).toMatch(/^threw:SecurityError$|^value:$/);
  expect(r.cookie).not.toContain("al_probe");
  expect(r.storage).toBe("threw:SecurityError");
  expect(r.parent).toBe("threw:SecurityError");
  expect(r.fetch).toBe("rejected:TypeError");
  expect(r.violations).toContain("connect-src " + `${baseURL}/api/conversations`);
  expect(apiCalls).toEqual([]); // the request never left the frame
  // No top navigation: the address is still the artifact page.
  await page.waitForTimeout(300);
  expect(new URL(page.url()).pathname).toBe(`/a/${id}`);
  expect(r.top).toBe("threw:SecurityError"); // no allow-top-navigation

  // 3) External scripts outside the allow-list are blocked (another host, another version of the allowed one).
  expect(r.violations).toContain("script-src-elem https://evil.example.com/steal.js");
  expect(r.violations).toContain(
    "script-src-elem https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js",
  );
  // Inline event handlers do not run (no 'unsafe-inline' / 'unsafe-hashes').
  await frame.locator("#inline").click();
  await page.waitForTimeout(100);
  expect(await frame.evaluate(() => document.body.dataset.inline ?? "none")).toBe("none");
  const after = JSON.parse((await frame.locator("#out").textContent())!) as Probe;
  expect(after.violations.some((v) => v.startsWith("script-src-attr"))).toBe(true);
});

test("the original opened as a top-level page is still sandboxed (opaque origin, no API)", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  await page.context().addCookies([{ name: "al_probe", value: "visible", url: baseURL! }]);
  const { id } = await makeArtifact(page, baseURL!, "html", "최상위 시험", PROBE_HTML);
  const res = await page.goto(`/a/${id}/v/1/raw`);
  expect(res!.status()).toBe(200);
  const h = res!.headers();
  // Two policies, two header lines: A (sandbox, hashes, everything else) and B (external scripts: CDN URL only).
  const policies = await res!.headerValues("content-security-policy");
  expect(policies).toHaveLength(2);
  expect(policies[0]).toMatch(/^sandbox allow-scripts; default-src 'none'; script-src 'sha256-/);
  expect(policies[0]).toContain(`${CHART_JS};`);
  expect(policies[0]).toContain("connect-src 'none'");
  expect(policies[1]).toBe(`script-src 'unsafe-inline' ${CHART_JS}`);
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["cache-control"]).toBe("no-store");
  expect(h["cross-origin-resource-policy"]).toBe("same-origin");
  expect(h["referrer-policy"]).toBe("no-referrer");
  await expect(page.locator("body[data-done='1']")).toBeAttached();
  const r = JSON.parse((await page.locator("#out").textContent())!) as Probe;
  expect(r.origin).toBe("null");
  expect(r.cookie).not.toContain("al_probe");
  expect(r.storage).toBe("threw:SecurityError");
  expect(r.fetch).toBe("rejected:TypeError");
  // Even script run by the page's own window cannot read the app cookie here.
  expect(await page.evaluate(() => (self.origin === "null" ? "opaque" : document.cookie))).toBe("opaque");
});

test("another family member gets 403 on the page and the original; the owner can revert", async ({
  page,
  browser,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const { id } = await makeArtifact(page, baseURL!, "markdown", "엄마 메모", "# 비밀 메모");
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const son = await ctx.newPage();
  await useAccount(son, SON);
  for (const path of [`/a/${id}`, `/a/${id}/v/1/raw`, `/a/${id}/v/1/download`, `/api/artifacts/${id}`])
    expect((await son.request.get(path)).status(), path).toBe(403);
  const shown = await son.goto(`/a/${id}`);
  expect(shown!.status()).toBe(403);
  await expect(son.getByRole("alert")).toHaveText("이 아티팩트를 볼 권한이 없어요.");
  await expect(son.getByText("비밀 메모")).toHaveCount(0);
  await ctx.close();

  // The owner: a second version, then back to the first (a copy as version 3).
  const conv = (await (await page.request.get(`/api/artifacts/${id}`)).json()) as { conversationId: string };
  await runCommand(
    page.request,
    baseURL!,
    conv.conversationId,
    `/artifact-update ${id} content\n# 고친 메모`,
  );
  await page.goto(`/a/${id}`);
  const frame = await artifactFrame(page);
  await expect(frame.locator("body")).toHaveText("# 고친 메모");
  await page.getByTestId("artifact-version").selectOption("1");
  await expect((await artifactFrame(page)).locator("body")).toHaveText("# 비밀 메모");
  await page.getByRole("button", { name: "이 버전으로 되돌리기" }).click();
  await expect(page.getByTestId("artifact-version")).toHaveValue("3");
  await expect(page.getByTestId("artifact-version").locator("option").first()).toHaveText(/v3 \(v1 복원\)/);
  await expect((await artifactFrame(page)).locator("body")).toHaveText("# 비밀 메모");
});

test("an external script carrying an allowed inline script's hash as its integrity does not run", async ({
  page,
  baseURL,
}) => {
  // CSP3: a hash source also admits an external script whose integrity names it. The second policy (external
  // scripts only from the exact CDN URLs) must stop it even though the body and SRI match an allowed inline script.
  const BODY = "window.hits=(window.hits||0)+1;document.documentElement.dataset.hits=String(window.hits);";
  const hash = crypto.createHash("sha256").update(BODY, "utf8").digest("base64");
  let served = 0;
  await page.route("https://evil.example.com/**", (route) => {
    served++;
    return route.fulfill({
      status: 200,
      contentType: "application/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: BODY,
    });
  });
  await useAccount(page, MOM);
  const html = `<!doctype html><body>
<script>document.addEventListener("securitypolicyviolation", (e) => {
  document.documentElement.dataset.violations = (document.documentElement.dataset.violations || "") + "|" + e.effectiveDirective + " " + e.blockedURI;
});</script>
<script>${BODY}</script>
<script src="https://evil.example.com/same.js" integrity="sha256-${hash}" crossorigin="anonymous"></script>
<script>document.body.dataset.done = "1";</script>
</body>`;
  const { id } = await makeArtifact(page, baseURL!, "html", "해시 우회 시험", html);
  await page.goto(`/a/${id}`);
  const frame = await artifactFrame(page);
  await expect(frame.locator("body[data-done='1']")).toBeAttached();
  await page.waitForTimeout(200);
  expect(await frame.evaluate(() => document.documentElement.dataset.hits)).toBe("1"); // the inline copy only
  expect(await frame.evaluate(() => document.documentElement.dataset.violations ?? "")).toContain(
    "script-src-elem https://evil.example.com/same.js",
  );
  expect(served).toBe(0); // refused before any request
});

const CHART_HTML = `<canvas id="c" width="300" height="150"></canvas><script src="${CHART_JS}"></script>
<script>
  if (window.Chart) {
    new Chart(document.getElementById("c"), {
      type: "bar",
      data: { labels: ["a", "b"], datasets: [{ data: [3, 5], backgroundColor: "rgb(200, 30, 30)" }] },
      options: { animation: false, responsive: false, plugins: { legend: { display: false } } },
    });
  }
  document.body.dataset.chart = window.Chart ? "loaded" : "missing";
</script>`;

test("the allow-listed CDN script gets its SRI hash; only that exact URL is allowed", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const { id } = await makeArtifact(page, baseURL!, "html", "Chart.js 시험", CHART_HTML);
  const raw = await page.request.get(`/a/${id}/v/1/raw`);
  const body = await raw.text();
  expect(body).toMatch(
    new RegExp(
      `<script src="${CHART_JS.replace(/[.]/g, "\\.")}" integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous">`,
    ),
  );
  const [csp] = raw
    .headersArray()
    .filter((x) => x.name.toLowerCase() === "content-security-policy")
    .map((x) => x.value);
  const scriptSrc = csp!.split("; ").find((d) => d.startsWith("script-src"))!;
  // Exact path only: no host-wide or prefix source that would admit other versions or packages.
  expect(scriptSrc.split(" ").filter((s) => s.startsWith("https:"))).toEqual([CHART_JS]);
});

// Loading the library needs the network (cdn.jsdelivr.net), so CI does not depend on it: E2E_NETWORK=1 runs it.
test("with the network, the allow-listed Chart.js loads (SRI checked) and draws", async ({
  page,
  baseURL,
}) => {
  test.skip(process.env.E2E_NETWORK !== "1", "set E2E_NETWORK=1 to load the CDN script for real");
  await useAccount(page, MOM);
  const { id } = await makeArtifact(page, baseURL!, "html", "Chart.js 그리기", CHART_HTML);
  await page.goto(`/a/${id}`);
  const frame = await artifactFrame(page);
  await expect(frame.locator("body[data-chart='loaded']")).toBeAttached({ timeout: 15_000 });
  const drawn = await frame.evaluate(() => {
    const c = document.getElementById("c") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i]! > 150 && d[i + 1]! < 80 && d[i + 2]! < 80) return true;
    return false;
  });
  expect(drawn).toBe(true);
});

/** PNG/PDF export (#51). The server renders only on macOS (process sandbox); elsewhere it refuses (503). */
const SERVER_RENDERS = process.platform === "darwin";
const CHART = JSON.stringify({
  type: "bar",
  title: "월별 매출",
  labels: ["1월", "2월", "3월"],
  series: [{ name: "매출", values: [3, 7, 5] }],
});
const head = async (path: string, n: number) => (await import("node:fs")).readFileSync(path).subarray(0, n);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("chart PNG: drawn in the browser first, the server's isolated renderer only when that fails", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const { id } = await makeArtifact(page, baseURL!, "chart", "매출 차트", CHART);
  const serverCalls: string[] = [];
  page.on("request", (r) => {
    if (/\/v\/1\/(png|pdf)$/.test(new URL(r.url()).pathname)) serverCalls.push(r.url());
  });
  await page.goto(`/a/${id}`);
  await expect(page.getByTestId("artifact-export-png")).toBeVisible();

  // 1) Client capture: a PNG, and the server renderer was not asked.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("artifact-export-png").click(),
  ]);
  expect(download.suggestedFilename()).toBe("매출 차트.png");
  expect((await head((await download.path())!, 8)).equals(PNG_MAGIC)).toBe(true);
  expect(serverCalls).toEqual([]);

  // 2) Capture fails (the SVG cannot be fetched): the server renders instead.
  await page.route(`**/a/${id}/v/1/download`, (route) => route.abort());
  if (SERVER_RENDERS) {
    const [again] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("artifact-export-png").click(),
    ]);
    expect((await head((await again.path())!, 8)).equals(PNG_MAGIC)).toBe(true);
  } else {
    await page.getByTestId("artifact-export-png").click();
    await expect(page.getByTestId("artifact-export-error")).toBeVisible();
  }
  expect(serverCalls).toHaveLength(1);
  expect(serverCalls[0]).toMatch(new RegExp(`/a/${id}/v/1/png$`));
});

test("document PDF from the isolated renderer; another family member gets 403 on the exports", async ({
  page,
  browser,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body><h1>여행 계획</h1>
<p>첫째 날</p><script>fetch("/api/conversations").catch(() => {}); setTimeout(() => { location.href = "/api/conversations"; }, 30);</script></body></html>`;
  const { id } = await makeArtifact(page, baseURL!, "html", "여행 계획", html);
  await page.goto(`/a/${id}`);
  if (SERVER_RENDERS) {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("artifact-export-pdf").click(),
    ]);
    expect(download.suggestedFilename()).toBe("여행 계획.pdf");
    expect((await head((await download.path())!, 5)).toString("latin1")).toBe("%PDF-");
  } else {
    await page.getByTestId("artifact-export-pdf").click();
    await expect(page.getByTestId("artifact-export-error")).toBeVisible();
    expect((await page.request.get(`/a/${id}/v/1/pdf`)).status()).toBe(503);
  }
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const son = await ctx.newPage();
  await useAccount(son, SON);
  for (const path of [`/a/${id}/v/1/png`, `/a/${id}/v/1/pdf`])
    expect((await son.request.get(path)).status(), path).toBe(403);
  await ctx.close();
});

test("an expired gate or session never turns into a saved PNG/PDF (login page, redirect or error body)", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const { id } = await makeArtifact(page, baseURL!, "chart", "만료 시험", CHART);
  await page.goto(`/a/${id}`);
  await expect(page.getByTestId("artifact-export-png")).toBeVisible();
  let downloads = 0;
  page.on("download", () => downloads++);
  const expectRefused = async (button: "png" | "pdf") => {
    await page.getByTestId(`artifact-export-${button}`).click();
    await expect(page.getByTestId("artifact-export-error")).toBeVisible();
    await page.waitForTimeout(300);
    expect(downloads).toBe(0);
  };

  // 1) The gate expired: every request is redirected to the gate page (which would answer 200 HTML).
  const toGate = { status: 302, headers: { location: "/gate" } };
  await page.route(`**/a/${id}/v/1/download`, (r) => r.fulfill(toGate));
  await page.route(`**/a/${id}/v/1/png`, (r) => r.fulfill(toGate));
  await page.route(`**/a/${id}/v/1/pdf`, (r) => r.fulfill(toGate));
  await expectRefused("png");
  await expectRefused("pdf");

  // 2) A login page served as 200 HTML in place of the file.
  await page.unrouteAll();
  const login = { status: 200, contentType: "text/html", body: "<!doctype html><title>로그인</title>" };
  await page.route(`**/a/${id}/v/1/download`, (r) => r.fulfill(login));
  await page.route(`**/a/${id}/v/1/png`, (r) => r.fulfill(login));
  await page.route(`**/a/${id}/v/1/pdf`, (r) => r.fulfill(login));
  await expectRefused("png");
  await expectRefused("pdf");

  // 3) The session really ended (signed out elsewhere): the server answers 401.
  await page.unrouteAll();
  await page.context().clearCookies();
  await expectRefused("png");
  await expectRefused("pdf");
});
