/**
 * The calculation and data tool `python_run` (#47, PRD §7 `python-scratchpad`, NFR 격리): limits and outcome codes
 * shared by the tool definition (`@agentlee/mcp-tools/python`), the server and the logs. How the code runs (the
 * sandboxed interpreter, its own working folder) is the server's business (apps/server/src/python).
 */

/** The PRD §7 skill whose per-user permission turns `python_run` on (FR-1.6). Not a finance skill. */
export const PYTHON_SKILL = "python-scratchpad";

export const PYTHON_LIMITS = {
  /** Characters of code in one call. */
  codeChars: 50_000,
  /** Conversation files copied into the working folder per call. */
  inputFiles: 10,
  /** Their bytes together. */
  inputBytes: 100 * 1024 * 1024,
  /** Wall-clock time of one run (the interpreter, imports included). */
  timeoutMs: 30_000,
  /** CPU seconds of one run (RLIMIT_CPU inside the process — a second guard next to the wall clock). */
  cpuSeconds: 30,
  /** Resident memory of the process. */
  memoryBytes: 768 * 1024 * 1024,
  /** What the code may add to its working folder (bytes beyond the input copies), checked while it runs. */
  workBytes: 100 * 1024 * 1024,
  /** Entries (files and folders) its working folder may hold. */
  workEntries: 1000,
  /** One file the code writes (RLIMIT_FSIZE: a bigger write fails inside python). */
  fileBytes: 20 * 1024 * 1024,
  /** stdout and stderr kept by the interpreter, each (characters; the rest is counted, not kept). */
  captureChars: 200_000,
  /** stdout characters handed back to the model (the start); the whole kept stdout becomes a file when cut. */
  stdoutChars: 8_000,
  /** stderr and traceback characters handed back (the end). */
  stderrChars: 4_000,
  /** Files registered from one run (new or changed files of the working folder). */
  outputFiles: 5,
  /** One registered file. */
  outputBytes: 10 * 1024 * 1024,
  /** Skipped entries listed in the result. */
  skippedListed: 20,
} as const;

/**
 * What a working-folder file may be registered as: text formats only, so the server can take every known secret out
 * of its content before it is stored (a binary format could carry one it cannot see).
 */
export const PYTHON_OUTPUT_KINDS = ["csv", "txt", "md"] as const;

/** Why a call did not run or did not finish (`{ error }` to the model, `pythonCode` in the log). */
export const PYTHON_CODES = [
  "python_not_allowed",
  "python_bad_input",
  "python_file_not_found",
  "python_files_too_large",
  "python_busy",
  "python_timeout",
  "python_memory_limit",
  "python_output_limit",
  "python_disk_limit",
  /** The working folder could not be measured (the code made part of it unreadable): stopped, fail closed. */
  "python_workdir_blocked",
  "python_failed",
  "python_unavailable",
  "python_not_installed",
] as const;
export type PythonCode = (typeof PYTHON_CODES)[number];

/** Why a working-folder entry was not registered (`skipped[].reason`). */
export const PYTHON_SKIP_REASONS = [
  "unsupported_kind",
  "not_text",
  "too_large",
  "too_many",
  "link",
  "too_deep",
  "conversation_full",
] as const;
export type PythonSkipReason = (typeof PYTHON_SKIP_REASONS)[number];
