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

  it("opens nothing when the client left, or the proxy closed, while the name was being resolved", async () => {
    const up = await upstream();
    let resolveLookup!: (ips: string[]) => void;
    const pending = () => new Promise<string[]>((r) => (resolveLookup = r));
    const a = await proxy(pending, up.port);
    const s1 = net.connect({ host: "127.0.0.1", port: a.p.port }, () =>
      s1.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n"),
    );
    await new Promise((r) => setTimeout(r, 50));
    s1.destroy();
    await new Promise((r) => setTimeout(r, 50));
    resolveLookup(["160.79.104.10"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.dialed).toEqual([]);

    const b = await proxy(pending, up.port);
    const s2 = net.connect({ host: "127.0.0.1", port: b.p.port }, () =>
      s2.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n"),
    );
    closers.push(async () => s2.destroy());
    await new Promise((r) => setTimeout(r, 50));
    await b.p.close();
    resolveLookup(["160.79.104.10"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(b.dialed).toEqual([]);
  });

  it("caps open tunnels and closes idle ones", async () => {
    const up = await upstream();
    const p = await startEgressProxy({
      allow: ["api.anthropic.com"],
      lookup: PUBLIC,
      connect: () => net.connect({ host: "127.0.0.1", port: up.port }),
      maxTunnels: 2,
      idleMs: 200,
    });
    closers.push(() => p.close());
    const req = "CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n";
    const one = await send(p.port, req);
    const two = await send(p.port, req);
    expect(one.head).toMatch(/200/);
    expect(two.head).toMatch(/200/);
    expect((await send(p.port, req)).head).toMatch(/^HTTP\/1\.1 503/);
    // Idle tunnels are closed, which frees their slots.
    await new Promise<void>((r) => one.sock.once("close", () => r()));
    await new Promise<void>((r) => (two.sock.destroyed ? r() : two.sock.once("close", () => r())));
    await new Promise((r) => setTimeout(r, 30));
    expect((await send(p.port, req)).head).toMatch(/200/);
  });

  it("closes refused sockets even when the client keeps its side open (no lingering half-open sockets)", async () => {
    const up = await upstream();
    const p = await startEgressProxy({
      allow: ["api.anthropic.com"],
      lookup: PUBLIC,
      connect: () => net.connect({ host: "127.0.0.1", port: up.port }),
      maxTunnels: 1,
    });
    closers.push(() => p.close());
    const req = "CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n";
    await send(p.port, req); // takes the only slot
    // 503 (over the cap), 403 (not allowed); 502 is covered by a proxy whose lookup fails, below.
    for (const r of [req, "CONNECT evil.example:443 HTTP/1.1\r\n\r\n"]) {
      // allowHalfOpen: this client never ends its side; only the server can close the socket.
      const sock = net.connect({ host: "127.0.0.1", port: p.port, allowHalfOpen: true }, () => sock.write(r));
      closers.push(async () => sock.destroy());
      // After the answer, keep writing: a server that really closed the socket resets it; a half-open one
      // would keep reading forever.
      sock.on("error", () => {});
      const closed = new Promise<boolean>((res) => {
        sock.once("close", () => res(true));
        const tick = setInterval(() => {
          if (!sock.destroyed) sock.write("x");
        }, 100);
        setTimeout(() => {
          clearInterval(tick);
          res(false);
        }, 2500);
      });
      expect(await closed, r).toBe(true);
    }
  });

  it("closes a 502-refused socket even when the client keeps its side open", async () => {
    const p = await startEgressProxy({
      allow: ["api.anthropic.com"],
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    closers.push(() => p.close());
    const sock = net.connect({ host: "127.0.0.1", port: p.port, allowHalfOpen: true }, () =>
      sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n"),
    );
    closers.push(async () => sock.destroy());
    sock.on("error", () => {});
    const closed = await new Promise<boolean>((res) => {
      sock.once("close", () => res(true));
      const tick = setInterval(() => {
        if (!sock.destroyed) sock.write("x");
      }, 100);
      setTimeout(() => {
        clearInterval(tick);
        res(false);
      }, 2500);
    });
    expect(closed).toBe(true);
  });

  it("listens on loopback only", async () => {
    const { p } = await proxy(PUBLIC, 1);
    expect(p.url).toBe(`http://127.0.0.1:${p.port}`);
  });
});
