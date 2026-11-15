import { TopBar } from "../Shell.js";

/** Screens whose content comes with later issues. */
export function PlaceholderPage({ title, issue }: { title: string; issue?: string }) {
  return (
    <>
      <TopBar title={title} />
      <div className="empty">
        <h1>{title}</h1>
        <p className="muted">{issue ? `이 화면은 ${issue}에서 만들어요.` : "주소를 확인해 주세요."}</p>
      </div>
    </>
  );
}
