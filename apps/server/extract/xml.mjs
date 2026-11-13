// XML reader of the extractor (#48): a small non-validating pull parser for the Office parts we read. It never
// processes a DTD — any `<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT` … refuses the document (`extract_xml_forbidden`), so
// external entities (XXE) and entity expansion (billion laughs) cannot happen, and only the five predefined
// entities and numeric character references are decoded (any other `&name;` is refused the same way). OOXML parts
// never carry a DTD, so no real document is lost.
//
// Events go to a handler: `open(name, attrs)`, `close(name)`, `text(value)`; element names are local names (the
// prefix is dropped: `w:t` → `t`), attribute names are kept as written (`r:id` next to `id`; see `nsAttr`). Not well-formed input (unclosed or mismatched tags, nesting deeper than `maxDepth`)
// throws `extract_xml_invalid`.
import { ExtractError } from "./errors.mjs";

const PREDEFINED = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

const forbidden = () => new ExtractError("extract_xml_forbidden");
const invalid = () => new ExtractError("extract_xml_invalid");

/** Decodes the predefined entities and character references; anything else is refused. */
export function decodeEntities(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&([^;&\s<]{0,32})(;?)/g, (_m, name, semi) => {
    if (!semi) throw invalid();
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        throw invalid();
      return String.fromCodePoint(code);
    }
    if (Object.hasOwn(PREDEFINED, name)) return PREDEFINED[name];
    // An entity this document would have to declare: never expanded, never looked up.
    throw forbidden();
  });
}

const local = (name) => {
  const c = name.indexOf(":");
  return c === -1 ? name : name.slice(c + 1);
};

/** Index of the `>` that ends the tag starting at `from`, skipping quoted attribute values. */
function tagEnd(s, from) {
  let q = "";
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === ">") return i;
    else if (c === "<") throw invalid();
  }
  throw invalid();
}

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseXml(input, h, { maxDepth = 256 } = {}) {
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const stack = [];
  let i = 0;
  const text = (t) => {
    if (!t) return;
    if (!stack.length) {
      if (t.trim()) throw invalid();
      return;
    }
    // Decoded (and checked) even when nobody listens: an entity reference is refused wherever it is.
    const v = decodeEntities(t);
    h.text?.(v);
  };
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      text(s.slice(i));
      break;
    }
    if (lt > i) text(s.slice(i, lt));
    const c = s[lt + 1];
    if (c === "?") {
      const e = s.indexOf("?>", lt + 2);
      if (e < 0) throw invalid();
      i = e + 2;
      continue;
    }
    if (c === "!") {
      if (s.startsWith("<!--", lt)) {
        const e = s.indexOf("-->", lt + 4);
        if (e < 0) throw invalid();
        i = e + 3;
        continue;
      }
      if (s.startsWith("<![CDATA[", lt)) {
        const e = s.indexOf("]]>", lt + 9);
        if (e < 0 || !stack.length) throw invalid();
        h.text?.(s.slice(lt + 9, e));
        i = e + 3;
        continue;
      }
      // <!DOCTYPE, <!ENTITY, <!ELEMENT, <!ATTLIST, <!NOTATION … : no DTD is ever read.
      throw forbidden();
    }
    const gt = tagEnd(s, lt + 1);
    if (c === "/") {
      const name = local(s.slice(lt + 2, gt).trim());
      if (stack.pop() !== name) throw invalid();
      h.close?.(name);
      i = gt + 1;
      continue;
    }
    const self = s[gt - 1] === "/";
    const body = s.slice(lt + 1, self ? gt - 1 : gt);
    const m = /^[^\s/>]+/.exec(body);
    if (!m) throw invalid();
    const name = local(m[0]);
    const attrs = {};
    if (body.length > m[0].length)
      for (const a of body.slice(m[0].length).matchAll(ATTR))
        attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? "");
    if (stack.length >= maxDepth) throw invalid();
    h.open?.(name, attrs);
    if (self) h.close?.(name);
    else stack.push(name);
    i = gt + 1;
  }
  if (stack.length) throw invalid();
}

/** The XML of an archive entry as text: UTF-8, or UTF-16 with its byte order mark. */
export function xmlText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  return new TextDecoder("utf-8").decode(buf);
}

/** A namespaced attribute by its local name (`r:id`, whatever the prefix), never the plain one of that name. */
export function nsAttr(attrs, name) {
  for (const [k, v] of Object.entries(attrs)) if (k.endsWith(`:${name}`)) return v;
  return undefined;
}

/** An attribute by its local name, the plain one first (`w:val` or `val`). */
export function attr(attrs, name) {
  return attrs[name] ?? nsAttr(attrs, name);
}
