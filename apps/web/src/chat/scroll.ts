import { useCallback, useEffect, useRef, useState } from "react";

const NEAR = 80; // px from the bottom that still counts as "at the bottom"
const distance = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;
const scrollToEnd = (el: HTMLElement) => el.scrollTo({ top: el.scrollHeight });

/**
 * Follows new content while the user is at the bottom; stops as soon as they scroll up, and offers a button
 * back down (FR-3.1). Growth is watched with a ResizeObserver, so streaming text, math and code blocks that
 * change height are all followed without an effect per token. Attach `scroller` to the scrolling element and
 * `content` to the element inside it that grows.
 */
export function useStickToBottom() {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);

  const toBottom = useCallback(() => {
    stick.current = true;
    setAway(false);
    if (scroller.current) scrollToEnd(scroller.current);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const onScroll = () => {
      const atBottom = distance(el) <= NEAR;
      stick.current = atBottom;
      setAway(!atBottom);
    };
    const ro = new ResizeObserver(() => {
      if (stick.current) scrollToEnd(el);
      else setAway(distance(el) > NEAR);
    });
    ro.observe(inner);
    el.addEventListener("scroll", onScroll, { passive: true });
    scrollToEnd(el);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  return { scroller, content, away, toBottom };
}
