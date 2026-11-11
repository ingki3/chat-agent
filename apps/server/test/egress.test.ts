import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startEgressProxy, type RunningEgress } from "../src/isolation/egress.js";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** A local "upstream" that the proxy is made to dial instead of the real address (tests only). */
async function upstream() {
  const got: string[] = [];
  const srv = net.createServer((s) => {
    s.on("data", (d) => {
      got.push(d.toString());
      s.write(`echo:${d.toString()}`);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => srv.close(r)));
  return { port: (srv.address() as net.AddressInfo).port, got };
}

async function proxy(
  lookup: (h: string) => Promise<string[]>,
  upPort: number,
): Promise<{ p: RunningEgress; dialed: string[] }> {
  const dialed: string[] = [];
  const p = await startEgressProxy({
    allow: ["api.anthropic.com"],
    lookup,
    connect: (ip, port) => {
      dialed.push(`${ip}:${port}`);
      return net.connect({ host: "127.0.0.1", port: upPort });
    },
  });
  closers.push(() => p.close());
  return { p, dialed };
}

/** Sends a raw request line to the proxy and returns the first response chunk (and the socket). */
function send(port: number, request: string): Promise<{ head: string; sock: net.Socket }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => sock.write(request));
    sock.once("data", (d) => resolve({ head: d.toString(), sock }));
    sock.once("error", reject);
    sock.once("end", () => resolve({ head: "", sock }));
    closers.push(async () => sock.destroy());
  });
}

const PUBLIC = async () => ["160.79.104.10"];

describe("egress proxy (#15, review #80)", () => {
  it("tunnels CONNECT to an allowed host on 443, to the address it resolved itself", async () => {
    const up = await upstream();
    const { p, dialed } = await proxy(PUBLIC, up.port);
    const { head, sock } = await send(
      p.port,
      "CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n",
    );
    expect(head).toMatch(/^HTTP\/1\.1 200/);
    expect(dialed).toEqual(["160.79.104.10:443"]);
    const echoed = await new Promise<string>((r) => {
      sock.once("data", (d) => r(d.toString()));
      sock.write("ping");
    });
    expect(echoed).toBe("echo:ping");
  });

  it("refuses other hosts, other ports, and plain HTTP proxying", async () => {
    const up = await upstream();
    const { p, dialed } = await proxy(PUBLIC, up.port);
    for (const target of [
      "evil.example:443",
      "api.anthropic.com:80",
      "api.anthropic.com:8443",
      "api.anthropic.com.evil.example:443",
      "127.0.0.1:443",
      "[::1]:443",
    ])
      expect((await send(p.port, `CONNECT ${target} HTTP/1.1\r\n\r\n`)).head, target).toMatch(
        /^HTTP\/1\.1 403/,
      );
    expect(
      (await send(p.port, "GET http://api.anthropic.com/ HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n")).head,
    ).toMatch(/^HTTP\/1\.1 405/);
    expect(dialed).toEqual([]);
  });

  it("refuses names that resolve to this machine, the home network, link-local or metadata addresses", async () => {
    const up = await upstream();
    for (const answer of [
      ["127.0.0.1"],
      ["10.0.0.5"],
      ["192.168.1.2"],
      ["169.254.169.254"],
      ["::1"],
      ["fd00::1"],
      ["160.79.104.10", "192.168.1.2"],
    ]) {
      const { p, dialed } = await proxy(async () => answer, up.port);
      expect(
        (await send(p.port, "CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n")).head,
        answer.join(","),
      ).toMatch(/^HTTP\/1\.1 403/);
      expect(dialed).toEqual([]);
    }
  });

  it("answers 502 when the name does not resolve or the upstream fails", async () => {
    const { p } = await proxy(async () => {
      throw new Error("ENOTFOUND");
    }, 1);
    expect((await send(p.port, "CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n")).head).toMatch(
      /^HTTP\/1\.1 502/,
    );
    const dead = await startEgressProxy({
      allow: ["api.anthropic.com"],
      lookup: PUBLIC,
      connect: () => net.connect({ host: "127.0.0.1", port: 1 }),
    });
    closers.push(() => dead.close());
    expect((await send(dead.port, "CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n")).head).toMatch(
      /^HTTP\/1\.1 502/,
    );
  });

  it("listens on loopback only", async () => {
    const { p } = await proxy(PUBLIC, 1);
    expect(p.url).toBe(`http://127.0.0.1:${p.port}`);
  });
});
