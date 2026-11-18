// A stand-in for the headless browser (#51 host-survival tests): speaks the DevTools pipe (fd 3 in, fd 4 out) and
// misbehaves the way a crashed or compromised renderer could, chosen by argv[2]. `orphan` (#170): answers nothing
// and, like the real shell, keeps running when the pipe closes.
import fs from "node:fs";
import net from "node:net";

const mode = process.argv[2];
// `exit127` (#170): a browser that starts and exits 127 by itself (not an exec failure).
if (mode === "exit127") process.exit(127);
// $PIDFILE (#170): the stand-in records its pid as it starts (a test can then check it never outlived its watchdog).
if (process.env.PIDFILE) fs.writeFileSync(process.env.PIDFILE, String(process.pid));
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
if (mode === "orphan") setInterval(() => {}, 1000);
else input.on("end", () => process.exit(0));

function handle(m) {
  if (mode === "hang" || mode === "orphan") return;
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
      // `ok-130`: a good render, then an exit code ≥ 126 of the browser's own (not a watchdog failure).
      // `ok-exit`: the same with $EXIT_CODE (a stand-in watchdog reporting a status).
      return setTimeout(
        () => process.exit(mode === "ok-130" ? 130 : mode === "ok-exit" ? Number(process.env.EXIT_CODE) : 0),
        10,
      );
    default:
      return json({ id: m.id, result: {} });
  }
}
