import { describe, expect, it } from "vitest";
import { checkNotices, daysOf, hostList, mergePages } from "../src/public-links/PublicLinkDialog.js";

/** The "공개 링크 만들기" dialog's rules (#204): whole days 1–365 only, and what the pre-publish check says. */
describe("public link dialog", () => {
  it("days: a whole number from 1 to 365 — no 'never', nothing else", () => {
    expect(daysOf("7")).toBe(7);
    expect(daysOf("1")).toBe(1);
    expect(daysOf("365")).toBe(365);
    for (const bad of ["0", "366", "1.5", "-3", "", "abc", "7일"]) expect(daysOf(bad), bad).toBeUndefined();
  });

  it("a secret blocks; emails and phone numbers warn; external hosts are a notice", () => {
    expect(
      checkNotices({
        version: 1,
        secret: false,
        emails: 0,
        phones: 0,
        externalHosts: [],
        externalHostsMore: 0,
      }),
    ).toEqual([]);
    const n = checkNotices({
      version: 1,
      secret: true,
      emails: 2,
      phones: 1,
      externalHosts: ["cdn.jsdelivr.net"],
      externalHostsMore: 0,
    });
    expect(n.map((x) => x.level)).toEqual(["block", "warn", "info"]);
    expect(n[1]!.text).toContain("이메일 주소 2개, 전화번호 1개");
    expect(n[2]!.text).toContain("cdn.jsdelivr.net");
  });
});

describe("public link lists", () => {
  it("merging pages: each link once, where it first appeared, in the state of the latest page that has it", () => {
    const l = (id: string, status: string) => ({ id, status });
    const merged = mergePages([
      { active: [l("old", "active"), l("b", "active")], history: [l("h1", "expired")] },
      // Turned off in another tab before this page was read: the later state wins.
      { active: [], history: [l("old", "disabled"), l("h2", "disabled")] },
    ]);
    expect(merged).toEqual([l("old", "disabled"), l("b", "active"), l("h1", "expired"), l("h2", "disabled")]);
  });
});

describe("external address notice", () => {
  it("the first 10, then 외 N개 — counting the hosts the server only counted", () => {
    const hosts = Array.from({ length: 100 }, (_, i) => `h${String(i).padStart(3, "0")}.example`);
    expect(hostList({ externalHosts: hosts.slice(0, 3), externalHostsMore: 0 })).toBe(
      "h000.example, h001.example, h002.example",
    );
    const t = hostList({ externalHosts: hosts, externalHostsMore: 50 });
    expect(t.split(", ")).toHaveLength(10);
    expect(t.endsWith(" 외 140개")).toBe(true);
  });
});
