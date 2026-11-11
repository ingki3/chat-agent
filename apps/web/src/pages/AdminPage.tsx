import { useSearchParams } from "react-router";
import { TopBar } from "../Shell.js";
import { UserAdmin } from "../UserAdmin.js";
import { PermissionsAdmin } from "../admin/PermissionsAdmin.js";
import { RuntimesAdmin } from "../admin/RuntimesAdmin.js";
import { SkillsAdmin } from "../admin/SkillsAdmin.js";
import { SystemAdmin } from "../admin/SystemAdmin.js";
import { UsageAdmin } from "./Usage.js";

const TABS = [
  ["users", "사용자"],
  ["permissions", "권한"],
  ["runtimes", "런타임"],
  ["skills", "스킬"],
  ["system", "시스템 상태"],
  ["usage", "사용량"],
] as const;
type Tab = (typeof TABS)[number][0];

/**
 * Admin screen (#35, PRD FR-10): users (#41 + edit), per-user permissions, runtimes and connections, skills, system
 * status and usage (#32). The tab is in the address (`?tab=`), so a notification can open the right one.
 */
export function AdminPage({ selfId }: { selfId: string }) {
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.some(([t]) => t === params.get("tab")) ? (params.get("tab") as Tab) : "users";
  return (
    <>
      <TopBar title="🛠 관리자" />
      <div className="page">
        <div className="tabs" role="tablist" aria-label="관리자 메뉴">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`admin-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`admin-panel-${t}`}
              className={tab === t ? "on" : ""}
              onClick={() => setParams(t === "users" ? {} : { tab: t }, { replace: true })}
            >
              {label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`admin-panel-${tab}`} aria-labelledby={`admin-tab-${tab}`}>
          {tab === "users" && <UserAdmin selfId={selfId} />}
          {tab === "permissions" && <PermissionsAdmin />}
          {tab === "runtimes" && <RuntimesAdmin />}
          {tab === "skills" && <SkillsAdmin />}
          {tab === "system" && <SystemAdmin />}
          {tab === "usage" && <UsageAdmin />}
        </div>
      </div>
    </>
  );
}
