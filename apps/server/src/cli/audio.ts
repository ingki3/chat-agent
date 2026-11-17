import "../env.js";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { pythonRuntime } from "../mcp/python.js";
import { audioState, installAudioModels, installAudioPackages } from "../audio/packages.js";
import { sandboxedAudioRunner, workFolders } from "../audio/runner.js";
import { makeAudioWorkdir } from "../audio/service.js";
import { removeTree } from "../python/service.js";

/**
 * `pnpm audio:install` installs what `audio_transcribe` (#173) runs: the pinned packages (requirements.lock) for
 * SKILL_PYTHON into `<DATA_DIR>/audio-packages/`, and the pinned model weights (models.json: repo, commit, sizes,
 * SHA-256) into `<DATA_DIR>/audio-models/`. The only network the feature ever uses for itself (PyPI, Hugging Face),
 * from this command only. `pnpm audio:status` shows what the server would offer; `pnpm audio:check` runs the real
 * sandboxed steps once on a synthetic tone (ffmpeg, the diarizer, Whisper — Metal inside the sandbox) and prints
 * the outcome of each step, never any content. Restart the server afterwards.
 */
const config = loadConfig();
const [cmd] = process.argv.slice(2);

const state = () => audioState(config.skillPython, config.dataDir, config.audioFfmpeg);

/** A 16-bit mono PCM WAV of a quiet tone (seconds at `rate`). */
function toneWav(seconds: number, rate = 44100): Buffer {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

if (cmd === "install") {
  const py = pythonRuntime(config.skillPython);
  if (!py.ok) {
    console.error(`python: not usable (${py.reason})`);
    process.exit(1);
  }
  try {
    installAudioPackages(py.runtime, config.dataDir, { log: (l) => console.log(l) });
    await installAudioModels(config.dataDir, { log: (l) => console.log(l) });
  } catch (e) {
    console.error(`audio_transcribe: refused — ${(e as Error).message}`);
    process.exit(1);
  }
  const s = state();
  console.log(`audio_transcribe: ${s.state}${s.state === "available" ? "" : ` (${s.reason})`}`);
  process.exit(s.state === "available" ? 0 : 1);
} else if (cmd === "status") {
  const s = state();
  console.log(`audio_transcribe: ${s.state}${s.state === "available" ? "" : ` (${s.reason})`}`);
  console.log(`OPENROUTER_API_KEY: ${config.skillSecrets.OPENROUTER_API_KEY ? "set" : "not set"}`);
  process.exit(s.state === "available" ? 0 : 1);
} else if (cmd === "check") {
  const s = state();
  if (s.state !== "available") {
    console.error(`audio_transcribe: ${s.state} (${s.reason})`);
    process.exit(1);
  }
  const runner = sandboxedAudioRunner();
  const workdir = makeAudioWorkdir(config.dataDir);
  let ok = true;
  try {
    const input = path.join(workFolders(workdir).in, "input.wav");
    fs.writeFileSync(input, toneWav(4), { mode: 0o600 });
    let t = Date.now();
    const c = await runner.convert({ env: s.env, workdir, input });
    console.log(
      `convert (ffmpeg, sandbox): ${c.ok ? `ok ${c.seconds.toFixed(1)} s` : c.code} — ${Date.now() - t} ms`,
    );
    if (!c.ok) process.exitCode = 1;
    else {
      const job = { env: s.env, workdir, wav: c.wav, language: "ko", threshold: 0.85 };
      t = Date.now();
      const d = await runner.diarize(job);
      console.log(`diarize (Nemotron, sandbox + Metal): ${d.ok ? "ok" : d.code} — ${Date.now() - t} ms`);
      t = Date.now();
      const w = await runner.transcribe(job);
      console.log(`transcribe (Whisper, sandbox + Metal): ${w.ok ? "ok" : w.code} — ${Date.now() - t} ms`);
      ok = d.ok && w.ok;
    }
  } finally {
    removeTree(workdir);
  }
  process.exit(ok && !process.exitCode ? 0 : 1);
} else {
  console.error("usage: audio install | audio status | audio check");
  process.exit(2);
}
