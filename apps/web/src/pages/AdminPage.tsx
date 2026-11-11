import { TopBar } from "../Shell.js";
import { UserAdmin } from "../UserAdmin.js";
import { UsageAdmin } from "./Usage.js";

/** Admin screen (#35 completes it). For now: family accounts (#41) and usage (#32). */
export function AdminPage({ selfId }: { selfId: string }) {
  return (
    <>
      <TopBar title="🛠 관리자" />
      <div className="page">
        <UserAdmin selfId={selfId} />
        <UsageAdmin />
      </div>
    </>
  );
}
