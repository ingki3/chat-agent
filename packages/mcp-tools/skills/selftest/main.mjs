// Verification skill (#43): harmless and read-only. Reads {"text": "..."} on stdin and answers with facts about
// it on stdout. Runs inside the sandbox with no network, no writes and no child processes.
import { createHash } from "node:crypto";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const { text } = JSON.parse(raw);
  process.stdout.write(
    JSON.stringify({
      characters: [...text].length,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      reversed: [...text].reverse().join(""),
    }),
  );
});
