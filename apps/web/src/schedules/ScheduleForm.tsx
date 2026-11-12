import { useEffect, useId, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  SCHEDULE_DEFAULT_TIME_ZONE,
  type ChangeSettingsRequest,
  type ChatSettings,
  type CreateScheduleRequest,
  type Schedule,
  type ScheduleTiming,
  type UpdateScheduleRequest,
} from "@agentlee/shared";
import { errorText, schedules, settings as settingsApi } from "../api.js";
import { ChipChoice } from "../chat/chip.js";
import { RuntimeChip } from "../chat/RuntimeChip.js";
import { TYPE_LABEL, WEEKDAY_NAMES, whenText } from "./format.js";

const TIME_ZONES = [
  "Asia/Seoul",
  "Asia/Tokyo",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "UTC",
] as const;
const TYPES = ["once", "daily", "weekdays", "weekly", "cron"] as const;

type Draft = {
  name: string;
  prompt: string;
  type: ScheduleTiming["type"];
  date: string;
  time: string;
  weekdays: number[];
  cron: string;
  timeZone: string;
  skills: string[];
  notify: boolean;
};

/** Tomorrow in the browser's calendar, "YYYY-MM-DD" (only a starting value for a one-off; the server checks it). */
function tomorrow(): string {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function draftOf(s: Schedule | undefined): Draft {
  const t = s?.timing;
  return {
    name: s?.name ?? "",
    prompt: s?.prompt ?? "",
    type: t?.type ?? "daily",
    date: t?.type === "once" ? t.date : tomorrow(),
    time: t && t.type !== "cron" ? t.time : "08:00",
    weekdays: t?.type === "weekly" ? t.weekdays : [1],
    cron: t?.type === "cron" ? t.cron : "0 8 * * 1-5",
    timeZone: s?.timeZone ?? SCHEDULE_DEFAULT_TIME_ZONE,
    skills: s?.skills ?? [],
    notify: s?.notify ?? true,
  };
}

function timingOf(d: Draft): ScheduleTiming {
  switch (d.type) {
    case "once":
      return { type: "once", date: d.date, time: d.time };
    case "daily":
      return { type: "daily", time: d.time };
    case "weekdays":
      return { type: "weekdays", time: d.time };
    case "weekly":
      return { type: "weekly", time: d.time, weekdays: [...d.weekdays].sort((a, b) => a - b) };
    case "cron":
      return { type: "cron", cron: d.cron.trim() };
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const asRequest = (c: ChatSettings): ChangeSettingsRequest => ({
  runtime: c.runtime,
  model: c.model,
  ...(c.effort ? { effort: c.effort } : {}),
  useShared: c.useShared,
});

/** `value`, once it has stayed the same for `ms` (the first one at once). */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** The server's next occurrences of the timing being typed (after a short pause), or the code it refuses it with. */
function useNextRuns(timing: ScheduleTiming, timeZone: string) {
  const key = useSettled(JSON.stringify([timing, timeZone]), 250);
  const q = useQuery({
    queryKey: ["schedules", "preview", key],
    queryFn: ({ signal }) => {
      const [t, z] = JSON.parse(key) as [ScheduleTiming, string];
      return schedules.preview({ timing: t, timeZone: z }, signal);
    },
    retry: false,
    staleTime: 30_000,
  });
  return { next: q.data, error: q.isError ? errorText(q.error) : undefined };
}

/**
 * The create / edit form (#55, PRD FR-8.2): name, prompt, when (one-off date, every day, weekdays, chosen weekdays
 * or a cron expression), time zone (Asia/Seoul by default), skills, notification (on by default), runtime·model.
 * The runtime·model start as the creator's defaults (FR-12.2) and are changed only through the chip — which lists
 * only what is allowed and usable, every change previewed by the server; the server checks the result again (403).
 */
export function ScheduleForm(props: {
  schedule?: Schedule;
  onSaved: (s: Schedule) => void;
  onCancel: () => void;
}) {
  const editing = props.schedule;
  const [d, setD] = useState<Draft>(() => draftOf(editing));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const options = useQuery({ queryKey: ["schedules", "options"], queryFn: schedules.options });
  const usable = useQuery({ queryKey: ["runtimes", "usable"], queryFn: settingsApi.usableRuntimes });
  const defaults = useQuery({ queryKey: ["settings", "defaults"], queryFn: settingsApi.defaults });
  const [chosen, setChosen] = useState<ChatSettings | null>(null);
  const [choice] = useState(() => new ChipChoice<ChatSettings>(settingsApi.preview));
  const base = editing?.settings ?? defaults.data?.start ?? null;
  const shown = chosen ?? base;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timing = timingOf(d);
  const next = useNextRuns(timing, d.timeZone);
  const uid = useId();
  const f = (name: string) => `${uid}-${name}`;

  const change = async (c: ChangeSettingsRequest) => {
    if (!base) return;
    setChosen(await choice.change(base, c));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      // A chip change still on its way is waited for; a failed one stops the save (its error shows).
      const settled = chosen ? await choice.settled() : null;
      const picked = settled ? asRequest(settled) : {};
      let saved: Schedule;
      if (editing) {
        const body: UpdateScheduleRequest = { ...picked };
        if (d.name.trim() !== editing.name) body.name = d.name;
        if (d.prompt.trim() !== editing.prompt) body.prompt = d.prompt;
        if (!same(timing, editing.timing)) body.timing = timing;
        if (d.timeZone !== editing.timeZone) body.timeZone = d.timeZone;
        if (!same([...d.skills].sort(), [...editing.skills].sort())) body.skills = d.skills;
        if (d.notify !== editing.notify) body.notify = d.notify;
        saved = Object.keys(body).length ? await schedules.update(editing.id, body) : editing;
      } else {
        const body: CreateScheduleRequest = {
          name: d.name,
          prompt: d.prompt,
          timing,
          timeZone: d.timeZone,
          skills: d.skills,
          notify: d.notify,
          ...picked,
        };
        saved = await schedules.create(body);
      }
      props.onSaved(saved);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const zones: string[] = TIME_ZONES.includes(d.timeZone as (typeof TIME_ZONES)[number])
    ? [...TIME_ZONES]
    : [d.timeZone, ...TIME_ZONES];
  const skillList = options.data?.skills ?? [];

  return (
    <form
      className="sched-form"
      onSubmit={(e) => void submit(e)}
      aria-label={editing ? "예약 수정" : "새 예약"}
    >
      <div className="field">
        <label htmlFor={f("name")}>이름</label>
        <input
          id={f("name")}
          required
          maxLength={100}
          value={d.name}
          placeholder="예: 아침 관심 종목 브리핑"
          onChange={(e) => set("name", e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={f("prompt")}>실행할 프롬프트</label>
        <textarea
          id={f("prompt")}
          required
          rows={3}
          maxLength={8000}
          value={d.prompt}
          placeholder="예: 내 관심 종목을 브리핑해줘"
          onChange={(e) => set("prompt", e.target.value)}
        />
      </div>

      <fieldset className="field sched-when">
        <legend>일정</legend>
        <div className="segmented" role="radiogroup" aria-label="일정 유형">
          {TYPES.map((t) => (
            <label key={t} className={`seg${d.type === t ? " on" : ""}`}>
              <input
                type="radio"
                name={f("type")}
                value={t}
                checked={d.type === t}
                onChange={() => set("type", t)}
              />
              {TYPE_LABEL[t]}
            </label>
          ))}
        </div>
        {d.type === "once" && (
          <div className="row wrap">
            <label className="inline" htmlFor={f("date")}>
              날짜
            </label>
            <input
              id={f("date")}
              type="date"
              required
              value={d.date}
              onChange={(e) => set("date", e.target.value)}
            />
          </div>
        )}
        {d.type === "weekly" && (
          <fieldset className="segmented weekday-pick">
            <legend className="small muted">요일</legend>
            {WEEKDAY_NAMES.map((w, i) => (
              <label key={w} className={`seg${d.weekdays.includes(i) ? " on" : ""}`}>
                <input
                  type="checkbox"
                  checked={d.weekdays.includes(i)}
                  aria-label={`${w}요일`}
                  onChange={(e) =>
                    set("weekdays", e.target.checked ? [...d.weekdays, i] : d.weekdays.filter((x) => x !== i))
                  }
                />
                {w}
              </label>
            ))}
          </fieldset>
        )}
        {d.type !== "cron" ? (
          <div className="row wrap">
            <label className="inline" htmlFor={f("time")}>
              시각
            </label>
            <input
              id={f("time")}
              type="time"
              required
              value={d.time}
              onChange={(e) => set("time", e.target.value)}
            />
          </div>
        ) : (
          <div className="field">
            <label htmlFor={f("cron")}>cron 식</label>
            <input
              id={f("cron")}
              required
              spellCheck={false}
              value={d.cron}
              aria-describedby={f("cron-hint")}
              onChange={(e) => set("cron", e.target.value)}
            />
            <span id={f("cron-hint")} className="small muted">
              분 시 일 월 요일 (예: <code>0 8 * * 1-5</code> = 평일 8시). 요일 0·7 = 일요일.
            </span>
          </div>
        )}
        <div className="row wrap">
          <label className="inline" htmlFor={f("tz")}>
            시간대
          </label>
          <select id={f("tz")} value={d.timeZone} onChange={(e) => set("timeZone", e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>
        <div className="sched-next small" aria-live="polite" data-testid="schedule-next">
          {next.error ? (
            <span className="error">{next.error}</span>
          ) : next.next ? (
            <>
              다음 실행:{" "}
              {next.next.length
                ? next.next.map((n) => whenText(n, d.timeZone)).join(" · ")
                : "실행될 시각이 없어요"}
            </>
          ) : (
            <span className="muted">다음 실행 계산 중…</span>
          )}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>스킬</legend>
        {skillList.length === 0 ? (
          <span className="small muted">고를 수 있는 스킬이 없어요.</span>
        ) : (
          <div className="row wrap">
            {skillList.map((s) => (
              <label key={s.name} className="inline row">
                <input
                  type="checkbox"
                  checked={d.skills.includes(s.name)}
                  onChange={(e) =>
                    set(
                      "skills",
                      e.target.checked ? [...d.skills, s.name] : d.skills.filter((x) => x !== s.name),
                    )
                  }
                />
                {s.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <label className="inline row">
        <input type="checkbox" checked={d.notify} onChange={(e) => set("notify", e.target.checked)} />
        실행이 끝나면 알림 받기
      </label>

      <div className="field">
        <span id={f("rt")}>런타임·모델</span>
        <div className="row wrap" aria-labelledby={f("rt")}>
          <RuntimeChip
            settings={shown}
            options={usable.data}
            onChange={change}
            note="이 예약에만 적용돼요. 허용된 런타임·모델만 고를 수 있어요."
          />
          {!editing && !chosen && base && <span className="small muted">내 기본값</span>}
        </div>
        {defaults.data && !editing && defaults.data.start === null && (
          <span className="error small">쓸 수 있는 런타임이 없어요 — 관리자에게 문의하세요.</span>
        )}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "저장 중…" : editing ? "저장" : "예약 만들기"}
        </button>
        <button type="button" onClick={props.onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
