import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "../env.js";
import { CLAUDE_EGRESS_HOSTS, CODEX_EGRESS_HOSTS, EgressService } from "../isolation/egress.js";
import { runInjectionEval, scriptedInjectionRuntime } from "../instructions/injection-eval.js";
import type { RuntimeAdapter } from "../runtime/adapter.js";
import { ClaudeAdapter } from "../runtime/claude.js";
import { CodexAdapter } from "../runtime/codex.js";

/**
 * Prompt-injection evaluation (#20, docs/acceptance.md §4, docs/ops.md "시스템 지침").
 *
 *   pnpm -s injection-eval --runtime claude-code,codex --out docs/evidence/injection/<date>.json
 *   pnpm -s injection-eval --runtime fake-compliant          (harness self-check, no credentials)
 *
 * claude-code needs CLAUDE_API_KEY, codex needs CODEX_API_KEY in .env (macOS sandbox).
 * The report holds tool names and targets only. Exit 0 only when every non-pending run passed.
 */
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const runtimes = (arg("--runtime") ?? "fake-compliant").split(",");
// pnpm runs this from apps/server: a relative --out is relative to where the command was typed.
const outArg = arg("--out");
const out = outArg ? path.resolve(process.env.INIT_CWD ?? process.cwd(), outArg) : undefined;

const closers: (() => Promise<void>)[] = [];
function adapterFor(name: string): RuntimeAdapter {
  if (name === "fake-compliant" || name === "fake-obedient")
    return scriptedInjectionRuntime(name === "fake-compliant" ? "compliant" : "obedient");
  if (name === "claude-code") {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) throw new Error("claude-code: CLAUDE_API_KEY is not set");
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentlee-inj-"));
    const egress = new EgressService({ allow: CLAUDE_EGRESS_HOSTS });
    closers.push(
      () => egress.close(),
      async () => fs.rmSync(dir, { recursive: true, force: true }),
    );
    return new ClaudeAdapter({
      connection: () => ({
        id: "injection-eval",
        dir: path.join(dir, "conn"),
        auth: { kind: "api_key", apiKey },
      }),
      egress,
    });
  }
  if (name === "codex") {
    const apiKey = process.env.CODEX_API_KEY;
    if (!apiKey) throw new Error("codex: CODEX_API_KEY is not set");
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentlee-inj-"));
    const egress = new EgressService({ allow: CODEX_EGRESS_HOSTS });
    closers.push(
      () => egress.close(),
      async () => fs.rmSync(dir, { recursive: true, force: true }),
    );
    return new CodexAdapter({
      connection: () => ({
        id: "injection-eval",
        dir: path.join(dir, "conn"),
        auth: { kind: "api_key", apiKey },
      }),
      egress,
    });
  }
  throw new Error(`${name}: unknown runtime`);
}

try {
  const report = await runInjectionEval({ adapters: runtimes.map(adapterFor) });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
  }
  const s = report.summary;
  console.log(
    `injection-eval: ${s.runs} runs — pass ${s.pass}, fail ${s.fail}, error ${s.error}, pending ${s.pending}, ` +
      `forbidden calls ${s.violations}${out ? ` → ${out}` : ""}`,
  );
  if (!out) process.stdout.write(json);
  process.exitCode = s.fail || s.error ? 1 : 0;
} finally {
  for (const c of closers) await c().catch(() => {});
}
