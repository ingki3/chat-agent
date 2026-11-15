import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminUsageReport, ModelPrice, UsageGroup, UsageRecordView } from "@agentlee/shared";
import { errorText, usage, USAGE_KEY } from "../api.js";
import { costText, recordCost, recordTokens, tokenText, usd } from "../usage-format.js";

const RUNTIMES = [
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
] as const;
const PURPOSE: Record<UsageRecordView["purpose"], string> = {
  chat: "대화",
  schedule: "예약",
  title: "제목",
  summary: "요약",
  connection_test: "연결 테스트",
};

function GroupTable({ groups, label }: { groups: UsageGroup[]; label: string }) {
  return (
    <table className="devices usage-table" aria-label={label}>
      <thead>
        <tr>
          <th>{label}</th>
          <th className="num">요청</th>
          <th className="num">토큰</th>
          <th className="num">비용</th>
        </tr>
      </thead>
      <tbody>
        {groups.length === 0 && (
          <tr>
            <td colSpan={4} className="muted">
              이번 달 기록이 없어요.
            </td>
          </tr>
        )}
        {groups.map((g) => (
          <tr key={g.key}>
            <td>{g.label}</td>
            <td className="num">{g.requests.toLocaleString("ko-KR")}</td>
            <td className="num">{tokenText(g)}</td>
            <td className="num">{costText(g)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const COST_NOTE =
  "비용은 API 키 연결만 계산해요(관리자 가격표 기준). 구독 연결은 요청 수와 토큰만 세요. 가격이 없는 모델·토큰을 받지 못한 기록은 ‘미제공’, 연결을 찾을 수 없는 옛 기록은 ‘미확인’(미제공으로 셈)이에요.";

/** 설정 → 내 사용량 (#32, FR-9.3): the caller's own month, by runtime and model. */
export function MyUsagePanel() {
  const mine = useQuery({ queryKey: [...USAGE_KEY, "me"], queryFn: usage.mine });
  return (
    <section className="panel" id="usage" aria-labelledby="usage-h">
      <h2 id="usage-h">내 사용량</h2>
      {mine.isError && <p className="error small">{errorText(mine.error)}</p>}
      {mine.data && (
        <>
          <p data-testid="my-usage-total">
            {mine.data.month} · 요청 {mine.data.total.requests.toLocaleString("ko-KR")}회 · 토큰{" "}
            {tokenText(mine.data.total)} · 비용 {costText(mine.data.total)}
          </p>
          <GroupTable groups={mine.data.byRuntime} label="런타임" />
          <GroupTable groups={mine.data.byModel} label="모델" />
        </>
      )}
      <p className="muted small">{COST_NOTE} 사용량으로 막히는 일은 없어요.</p>
    </section>
  );
}

const BREAKDOWNS = [
  ["byUser", "사용자별"],
  ["byRuntime", "런타임별"],
  ["byModel", "모델별"],
  ["byConnection", "연결별"],
  ["byPurpose", "목적별"],
] as const satisfies readonly (readonly [keyof AdminUsageReport, string])[];

/** 관리자 → 사용량 (#32, FR-9.3·9.5): this month for everyone, the price table and the daily cost threshold. */
export function UsageAdmin() {
  const report = useQuery({ queryKey: [...USAGE_KEY, "admin"], queryFn: usage.report });
  const [view, setView] = useState<(typeof BREAKDOWNS)[number][0]>("byUser");
  const r = report.data;
  return (
    <section className="admin usage-admin" aria-label="사용량">
      <h2>사용량</h2>
      {report.isError && <p className="error small">{errorText(report.error)}</p>}
      {r && (
        <>
          <div className="usage-summary" data-testid="usage-summary">
            <div>
              <div className="muted small">{r.month} 누적</div>
              <strong data-testid="usage-month-cost">{costText(r.total)}</strong>
            </div>
            <div>
              <div className="muted small">오늘</div>
              <strong data-testid="usage-today-cost">{costText(r.today)}</strong>
            </div>
            <div>
              <div className="muted small">예상 (일평균 × 남은 {r.daysRemaining}일)</div>
              {/* Only the costed rows are forecast: the month's 미제공 rows are named next to it. */}
              <strong data-testid="usage-forecast">{costText(r.total, r.forecastCostUsd)}</strong>
            </div>
            <div>
              <div className="muted small">요청 · 토큰</div>
              <strong>
                {r.total.requests.toLocaleString("ko-KR")}회 · {tokenText(r.total)}
              </strong>
            </div>
          </div>
          <p className="muted small">
            {COST_NOTE} 기준 시간대 {r.timeZone}. 가격표{" "}
            {r.priceVersion === null ? "없음" : `v${r.priceVersion}`}.
          </p>
          <div className="segmented" role="radiogroup" aria-label="분류">
            {BREAKDOWNS.map(([k, label]) => (
              <label key={k} className={view === k ? "on" : ""}>
                <input type="radio" name="usage-view" checked={view === k} onChange={() => setView(k)} />
                {label}
              </label>
            ))}
          </div>
          <GroupTable groups={r[view]} label={BREAKDOWNS.find(([k]) => k === view)![1]} />
          <details>
            <summary>최근 기록 {r.recent.length}건</summary>
            <table className="devices usage-table" aria-label="최근 기록">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>사용자</th>
                  <th>모델</th>
                  <th>목적</th>
                  <th className="num">토큰</th>
                  <th className="num">비용</th>
                </tr>
              </thead>
              <tbody>
                {r.recent.map((x) => (
                  <tr key={x.id}>
                    <td>{new Date(x.createdAt).toLocaleString("ko-KR")}</td>
                    <td>{x.userName}</td>
                    <td>
                      {x.model} <span className="muted small">{x.connectionLabel}</span>
                    </td>
                    <td>{PURPOSE[x.purpose]}</td>
                    <td className="num">{recordTokens(x)}</td>
                    <td
                      className="num"
                      title={x.priceVersion === null ? undefined : `가격표 v${x.priceVersion}`}
                    >
                      {recordCost(x)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          {/* Starts from the saved value; kept mounted so its message survives the refetch after saving. */}
          <DailyThreshold current={r.settings.dailyCostThresholdUsd} />
          <BudgetSwitch />
        </>
      )}
      <PriceEditor />
    </section>
  );
}

/** The monthly budget comes in v1.1 (FR-9.1): shown, switched off and disabled. */
function BudgetSwitch() {
  return (
    <div className="budget" data-testid="budget-switch">
      <label className="row">
        <input type="checkbox" disabled checked={false} readOnly aria-describedby="budget-note" />월 예산 제한
        <span className="badge gray">추후 제공</span>
      </label>
      <p id="budget-note" className="muted small">
        지금은 예산 상한이 없어요. 사용량은 기록하고 보여 주기만 하고, 막지 않아요.
      </p>
    </div>
  );
}

function DailyThreshold({ current }: { current: number | null }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(current === null ? "" : String(current));
  const [msg, setMsg] = useState<string>();
  const save = useMutation({
    mutationFn: (v: number | null) => usage.saveSettings({ dailyCostThresholdUsd: v }),
    onSuccess: (s) =>
      setMsg(
        s.dailyCostThresholdUsd === null
          ? "일일 비용 알림을 껐어요."
          : `하루 비용이 ${usd(s.dailyCostThresholdUsd)}를 넘으면 하루 한 번 알려 드려요.`,
      ),
    onError: (e) => setMsg(errorText(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: USAGE_KEY }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim() === "" ? null : Number(value);
    if (v !== null && !(v > 0)) return setMsg("0보다 큰 금액을 넣거나 비워 두세요.");
    save.mutate(v);
  };
  return (
    <form className="row wrap threshold" onSubmit={submit}>
      <label className="field">
        <span>일일 비용 알림 기준 (USD, 선택)</span>
        <input
          type="number"
          min="0.01"
          step="0.01"
          inputMode="decimal"
          placeholder="꺼짐"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button disabled={save.isPending}>저장</button>
      {msg && (
        <p className="small" role="status">
          {msg}
        </p>
      )}
    </form>
  );
}

type Draft = {
  runtime: string;
  model: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
};
const PRICE_FIELDS = [
  ["input", "입력"],
  ["output", "출력"],
  ["cacheRead", "캐시 읽기"],
  ["cacheWrite", "캐시 쓰기"],
] as const;
const toDraft = (p: ModelPrice): Draft => ({
  runtime: p.runtime,
  model: p.model,
  input: p.input ?? "",
  output: p.output ?? "",
  cacheRead: p.cacheRead ?? "",
  cacheWrite: p.cacheWrite ?? "",
});
/** Sent as the decimal text typed (never a float): the server computes costs exactly from it. */
const price = (s: string) => (s.trim() === "" ? null : s.trim());

/** Model price table: each save is a new version; rows already costed keep the version they were costed with. */
function PriceEditor() {
  const qc = useQueryClient();
  const table = useQuery({ queryKey: [...USAGE_KEY, "prices"], queryFn: usage.prices });
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [msg, setMsg] = useState<string>();
  const current = table.data?.current;
  const shown = rows ?? current?.prices.map(toDraft) ?? [];
  const set = (i: number, patch: Partial<Draft>) =>
    setRows(shown.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = useMutation({
    mutationFn: () =>
      usage.savePrices(
        shown.map((r) => ({
          runtime: r.runtime,
          model: r.model.trim(),
          input: price(r.input),
          output: price(r.output),
          cacheRead: price(r.cacheRead),
          cacheWrite: price(r.cacheWrite),
        })),
      ),
    onSuccess: (t) => {
      setRows(null);
      setMsg(`가격표 v${t.version}을 저장했어요. 이미 기록된 비용은 그대로예요.`);
    },
    onError: (e) => setMsg(errorText(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: USAGE_KEY }),
  });
  return (
    <div className="prices" data-testid="price-table">
      <h3>모델 가격표</h3>
      <p className="muted small">
        {current
          ? `현재 v${current.version} · ${new Date(current.createdAt).toLocaleString("ko-KR")} 저장 · 버전 ${table.data?.versions.length ?? 0}개`
          : "아직 가격표가 없어요. 가격이 없으면 API 키 사용 비용은 ‘미제공’으로 보여요."}{" "}
        단위: 100만 토큰당 USD, 소수점 아래 6자리까지. 빈칸은 미제공이에요. 저장하면 새 버전이 되고, 지난
        기록의 비용은 바뀌지 않아요.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setMsg(undefined);
          save.mutate();
        }}
      >
        <div className="price-rows">
          {shown.map((r, i) => (
            <div className="price-row" key={i} role="group" aria-label={`가격 ${i + 1}`}>
              <select
                aria-label="런타임"
                value={r.runtime}
                onChange={(e) => set(i, { runtime: e.target.value })}
              >
                {RUNTIMES.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                aria-label="모델"
                placeholder="모델 id"
                required
                maxLength={100}
                value={r.model}
                onChange={(e) => set(i, { model: e.target.value })}
              />
              {PRICE_FIELDS.map(([k, label]) => (
                <input
                  key={k}
                  aria-label={label}
                  placeholder={label}
                  type="number"
                  min="0"
                  step="0.000001"
                  inputMode="decimal"
                  value={r[k]}
                  onChange={(e) => set(i, { [k]: e.target.value })}
                />
              ))}
              <button
                type="button"
                className="ghost small"
                aria-label="이 모델 빼기"
                onClick={() => setRows(shown.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="row wrap">
          <button
            type="button"
            onClick={() =>
              setRows([
                ...shown,
                { runtime: "claude-code", model: "", input: "", output: "", cacheRead: "", cacheWrite: "" },
              ])
            }
          >
            모델 추가
          </button>
          <button disabled={save.isPending || rows === null}>새 버전으로 저장</button>
        </div>
        {msg && (
          <p className="small" role="status">
            {msg}
          </p>
        )}
      </form>
    </div>
  );
}
