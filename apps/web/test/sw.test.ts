import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The service worker's push logic (apps/web/public/sw.js, #34), run in a sandbox with fake worker globals:
 * clients, registration, caches and fetch.
 */
const SOURCE = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/sw.js"),
  "utf8",
);
const ORIGIN = "https://chat.example";

type Handler = (e: Record<string, unknown>) => void;
type FakeWindow = {
  url: string;
  navigated: string[];
  focused: number;
  messages: unknown[];
  navigate: (u: string) => Promise<FakeWindow | null>;
  focus: () => Promise<FakeWindow>;
  postMessage: (m: unknown) => void;
};

function win(url: string, opts: { uncontrolled?: boolean } = {}): FakeWindow {
  const w: FakeWindow = {
    url,
    navigated: [],
    focused: 0,
    messages: [],
    navigate: async (u) => {
      if (opts.uncontrolled) throw new TypeError("not controlled");
      w.navigated.push(u);
      w.url = ORIGIN + u;
      return w;
    },
    focus: async () => {
      w.focused++;
      return w;
    },
    postMessage: (m) => w.messages.push(m),
  };
  return w;
}

function worker(o: { windows?: FakeWindow[]; status?: number } = {}) {
  const handlers = new Map<string, Handler>();
  const opened: string[] = [];
  const requests: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const store = new Map<string, Map<string, string>>();
  let status = o.status ?? 201;
  const caches = {
    open: async (name: string) => {
      const m = store.get(name) ?? new Map<string, string>();
      store.set(name, m);
      return {
        put: async (k: string, r: Response) => void m.set(k, await r.text()),
        delete: async (k: string) => m.delete(k),
        add: async () => {},
      };
    },
    keys: async () => [...store.keys()],
    delete: async (k: string) => store.delete(k),
    match: async () => undefined,
  };
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/renewed",
    toJSON: () => ({
      endpoint: "https://fcm.googleapis.com/fcm/send/renewed",
      keys: { p256dh: "p", auth: "a" },
    }),
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, h: Handler) => handlers.set(t, h),
    skipWaiting: async () => {},
    clients: {
      matchAll: async () => o.windows ?? [],
      openWindow: async (u: string) => void opened.push(u),
      claim: async () => {},
    },
    registration: {
      showNotification: async () => {},
      pushManager: { subscribe: async () => subscription },
    },
  };
  const fetch = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => {
    requests.push({ url, ...init });
    return { ok: status >= 200 && status < 300, status };
  };
  vm.runInNewContext(SOURCE, { self, caches, fetch, URL, Response, console });
  const fire = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  const tap = (data: unknown) => fire("notificationclick", { notification: { data, close: () => {} } });
  return {
    tap,
    fire,
    opened,
    requests,
    pending: () => store.get("agentlee-push")?.has("/push-reregister") ?? false,
    setStatus: (s: number) => (status = s),
  };
}

describe("service worker: tapping a notification", () => {
  it("navigates an open window — even one on the login screen — to the address, then focuses it", async () => {
    const login = win(`${ORIGIN}/`);
    const w = worker({ windows: [login] });
    await w.tap({ url: "/c/42", id: "n-1" });
    expect(login.navigated).toEqual(["/c/42"]);
    expect(login.focused).toBe(1);
    expect(login.messages).toEqual([]);
    expect(w.opened).toEqual([]);
    // Marked read on the way, as a same-origin CSRF-protected call.
    expect(w.requests).toEqual([
      expect.objectContaining({
        url: "/api/notifications/n-1/read",
        method: "POST",
        headers: expect.objectContaining({ "x-agent-lee": "1" }) as unknown,
      }),
    ]);
  });

  it("only ever goes to a same-origin single-slash path", async () => {
    for (const bad of [
      "https://evil.example/x",
      "//evil.example",
      "/a/..//evil.example",
      "/a/%2e%2e//evil.example",
      "/\\evil",
    ]) {
      const page = win(`${ORIGIN}/settings`);
      await worker({ windows: [page] }).tap({ url: bad });
      expect(page.navigated, bad).toEqual(["/"]);
    }
  });

  it("falls back to a message when it cannot navigate the window, and opens a window when none is open", async () => {
    const old = win(`${ORIGIN}/`, { uncontrolled: true });
    await worker({ windows: [old] }).tap({ url: "/c/1" });
    expect(old.messages).toEqual([{ type: "agentlee:open", url: "/c/1" }]);
    expect(old.focused).toBe(1);
    const w = worker();
    await w.tap({ url: "/notifications" });
    expect(w.opened).toEqual(["/notifications"]);
  });
});

describe("service worker: renewed subscription", () => {
  const oldSubscription = { options: { applicationServerKey: new Uint8Array([4, 1, 2]).buffer } };

  it("remembers a failed re-registration (403 after Access expired) for the app, and clears it once it works", async () => {
    const w = worker({ status: 403 });
    await w.fire("pushsubscriptionchange", { oldSubscription });
    expect(w.requests.map((r) => r.url)).toEqual(["/api/push/devices"]);
    expect(w.pending()).toBe(true);
    w.setStatus(201);
    await w.fire("pushsubscriptionchange", { oldSubscription });
    expect(w.pending()).toBe(false);
  });

  it("uses the browser's new subscription when it is given, and flags a missing key", async () => {
    const w = worker();
    await w.fire("pushsubscriptionchange", {
      newSubscription: { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/new" }) },
    });
    expect(JSON.parse(w.requests[0]!.body)).toMatchObject({
      endpoint: "https://fcm.googleapis.com/fcm/send/new",
    });
    const none = worker();
    await none.fire("pushsubscriptionchange", {});
    expect(none.requests).toEqual([]);
    expect(none.pending()).toBe(true);
  });
});
