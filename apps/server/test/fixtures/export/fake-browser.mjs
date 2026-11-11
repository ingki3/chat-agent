// A stand-in for the headless browser (#51 host-survival tests): speaks the DevTools pipe (fd 3 in, fd 4 out) and
// misbehaves the way a crashed or compromised renderer could, chosen by argv[2].
import net from "node:net";

const mode = process.argv[2];
const input = new net.Socket({ fd: 3, readable: true, writable: false });
const output = new net.Socket({ fd: 4, readable: false, writable: true });
const send = (raw) => output.write(raw + "\0");
const json = (v) => send(JSON.stringify(v));
let buf = "";
let first = true;
input.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\0")) !== -1) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    handle(msg);
  }
});
input.on("end", () => process.exit(0));

function handle(m) {
  if (mode === "hang") return;
  if (first) {
    first = false;
    if (mode === "null") return send("null");
    if (mode === "badjson") return send("{oops");
    if (mode === "array") return send("[1,2]");
    if (mode === "wrong-id") return json({ id: String(m.id), result: {} });
    if (mode === "unknown-id") return json({ id: 999999, result: {} });
    if (mode === "bad-result") return json({ id: m.id, result: "x" });
    if (mode === "bad-reply") return json({ id: m.id, result: { targetId: 5 } });
    if (mode === "huge") return json({ id: m.id, result: { targetId: "t".repeat(2 * 1024 * 1024) } });
  }
  switch (m.method) {
    case "Target.createTarget":
      return json({ id: m.id, result: { targetId: "t1" } });
    case "Target.attachToTarget":
      return json({ id: m.id, result: { sessionId: "s1" } });
    case "Fetch.enable":
      json({ id: m.id, result: {} });
      if (mode === "bad-params")
        json({ method: "Fetch.requestPaused", sessionId: "s1", params: { requestId: 5, request: null } });
      return;
    case "Page.navigate":
      if (mode === "close-before-navigate") process.exit(0);
      json({ id: m.id, result: { frameId: "f" } });
      return json({ method: "Page.loadEventFired", sessionId: "s1", params: { timestamp: 1 } });
    case "Page.printToPDF":
      return json({ id: m.id, result: { data: Buffer.from("%PDF-fake").toString("base64") } });
    case "Browser.close":
      json({ id: m.id, result: {} });
      return setTimeout(() => process.exit(0), 10);
    default:
      return json({ id: m.id, result: {} });
  }
}
