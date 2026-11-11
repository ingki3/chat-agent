import { Component, lazy, Suspense, type ReactNode } from "react";

/**
 * Markdown text with the renderer (KaTeX, highlighter) loaded as a separate chunk: the app shell stays small,
 * and until the chunk has loaded the text shows as plain text. If loading fails (offline, a deploy replaced the
 * chunk) the text stays readable as plain text with a "다시 시도" button; a retry loads the chunk afresh for
 * every reply that failed.
 */
const load = () => import("./Markdown.js");
let Markdown = lazy(load);
const waiting = new Set<() => void>();
function retry() {
  Markdown = lazy(load); // a rejected lazy() stays rejected: start over with a new one
  for (const reset of [...waiting]) reset();
}

const Plain = ({ text }: { text: string }) => <div className="md plain">{text}</div>;

class Boundary extends Component<{ text: string }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  private reset = () => this.setState({ failed: false });
  override componentDidMount() {
    waiting.add(this.reset);
  }
  override componentWillUnmount() {
    waiting.delete(this.reset);
  }
  override render(): ReactNode {
    const { text } = this.props;
    if (this.state.failed)
      return (
        <>
          <Plain text={text} />
          <div className="notice warn fx small" role="status">
            <span>서식을 불러오지 못해 글자만 보여드려요.</span>
            <button type="button" className="small" onClick={retry}>
              다시 시도
            </button>
          </div>
        </>
      );
    const Md = Markdown;
    return (
      <Suspense fallback={<Plain text={text} />}>
        <Md text={text} />
      </Suspense>
    );
  }
}

export function RichText({ text }: { text: string }) {
  return <Boundary text={text} />;
}
