import type { UsageRecordView, UsageTotals } from "@agentlee/shared";

/** Shown wherever a figure cannot be given (no price for the model, tokens not reported, connection unknown). */
export const NOT_PROVIDED = "미제공";
/** Media generations still going or waiting for their cost (#238). */
export const PENDING = "진행 중";
/** A row whose connection could not be found: whether it cost anything is not known. */
export const UNKNOWN = "미확인";

export function usd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const compact = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });
export const tokens = (n: number) => compact.format(n);

type CostFlags = Pick<UsageTotals, "apiKeyRequests" | "unknownRequests" | "costMissing" | "costUsd"> &
  Partial<Pick<UsageTotals, "costPending">>;

/**
 * A cost over a set of rows (`amount`, default their sum — the forecast passes its own): "—" when none of the rows
 * could have a cost (subscriptions only), "미제공" when none of those that could has one, otherwise the amount with
 * how many rows have none ("$1.20 + 미제공 2건"). Never "$0.00" for rows whose cost is not known.
 */
export function costText(t: CostFlags, amount: number = t.costUsd): string {
  // Media generations still going or waiting for their cost (#238) are said apart: "진행 중 n건".
  const pending = t.costPending ?? 0;
  const tail = pending > 0 ? ` · ${PENDING} ${pending}건` : "";
  const costable = t.apiKeyRequests + t.unknownRequests - pending;
  if (costable <= 0) return pending > 0 ? `${PENDING} ${pending}건` : "—";
  if (t.costMissing >= costable) return `${NOT_PROVIDED}${tail}`;
  return (t.costMissing > 0 ? `${usd(amount)} + ${NOT_PROVIDED} ${t.costMissing}건` : usd(amount)) + tail;
}

/** Tokens over a set of rows: rows that did not report them are "미제공", not 0. */
export function tokenText(t: Pick<UsageTotals, "requests" | "tokensMissing" | "totalTokens">): string {
  if (t.requests > 0 && t.tokensMissing >= t.requests) return NOT_PROVIDED;
  return t.tokensMissing > 0
    ? `${tokens(t.totalTokens)} + ${NOT_PROVIDED} ${t.tokensMissing}건`
    : tokens(t.totalTokens);
}

/** One record's cost. */
export function recordCost(
  r: Pick<UsageRecordView, "authType" | "costUsd"> & Partial<Pick<UsageRecordView, "costPending">>,
): string {
  if (r.costPending && r.costUsd === null) return PENDING;
  if (r.authType === "subscription") return "구독 · 비용 없음";
  if (r.authType === "unknown") return `${UNKNOWN} (${NOT_PROVIDED})`;
  if (r.authType === null) return "—";
  return r.costUsd === null ? NOT_PROVIDED : usd(r.costUsd);
}

/** One record's tokens: null (not reported) is "미제공". */
export const recordTokens = (r: Pick<UsageRecordView, "totalTokens">) =>
  r.totalTokens === null ? NOT_PROVIDED : tokens(r.totalTokens);

/** One line for the sidebar: cost (API keys only), requests, tokens. */
export function usageLine(t: UsageTotals): string {
  const parts: string[] = [];
  if (t.apiKeyRequests + t.unknownRequests > 0) parts.push(costText(t));
  parts.push(`${t.requests.toLocaleString("ko-KR")}회`);
  parts.push(`${tokenText(t)} 토큰`);
  return parts.join(" · ");
}
