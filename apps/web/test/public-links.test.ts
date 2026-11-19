import { describe, expect, it } from "vitest";
import { checkNotices, daysOf } from "../src/public-links/PublicLinkDialog.js";

/** The "공개 링크 만들기" dialog's rules (#204): whole days 1–365 only, and what the pre-publish check says. */
describe("public link dialog", () => {
  it("days: a whole number from 1 to 365 — no 'never', nothing else", () => {
    expect(daysOf("7")).toBe(7);
    expect(daysOf("1")).toBe(1);
    expect(daysOf("365")).toBe(365);
    for (const bad of ["0", "366", "1.5", "-3", "", "abc", "7일"]) expect(daysOf(bad), bad).toBeUndefined();
  });

  it("a secret blocks; emails and phone numbers warn; external hosts are a notice", () => {
    expect(checkNotices({ version: 1, secret: false, emails: 0, phones: 0, externalHosts: [] })).toEqual([]);
    const n = checkNotices({
      version: 1,
      secret: true,
      emails: 2,
      phones: 1,
      externalHosts: ["cdn.jsdelivr.net"],
    });
    expect(n.map((x) => x.level)).toEqual(["block", "warn", "info"]);
    expect(n[1]!.text).toContain("이메일 주소 2개, 전화번호 1개");
    expect(n[2]!.text).toContain("cdn.jsdelivr.net");
  });
});
