import "../env.js";
import { loadConfig } from "../config.js";
import { pythonRuntime } from "../mcp/python.js";
import { runIsolated } from "../isolation/sandbox.js";
import { removeTree } from "../python/service.js";
import { installYoutubePackages, youtubeState } from "../youtube/packages.js";
import { scriptReport, youtubeFolders, ytdlpOptions } from "../youtube/runner.js";
import { makeYoutubeWorkdir } from "../youtube/service.js";
import fs from "node:fs";
import path from "node:path";

/**
 * `pnpm youtube:install` installs what `youtube_audio_fetch` (#191) runs: the pinned yt-dlp, yt-dlp-ejs and deno
 * (apps/server/youtube/requirements.lock: exact versions, wheel hashes) for SKILL_PYTHON into
 * `<DATA_DIR>/youtube-packages/` — never the admin's Homebrew yt-dlp. The only network it uses for itself (PyPI),
 * from this command only. To update yt-dlp, the lock is changed in the repository (a new version ≥ 3 days old, its
 * hashes) and this command run again. `pnpm youtube:status` shows what the server would offer; `pnpm youtube:check`
 * runs the real sandboxed yt-dlp once without network (it imports, starts deno as it would for YouTube's challenge,
 * and deno solves a tiny script) and prints the versions. Restart the server afterwards.
 */
const config = loadConfig();
const [cmd] = process.argv.slice(2);

const state = () => youtubeState(config.skillPython, config.dataDir, config.audioFfmpeg);
const show = (s: ReturnType<typeof state>) =>
  `youtube_audio_fetch: ${s.state}${s.state === "available" ? "" : ` (${s.reason})`}`;

if (cmd === "install") {
  const py = pythonRuntime(config.skillPython);
  if (!py.ok) {
    console.error(`python: not usable (${py.reason})`);
    process.exit(1);
  }
  try {
    installYoutubePackages(py.runtime, config.dataDir, { log: (l) => console.log(l) });
  } catch (e) {
    console.error(`youtube_audio_fetch: refused — ${(e as Error).message}`);
    process.exit(1);
  }
  const s = state();
  console.log(show(s));
  process.exit(s.state === "available" ? 0 : 1);
} else if (cmd === "status") {
  const s = state();
  console.log(show(s));
  process.exit(s.state === "available" ? 0 : 1);
} else if (cmd === "check") {
  const s = state();
  if (s.state !== "available") {
    console.error(show(s));
    process.exit(1);
  }
  const workdir = makeYoutubeWorkdir(config.dataDir);
  let ok: boolean;
  try {
    const f = youtubeFolders(workdir);
    for (const d of [f.yt, f.home, path.join(f.home, "tmp")])
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const t = Date.now();
    // No proxy is listening on this port: the check needs no network, and gets none.
    const r = await runIsolated(
      ytdlpOptions(
        { env: s.env, workdir, proxy: { url: "http://127.0.0.1:9", port: 9 } },
        { mode: "check" },
        120_000,
      ),
    );
    const rep = scriptReport(r);
    const v = rep.ok ? (rep as { ytdlp?: unknown; deno?: unknown; denoArgs?: unknown }) : undefined;
    ok = rep.ok;
    console.log(
      `check (yt-dlp + deno, sandbox): ${rep.ok ? `ok — yt-dlp ${String(v?.ytdlp)}, deno ${String(v?.deno)} ${JSON.stringify(v?.denoArgs)}` : rep.code} — ${Date.now() - t} ms`,
    );
  } finally {
    removeTree(workdir);
  }
  process.exit(ok ? 0 : 1);
} else {
  console.error("usage: youtube install | youtube status | youtube check");
  process.exit(2);
}
