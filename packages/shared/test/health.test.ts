import { describe, expect, it } from "vitest";
import { HealthResponse } from "../src/index.js";

describe("HealthResponse", () => {
  it("accepts a valid payload", () => {
    expect(
      HealthResponse.parse({ status: "ok", service: "agent-lee", version: "0.0.0", uptimeSec: 1 }),
    ).toBeTruthy();
  });
  it("rejects an unknown status", () => {
    expect(() =>
      HealthResponse.parse({ status: "down", service: "agent-lee", version: "0", uptimeSec: 0 }),
    ).toThrow();
  });
});
