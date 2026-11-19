import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #219: the CI classifier that lets a documentation-only pull request skip the test and e2e shards.
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ci/docs-only.sh");
const classify = (input: Buffer | string) => execFileSync("bash", [SCRIPT], { input }).toString().trim();
/** NUL-separated, as `git diff -z` writes it. */
const docsOnly = (paths: string[]) => classify(paths.map((p) => p + "\0").join(""));

/** A throwaway repository with a base commit; `change` makes the PR commit; returns ci.yml's verdict on the diff. */
function inRepo(
  base: Record<string, string>,
  change: (git: (...args: string[]) => string, repo: string) => void,
) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "docs-only-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: repo,
      }).toString();
    for (const [file, text] of Object.entries(base)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    }
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "base");
    change(git, repo);
    git("add", "-A");
    git("commit", "-qm", "change");
    // The same command as the `changes` job in .github/workflows/ci.yml.
    const diff = execFileSync(
      "git",
      ["-c", "core.quotepath=false", "diff", "--name-only", "--no-renames", "-z", "HEAD^1", "HEAD"],
      { cwd: repo },
    );
    return { git, verdict: classify(diff) };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

describe("docs-only classifier (#219)", () => {
  it.each([
    [["docs/foo.md"], "true"],
    [["README.md"], "true"],
    [["docs/decisions/a.md", "mockup/REVIEW_01.md", ".github/pull_request_template.md"], "true"],
    [["docs/운영 안내.md", "안내.md"], "true"], // Korean paths are documentation like any other
    [["PRD.md"], "false"], // read by scripts/test/traceability.test.ts
    [["docs/traceability.md"], "false"], // likewise
    [["docs/foo.sh"], "false"], // a script under docs/ is code
    [["docs/foo.md", "apps/server/src/index.ts"], "false"],
    [["apps/server/instructions/common.md"], "false"], // runtime prompts, not docs
    [["fixtures/extract/sample.md"], "false"],
    [["mockup/index.html"], "false"],
    [[".github/workflows/ci.yml"], "false"],
    [["docs/a.md\nevil.ts"], "false"], // a newline in a path: never documentation (full run)
    [["docs/a\nb.md"], "false"],
    [[], "false"], // no changed files: run everything
  ])("%j → %s", (paths, expected) => {
    expect(docsOnly(paths)).toBe(expected);
  });

  it("a renamed test input counts by its old path too (--no-renames, as in ci.yml)", () => {
    const { verdict } = inRepo({ "docs/traceability.md": "# trace\n".repeat(50) }, (git) => {
      git("mv", "docs/traceability.md", "docs/trace-moved.md");
      // Without --no-renames git lists only the new path, which alone would pass as documentation.
      expect(git("diff", "--name-only", "--cached").trim()).toBe("docs/trace-moved.md");
    });
    expect(verdict).toBe("false");
  });

  it("a Korean documentation path is not quoted away (core.quotepath=false, -z)", () => {
    const { verdict } = inRepo({ "README.md": "x\n" }, (_git, repo) => {
      fs.mkdirSync(path.join(repo, "docs"));
      fs.writeFileSync(path.join(repo, "docs/운영 안내.md"), "# 안내\n");
    });
    expect(verdict).toBe("true");
  });

  it("a file whose name has a newline runs everything", () => {
    const { verdict } = inRepo({ "README.md": "x\n" }, (_git, repo) => {
      fs.mkdirSync(path.join(repo, "docs"));
      fs.writeFileSync(path.join(repo, "docs/a.md\nevil.ts"), "x\n");
    });
    expect(verdict).toBe("false");
  });
});
