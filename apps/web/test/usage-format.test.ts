import { describe, expect, it } from "vitest";
import type { UsageTotals } from "@agentlee/shared";
import { costText, recordCost, recordTokens, tokenText, usageLine } from "../src/usage-format.js";

const totals = (o: Partial<UsageTotals>): UsageTotals => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  tokensMissing: 0,
  costMicroUsd: 0,
  costUsd: 0,
  costMissing: 0,
  apiKeyRequests: 0,
  subscriptionRequests: 0,
  unknownRequests: 0,
  ...o,
});

describe("usage formatting (#32): 미제공 is never shown as $0.00 or 0 토큰", () => {
  it("cost: subscriptions only → —; all unpriced → 미제공; some unpriced → amount + 미제공 n건", () => {
    expect(costText(totals({ requests: 2, subscriptionRequests: 2 }))).toBe("—");
    const unpriced = totals({ requests: 2, apiKeyRequests: 2, costMissing: 2 });
    expect(costText(unpriced)).toBe("미제공");
    // The forecast passes its own amount but keeps the month's flags: all unpriced is still 미제공.
    expect(costText(unpriced, 0)).toBe("미제공");
    const some = totals({ requests: 3, apiKeyRequests: 3, costMissing: 1, costUsd: 1.2 });
    expect(costText(some)).toBe("$1.20 + 미제공 1건");
    expect(costText(some, 3.5)).toBe("$3.50 + 미제공 1건");
    expect(costText(totals({ requests: 1, apiKeyRequests: 1, costUsd: 0.3 }))).toBe("$0.30");
    // Unknown (connection not found) rows count as costable but unpriced.
    expect(costText(totals({ requests: 1, unknownRequests: 1, costMissing: 1 }))).toBe("미제공");
  });

  it("tokens: rows that did not report them are 미제공, not 0", () => {
    expect(tokenText(totals({ requests: 1, tokensMissing: 1 }))).toBe("미제공");
    expect(tokenText(totals({ requests: 2, tokensMissing: 1, totalTokens: 1500 }))).toMatch(
      /^1\.5천 \+ 미제공 1건$/,
    );
    expect(tokenText(totals({}))).toBe("0");
    expect(recordTokens({ totalTokens: null })).toBe("미제공");
    expect(recordTokens({ totalTokens: 0 })).toBe("0");
  });

  it("records: subscription, unknown, no connection, unpriced and priced", () => {
    expect(recordCost({ authType: "subscription", costUsd: null })).toBe("구독 · 비용 없음");
    expect(recordCost({ authType: "unknown", costUsd: null })).toBe("미확인 (미제공)");
    expect(recordCost({ authType: null, costUsd: null })).toBe("—");
    expect(recordCost({ authType: "api_key", costUsd: null })).toBe("미제공");
    expect(recordCost({ authType: "api_key", costUsd: 2.05 })).toBe("$2.05");
  });

  it("the sidebar line shows 미제공 instead of a zero cost or zero tokens", () => {
    expect(usageLine(totals({ requests: 1, apiKeyRequests: 1, costMissing: 1, tokensMissing: 1 }))).toBe(
      "미제공 · 1회 · 미제공 토큰",
    );
  });
});
