import { spawnSync } from "node:child_process";

/**
 * Who a process is, as `ps` tells it: process group, start time (`lstart`, to the second) and command line. A pid
 * alone can be reused; pid + start time names one process.
 */
export type ProcessIdentity = { pgid: number; lstart: string; command: string };

export function processIdentity(pid: number): ProcessIdentity | undefined {
  const r = spawnSync("/bin/ps", ["-o", "pgid=,lstart=,command=", "-p", String(pid)], {
    encoding: "utf8",
    env: {},
    timeout: 2000,
  });
  if (r.status !== 0) return undefined;
  // "<pgid> <Www Mmm dd hh:mm:ss yyyy> <command…>"
  const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+[\d:]{8}\s+\d{4})\s+(.+?)\s*$/.exec(r.stdout);
  if (!m) return undefined;
  return { pgid: Number(m[1]), lstart: m[2]!.replace(/\s+/g, " "), command: m[3]! };
}
