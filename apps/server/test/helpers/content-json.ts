/**
 * JSON of a value for "this secret never appears anywhere" checks, with the metadata that is random or a clock reading
 * masked (#208): strings that are a UUID or an ISO time, and the numbers of `…At` (epoch-ms times) and `…Ms`
 * (durations) fields. A check for a short numeric synthetic secret (`9876`, `123456`) over the whole serialized
 * object could otherwise match digits that merely occur in a random id (`…-9876-…`) or a timestamp. Every other field —
 * the content, tool input and output included — is serialized as-is, so a leak anywhere in it is still caught.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const META_NUMBER_KEY = /(At|Ms)$/;

export function contentJson(value: unknown): string {
  return JSON.stringify(value, (key, v: unknown) => {
    if (typeof v === "string" && (UUID.test(v) || ISO_TIME.test(v))) return "<meta>";
    if (typeof v === "number" && META_NUMBER_KEY.test(key)) return 0;
    return v;
  });
}
