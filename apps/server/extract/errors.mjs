// A refusal of the extractor (#48) with one of the fixed codes of `EXTRACT_CODES` (packages/shared locators.ts).
// The code is all that leaves the sandbox: never a message, a path or file content.
export class ExtractError extends Error {
  constructor(code) {
    super(code);
    this.name = "ExtractError";
    this.code = code;
  }
}
