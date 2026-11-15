import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type JSZipType from "jszip";
import type { DocContent } from "@agentlee/shared";
import { DOC_WORKER_DIR } from "../docgen/runner.js";
import { knownSecrets, scrubKnown } from "../secrets/known.js";

/**
 * The `.docx` of a reference export opened again on the server and checked against the known secrets **as they are
 * now** (#26, review #115 round 2). Scrubbing the input is not enough: writing XML can *make* a registered value —
 * `&` becomes `&amp;`, `<` becomes `&lt;` — so `sk-a&b` in a title is `sk-a&amp;b` in `word/document.xml`. Every XML
 * part of the ZIP is read (never the compressed bytes) and checked three ways: its raw text, its text content
 * (the worker's own reader, `xmlText` of docgen/verify.mjs — tags removed, entities decoded) and its attribute
 * values (decoded).
 */

const require = createRequire(import.meta.url);
const JSZip = require("jszip") as typeof JSZipType;

type Verify = { xmlText(xml: string): string };
let reader: Promise<Verify> | undefined;
const verify = () =>
  (reader ??= import(pathToFileURL(path.join(DOC_WORKER_DIR, "verify.mjs")).href) as Promise<Verify>);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : (ENTITIES[e.toLowerCase()] ?? m),
  );

/**
 * Whole values only (`tail: false`): a complete XML part, text or attribute value is not a cut-off secret — its
 * end matching the first characters of a registered value (the fixed font `Malgun Gothic` against a registered
 * `Malgun Gothic-…`) is not a leak (review #115 round 3). Full values and their encodings are found.
 */
const hit = (s: string) => scrubKnown(s, { tail: false }) !== s;

export type XmlPart = { name: string; xml: string; text: string; attrs: string[] };

/**
 * Every XML part of the file, read in full (the asynchronous step) — before anything is checked, so a value
 * registered while a later part is read is still checked against the earlier ones. Undefined for a bad ZIP.
 */
export async function readParts(buf: Buffer): Promise<XmlPart[] | undefined> {
  let zip: JSZipType;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    return undefined;
  }
  const { xmlText } = await verify();
  const out: XmlPart[] = [];
  for (const name of Object.keys(zip.files)) {
    const f = zip.file(name);
    if (!f || !/\.(xml|rels)$/i.test(name)) continue;
    const xml = await f.async("string");
    const attrs = [...xml.matchAll(/=\s*"([^"]*)"|=\s*'([^']*)'/g)].map((m) => decode(m[1] ?? m[2] ?? ""));
    out.push({ name, xml, text: xmlText(xml), attrs });
  }
  return out;
}

/** Synchronous: whether any part holds a known secret of the registry as it is now (raw, as text, in an attribute). */
export const partsHoldSecret = (parts: readonly XmlPart[]): boolean =>
  parts.some((p) => hit(p.xml) || hit(p.text) || p.attrs.some(hit));

/** The registry's state: a new object whenever a value is registered or removed (the compiled matcher). */
export const registryState = () => knownSecrets.matcher();

/** Reads the file, then checks it in one synchronous step; a bad ZIP is a hit. */
export async function docxHoldsSecret(buf: Buffer): Promise<boolean> {
  const parts = await readParts(buf);
  return !parts || partsHoldSecret(parts);
}

const escapeXml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * Each string of the document whose XML form (escaped) holds a known secret, masked there and turned back into text
 * — the input the file is made again from. The same object when no string's escaped form holds one.
 */
export function maskEscaped(doc: DocContent): DocContent {
  let changed = false;
  const mask = (s: string) => {
    const esc = escapeXml(s);
    const out = scrubKnown(esc, { tail: false });
    if (out === esc) return s;
    changed = true;
    return decode(out);
  };
  const next: DocContent = {
    ...doc,
    title: mask(doc.title),
    ...(doc.subtitle !== undefined ? { subtitle: mask(doc.subtitle) } : {}),
    ...(doc.author !== undefined ? { author: mask(doc.author) } : {}),
    blocks: doc.blocks.map((b) => (b.type === "paragraph" ? { ...b, text: mask(b.text) } : b)),
  };
  return changed ? next : doc;
}
