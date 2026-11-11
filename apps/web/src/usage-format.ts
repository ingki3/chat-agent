import type { UsageTotals } from "@agentlee/shared";

/** Shown wherever a cost cannot be given (no price for the model, or tokens not reported). */
export const NOT_PROVIDED = "미제공";

export function usd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const compact = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });
export const tokens = (n: number) => compact.format(n);

/**
 * The cost of a set of rows: "—" when none was on an API key (subscriptions have no cost), "미제공" when none of the
 * API key rows could be costed, otherwise the sum — with how many rows had no cost.
 */
export function costText(t: Pick<UsageTotals, "apiKeyRequests" | "costMissing" | "costUsd">): string {
  if (t.apiKeyRequests === 0) return "—";
  if (t.costMissing > 0 && t.costMissing >= t.apiKeyRequests) return NOT_PROVIDED;
  return t.costMissing > 0 ? `${usd(t.costUsd)} (${NOT_PROVIDED} ${t.costMissing}건)` : usd(t.costUsd);
}

/** One line for the sidebar: cost (API keys only), requests, tokens. */
export function usageLine(t: UsageTotals): string {
  const parts: string[] = [];
  if (t.apiKeyRequests > 0) parts.push(costText(t));
  parts.push(`${t.requests.toLocaleString("ko-KR")}회`);
  parts.push(`${tokens(t.totalTokens)} 토큰`);
  return parts.join(" · ");
}
