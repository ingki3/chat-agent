import { Link } from "react-router";
import { TopBar } from "../Shell.js";
import {
  ArtifactRevoked,
  ArtifactBody,
  ArtifactToolbar,
  KIND_LABEL,
  artifactErrorText,
  useArtifactViewer,
} from "../artifacts/viewer.js";
import { panelLink } from "../artifacts/ArtifactPanel.js";

/**
 * `/a/:id` (#27): one artifact on its own page. The viewer (sandboxed frame, versions, downloads) is the same one
 * the panel next to the chat uses (#28, `artifacts/viewer.tsx`).
 */
export function ArtifactPage({ id }: { id: string }) {
  const v = useArtifactViewer(id);
  const { data, error } = v;
  if (v.revoked)
    return (
      <>
        <TopBar title="🧩 아티팩트" />
        <ArtifactRevoked />
      </>
    );
  if (error)
    return (
      <>
        <TopBar title="🧩 아티팩트" />
        <div className="empty" role="alert">
          <p>{artifactErrorText(error)}</p>
        </div>
      </>
    );
  if (!data)
    return (
      <>
        <TopBar title="🧩 아티팩트" />
        <div className="empty muted">불러오는 중…</div>
      </>
    );
  return (
    <>
      <TopBar title={`🧩 ${data.title}`}>
        <span className="badge" data-testid="artifact-kind">
          {KIND_LABEL[data.kind]}
        </span>
        <Link className="small" to={panelLink(data.conversationId, data.id, v.version)}>
          대화에서 보기
        </Link>
      </TopBar>
      <div className="artifact-view">
        <ArtifactToolbar v={v} />
        <ArtifactBody v={v} />
      </div>
    </>
  );
}
