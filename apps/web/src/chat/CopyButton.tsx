import { useState, type ReactNode } from "react";
import { copyText } from "./copy.js";

export function CopyButton({ text, label, children }: { text: string; label: string; children?: ReactNode }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() =>
        void copyText(text).then((ok) => {
          setState(ok ? "ok" : "fail");
          setTimeout(() => setState("idle"), 1500);
        })
      }
    >
      {state === "ok" ? "✓ 복사됨" : state === "fail" ? "복사 못 했어요" : (children ?? "⧉ 복사")}
    </button>
  );
}
