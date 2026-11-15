// Network probe run under the renderer's sandbox policy (#51, macOS): name resolution, UDP (to a local listener
// and to a public DNS server), TCP to the allowed proxy port and to another local port. Prints what worked.
import dgram from "node:dgram";
import dns from "node:dns/promises";
import net from "node:net";

const [udpPort, proxyPort, otherPort] = process.argv.slice(2).map(Number);
const out = {};
const code = (e) => `err:${e.code ?? e.name}`;
try {
  out.lookup = (await dns.lookup("example.com")).address;
} catch (e) {
  out.lookup = code(e);
}
const udp = (port, host) =>
  new Promise((r) => {
    const s = dgram.createSocket("udp4");
    s.on("error", (e) => r(code(e)));
    s.send("probe", port, host, (e) => {
      s.close();
      r(e ? code(e) : "sent");
    });
  });
out.udpLocal = await udp(udpPort, "127.0.0.1");
out.udpDns = await udp(53, "8.8.8.8");
const tcp = (port) =>
  new Promise((r) => {
    const c = net.connect(port, "127.0.0.1");
    c.on("connect", () => (c.destroy(), r("ok")));
    c.on("error", (e) => r(code(e)));
  });
out.tcpProxy = await tcp(proxyPort);
out.tcpOther = await tcp(otherPort);
process.stdout.write(JSON.stringify(out));
