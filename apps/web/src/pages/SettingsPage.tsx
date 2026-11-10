import { useState } from "react";
import type { AuthState } from "@agentlee/shared";
import { ChangePassword } from "../auth-screens.js";
import { TopBar } from "../Shell.js";
import { getTheme, setTheme, type ThemeChoice } from "../theme.js";

export function SettingsPage({ onChanged }: { onChanged: (s: AuthState) => void }) {
  const [theme, set] = useState<ThemeChoice>(getTheme());
  const [changed, setChanged] = useState(false);
  return (
    <>
      <TopBar title="⚙️ 설정" />
      <div className="page">
        <section className="panel">
          <h2>화면</h2>
          <div className="segmented" role="radiogroup" aria-label="테마">
            {(
              [
                ["system", "시스템"],
                ["light", "밝게"],
                ["dark", "어둡게"],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className={theme === v ? "on" : ""}>
                <input
                  type="radio"
                  name="theme"
                  value={v}
                  checked={theme === v}
                  onChange={() => {
                    setTheme(v);
                    set(v);
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          <p className="muted small">기본 런타임·모델 설정은 #19, 알림 설정은 #34에서 들어와요.</p>
        </section>
        <section className="panel">
          {changed ? (
            <p role="status">비밀번호를 바꿨어요. 다른 기기의 로그인은 끊겼어요.</p>
          ) : (
            <ChangePassword
              embedded
              onDone={(s) => {
                onChanged(s);
                setChanged(true);
              }}
            />
          )}
        </section>
      </div>
    </>
  );
}
