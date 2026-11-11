import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the OpenAI Responses API (streaming SSE), for running the real codex binary without
 * credentials (#16). Each request gets the next scripted answer; every request body is kept so tests can see
 * exactly what the binary sent the model (tools, instructions, input).
 */
type Json = Record<string, unknown>;
export type Answer = Json[] | { status: number; body: Json } | { hang: Json[] };
export type FakeResponses = {
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: Json[];
  close(): Promise<void>;
};

export async function startFakeResponses(script: (n: number, body: Json) => Answer): Promise<FakeResponses> {
  const requests: Json[] = [];
  const open = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d: Buffer) => (b += d.toString()));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/responses")) return void res.writeHead(404).end("{}");
      let body: Json = {};
      try {
        body = JSON.parse(b) as Json;
      } catch {
        /* keep {} */
      }
      requests.push(body);
      const a = script(requests.length - 1, body);
      if (!Array.isArray(a) && "status" in a) {
        res.writeHead(a.status, { "content-type": "application/json" }).end(JSON.stringify(a.body));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of Array.isArray(a) ? a : a.hang)
        res.write(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`);
      if (Array.isArray(a)) res.end();
      else open.add(res); // stays open until closed (a slow answer to interrupt)
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const res of open) res.destroy();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

let n = 0;
const usage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 40 },
  output_tokens: 7,
  total_tokens: 107,
};
/** Server-sent events of one model answer. */
export const sse = {
  text(text: string, o: { chunks?: number; reasoning?: string } = {}): Json[] {
    const id = `msg_${++n}`;
    const parts = text.match(
      new RegExp(`.{1,${Math.max(1, Math.ceil(text.length / (o.chunks ?? 3)))}}`, "gu"),
    );
    return [
      { type: "response.created", response: { id: `resp_${n}` } },
      ...(o.reasoning
        ? [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "reasoning", id: `rs_${n}`, summary: [] },
            },
            {
              type: "response.reasoning_summary_text.delta",
              item_id: `rs_${n}`,
              output_index: 0,
              summary_index: 0,
              delta: o.reasoning,
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                type: "reasoning",
                id: `rs_${n}`,
                summary: [{ type: "summary_text", text: o.reasoning }],
              },
            },
          ]
        : []),
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id, role: "assistant", content: [] },
      },
      ...(parts ?? [text]).map((delta) => ({
        type: "response.output_text.delta",
        item_id: id,
        output_index: 1,
        content_index: 0,
        delta,
      })),
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] },
      },
      { type: "response.completed", response: { id: `resp_${n}`, usage } },
    ];
  },
  /** A function call; MCP tools of server `s` are in namespace `mcp__<s>`. */
  call(name: string, args: unknown, namespace?: string): Json[] {
    const item = {
      type: "function_call",
      id: `fc_${++n}`,
      call_id: `call_${n}`,
      name,
      arguments: JSON.stringify(args),
      ...(namespace ? { namespace } : {}),
    };
    return [
      { type: "response.created", response: { id: `resp_${n}` } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${n}`, usage } },
    ];
  },
};

/** Tool names offered in a request: `namespace.name` for every function the binary listed. */
export function offeredTools(body: Json): string[] {
  const out: string[] = [];
  const walk = (tools: unknown, ns: string) => {
    for (const t of (Array.isArray(tools) ? tools : []) as Json[]) {
      if (t.type === "namespace") walk(t.tools, String(t.name));
      else out.push(`${ns ? ns + "." : ""}${String(t.name ?? t.type)}`);
    }
  };
  walk(body.tools, "");
  for (const i of (Array.isArray(body.input) ? body.input : []) as Json[])
    if (i.type === "additional_tools") walk(i.tools, "");
  return out.sort();
}

/** All text the model was given (instructions and input messages), for prompt checks. */
export function promptText(body: Json): string {
  return JSON.stringify([body.instructions ?? null, body.input ?? null]);
}
