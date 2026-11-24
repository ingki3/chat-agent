import { useSearchParams } from "react-router";
import { TopBar } from "../Shell.js";
import { UserAdmin } from "../UserAdmin.js";
import { PermissionsAdmin } from "../admin/PermissionsAdmin.js";
import { RuntimesAdmin } from "../admin/RuntimesAdmin.js";
import { SkillsAdmin } from "../admin/SkillsAdmin.js";
import { SystemAdmin } from "../admin/SystemAdmin.js";
import { BackupAdmin } from "../admin/BackupAdmin.js";
import { InstructionsAdmin } from "../admin/InstructionsAdmin.js";
import { DreamingAdmin } from "../admin/DreamingAdmin.js";
import { UsageAdmin } from "./Usage.js";
import { AccessAdmin } from "../admin/AccessAdmin.js";
import { PublicLinksAdmin } from "../admin/PublicLinksAdmin.js";
import { MediaAdmin } from "../admin/MediaAdmin.js";

const TABS = [
  ["users", "사용자"],
  ["access", "Access"],
  ["permissions", "권한"],
  ["runtimes", "런타임"],
  ["skills", "스킬"],
  ["media", "미디어 생성"],
  ["instructions", "지침"],
  ["dreaming", "기억 정리"],
  ["system", "시스템 상태"],
  ["backup", "백업"],
  ["usage", "사용량"],
  ["public-links", "공개 링크"],
] as const;
type Tab = (typeof TABS)[number][0];

/**
 * Admin screen (#35, PRD FR-10): users (#41 + edit), Cloudflare Access (#36), per-user permissions, runtimes and connections, skills, 지침 (#144),
 * 기억 정리 (#146 — since #188 only the server-wide switch, token cap, allowed connections, youth settings and status), system status, backups (#37), usage (#32) and 미디어 생성 (#238). The tab is in the address (`?tab=`), so a notification can open the right one.
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
          {tab === "access" && <AccessAdmin />}
          {tab === "permissions" && <PermissionsAdmin />}
          {tab === "runtimes" && <RuntimesAdmin />}
          {tab === "skills" && <SkillsAdmin />}
          {tab === "media" && <MediaAdmin />}
          {tab === "instructions" && <InstructionsAdmin />}
          {tab === "dreaming" && <DreamingAdmin />}
          {tab === "system" && <SystemAdmin />}
          {tab === "backup" && <BackupAdmin />}
          {tab === "usage" && <UsageAdmin />}
          {tab === "public-links" && <PublicLinksAdmin />}
        </div>
      </div>
    </>
  );
}
