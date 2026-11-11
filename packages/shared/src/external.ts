/**
 * Framing of external content (#20, PRD NFR 프롬프트 주입): web pages, uploaded files and tool results reach a
 * runtime inside an `<external_content>` block, which the common instructions declare to be data, never commands.
 * The content cannot close the block early or open a fake one: any tag of that name inside it is defused —
 * also when written with lookalike characters (fullwidth `＜／ｅｘｔ…`, small or angle brackets, fraction slash)
 * or with invisible characters (zero-width space, soft hyphen) between the letters.
 */
export const EXTERNAL_TAG = "external_content";

/** Characters a reader (or a model) may take for `<`, `/` and nothing at all. */
const LT = "[<\\uFF1C\\uFE64\\u2039\\u2329\\u3008\\u27E8]";
const SLASH = "[/\\uFF0F\\u2044\\u2215]";
const INVISIBLE = "[\\s\\u200B-\\u200D\\u2060\\uFEFF\\u00AD]*";
/** One tag-name character: ASCII (any case) or its fullwidth form. */
const letter = (ch: string) => {
  const full = (c: string) => String.fromCharCode(c.charCodeAt(0) + 0xfee0);
  if (ch === "_") return `[_${full("_")}]`;
  return `[${ch}${ch.toUpperCase()}${full(ch)}${full(ch.toUpperCase())}]`;
};
const TAG = new RegExp(
  `${LT}${INVISIBLE}(${SLASH}?)${INVISIBLE}${[...EXTERNAL_TAG].map(letter).join(INVISIBLE)}`,
  "g",
);

/** `source` is a short label (URL, file name) — reduced to characters that cannot break the attribute. */
export function frameExternal(input: { source: string; content: string }): string {
  const source = input.source.replace(/[^\w\-.:/?=&%#@+~ ]/g, "").slice(0, 300);
  const content = input.content.replace(TAG, (_m, slash: string) => `&lt;${slash ? "/" : ""}${EXTERNAL_TAG}`);
  return `<${EXTERNAL_TAG} source="${source}">\n${content}\n</${EXTERNAL_TAG}>`;
}
