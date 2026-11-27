import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { NotificationPrefs, PushDevice, SaveNotificationPrefsRequest } from "@agentlee/shared";
import { errorText, notifications, push } from "../api.js";
import { afterSave } from "../instructions/draft.js";
import { applySaved, prefsFromGet, prefsFromPut, sharing, type Prefs } from "../instructions/rev.js";

const keepPrefs = sharing(prefsFromGet);
/** A save's answer into the cache, unless a newer revision is there (rev.ts). */
const applyPrefs = (qc: QueryClient, v: NotificationPrefs) =>
  applySaved<Prefs>(qc, PREFS_KEY, (old) => prefsFromPut(old, { ...v, rev: v.rev ?? 0 }));
import {
  browserState,
  disablePush,
  enablePush,
  PUSH_DEVICES_KEY as DEVICES_KEY,
  PushSetupError,
  syncPush,
  type DeviceState,
} from "../push.js";

const PREFS_KEY = ["notification-prefs"] as const;

const STATE_BADGE: Record<DeviceState, [string, string]> = {
  on: ["켜짐", "ok"],
  off: ["꺼짐", "gray"],
  denied: ["브라우저가 차단", "err"],
  unsupported: ["지원 안 됨", "warn"],
  "ios-install": ["지원 안 됨", "warn"],
};

/** 설정 → 알림 (FR-12.8, FR-13.1): this device on/off, other devices, quiet hours, and per-device guidance. */
export function NotificationSettings() {
  const qc = useQueryClient();
  // Re-read the browser's own state when asked ("다시 확인") or when the window gets focus back.
  const [browser, setBrowser] = useState(browserState);
  useEffect(() => {
    const again = () => {
      setBrowser(browserState());
      void qc.invalidateQueries({ queryKey: DEVICES_KEY });
    };
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [qc]);
  // Reconciled with this browser's real subscription on every visit: "켜짐" only when pushes really arrive here
  // (a withdrawn permission or a lost subscription removes the stale row; a renewed one is registered).
  const devices = useQuery({ queryKey: DEVICES_KEY, queryFn: syncPush, staleTime: 0 });
  const current = devices.data?.devices.find((d) => d.current);
  const state: DeviceState = browser !== "off" ? browser : current ? "on" : "off";
  const [message, setMessage] = useState<string>();
  const refresh = () => qc.invalidateQueries({ queryKey: DEVICES_KEY });

  const turnOn = useMutation({
    // The browser's permission prompt opens from this click only.
    mutationFn: () => enablePush(devices.data?.sessionTag),
    onMutate: () => setMessage(undefined),
    onError: (e) => {
      if (e instanceof PushSetupError && e.reason === "denied") setBrowser("denied");
      else if (e instanceof PushSetupError && e.reason === "unsupported") setBrowser("unsupported");
      else if (e instanceof PushSetupError && e.reason === "session_changed")
        setMessage(
          "이 브라우저가 다른 계정이나 새 로그인으로 바뀌었어요. 페이지를 새로 고친 뒤 다시 켜 주세요.",
        );
      else if (e instanceof PushSetupError)
        setMessage("알림을 켜지 못했어요. 잠시 뒤 다시 시도하세요. (허용 창을 닫았다면 다시 눌러 주세요.)");
      else setMessage(errorText(e));
    },
    onSettled: () => {
      setBrowser(browserState());
      void refresh();
    },
  });
  const turnOff = useMutation({
    mutationFn: async (d: PushDevice) => {
      if (d.current) await disablePush();
      else await push.remove(d.id);
    },
    onMutate: () => setMessage(undefined),
    onError: (e) =>
      setMessage(
        e instanceof PushSetupError && e.reason === "unsubscribe_failed"
          ? "알림을 껐지만 이 브라우저의 구독을 끊지 못했어요. 이 기기로는 더 보내지 않아요. 브라우저 사이트 설정에서 알림을 차단하면 완전히 멈춰요."
          : errorText(e),
      ),
    onSettled: refresh,
  });
  const test = useMutation({
    mutationFn: notifications.test,
    onSuccess: () => {
      setMessage("테스트 알림을 보냈어요. 잠시 뒤 이 기기에 떠요.");
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (e) => setMessage(errorText(e)),
  });
  const [badgeText, badgeClass] = STATE_BADGE[state];
  const others = devices.data?.devices.filter((d) => !d.current) ?? [];

  return (
    <section className="panel" id="notifications" aria-labelledby="noti-h">
      <h2 id="noti-h">알림</h2>
      <table className="devices">
        <tbody>
          <tr data-testid="this-device">
            <td>
              <b>이 기기</b>
              {current ? ` · ${current.label}` : ""}
            </td>
            <td>
              <span className={`badge ${badgeClass}`} data-testid="device-state">
                {badgeText}
              </span>
            </td>
            <td className="actions">
              {state === "off" && (
                <button
                  type="button"
                  className="small primary"
                  disabled={turnOn.isPending}
                  onClick={() => turnOn.mutate()}
                >
                  {turnOn.isPending ? "켜는 중…" : "이 기기에서 알림 켜기"}
                </button>
              )}
              {state === "on" && current && (
                <>
                  <button type="button" className="small" onClick={() => turnOff.mutate(current)}>
                    끄기
                  </button>
                  <button
                    type="button"
                    className="small"
                    disabled={test.isPending}
                    onClick={() => test.mutate()}
                  >
                    테스트 알림
                  </button>
                </>
              )}
              {state === "denied" && (
                <button
                  type="button"
                  className="small"
                  onClick={() => {
                    setBrowser(browserState());
                    void refresh();
                  }}
                >
                  다시 확인
                </button>
              )}
            </td>
          </tr>
          {others.map((d) => (
            <tr key={d.id} data-testid="other-device">
              <td>{d.label}</td>
              <td>
                <span className="badge ok">켜짐</span>
              </td>
              <td className="actions">
                <button
                  type="button"
                  className="small"
                  aria-label={`${d.label} 알림 끄기`}
                  onClick={() => turnOff.mutate(d)}
                >
                  끄기
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {devices.isError && <p className="error small">{errorText(devices.error)}</p>}
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      {state === "denied" && (
        <div className="notice err small" role="note">
          🚫 이 브라우저에서 Agent Lee 알림을 <b>차단</b>했어요. 앱에서는 다시 물어볼 수 없어요. 주소창 왼쪽
          🔒 → 사이트 설정 → 알림을 ‘허용’으로 바꾼 뒤 ‘다시 확인’을 눌러 주세요. 그동안 알림은 🔔 알림함에만
          쌓여요.
        </div>
      )}
      {state === "ios-install" && (
        <div className="notice warn small" role="note">
          ⚠ 지금 화면(Safari 탭)에서는 웹 푸시를 받을 수 없어요. 공유 버튼 → “홈 화면에 추가” → 추가된 앱을
          열고 여기서 알림을 켜 주세요(iOS 16.4 이상). 그보다 낮은 버전은 지원하지 않아요. 알림은 🔔
          알림함에서 볼 수 있어요.
        </div>
      )}
      {state === "unsupported" && (
        <div className="notice warn small" role="note">
          ⚠ 이 브라우저에서는 웹 푸시를 받을 수 없어요(오래된 브라우저, 사생활 보호 모드 등). 알림은 🔔
          알림함에서 볼 수 있어요.
        </div>
      )}
      {(state === "off" || state === "on") && (
        <div className="notice info small">
          📱 iPhone: Safari에서 chat.2prostream.com 열기 → 공유 버튼 → “홈 화면에 추가” → 추가된 앱을 열고
          알림 허용 (iOS 16.4 이상). Android: Chrome에서 바로 허용하면 돼요.
        </div>
      )}
      <QuietHours />
      <MemoryNotifications />
      <ResearchNotifications />
      <VideoNotifications />
      <ComposeNotifications />
    </section>
  );
}

function QuietHours() {
  const qc = useQueryClient();
  // The newest revision wins (rev.ts): a GET older than a save's answer never replaces it.
  const prefs = useQuery({ queryKey: PREFS_KEY, queryFn: notifications.prefs, structuralSharing: keepPrefs });
  const [draft, setDraft] = useState<{ on: boolean; start: string; end: string }>();
  const [saved, setSaved] = useState(false);
  const value = draft ?? {
    on: !!prefs.data?.quietStart,
    start: prefs.data?.quietStart ?? "23:00",
    end: prefs.data?.quietEnd ?? "07:00",
  };
  const save = useMutation({
    // `sent`: the draft as it was when saved — what the form compares against afterwards.
    mutationFn: async (sent: typeof value) => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul";
      // Only the quiet hours (and the zone they are in): the server keeps the rest as stored (#188 review 5).
      const p: SaveNotificationPrefsRequest = sent.on
        ? { quietStart: sent.start, quietEnd: sent.end, timeZone }
        : { quietStart: null, quietEnd: null, timeZone };
      return notifications.setPrefs(p);
    },
    // The answer (the stored preferences + revision) into the cache unless newer is there; the draft goes only if it
    // is still what was sent (review #195 6, 9).
    onSuccess: (v, sent) => {
      applyPrefs(qc, v);
      setDraft((cur) => (cur === undefined ? cur : afterSave(cur, sent, undefined)));
      setSaved(true);
    },
  });
  const edit = (v: Partial<typeof value>) => {
    setSaved(false);
    setDraft({ ...value, ...v });
  };
  const invalid = value.on && value.start === value.end;
  // Not editable before the saved value is here (#103): an edit made on the defaults would be the draft, and the
  // save would overwrite what was stored (and a tick could land just as the stored "on" arrives, undoing itself).
  // Locked while saving too (review #195 6): nothing typed meanwhile can be lost, no second submit.
  const loading = !prefs.data || save.isPending;

  return (
    <form
      className="quiet"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid && !save.isPending) save.mutate(value);
      }}
    >
      <h3>방해 금지 시간</h3>
      <label className="row">
        <input
          type="checkbox"
          checked={value.on}
          disabled={loading}
          onChange={(e) => edit({ on: e.target.checked })}
        />{" "}
        사용
      </label>
      <div className="row wrap">
        <input
          type="time"
          aria-label="방해 금지 시작"
          value={value.start}
          disabled={loading || !value.on}
          required
          onChange={(e) => edit({ start: e.target.value })}
        />
        ~
        <input
          type="time"
          aria-label="방해 금지 끝"
          value={value.end}
          disabled={loading || !value.on}
          required
          onChange={(e) => edit({ end: e.target.value })}
        />
        <button type="submit" className="small" disabled={save.isPending || invalid || loading}>
          저장
        </button>
      </div>
      <p className="muted small">이 시간에는 알림함에만 쌓이고, 끝나면 모아서 한 번 보내요.</p>
      {invalid && <p className="error small">시작과 끝을 다르게 정해 주세요.</p>}
      {prefs.isError && (
        <p className="error small" role="alert">
          {errorText(prefs.error)}
        </p>
      )}
      {save.isError && (
        <p className="error small" role="alert">
          {errorText(save.error)}
        </p>
      )}
      {saved && (
        <p className="small" role="status">
          저장했어요.
        </p>
      )}
    </form>
  );
}

type Toggle =
  | "memoryProposals"
  | "memoryApplied"
  | "memoryFailed"
  | "researchDone"
  | "researchFailed"
  | "videoDone"
  | "videoFailed"
  | "composeDone"
  | "composeFailed";

/** 기억 정리 notifications (#146, #188, spec §8): 제안 대기, 자동 반영, 실패 — each can be turned off. */
function MemoryNotifications() {
  return (
    <KindToggles
      testId="memory-notifications"
      title="기억 정리 알림"
      items={[
        ["memoryProposals", "기억 정리 제안이 기다릴 때"],
        ["memoryApplied", "기억 정리가 자동으로 반영했을 때"],
        ["memoryFailed", "내 기억 정리가 실패했을 때"],
      ]}
      note="알림에는 개수·이유만 적혀요. 내용과 기억 정리 설정은 설정 → 내 지침에서 봐요."
    />
  );
}

/** 깊이 조사 notifications (#211): 완료, 실패·중지 — each can be turned off. */
function ResearchNotifications() {
  return (
    <KindToggles
      testId="research-notifications"
      title="깊이 조사 알림"
      items={[
        ["researchDone", "깊이 조사 보고서가 완성됐을 때"],
        ["researchFailed", "깊이 조사가 실패하거나 중지됐을 때"],
      ]}
      note="알림에는 주제 앞부분 한 줄만 적혀요. 보고서 내용과 출처는 눌러서 대화에서 봐요."
    />
  );
}

/** 영상 생성 notifications (#238 stage 3): 완성, 실패 — each can be turned off. */
function VideoNotifications() {
  return (
    <KindToggles
      testId="video-notifications"
      title="영상 생성 알림"
      items={[
        ["videoDone", "승인한 영상이 완성됐을 때"],
        ["videoFailed", "승인한 영상을 만들지 못했을 때"],
      ]}
      note="알림에는 정해진 문구와 이유만 적혀요. 요청 내용과 영상은 눌러서 대화에서 봐요."
    />
  );
}

/** 멀티미디어 합성 notifications (#238 stage 4): 완성, 실패 — each can be turned off. */
function ComposeNotifications() {
  return (
    <KindToggles
      testId="compose-notifications"
      title="영상 합성 알림"
      items={[
        ["composeDone", "합성한 영상이 완성됐을 때"],
        ["composeFailed", "영상을 합성하지 못했을 때"],
      ]}
      note="알림에는 정해진 문구와 이유만 적혀요. 영상과 자막은 눌러서 대화에서 봐요."
    />
  );
}

/** Per-kind switches of the notification settings (only the toggled field is saved). */
function KindToggles(props: { testId: string; title: string; items: [Toggle, string][]; note: string }) {
  const qc = useQueryClient();
  // The newest revision wins (rev.ts): a GET older than a save's answer never replaces it.
  const prefs = useQuery({ queryKey: PREFS_KEY, queryFn: notifications.prefs, structuralSharing: keepPrefs });
  // A choice shows at once while it is being saved; then the cache — the newest revision seen, which holds the save's
  // answer (or, refused, the newest stored value) — shows again (rev.ts, review #195 9).
  const [picked, setPicked] = useState<Partial<Record<Toggle, boolean>>>({});
  const shown = (f: Toggle) => picked[f] ?? prefs.data?.[f] !== false;
  const save = useMutation({
    // Only the toggled field (#188 review 5): never the whole object, which would overwrite quiet hours saved meanwhile.
    mutationFn: (a: { field: Toggle; value: boolean }) => notifications.setPrefs({ [a.field]: a.value }),
    onMutate: (a) => setPicked((p) => ({ ...p, [a.field]: a.value })),
    onSuccess: (v) => applyPrefs(qc, v),
    onSettled: (_v, _e, a) =>
      setPicked((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== a.field))),
  });
  const loading = !prefs.data || save.isPending;
  return (
    <fieldset className="quiet" data-testid={props.testId}>
      <legend>
        <h3>{props.title}</h3>
      </legend>
      {props.items.map(([field, label]) => (
        <label className="row" key={field}>
          <input
            type="checkbox"
            checked={shown(field)}
            disabled={loading}
            onChange={(e) => save.mutate({ field, value: e.target.checked })}
          />{" "}
          {label}
        </label>
      ))}
      <p className="muted small">{props.note}</p>
      {save.isError && (
        <p className="error small" role="alert">
          {errorText(save.error)}
        </p>
      )}
    </fieldset>
  );
}
