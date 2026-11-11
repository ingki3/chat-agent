import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeUptime,
  formatReport,
  INTERVAL_MS,
  probeHealth,
  readRecords,
  readTokenFile,
  runCheck,
  type CheckRecord,
  type UptimeRecord,
} from "../uptime.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const FROM = NOW - 7 * DAY;
const SLOTS = (7 * DAY) / INTERVAL_MS; // 2016

const ok = { ok: true, status: 200, ms: 40 };
const down = { ok: false, status: 0, ms: 10_000, error: "timeout" };
/** One check per slot over 7 days; `bad(i)` decides which slots fail and how. */
function week(bad: (i: number) => "app" | "tunnel" | "skip" | "none" | undefined = () => undefined) {
  const out: UptimeRecord[] = [];
  for (let i = 0; i < SLOTS; i++) {
    const kind = bad(i);
    if (kind === "skip") continue;
    const at = FROM + i * INTERVAL_MS + 1000;
    const rec: CheckRecord =
      kind === "app"
        ? { kind: "check", at, local: down, external: { ok: false, status: 502, ms: 50 } }
        : kind === "tunnel"
          ? { kind: "check", at, local: ok, external: down }
          : kind === "none"
            ? { kind: "check", at, local: ok, external: { skipped: true } }
            : { kind: "check", at, local: ok, external: ok };
    out.push(rec);
  }
  return out;
}

describe("uptime report", () => {
  it("passes at ≥ 99% over a full week and classifies failures", () => {
    // 15 failures out of 2016 = 99.26 %.
    const r = computeUptime(
      week((i) => (i < 10 ? "app" : i < 15 ? "tunnel" : undefined)),
      { now: NOW },
    );
    expect(r.slots).toBe(2016);
    expect(r.denominator).toBe(2016);
    expect(r.counts).toMatchObject({ ok: 2001, app: 10, tunnel: 5, missing: 0 });
    expect(r.verdict).toBe("pass");
    expect(formatReport(r)).toMatch(/합격/);
  });

  it("fails below 99%, and counts slots without any check as failures", () => {
    const r = computeUptime(
      week((i) => (i >= 100 && i < 130 ? "skip" : undefined)),
      { now: NOW },
    );
    expect(r.counts.missing).toBe(30);
    expect(r.recorded).toBe(2016 - 30);
    expect(r.verdict).toBe("fail");
    expect(r.uptime).toBeCloseTo(1986 / 2016, 6);
    expect(formatReport(r)).toMatch(/불합격/);
  });

  it("excludes planned stops from the denominator and shows them", () => {
    const records = week((i) => (i >= 200 && i < 260 ? "skip" : undefined));
    const a = FROM + 200 * INTERVAL_MS;
    const b = FROM + 260 * INTERVAL_MS;
    records.push({ kind: "planned_start", at: a, note: "filevault" }, { kind: "planned_end", at: b });
    const r = computeUptime(records, { now: NOW });
    expect(r.counts.planned).toBe(60);
    expect(r.counts.missing).toBe(0);
    expect(r.denominator).toBe(2016 - 60);
    expect(r.verdict).toBe("pass");
    // The same window given as a range.
    const r2 = computeUptime(
      [...week((i) => (i >= 200 && i < 260 ? "skip" : undefined)), { kind: "planned", from: a, to: b }],
      {
        now: NOW,
      },
    );
    expect(r2.counts.planned).toBe(60);
  });

  it("tolerates jitter and late starts, but counts real misses, outages and restarts correctly", () => {
    const at = (i: number, delay = 0): CheckRecord => ({
      kind: "check",
      at: FROM + i * INTERVAL_MS + 1000 + delay,
      local: ok,
      external: ok,
    });
    const series = (delay: (i: number) => number, skip: (i: number) => boolean = () => false) =>
      Array.from({ length: SLOTS }, (_, i) => i)
        .filter((i) => !skip(i))
        .map((i) => at(i, delay(i)));

    // ±1 s alternating (the review's case: was 50 %), and late starts up to 50 s.
    const jitter = computeUptime(
      series((i) => (i % 2 ? 1000 : -1000)),
      { now: NOW },
    );
    expect(jitter.counts).toMatchObject({ ok: 2016, missing: 0 });
    expect(jitter.verdict).toBe("pass");
    const late = computeUptime(
      series((i) => (i * 7919) % 50_000),
      { now: NOW },
    );
    expect(late.counts.missing).toBe(0);
    expect(late.slots).toBe(2016);

    // One check that never ran is one miss; a 1-hour outage (12 checks) is 12.
    expect(
      computeUptime(
        series(
          () => 0,
          (i) => i === 500,
        ),
        { now: NOW },
      ).counts.missing,
    ).toBe(1);
    const outage = computeUptime(
      series(
        () => 0,
        (i) => i >= 700 && i < 712,
      ),
      { now: NOW },
    );
    expect(outage.counts.missing).toBe(12);
    expect(outage.slots).toBe(2016);

    // A restart runs one extra check at load (20 s later): still one slot, and the worse result counts.
    const restart = series(() => 0);
    restart.push({ ...at(900), at: at(900).at + 20_000, local: down, external: down });
    const r = computeUptime(restart, { now: NOW });
    expect(r.slots).toBe(2016);
    expect(r.counts).toMatchObject({ ok: 2015, app: 1, missing: 0 });
    expect(r.recorded).toBe(2017);
  });

  it("follows the schedule shifted by restarts (the next check is an interval after the restart check)", () => {
    // 30 restarts over the week, each 120 s (or 200 s) after a regular check; launchd then runs every 5 minutes
    // from the restart check, so every later check is shifted.
    const records: CheckRecord[] = [];
    let t = FROM + 1000;
    let restarts = 0;
    while (t < NOW) {
      records.push({ kind: "check", at: t, local: ok, external: ok });
      const i = records.length;
      if (i % 67 === 0 && restarts < 30) {
        restarts++;
        t += restarts % 2 ? 120_000 : 200_000;
      } else t += INTERVAL_MS;
    }
    expect(restarts).toBe(30);
    const r = computeUptime(records, { now: NOW });
    expect(r.counts.missing).toBe(0);
    expect(r.counts.app + r.counts.tunnel).toBe(0);
    expect(r.verdict).toBe("pass");
    // The review's minimal case: 0 s → restart check at 120 s → next at 420 s is no miss.
    const base = FROM + 2 * DAY;
    const shifted: CheckRecord[] = [];
    for (let at = FROM + 1000; at <= base; at += INTERVAL_MS)
      shifted.push({ kind: "check", at, local: ok, external: ok });
    const restartAt = shifted.at(-1)!.at + 120_000;
    for (let at = restartAt; at < NOW; at += INTERVAL_MS)
      shifted.push({ kind: "check", at, local: ok, external: ok });
    const tiny = computeUptime(shifted, { now: NOW });
    expect(tiny.counts.missing).toBe(0);
  });

  it("refuses a verdict before 7 days are recorded or without the external path", () => {
    const partial = week().filter((r) => r.kind !== "check" || r.at > FROM + DAY);
    const r = computeUptime(partial, { now: NOW });
    expect(r.verdict).toBe("insufficient");
    expect(r.reasons.join()).toMatch(/7 days/);
    const noToken = computeUptime(
      week((i) => (i % 2 ? "none" : undefined)),
      { now: NOW },
    );
    expect(noToken.verdict).toBe("insufficient");
    expect(noToken.counts.unmeasured).toBe(1008);
    expect(computeUptime([], { now: NOW }).verdict).toBe("insufficient");
  });
});

const servers: http.Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});
async function serve(handler: http.RequestListener) {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/health`;
}
const health = JSON.stringify({ status: "ok", service: "agent-lee", version: "0", uptimeSec: 1 });

describe("health probe", () => {
  it("succeeds only on our 200 health response within the timeout", async () => {
    expect(await probeHealth(await serve((_q, s) => s.end(health)))).toMatchObject({ ok: true, status: 200 });
    // An Access login page, a redirect, a 5xx and a hang are all failures.
    const page = await probeHealth(await serve((_q, s) => s.end("<html>login</html>")));
    expect(page).toMatchObject({ ok: false, status: 200, error: "not_health" });
    const redirect = await probeHealth(await serve((_q, s) => s.writeHead(302, { location: "/x" }).end()));
    expect(redirect).toMatchObject({ ok: false, status: 302 });
    expect(await probeHealth(await serve((_q, s) => s.writeHead(502).end()))).toMatchObject({
      ok: false,
      status: 502,
    });
    const hang = await probeHealth(await serve(() => {}), {}, 100);
    expect(hang).toMatchObject({ ok: false, status: 0, error: "timeout" });
    const closed = await serve(() => {});
    servers.pop()!.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(await probeHealth(closed)).toMatchObject({ ok: false, status: 0, error: "refused" });
  });

  it("sends the service token but never records it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-uptime-"));
    const tokenFile = path.join(dir, "uptime-token");
    const SECRET = "svc-secret-NEVER-LOGGED-1234";
    fs.writeFileSync(tokenFile, `CF-Access-Client-Id: abc.access\nCF-Access-Client-Secret: ${SECRET}\n`, {
      mode: 0o600,
    });
    let seen: string | undefined;
    const external = await serve((q, s) => {
      seen = String(q.headers["cf-access-client-secret"]);
      s.end(health);
    });
    const local = await serve((_q, s) => s.end(health));
    const rec = await runCheck({ local, external, token: readTokenFile(tokenFile) });
    expect(seen).toBe(SECRET);
    expect(rec.external).toMatchObject({ ok: true });
    expect(JSON.stringify(rec)).not.toContain(SECRET);

    // Through the CLI: output and the records file never contain it either.
    const file = path.join(dir, "uptime.jsonl");
    // Async: the test's own servers must keep answering while the CLI runs.
    const cli = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
      execFile(
        process.execPath,
        [
          path.join(root, "node_modules/tsx/dist/cli.mjs"),
          path.join(root, "scripts/uptime.ts"),
          "check",
          "--file",
          file,
          "--token-file",
          tokenFile,
          "--local",
          local,
          "--external",
          external,
        ],
        { encoding: "utf8" },
        (err, stdout, stderr) => resolve({ status: err ? Number(err.code ?? 1) : 0, stdout, stderr }),
      ),
    );
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout + cli.stderr + fs.readFileSync(file, "utf8")).not.toContain(SECRET);
    expect(readRecords(file)).toHaveLength(1);

    fs.chmodSync(tokenFile, 0o644);
    expect(() => readTokenFile(tokenFile)).toThrow(/mode 600/);
    expect(readTokenFile(path.join(dir, "missing"))).toBeUndefined();
  });
});
