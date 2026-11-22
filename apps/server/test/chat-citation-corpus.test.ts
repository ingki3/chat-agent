import { describe, expect, it } from "vitest";
import {
  citationMarkers,
  citationUnits,
  plainTextRanges,
  sentenceEndMarkers,
  uncitedUnits,
} from "@agentlee/shared";
import { CHAT_CITATION_CORPUS } from "./fixtures/chat-citation-corpus.js";

/**
 * #233 review 3: the report's Markdown helpers live next to the chat's #202 check in `packages/shared`. The chat's
 * units, markers, sentence-end markers, missing ranges and plain-text ranges on a fixed corpus are kept as a
 * snapshot — checked equal to `origin/dev`'s code when it was written — so any change to the chat's results shows.
 */
describe("chat citation check is unchanged by the report's Markdown (#233)", () => {
  it("gives the same units, markers and missing ranges on the corpus", () => {
    const out = CHAT_CITATION_CORPUS.map((t) => {
      const parts = [0, Math.floor(t.length / 2)];
      const units = citationUnits(t, parts);
      return {
        t,
        units,
        markers: citationMarkers(t, units),
        ends: sentenceEndMarkers(t, units),
        missing: uncitedUnits(t, units),
        plain: plainTextRanges(t),
      };
    });
    expect(out).toMatchSnapshot();
  });
});
