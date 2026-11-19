import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #219: the CI classifier that lets a documentation-only pull request skip the test and e2e shards.
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ci/docs-only.sh");
const docsOnly = (paths: string[]) =>
  execFileSync("bash", [SCRIPT], { input: paths.join("\n") + "\n" })
    .toString()
    .trim();

describe("docs-only classifier (#219)", () => {
  it.each([
    [["docs/foo.md"], "true"],
    [["README.md"], "true"],
    [["docs/decisions/a.md", "mockup/REVIEW_01.md", ".github/pull_request_template.md"], "true"],
    [["PRD.md"], "false"], // read by scripts/test/traceability.test.ts
    [["docs/traceability.md"], "false"], // likewise
    [["docs/foo.sh"], "false"], // a script under docs/ is code
    [["docs/foo.md", "apps/server/src/index.ts"], "false"],
    [["apps/server/instructions/common.md"], "false"], // runtime prompts, not docs
    [["fixtures/extract/sample.md"], "false"],
    [["mockup/index.html"], "false"],
    [[".github/workflows/ci.yml"], "false"],
    [[], "false"], // no changed files: run everything
  ])("%j → %s", (paths, expected) => {
    expect(docsOnly(paths)).toBe(expected);
  });

  it("a renamed test input counts by its old path too (git diff --name-only --no-renames, as in ci.yml)", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "docs-only-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
          cwd: repo,
        }).toString();
      fs.mkdirSync(path.join(repo, "docs"));
      fs.writeFileSync(path.join(repo, "docs/traceability.md"), "# trace\n".repeat(50));
      git("init", "-q");
      git("add", ".");
      git("commit", "-qm", "base");
      git("mv", "docs/traceability.md", "docs/trace-moved.md");
      git("commit", "-qm", "rename");
      // Without --no-renames git lists only the new path, which alone would pass as documentation.
      expect(git("diff", "--name-only", "HEAD^1", "HEAD").trim()).toBe("docs/trace-moved.md");
      const changed = git("diff", "--name-only", "--no-renames", "HEAD^1", "HEAD").trim().split("\n");
      expect(changed.sort()).toEqual(["docs/trace-moved.md", "docs/traceability.md"]);
      expect(docsOnly(changed)).toBe("false");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
