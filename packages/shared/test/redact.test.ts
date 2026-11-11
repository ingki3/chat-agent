import { describe, expect, it } from "vitest";
import { decodeJsonString } from "../src/json-spans.js";
import {
  REDACTED,
  SECRET_NAMES,
  SECRET_SUFFIXES,
  isSecretKey,
  redactForDisplay,
  redactSecrets,
  redactString,
} from "../src/redact.js";

describe("redactSecrets", () => {
  it("hides secret fields at any depth, by exact name or a known secret suffix", () => {
    expect(
      redactSecrets({
        query: "날씨",
        apiKey: "abc",
        api_key: "abc",
        headers: { Authorization: "x", Cookie: "y", "X-Api-Key": "z" },
        list: [{ password: "p" }, { client_secret: "s" }, { accessToken: "t" }, { githubToken: "g" }],
        db: { dbPassword: "pw", sessionId: "sess" },
      }),
    ).toEqual({
      query: "날씨",
      apiKey: REDACTED,
      api_key: REDACTED,
      headers: { Authorization: REDACTED, Cookie: REDACTED, "X-Api-Key": REDACTED },
      list: [
        { password: REDACTED },
        { client_secret: REDACTED },
        { accessToken: REDACTED },
        { githubToken: REDACTED },
      ],
      db: { dbPassword: REDACTED, sessionId: REDACTED },
    });
  });

  it("hides secret fields whatever the value type — numeric OTPs, PINs and passwords too", () => {
    expect(
      redactSecrets({ otp: 123456, password: 1234, pin: 9876, session: { id: 1 }, token: true, auth: null }),
    ).toEqual({
      otp: REDACTED,
      password: REDACTED,
      pin: REDACTED,
      session: REDACTED,
      token: REDACTED,
      auth: null,
    });
  });

  it("finds credentials inside longer strings and keeps the rest of the text", () => {
    expect(redactString("request failed with key sk-proj-abcdefgh1234 (401)")).toBe(
      `request failed with key ${REDACTED} (401)`,
    );
    expect(redactSecrets({ error: "Authorization: Bearer 9f8a7b6c5d4e3f2a1b0c failed" })).toEqual({
      error: `Authorization: ${REDACTED} failed`,
    });
    expect(redactString("header Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(
      `header Authorization: ${REDACTED}`,
    );
    expect(
      redactString(
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ok",
      ),
    ).toBe(`jwt ${REDACTED} ok`);
    expect(
      redactString("key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nafter"),
    ).toBe(`key:\n${REDACTED}\nafter`);
    expect(
      redactSecrets(["log: ghp_" + "a".repeat(30) + " pushed", "AKIAABCDEFGHIJKLMNOP leaked", "평범한 글"]),
    ).toEqual([`log: ${REDACTED} pushed`, `${REDACTED} leaked`, "평범한 글"]);
    expect(redactString("GET /api?q=1&api_key=s3cr3t&page=2")).toBe(
      `GET /api?q=1&api_key=${REDACTED}&page=2`,
    );
    expect(redactString('config: password = "hunter2", user = "kim"')).toBe(
      `config: password = ${REDACTED}, user = "kim"`,
    );
  });

  it("keeps ordinary data: token counters, tokenizer names, symbols, keywords, page tokens", () => {
    const data = {
      inputTokens: 12,
      outputTokens: 30,
      max_tokens: 1000,
      totalToken: 42,
      tokenizer: "cl100k_base",
      tokenSymbol: "ETH",
      tokens: ["a", "b"],
      keyword: "k",
      author: "x",
      key: "price",
      passage: "본문",
      spin: 3,
      pagination: { nextPageToken: "abc" },
      text: "max_tokens: 100, tokenizer=cl100k, 맵핑 spin=3",
    };
    expect(redactSecrets(data)).toEqual(data);
    for (const k of [
      "tokenizer",
      "tokenSymbol",
      "inputTokens",
      "nextPageToken",
      "author",
      "keyword",
      "passage",
    ])
      expect(isSecretKey(k)).toBe(false);
  });

  it("redacts secret fields of JSON held in a string, field by field", () => {
    expect(redactString('{"password":"hunter2","otp":123456,"user":"kim"}')).toBe(
      `{"password":"${REDACTED}","otp":"${REDACTED}","user":"kim"}`,
    );
    expect(redactString('  [{"apiKey":"abc"},{"n":1}]  ')).toBe(`  [{"apiKey":"${REDACTED}"},{"n":1}]  `);
    // JSON inside a longer message (not parseable as a whole)
    expect(redactString('request failed: {"password":"hunter2","otp":123456} (400)')).toBe(
      `request failed: {"password":"${REDACTED}","otp":"${REDACTED}"} (400)`,
    );
    // An untouched document keeps its formatting.
    const pretty = '{\n  "user": "kim",\n  "n": 1\n}';
    expect(redactString(pretty)).toBe(pretty);
  });

  it("finds JSON printed into log text, across newlines, with any value type under a secret key", () => {
    expect(redactString('stdout: {"password":\n "hunter2","otp":[123456]}')).toBe(
      `stdout: {"password":\n "${REDACTED}","otp":"${REDACTED}"}`,
    );
    expect(
      redactString(
        'result {"user":{"name":"kim","credentials":{"user":"kim","pass":"x"}},"tokens":[{"token":"t1"},{"token":"t2"}]} end',
      ),
    ).toBe(
      `result {"user":{"name":"kim","credentials":"${REDACTED}"},"tokens":[{"token":"${REDACTED}"},{"token":"${REDACTED}"}]} end`,
    );
    expect(redactString('{"session": {"id": 1, "nested": [1, {"a": [2]}]}, "ok": true}')).toBe(
      `{"session": "${REDACTED}", "ok": true}`,
    );
    // Escaped quotes inside strings, and a secret value that is cut off.
    expect(redactString('{"note":"he said \\"hi\\"","secret":"a\\"b"}')).toBe(
      `{"note":"he said \\"hi\\"","secret":"${REDACTED}"}`,
    );
    expect(redactString('log {"user":"kim","password":"hunter2')).not.toContain("hunter2");
    expect(redactString('log {"user":"kim","password":"hunter2')).toContain('"user":"kim"');
    // Several documents, and prose braces around them.
    expect(redactString('use {name} here; a={"otp":1} b=[{"pin":2}] {not json}')).toBe(
      `use {name} here; a={"otp":"${REDACTED}"} b=[{"pin":"${REDACTED}"}] {not json}`,
    );
  });

  it("judges JSON keys by their decoded name (\\u escapes, surrogate pairs)", () => {
    expect(redactString('{"pass\\u0077ord":"hunter2","\\u006ftp":[123456],"user":"kim"}')).toBe(
      `{"pass\\u0077ord":"${REDACTED}","\\u006ftp":"${REDACTED}","user":"kim"}`,
    );
    expect(redactString('{"api\\u004Bey":1,"t\\u006F\\u006Ben":"x","\\ud83d\\ude00":"emoji key"}')).toBe(
      `{"api\\u004Bey":"${REDACTED}","t\\u006F\\u006Ben":"${REDACTED}","\\ud83d\\ude00":"emoji key"}`,
    );
  });

  it("opens JSON held in a JSON string (any depth) and rewrites only that string literal", () => {
    const one = '{"stdout":"{\\"password\\":\\"hunter2\\",\\"otp\\":[123456]}","code":0}';
    expect(redactString(one)).toBe(
      `{"stdout":${JSON.stringify(`{"password":"${REDACTED}","otp":"${REDACTED}"}`)},"code":0}`,
    );
    // Double nesting: a JSON string in a JSON string in JSON.
    const body = '{"token":"t-123","n":9007199254740993}'; // a number lexeme JavaScript cannot hold exactly
    const two = JSON.stringify({ log: JSON.stringify({ body }) });
    const out = redactString(two);
    expect(out).not.toContain("t-123");
    expect(JSON.parse(JSON.parse(out).log).body).toBe(`{"token":"${REDACTED}","n":9007199254740993}`);
    // Free text holding an escaped JSON string, and array elements.
    expect(redactString('stdout: "{\\"password\\":\\"hunter2\\"}" (exit 0)')).toBe(
      `stdout: ${JSON.stringify(`{"password":"${REDACTED}"}`)} (exit 0)`,
    );
    expect(redactString('["plain", "{\\"otp\\":1}"]')).toBe(
      `["plain", ${JSON.stringify(`{"otp":"${REDACTED}"}`)}]`,
    );
    // Nothing to hide: the literal stays exactly as written (escapes and all).
    const kept = '{"stdout":"{\\"user\\":\\"kim\\",\\"path\\":\\"a\\/b\\"}"}';
    expect(redactString(kept)).toBe(kept);
    // Unchanged quoted braces in prose do not hide JSON that follows.
    expect(redactString('see "{x}" then {"otp":5}')).toBe(`see "{x}" then {"otp":"${REDACTED}"}`);
  });

  it("looks inside a cut-off string too (no closing quote) and rewrites only what is there", () => {
    expect(redactString('{"stdout":"{\\"password\\":\\"hunter2\\",\\"otp\\":[123456]}')).toBe(
      `{"stdout":${JSON.stringify(`{"password":"${REDACTED}","otp":"${REDACTED}"}`).slice(0, -1)}`,
    );
    // In free text, cut off by the end of the input or by a raw line break.
    expect(redactString('stdout: "{\\"token\\":\\"t-1234567\\"}')).not.toContain("t-1234567");
    expect(redactString('stdout: "{\\"token\\":\\"t-1234567\\"}\nnext line {"otp":1}')).toBe(
      `stdout: ${JSON.stringify(`{"token":"${REDACTED}"}`).slice(0, -1)}\nnext line {"otp":"${REDACTED}"}`,
    );
    // Nothing secret inside: left exactly as written.
    const kept = '{"stdout":"{\\"user\\":\\"kim\\"';
    expect(redactString(kept)).toBe(kept);
  });

  it("a JSON-stringified value in free text is opened whole, even when it starts with [ or { (review #78)", () => {
    const one = JSON.stringify('[{"password":"hunter2","otp":[123456]}]');
    expect(redactString(`stdout: ${one}`)).toBe(
      `stdout: ${JSON.stringify(`[{"password":"${REDACTED}","otp":"${REDACTED}"}]`)}`,
    );
    const two = JSON.stringify('{"password":"hunter2","otp":[123456]}');
    expect(redactString(`stdout: ${two}`)).toBe(
      `stdout: ${JSON.stringify(`{"password":"${REDACTED}","otp":"${REDACTED}"}`)}`,
    );
    // Several lines, each a stringified value, and plain JSON in between.
    const lines = [`a ${one}`, `b ${two}`, 'c {"pin":42}', `d ${JSON.stringify('{"user":"kim"}')}`].join(
      "\n",
    );
    const out = redactString(lines);
    expect(out).not.toMatch(/hunter2|123456|"pin":42/);
    expect(out.split("\n")[3]).toBe(`d ${JSON.stringify('{"user":"kim"}')}`); // nothing secret: untouched
    // Without escapes it is not a stringified value: the JSON structure after the quote wins.
    expect(redactString('x="{"password":"y"}"')).toBe(`x="{"password":"${REDACTED}"}"`);
    expect(redactString('x="[{"otp":1}]" y')).toBe(`x="[{"otp":"${REDACTED}"}]" y`);
  });

  // Every leak a review of PR #78 found (rounds 2–8), in one table: secrets go, the rest stays.
  const SECRET = '{"password":"hunter2","otp":[123456]}';
  const wrap9 = (json: string) => "stdout: " + JSON.stringify(" " + json);
  const wrap13 = (s: string) => JSON.stringify(" " + s);
  const BS = String.fromCharCode(92);
  /** `{"api:key":"hunter2"}` with every quote written as a backslash, `u005c` × n, `u0022` (n + 1 decodes). */
  const chain = (n: number) => {
    const q = BS + "u005c".repeat(n) + "u0022";
    return `{${q}api:key${q}:${q}hunter2${q}}`;
  };
  const deep = (levels: number) => {
    let x = JSON.stringify({ "api:key": "hunter2" });
    for (let k = 0; k < levels; k++) x = JSON.stringify(" " + x);
    return x;
  };
  const REGRESSIONS: [round: string, input: string, kept: string[]][] = [
    ["2: JSON in a string", '{"password":"hunter2","otp":123456}', []],
    [
      "3: JSON in log text, newline after the colon",
      'stdout: {"password":\n "hunter2","otp":[123456]}',
      ["stdout: "],
    ],
    [
      "3: big integer next to a secret",
      '{"accountId":9007199254740993,"password":"hunter2"}',
      ["9007199254740993"],
    ],
    ["4: escaped keys", '{"pass\\u0077ord":"hunter2","\\u006ftp":[123456]}', ["pass\\u0077ord", "\\u006ftp"]],
    [
      "4: JSON in a JSON string",
      '{"stdout":"{\\"password\\":\\"hunter2\\",\\"otp\\":[123456]}"}',
      ['{"stdout":'],
    ],
    [
      "5: cut-off JSON string",
      '{"stdout":"{\\"password\\":\\"hunter2\\",\\"otp\\":[123456]}',
      ['{"stdout":'],
    ],
    [
      "6: stringified array",
      "stdout: " + JSON.stringify('[{"password":"hunter2","otp":[123456]}]'),
      ["stdout: "],
    ],
    [
      "6: stringified object",
      "stdout: " + JSON.stringify('{"password":"hunter2","otp":[123456]}'),
      ["stdout: "],
    ],
    [
      "7: broken quoted prefix, then real JSON",
      'stdout: "[\\"ok\\"] suffix {"password":"hunter2","otp":[123456]}',
      ['stdout: "[\\"ok\\"] suffix '],
    ],
    [
      "7: several broken prefixes",
      '"{\\"a "[\\"b " {"otp":123456} "{\\"x\\":1} {"password":"hunter2"}',
      ['"{\\"a "[\\"b "'],
    ],
    [
      "6+7: stringified and plain on one line",
      `a ${JSON.stringify('{"otp":123456}')} b {"password":"hunter2"}`,
      ["a ", " b "],
    ],
    ["unescaped quotes around JSON", 'x="{"password":"hunter2","otp":123456}"', ['x="{"password":']],
    [
      "8: broken string before JSON",
      'stdout: {"note":"broken ' + SECRET,
      ['stdout: {"note":"broken {"password":'],
    ],
    ["8: stray { before a stringified value", "stdout: {" + JSON.stringify(SECRET), ["stdout: {"]],
    [
      "8: broken prefix before a stringified value",
      'stdout: "[\\"ok\\"] suffix ' + JSON.stringify(SECRET),
      ["stdout: "],
    ],
    ["8: stringified with a leading space", "stdout: " + JSON.stringify(" " + SECRET), ["stdout: "]],
    ["8: stringified with a leading newline", "stdout: " + JSON.stringify("\n" + SECRET), ["stdout: "]],
    [
      "9: escaped whitespace before the values",
      wrap9('{"password":\n"hunter2","otp":\t"123456"}'),
      ["stdout: "],
    ],
    [
      "9: comma and ] inside the values",
      wrap9('{"password":"prefix,hunter2","otp":["]",123456]}'),
      ["stdout: "],
    ],
    ["9: escaped quote inside the value", wrap9('{"password":"a\\"b,hunter2","otp":[123456]}'), ["stdout: "]],
    ["9: quotes written as \\u0022", wrap9(SECRET).replaceAll('\\"', "\\u0022"), ["stdout: "]],
    ["9: long separator run", wrap9('{"password"' + " ".repeat(33) + ':"hunter2"}'), ["stdout: "]],
    ["9: value over 4 KB", wrap9(JSON.stringify({ password: "x".repeat(4096) + "hunter2" })), ["stdout: "]],
    [
      "9: values that start with the placeholder",
      wrap9('{"password":"[숨김]hunter2","otp":"[숨김]123456"}'),
      ["stdout: "],
    ],
    [
      "9: separator run over 4 KB",
      wrap9('{"password"' + " ".repeat(5000) + ':"hunter2","otp":[123456]}'),
      ["stdout: "],
    ],
    [
      "10: placeholder, then a comma",
      wrap9('{"password":"[숨김],hunter2","otp":"[숨김],123456"}'),
      ["stdout: "],
    ],
    [
      "10: placeholder, then an escaped quote",
      wrap9(JSON.stringify({ password: '[숨김]"hunter2' })),
      ["stdout: "],
    ],
    [
      "10: placeholder, then } and ]",
      wrap9('{"password":"[숨김]}hunter2","otp":"[숨김]]123456"}'),
      ["stdout: "],
    ],
    ["10: ] inside a string, value on the next line", "stdout: {'otp': [']',\n123456]}", ["stdout: {'otp':"]],
    [
      "10: } inside a string, value on the next line",
      'stdout: {"note":"broken {"password":{"hint":"}",\n"value":"hunter2"}}',
      ["stdout: "],
    ],
    [
      "10: colon written as \\u003a",
      "stdout: " + JSON.stringify(" " + SECRET).replaceAll(":", "\\u003a"),
      ["stdout: "],
    ],
    ["12: colon inside a quoted key", wrap9(JSON.stringify({ "api:key": "hunter2" })), ["stdout: "]],
    ["12: colon inside a quoted key (to:ken)", wrap9(JSON.stringify({ "to:ken": "hunter2" })), ["stdout: "]],
    ["12: equals sign inside a quoted key", wrap9(JSON.stringify({ "api=key": "hunter2" })), ["stdout: "]],
    ["12: \\b inside a key", wrap9(JSON.stringify({ "api\bkey": "hunter2" })), ["stdout: "]],
    ["12: \\f inside a key", wrap9(JSON.stringify({ "api\fkey": "hunter2" })), ["stdout: "]],
    ["12: a real backslash and n in a key", wrap9(JSON.stringify({ "toke\\n": "hunter2" })), ["stdout: "]],
    ["12: \\u000a inside a key", wrap9('{"api\\u000akey":"hunter2"}'), ["stdout: "]],
    ["12: \\u000d inside a key", wrap9('{"api\\u000dkey":"hunter2"}'), ["stdout: "]],
    [
      "13: an escaped backslash written as \\u005c",
      wrap13(wrap13(JSON.stringify({ "api:key": "hunter2" }))).replace(BS + BS, BS + "u005c"),
      [],
    ],
    [
      "13: raw line break inside a secret value",
      '{"password":"prefix' + String.fromCharCode(10) + 'hunter2"}',
      [],
    ],
    [
      "13: raw carriage return inside a secret value",
      '{"password":"prefix' + String.fromCharCode(13) + 'hunter2"}',
      [],
    ],
    ["13: NUL inside a secret value", '{"password":"prefix' + String.fromCharCode(0) + 'hunter2"}', []],
    [
      "13: other control characters inside a secret value",
      '{"otp":"1' + String.fromCharCode(1, 31, 8) + '123456","user":"kim"}',
      [],
    ],
    [
      "14: hex digits of an inner unicode escape escaped one layer out",
      wrap13(wrap13(JSON.stringify({ "api:key": "hunter2" })).replace(BS + '"', BS + "u0022")).replace(
        "u0022",
        "u0" + BS + "u003022",
      ),
      [],
    ],
    ["14: broken scalar 123hunter2", '{"password":123hunter2,"user":"kim"}', ['{"password":']],
    ["14: broken scalar truehunter2", '{"password":truehunter2,"user":"kim"}', ['{"password":']],
    ["14: broken scalar nullhunter2", '{"password":nullhunter2,"user":"kim"}', ['{"password":']],
    ["14: broken scalar 1e+hunter2", '{"password":1e+hunter2,"user":"kim"}', ['{"password":']],
    ["14: broken scalar -hunter2", '{"password":-hunter2,"user":"kim"}', ['{"password":']],
    ["14: broken scalar [1,123hunter2]", '{"password":[1,123hunter2],"user":"kim"}', ['{"password":']],
    ["14: broken scalar [truehunter2]", '{"password":[truehunter2],"user":"kim"}', ['{"password":']],
    ["14: broken scalar [nullhunter2,1]", '{"password":[nullhunter2,1],"user":"kim"}', ['{"password":']],
    [
      "15: the tag written as an escape is not a tag",
      '"' +
        [
          BS + "u007b",
          BS + "u0022api:key",
          BS + "u0022:",
          BS + "u0022",
          BS + "ufdd0hunter2",
          BS + "u0022}",
        ].join("") +
        '"',
      [],
    ],
    [
      "15: the tag escaped two layers deep",
      wrap13(wrap13('{"password":"' + BS + "ufdd0hunter2" + '" broken')),
      [],
    ],
    ["15: single-quoted key", "{'api:key':'hunter2'}", []],
    ["15: single-quoted key with spaces", "{'api:key': 'hunter2'}", []],
    ["15: single-quoted key, stringified", wrap13("{'api:key':'hunter2'}"), []],
    ["15: mixed quote styles", wrap13(`{"a":1, 'pin': "hunter2"`), []],
    ["15: five times stringified", deep(5), []],
    ["15: six times stringified", deep(6), []],
    ["15: ten times stringified", deep(10), []],
    [
      "16: Python string wrapping a dict",
      "'{" + BS + "'api:key" + BS + "': " + BS + "'hunter2" + BS + '\', "x": "y"}\'',
      [],
    ],
    ["16: Python string, api.key", "'{" + BS + "'api.key" + BS + "': " + BS + "'hunter2" + BS + "'}'", []],
    ["16: Python string, api key", "'{" + BS + "'api key" + BS + "': " + BS + "'hunter2" + BS + "'}'", []],
    [
      "16: escaped single quotes two layers deep",
      JSON.stringify("'{" + BS + "'pin" + BS + "': " + BS + "'hunter2" + BS + "'}'"),
      [],
    ],
    ["16: a quote behind nine escaped backslashes", chain(9), []],
    ["16: the same, stringified", JSON.stringify(chain(9)), []],
    ["16: a quote behind twelve escaped backslashes", chain(12), []],
    ["17: Python repr key with \\x00", "{'api" + BS + "x00key': 'hunter2'}", []],
    ["17: Python repr key with \\x0b", "{'api" + BS + "x0bkey': 'hunter2'}", []],
    ["17: Python repr key pass\\x77ord", "{'pass" + BS + "x77ord': 'hunter2'}", []],
    ["17: the same, JSON-stringified", JSON.stringify("{'api" + BS + "x00key': 'hunter2'}"), []],
    [
      "17: octal and \\U in keys",
      "{'api" + BS + "000key': 'x', 'pass" + BS + "U00000077ord': 'hunter2'}",
      [],
    ],
    ["17: octal key", "{'t" + BS + "157ken': 'hunter2'}", []],
    ["17: \\N{...} in a key", "{'pass" + BS + "N{LATIN SMALL LETTER W}ord': 'hunter2'}", []],
    ["17: \\a and \\v in keys", "{'api" + BS + "akey': 'x', 'api" + BS + "vkey': 'hunter2'}", []],
    ["18: \\N{KELVIN SIGN} in a key", "{'api" + BS + "N{KELVIN SIGN}ey': 'hunter2'}", []],
    ["18: the same, stringified", JSON.stringify("{'api" + BS + "N{KELVIN SIGN}ey': 'hunter2'}"), []],
    [
      "18: \\N{LATIN CAPITAL LETTER I WITH DOT ABOVE} in a key",
      "{'p" + BS + "N{LATIN CAPITAL LETTER I WITH DOT ABOVE}n': 'hunter2'}",
      [],
    ],
    [
      "18: the same, stringified twice",
      JSON.stringify(JSON.stringify("{'p" + BS + "N{LATIN CAPITAL LETTER I WITH DOT ABOVE}n': 'hunter2'}")),
      [],
    ],
    ...[
      "BOX DRAWINGS LIGHT DIAGONAL UPPER CENTRE TO MIDDLE RIGHT AND MIDDLE LEFT TO LOWER CENTRE",
      "X".repeat(80),
      "X".repeat(82),
      "X".repeat(83),
    ].flatMap((name): [string, string, string[]][] => {
      const raw = "{'api" + BS + "N{" + name + "}ey': 'hunter2'}";
      return [
        [`19: a ${name.length}-character name`, raw, []],
        [`19: a ${name.length}-character name, stringified`, JSON.stringify(raw), []],
      ];
    }),
    ["19: an unclosed N-escape at the end", "{'api" + BS + "N{KELVIN", []],
    ["19: an unclosed N-escape before the value", "{'api" + BS + "N{KELVIN" + "' : 'hunter2'}", []],
    ...(
      [
        ["u{77} in a key", "{'pass" + BS + "u{77}ord': 'hunter2'}"],
        ["u{212A} in a key", "{'api" + BS + "u{212A}ey': 'hunter2'}"],
        ["u{1FBA9} in a key", "{'api" + BS + "u{1FBA9}key': 'hunter2'}"],
        ["Ruby e", '{"api' + BS + 'ekey" => "hunter2"}'],
        ["Ruby s", '{"api' + BS + 'skey" => "hunter2"}'],
        ["Ruby cA", '{"api' + BS + 'cAkey" => "hunter2"}'],
        ["Ruby C-a", '{"api' + BS + 'C-akey" => "hunter2"}'],
        ["Ruby x0", '{"api' + BS + 'x0key" => "hunter2"}'],
        ["Ruby u{61 73 73}", '{"p' + BS + 'u{61 73 73}word" => "hunter2"}'],
        ["bare x77", "pass" + BS + "x77ord='hunter2'"],
        ["bare, JSON string", '"pass' + BS + "u005cu0077ord='hunter2'" + '"'],
        ["bare 167", "pass" + BS + "167ord='hunter2'"],
        ["bare U", "pass" + BS + "U00000077ord='hunter2'"],
        ["bare N{}", "pass" + BS + "N{LATIN SMALL LETTER W}ord='hunter2'"],
        ["bare x3d separator", "password" + BS + "x3d'hunter2'"],
        ["form feed before the colon", "{'pass" + BS + "x77ord'" + String.fromCharCode(12) + ": 'hunter2'}"],
        ["line continuation LF", "{'pass" + BS + "x77ord'" + BS + String.fromCharCode(10) + ": 'hunter2'}"],
        [
          "line continuation CRLF",
          "{'pass" + BS + "x77ord'" + BS + String.fromCharCode(13, 10) + ": 'hunter2'}",
        ],
        ...[0x0b, 0xa0, 0xfeff, 0x2003, 0x2028, 0x2029, 0x3000].map((c): [string, string] => [
          `U+${c.toString(16)} before the colon`,
          "{'password'" + String.fromCharCode(c) + ": 'hunter2'}",
        ]),
      ] as [string, string][]
    ).flatMap(([name, raw]): [string, string, string[]][] => [
      [`20: ${name}`, raw, []],
      [`20: ${name}, stringified`, JSON.stringify(raw), []],
      [`20: ${name}, stringified twice`, JSON.stringify(JSON.stringify(raw)), []],
    ]),
    ...(
      [
        ["Ruby octal above 377", '{"' + BS + '560assword" => "hunter2"}'],
        ["JavaScript a-escape", "({'p" + BS + "assword': 'hunter2'})"],
        ["octal 0 and a digit", "{'pass" + BS + "0167ord': 'hunter2'}"],
        ["f-escape in a key", "{'pass" + BS + "fword': 'hunter2'}"],
        ["KELVIN SIGN in a bare key", "({api" + String.fromCharCode(0x212a) + "ey: 'hunter2'})"],
        ["Hangul in a bare key", "({pass한word: 'hunter2'})"],
        ["u212A in a bare key", "({api" + BS + "u212Aey: 'hunter2'})"],
        ["u{212A} in a bare key", "({api" + BS + "u{212A}ey: 'hunter2'})"],
        ["block comment before the colon", '({"password" /* field */: "hunter2"})'],
        [
          "line comment before the colon",
          '({"password" // field' + String.fromCharCode(10) + ': "hunter2"})',
        ],
        ["hash comment before the colon", "{'password' # field" + String.fromCharCode(10) + ": 'hunter2'}"],
        ["computed key", '({["password"]: "hunter2"})'],
        ["computed template key", '({[`password`]: "hunter2"})'],
        ["template key with a substitution", '({[`pass${"w"}ord`]: "hunter2"})'],
        ["template key computed from a variable", "({[`pass${w}`]: 'hunter2'})"],
      ] as [string, string][]
    ).flatMap(([name, raw]): [string, string, string[]][] => [
      [`21: ${name}`, raw, []],
      [`21: ${name}, stringified`, JSON.stringify(raw), []],
      [`21: ${name}, stringified twice`, JSON.stringify(JSON.stringify(raw)), []],
    ]),
    ...(
      [
        ["Java uuuu after a semicolon", "a=1;p" + BS + 'uuuu0061ssword="hunter2";'],
        ["Java uuuu declaration", "String p" + BS + 'uuuu0061ssword="hunter2";'],
        ["Bash ANSI-C quoted assignment", "export $'" + BS + "560assword=hunter2'"],
        ["C++ long hex escape", 'm["pass' + BS + 'x002dword"] = "hunter2";'],
        ["block comment longer than the window", "({'password' /* " + "x".repeat(513) + " */: 'hunter2'})"],
        [
          "line comment longer than the window",
          "({'password' //" + "x".repeat(600) + String.fromCharCode(10) + ": 'hunter2'})",
        ],
        ["line comment ended by U+2028", "({'password'//x" + String.fromCharCode(0x2028) + ": 'hunter2'})"],
        ["computed key in parentheses", "({[('password')]: 'hunter2'})"],
        ["computed key concatenated", '({["pass" + "word"]: \'hunter2\'})'],
        ["computed key with nested template", "({[`pass${`w`}ord`]: 'hunter2'})"],
        ["bare key with an escaped dot", "pass" + BS + "u002eword=hunter2"],
        ["bare key with an escaped line break", "pass" + BS + "nword=hunter2"],
        ["bare key with a line continuation", "export pass" + BS + String.fromCharCode(10) + "word=hunter2"],
        ["INI key with a dot", "pass.word=hunter2"],
      ] as [string, string][]
    ).flatMap(([name, raw]): [string, string, string[]][] => [
      [`22: ${name}`, raw, []],
      [`22: ${name}, stringified`, JSON.stringify(raw), []],
      [`22: ${name}, stringified twice`, JSON.stringify(JSON.stringify(raw)), []],
    ]),
    // Round 23 (best effort, P3): the cheap data-format ones.
    ...(
      [
        ["properties whitespace separator", "password hunter2"],
        [
          "properties whitespace separator, later line",
          "user kim" + String.fromCharCode(10) + "password hunter2",
        ],
        ["URL query name percent-encoded", "https://x.test/login?%70assword=hunter2"],
        ["YAML doubled single quote", "'pass''word': hunter2"],
        ["shell single-quoted part", "export pass'word'='hunter2'"],
        ["shell empty double quotes", 'export pass""word=hunter2'],
        ["HTTP field name with !", "pass!word: hunter2"],
        ["INI key with /", "pass/word=hunter2"],
        ["properties escaped space", "pass" + BS + " word=hunter2"],
        ["comment before a computed key", '({/*field*/["pass" + "word"]: \'hunter2\'})'],
      ] as [string, string][]
    ).flatMap(([name, raw]): [string, string, string[]][] => [
      [`23: ${name}`, raw, []],
      [`23: ${name}, stringified`, JSON.stringify(raw), []],
      [`23: ${name}, stringified twice`, JSON.stringify(JSON.stringify(raw)), []],
    ]),
  ];
  it.each(REGRESSIONS)("review round %s", (_round, input, kept) => {
    const out = redactString(input);
    expect(out).not.toMatch(/hunter2|123456/);
    for (const k of kept) expect(out).toContain(k);
  });

  // Round 23 (P2): no key structure, so nothing is hidden — raw, stringified once and twice.
  it.each(
    [
      ["plain string before a long comment", 'console.log("hello" /* ' + "x".repeat(513) + ' */, "done");'],
      ...["password", "token", "passphrase"].map((w) => [
        `secret name before a long comment (${w})`,
        `console.log("${w}" /* ${"x".repeat(600)} */, "done");`,
      ]),
      [
        "secret name before a long line comment",
        'f("password" //' + "x".repeat(600) + String.fromCharCode(10) + ', "done");',
      ],
      ["regex character class after a comma", 'const r = /a,[b]:c/; const next = "save";'],
      ["Markdown link definition", "[guide]: https://example.com"],
      [
        "Python with an unknown \\N{} name (round 28)",
        'print("' + BS + 'N{SNOWMAN}")' + String.fromCharCode(10) + 'print("ordinary done")',
      ],
      [
        "Markdown link definition in a reply",
        "자세한 내용은 [guide]를 보세요." + String.fromCharCode(10) + "[guide]: https://example.com/docs",
      ],
      ["prose with password and a word", "password reset" + String.fromCharCode(10) + "다음 줄"],
    ].flatMap(([name, raw]) => [
      [name!, raw!],
      [`${name}, stringified`, JSON.stringify(raw)],
      [`${name}, stringified twice`, JSON.stringify(JSON.stringify(raw))],
    ]),
  )("review round 23 keeps: %s", (_name, input) => {
    expect(redactString(input)).toBe(input);
  });

  it("pass A's placeholder survives pass B decoding and re-encoding a literal that overlaps it", () => {
    for (const x of [REDACTED, `{"a":"${REDACTED}"}`, `\\ "${REDACTED}" \n`])
      expect(decodeJsonString(JSON.stringify(x).slice(1, -1))).toBe(x);
    expect(redactString('"{\\"pin\\":1} x {"otp":2}')).toBe(
      `"{\\"pin\\":\\"${REDACTED}\\"} x {"otp":"${REDACTED}"}`,
    );
  });

  it("fail-closed: secret JSON wrapped in 3,000 random broken prefixes, suffixes and stringify levels never leaks", () => {
    // mulberry32: a small seeded generator, so a failure can be replayed.
    let seed = 78;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const payloads = [
      SECRET,
      '{"password": "hunter2", "otp": [123456]}',
      '{\n  "password": "hunter2",\n  "otp": [\n    123456\n  ]\n}',
      '[{"password":"hunter2"},{"otp":123456}]',
      '{"a":{"password":"hunter2","otp":123456}}',
      '{"pass\\u0077ord":"hunter2","\\u006ftp":[123456]}',
      "{'password': 'hunter2', 'otp': 123456}",
      'password="hunter2" otp="123456"',
      // round 9: escaped whitespace, commas and brackets inside values, \u0022 quotes, long runs, big values,
      // values that start with the placeholder
      '{"password":\n"hunter2","otp":\t"123456"}',
      '{"password":"prefix,hunter2","otp":["]",123456]}',
      '{"password":"a\\"b,hunter2","otp":[",]}",123456]}',
      "{\u0022password\u0022:\u0022hunter2\u0022,\u0022otp\u0022:[123456]}",
      '{"password"' + " ".repeat(40) + ':"hunter2","otp"\t\n :[123456]}',
      '{"password":"' + "x".repeat(4200) + 'hunter2","otp":[' + "0,".repeat(2100) + "123456]}",
      '{"password":"[숨김]hunter2","otp":"[숨김]123456"}',
      '{"password":"[숨김]","otp":"[숨김] 123456"}',
      // round 10: placeholder then punctuation, brackets inside strings across lines, escaped separators,
      // backslash runs inside values
      '{"password":"[숨김],hunter2","otp":"[숨김]]123456"}',
      '{"password":"[숨김]}hunter2","otp":["[숨김]",123456]}',
      "{'otp': [']',\n123456], 'password': '}\nhunter2'}",
      '{"password":{"hint":"}",\n"value":"hunter2"},"otp":[\n"]",123456]}',
      '{"password"\\u003a"hunter2","otp"\\u003d[123456]}',
      '{"password":"\\\\\\\\hunter2","otp":["\\\\",123456]}',
      // round 17: Python repr() keys with \\x, octal and \\U escapes
      "{'pass" +
        String.fromCharCode(92) +
        "x77ord': 'hunter2', 'o" +
        String.fromCharCode(92) +
        "164p': [123456]}",
      "{'pass" +
        String.fromCharCode(92) +
        "U00000077ord': 'hunter2', 'api" +
        String.fromCharCode(92) +
        "x00key': 123456}",
      // round 16: Python strings wrapping dicts (\'), quotes behind chains of escaped backslashes
      "'{" +
        String.fromCharCode(92) +
        "'password" +
        String.fromCharCode(92) +
        "': " +
        String.fromCharCode(92) +
        "'hunter2" +
        String.fromCharCode(92) +
        "', 'otp': [123456]}'",
      "{" +
        [String.fromCharCode(92) + "u005c".repeat(9) + "u0022"].map(
          (q) => `${q}password${q}:${q}hunter2${q},${q}otp${q}:[123456]`,
        )[0] +
        "}",
      // round 15: Python-style dicts, the tag spelled as an escape
      "{'api:key': 'hunter2', 'otp': [123456]}",
      '{"password":"' +
        String.fromCharCode(92) +
        'ufdd0hunter2","otp":"' +
        String.fromCharCode(92) +
        'ufdd0123456"}',
      // round 13: raw control characters inside secret values
      '{"password":"a' + String.fromCharCode(10) + 'hunter2","otp":"' + String.fromCharCode(13) + '123456"}',
      '{"password":"' + String.fromCharCode(0) + 'hunter2","otp":[1' + String.fromCharCode(1) + ",123456]}",
    ];
    const junk = [
      "",
      "stdout: ",
      "{",
      "[",
      '"',
      "\\",
      " ",
      "\n",
      '{"note":"broken ',
      '"[\\"ok\\"] suffix ',
      '{"a":',
      "x=",
      "'",
      '\\"',
      "}",
      "]",
      ",",
      ":",
      "\\\\",
      '"{',
      "\t",
    ];
    const leaks: string[] = [];
    for (let k = 0; k < 3000; k++) {
      let x = pick(junk) + pick(junk) + pick(payloads) + pick(junk) + pick(junk);
      const levels = Math.floor(rnd() * 4);
      for (let l = 0; l < levels; l++) x = pick(junk) + JSON.stringify(x) + pick(junk);
      // Now and then much deeper than the decoder looks (fail-closed beyond it).
      if (rnd() < 0.05) for (let l = 0; l < 9; l++) x = JSON.stringify(x);
      if (/hunter2|123456/.test(redactString(x))) leaks.push(x);
    }
    expect(leaks.slice(0, 5)).toEqual([]);
  });

  it("pass C never changes what A and B handled precisely (well-formed JSON)", () => {
    const wellFormed = [
      '{"password":"hunter2","otp":123456,"user":"kim"}',
      '{"pass\\u0077ord":"hunter2","\\u006ftp":[123456],"user":"kim"}',
      '{"stdout":"{\\"password\\":\\"hunter2\\",\\"otp\\":[123456]}","code":0}',
      JSON.stringify({ log: JSON.stringify({ body: '{"token":"t-123","n":9007199254740993}' }) }),
      "stdout: " + JSON.stringify('[{"password":"hunter2","otp":[123456]}]'),
      'request failed: {"password":"hunter2","otp":123456} (400)',
      '{\n  "accountId" : 12345678901234567890 ,\n  "otp" : 123456 ,\n  "list" : [ 1.0 , -0 ]\n}\n',
      '{"password":"[숨김]","note":"set password: later"}',
    ];
    for (const doc of wellFormed) {
      const withC = redactString(doc);
      expect(withC).toBe(redactForDisplay(doc));
      expect(withC).not.toMatch(/hunter2|t-123/);
    }
  });

  it("a literal [숨김] typed into data does not count as already hidden", () => {
    const out = redactString('log: {"password": "[숨김]", broken "otp": "[숨김]x123456');
    expect(out).not.toContain("123456");
  });

  it("every listed secret name is caught by the sweep, also with quotes written as \\u0022 (review #78 round 11)", () => {
    const leaks: string[] = [];
    for (const name of SECRET_NAMES) {
      const json = JSON.stringify({ [name]: "hunter2", user: "kim" });
      for (const x of [
        wrap9(json).replaceAll('\\"', "\\u0022"),
        wrap9(json),
        "x " + json.replaceAll('"', "\\u0022"),
        wrap9(JSON.stringify({ a: 1, [name]: "hunter2" })).replaceAll('\\"', "\\\\\\u0022"),
      ])
        if (redactString(x).includes("hunter2")) leaks.push(`${name}: ${x}`);
    }
    expect(leaks).toEqual([]);
  });

  it("the sweep judges keys like isSecretKey does: punctuation, spaces, long names (property)", () => {
    const corpus = [
      ...SECRET_NAMES,
      ...SECRET_SUFFIXES.flatMap((x) => [`my${x}`, `my_${x}`, `My-${x.toUpperCase()}`]),
      "pass.word",
      "pass word",
      "pass/word",
      "api.key",
      "API-Key",
      "Password",
      "x".repeat(57) + "Password",
      "x".repeat(5000) + "_token",
      "client.secret",
      "db password",
      "auth",
      "X-Api-Key",
    ];
    const leaks: string[] = [];
    for (const k of corpus) {
      expect(isSecretKey(k), k.slice(0, 40)).toBe(true);
      const json = JSON.stringify({ [k]: "hunter2" });
      for (const x of [
        wrap9(json),
        wrap9(json).replaceAll('\\"', "\\u0022"),
        json,
        `log ${JSON.stringify(json)}`,
      ])
        if (redactString(x).includes("hunter2")) leaks.push(`${k.slice(0, 40)}: ${x.slice(0, 80)}`);
    }
    expect(leaks).toEqual([]);
  });

  it("a secret word inside a JSON string value is prose, not a key: the value stays byte for byte", () => {
    for (const message of [
      "password: 다음에 실제 값을 넣으세요.",
      "password=process.env.PASSWORD",
      "api_key=YOUR_API_KEY",
      "token: ${GITHUB_TOKEN} 를 쓰세요",
      "비밀번호(password): 8자 이상",
      "password:\n- 8자 이상\n- 숫자 포함",
      '참고, "password: 다음에 실제 값을 넣으세요."',
    ]) {
      const doc = JSON.stringify({ message, count: 1 });
      expect(redactString(doc)).toBe(doc);
      expect(redactString(wrap9(doc))).toBe(wrap9(doc));
      expect(redactString(`stdout: ${JSON.stringify(doc)}`)).toBe(`stdout: ${JSON.stringify(doc)}`);
    }
  });

  it("quoted strings in arrays are values, not keys: the text stays byte for byte (review #78 round 12)", () => {
    for (const doc of [
      JSON.stringify({ message: ["password: 다음에 실제 값을 넣으세요."], count: 1 }),
      JSON.stringify(["token: 매일 바뀌어요", "otp=문자로 와요"]),
      JSON.stringify({ steps: ["password: 8자 이상", "pin: 숫자 4개"], ok: true }),
    ]) {
      expect(redactString(doc)).toBe(doc);
      expect(redactString(wrap9(doc))).toBe(wrap9(doc));
    }
  });

  it("structured keys follow JSON grammar: any key isSecretKey accepts never leaks, 1–3 times stringified (property)", () => {
    const corpus = [
      "api:key",
      "to:ken",
      "api=key",
      "a:p:i:k:e:y",
      "api\bkey",
      "api\fkey",
      "api\nkey",
      "api\rkey",
      "api\tkey",
      "pass\u0000word",
      "toke\\n",
      "pass\\word",
      "pass\\nword",
      'pass"word',
      'pass\\"word',
      "pass/word",
      "api key",
      "\ud83d\ude00password",
      "x".repeat(300) + ":token",
      "password\n\n",
      ...SECRET_NAMES,
    ];
    const leaks: string[] = [];
    for (const k of corpus) {
      if (!isSecretKey(k)) continue;
      const json = JSON.stringify({ [k]: "hunter2", user: "kim" });
      let x = wrap9(json);
      for (let level = 1; level <= 3; level++) {
        if (redactString(x).includes("hunter2")) leaks.push(`${JSON.stringify(k).slice(0, 40)} ×${level}`);
        x = JSON.stringify(x);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("escapes may be written in their \\u forms at any layer (\\u005c, \\u0022): never a leak (property, seeded)", () => {
    let seed = 13;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /** Rewrites some escapes inside JSON strings into their \u forms — the same JSON value, written differently. */
    const reescape = (json: string) => {
      let out = "";
      let inString = false;
      for (let i = 0; i < json.length; i++) {
        const c = json[i]!;
        if (!inString) {
          if (c === '"') inString = true;
          out += c;
          continue;
        }
        if (c === BS) {
          const e = json[i + 1]!;
          i++;
          if (e === BS && rnd() < 0.5) out += BS + "u005c";
          else if (e === '"' && rnd() < 0.5) out += BS + "u0022";
          else out += c + e;
          continue;
        }
        if (c === '"') inString = false;
        // Any other character of a string may be written as a unicode escape too — including the hex digits and
        // the "u" of an inner escape, which are plain characters at this layer (round 14).
        else if (rnd() < 0.15) {
          out += BS + "u" + c.charCodeAt(0).toString(16).padStart(4, "0");
          continue;
        }
        out += c;
      }
      return out;
    };
    const keys = [
      "api:key",
      "password",
      "pin",
      "pass.word",
      "to:ken",
      "api" + String.fromCharCode(8) + "key",
      'pass"word',
      "toke" + BS + "n",
    ];
    const leaks: string[] = [];
    for (let round = 0; round < 640; round++) {
      const k = keys[round % keys.length]!;
      let x = JSON.stringify({ [k]: "hunter2", user: "kim" });
      const levels = 1 + Math.floor(rnd() * 3);
      for (let l = 0; l < levels; l++) x = JSON.stringify(" " + reescape(x));
      const y = reescape(x);
      expect(JSON.parse(y)).toBe(JSON.parse(x));
      if (redactString("stdout: " + y).includes("hunter2")) leaks.push(y);
    }
    expect(leaks.slice(0, 3)).toEqual([]);
  });

  it("fail-closed beyond the decoded layers fires only when something still decodes (round 16)", () => {
    // Benign backslash text: Windows paths, a regex, escaped quotes a few layers deep — nothing secret, kept.
    for (const text of [
      "C:" + BS + "Users" + BS + "kim" + BS + "Documents" + BS + "보고서.hwp",
      "C:" + BS + "x64" + BS + "tools" + BS + "2024" + BS + "v1.0", // \\\\x64 \\\\t \\\\202 decode on a layer: still kept
      "regex: " + BS + "d+" + BS + "s*" + BS + "w{3}",
      JSON.stringify(
        JSON.stringify(JSON.stringify({ path: "C:" + BS + "tmp" + BS + "x", note: "a" + BS + "b" })),
      ),
      BS.repeat(100) + " 끝", // 100 backslashes halve to a lone one within 7 layers
    ])
      expect(redactString(text)).toBe(text);
    // An escape that cannot be decoded for sure (an unknown \\N{…} name) is hidden from there only inside a key
    // (round 28; rounds 18–27 hid it anywhere): in plain text it stays.
    expect(redactString("C:" + BS + "tools" + BS + "N{none} 끝")).toBe(
      "C:" + BS + "tools" + BS + "N{none} 끝",
    );
    expect(redactString("{'pass" + BS + "N{none}word': 'hunter2'}")).not.toContain("hunter2");
    // 5,000 backslashes are wrapping 12 layers deep: beyond the decoded layers, so hidden (fail-closed).
    expect(redactString(BS.repeat(5000) + " 끝")).toBe(REDACTED);
    // Twelve layers of a quote: hidden from the first backslash that still decodes after eight.
    const out = redactString("log: " + chain(12) + " tail");
    expect(out.startsWith("log: {")).toBe(true);
    expect(out).not.toContain("hunter2");
  });

  it("Python repr keys with characters written as \\xHH, octal or \\U never leak (property, seeded)", () => {
    let seed = 17;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const spell = (c: string) => {
      const code = c.charCodeAt(0);
      const r = rnd();
      if (r < 0.3) return c;
      if (r < 0.55) return BS + "x" + code.toString(16).padStart(2, "0");
      if (r < 0.8) return BS + code.toString(8).padStart(3, "0");
      return BS + "U" + code.toString(16).padStart(8, "0");
    };
    const keys = [
      "password",
      "api:key",
      "api" + String.fromCharCode(0) + "key",
      "pin",
      "token",
      "pass.word",
      "otp",
    ];
    const leaks: string[] = [];
    for (let round = 0; round < 600; round++) {
      const k = keys[round % keys.length]!;
      let x = "{'" + [...k].map(spell).join("") + "': 'hunter2', 'user': 'kim'}";
      if (rnd() < 0.4) x = JSON.stringify(x);
      if (rnd() < 0.2) x = JSON.stringify(" " + x);
      if (redactString("stdout: " + x).includes("hunter2")) leaks.push(x);
    }
    expect(leaks.slice(0, 3)).toEqual([]);
  });

  it("key characters written as \\N{<any name>} never leak (property, seeded)", () => {
    let seed = 18;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // Each character is either written by its own name (decodes to the same key) or by a name we cannot decode
    // (KELVIN SIGN, …), which must fail closed. A different known name would just spell a different key.
    const unknown = [
      "KELVIN SIGN",
      "FULLWIDTH LATIN SMALL LETTER P",
      "SNOWMAN",
      "X",
      "LATIN CAPITAL LETTER I WITH DOT ABOVE",
    ];
    const own = (c: string) => `LATIN SMALL LETTER ${c.toUpperCase()}`;
    const leaks: string[] = [];
    for (let round = 0; round < 300; round++) {
      const key = [..."apikey"]
        .map((c) => {
          const r = rnd();
          if (r < 0.2) return BS + "N{" + own(c) + "}";
          if (r < 0.35) return BS + "N{" + unknown[Math.floor(rnd() * unknown.length)] + "}";
          return c;
        })
        .join("");
      let x = "{'" + key + "': 'hunter2'}";
      if (rnd() < 0.5) x = JSON.stringify(x);
      if (redactString("out: " + x).includes("hunter2")) leaks.push(x);
    }
    expect(leaks.slice(0, 3)).toEqual([]);
  });

  it("unclosed \\N{ repeated over 1 MB stays linear (round 18)", () => {
    const MB = 1 << 20;
    const make = (size: number) => (BS + "N{").repeat(Math.ceil(size / 3));
    const time = (input: string) => {
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        redactString(input);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    time(make(MB / 16));
    const small = time(make(MB / 8));
    const large = time(make(MB));
    expect(large / Math.max(small, 10), `${Math.round(small)} ms → ${Math.round(large)} ms`).toBeLessThan(20);
    expect(large).toBeLessThan(1500);
  }, 60_000);

  it("an N-escape name of exactly the window length is read; one character more is fail-closed (round 19)", () => {
    // 80 characters: the brace is inside the window — read as a name (unknown here). In a key: hidden from the
    // escape; in plain text (round 28): kept.
    const inside = "pre " + BS + "N{" + "Y".repeat(80) + "} post";
    expect(redactString(inside)).toBe(inside);
    expect(redactString("{'pre" + BS + "N{" + "Y".repeat(80) + "}': 'hunter2'}")).not.toContain("hunter2");
    // 81 characters: no brace inside the window — the same.
    const outside = "pre " + BS + "N{" + "Y".repeat(81) + "} post";
    expect(redactString(outside)).toBe(outside);
    expect(redactString("{'pre" + BS + "N{" + "Y".repeat(81) + "}': 'hunter2'}")).not.toContain("hunter2");
    // A known name is still decoded (and the text kept) when it closes inside the window.
    const known = "pre " + BS + "N{LATIN SMALL LETTER A} post";
    expect(redactString(known)).toBe(known);
  });

  it("a key with an escape the decoder does not know is unknown: its value is hidden (round 20)", () => {
    // Accepted over-redaction: a key that is not secret but holds such an escape loses its value too.
    expect(redactString('{"C:' + BS + BS + 'path": "x", "n": 1}')).toBe(
      '{"C:' + BS + BS + 'path":' + REDACTED,
    );
    // Text without key/separator structure keeps its backslashes as they are.
    for (const text of [
      "C:" + BS + "Users" + BS + "kim",
      "regex: " + BS + "d+" + BS + "s*",
      "see " + BS + "e and " + BS + "cA here",
    ])
      expect(redactString(text)).toBe(text);
  });

  it("any key spelling, gap and separator never leaks (property, seeded)", () => {
    let seed = 20;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    // A backslash and some characters, inserted anywhere in the key: an escape we may or may not know.
    const junk = () =>
      // Only escapes no decoder knows: a known one would spell a different key (`pass\u{77}word` is
      // "passwword"), and `\x0` before "a" swallows the "a" as a hex digit.
      BS + pick(["e", "s", "cA", "C-a", "q", "u{61 73}", "N{SNOWMAN}", "z", "8", "k", "m", "y"]);
    const gaps = [
      "",
      " ",
      String.fromCharCode(12),
      String.fromCharCode(11),
      String.fromCharCode(0xa0),
      String.fromCharCode(0x2028),
      BS + String.fromCharCode(10),
      String.fromCharCode(0xfeff),
    ];
    const seps = [":", "=", "=>", ":="];
    const leaks: string[] = [];
    for (let round = 0; round < 800; round++) {
      let key = "password";
      const at = Math.floor(rnd() * (key.length + 1));
      if (rnd() < 0.8) key = key.slice(0, at) + junk() + key.slice(at);
      const quote = pick(['"', "'", "`", ""]);
      const value = quote ? `${quote === "" ? "'" : quote}hunter2${quote === "" ? "'" : quote}` : "'hunter2'";
      let x = `{${quote}${key}${quote}${pick(gaps)}${pick(seps)}${pick(gaps)}${value}}`;
      const levels = Math.floor(rnd() * 3);
      for (let l = 0; l < levels; l++) x = JSON.stringify(x);
      if (redactString("out: " + x).includes("hunter2")) leaks.push(x);
    }
    expect(leaks.slice(0, 3)).toEqual([]);
  });

  it("an unknown escape outside a key position (regex, path) is text: kept verbatim (round 21)", () => {
    for (const text of [
      "정규식 /" + BS + "d{2}:" + BS + "d{2}/로 시각을 검사하세요. 다음 단계는 저장입니다.",
      "Windows 경로는 " + BS + BS + "?" + BS + "C:" + BS + "Users" + BS + "kim 입니다. 이 폴더를 여세요.",
      "grep -E '" + BS + "w+:" + BS + "d+' log.txt",
      // round 22: a group in a regex is not a key position
      "정규식 /(" + BS + "d{2}:" + BS + "d{2})/로 시각을 검사하세요. 다음 단계는 저장입니다.",
      "grep -E '(" + BS + "w{2}:" + BS + "d{2})' log.txt",
      // dots in bare keys: an ordinary file name is no secret key
      "see file.txt=report and arr[i] = 5; obj[key] = value",
    ])
      expect(redactString(text)).toBe(text);
  });

  it("2 MB of free-text assignments: no call stack overflow, every value hidden (round 21)", () => {
    const input = ("p" + BS + "u0069n=abc123 ").repeat(125_000);
    const out = redactString(input);
    expect(out).not.toContain("abc123");
    const input2 = ("pin" + String.fromCharCode(12) + "=abc123 ").repeat(125_000);
    expect(redactString(input2)).not.toContain("abc123");
  }, 60_000);

  it("ambiguous escapes, non-ASCII keys, comment gaps and computed keys never leak (property, seeded)", () => {
    let seed = 21;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    // Spell one character of the key in a way some language reads as that character: `\p` is "p" in
    // JavaScript (only for letters with no escape meaning there), `\5xx` keeps the low 8 bits in Ruby (ASCII
    // only), `\0` and a digit, `\u{…}`.
    const spell = (c: string) => {
      const code = c.charCodeAt(0);
      const forms = [c, BS + "u{" + code.toString(16) + "}"];
      if (/[a-z]/i.test(c) && !"bfnrtvuxUN".includes(c)) forms.push(BS + c);
      if (code < 128) forms.push(BS + (0o400 + code).toString(8), BS + "0" + code.toString(8));
      return pick(forms);
    };
    const keys = [
      "password",
      "pin",
      "token",
      "apiKey",
      "pass한word",
      "api" + String.fromCharCode(0x212a) + "ey",
    ];
    const gaps = ["", " ", " /* c */ ", " // c" + String.fromCharCode(10), " # c" + String.fromCharCode(10)];
    const leaks: string[] = [];
    for (let round = 0; round < 800; round++) {
      const k = pick(keys);
      const at = Math.floor(rnd() * k.length);
      const key = k.slice(0, at) + spell(k[at]!) + k.slice(at + 1);
      const form = pick(["bare", "dq", "sq", "computed", "template"]);
      const written =
        form === "bare"
          ? key
          : form === "dq"
            ? `"${key}"`
            : form === "sq"
              ? `'${key}'`
              : form === "computed"
                ? `["${key}"]`
                : `[\`${key}\`]`;
      const statement = pick(["object", "semicolon", "export", "query", "line"]);
      const kv = `${written}${pick(gaps)}${pick([":", "=>"])} 'hunter2'`;
      let x =
        statement === "object"
          ? `({${kv}})`
          : statement === "semicolon"
            ? `a=1;${key}='hunter2';`
            : statement === "export"
              ? `export ${key}='hunter2'`
              : statement === "query"
                ? `/login?user=kim&${key}='hunter2'`
                : `first line` + String.fromCharCode(10) + `${key}='hunter2'`;
      const levels = Math.floor(rnd() * 3);
      for (let l = 0; l < levels; l++) x = JSON.stringify(x);
      if (redactString("out: " + x).includes("hunter2")) leaks.push(x);
    }
    expect(leaks.slice(0, 3)).toEqual([]);
  });

  it("never re-serialises: other numbers and formatting stay byte-identical", () => {
    expect(redactString('{"accountId":9007199254740993,"password":"hunter2","rate":1.50e+2}')).toBe(
      `{"accountId":9007199254740993,"password":"${REDACTED}","rate":1.50e+2}`,
    );
    const doc =
      '{\n    "accountId" : 12345678901234567890 ,\n    "otp" : 123456 ,\n    "list" : [ 1.0 , -0 ]\n}\n';
    expect(redactString(doc)).toBe(doc.replace("123456 ,", `"${REDACTED}" ,`));
  });

  it("keeps prose and code examples (only clear credentials go in free text)", () => {
    const kept = [
      "Basic authentication is an HTTP scheme",
      "Bearer tokens are sent in the Authorization header",
      "문서에서 password= 다음에 실제 값을 넣으세요.",
      "password=process.env.PASSWORD",
      "const token = os.environ.TOKEN",
      "api_key=YOUR_API_KEY",
      "token: ${GITHUB_TOKEN}",
      "password: {{ secrets.password }}",
      "password=<비밀번호>",
      "password=xxxxxxxx",
      "set the token: ... then retry",
      "risk-management and task-oriented skills",
      "max_tokens: 100, tokenizer=cl100k, 맵핑 spin=3",
      "비밀번호(password)는 8자 이상이어야 해요.",
    ];
    for (const text of kept) expect(redactString(text)).toBe(text);
  });

  it("runs in linear time: 1 MB of adversarial input per pattern stays fast", () => {
    const MB = 1 << 20;
    const fill = (unit: string, size = MB) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    const inputs = [
      "eyJabcdefgh-",
      "eyJabcdefgh.abcdefgh-",
      "eyJabcdefgh.abcdefgh.",
      "sk-",
      "sk-abc",
      "ghp_aaaaaaaa-",
      "github_pat_",
      "xoxb-",
      "AKIAAAAAAAAA",
      "AIzaa-",
      "Bearer ",
      "Bearer a",
      "Basic a",
      "-----BEGIN PRIVATE KEY-----",
      "-----BEGIN ",
      "password=",
      "password= a",
      "a",
      "a-",
      '"password":"',
      '"a":"\\',
      '"a":',
      '"aaaaaaaa',
      "{",
      "[",
      "[{",
      '{"a":',
      '{"a":[',
      '{"password":"',
      '{"password":',
      '{"a":"\\"',
      '{"a":1,',
      '{"',
      "[1,",
      "]}",
      '"}{"',
      '"{\\"',
      '"{\\"a\\":\\"{\\\\\\"',
      '{"a":"{\\"a\\":\\"{\\\\\\"a',
      '"[',
      '{"a":"[',
      "\\u007b",
      // many tiny JSON strings (opened one level deeper)
      '"{\\"ab\\":12}"',
      '"{\\"pin\\":1}"',
      '["{\\"ab\\":12}",',
      '{"a":"{\\"ab\\":12}",',
      // pass C: secret names with and without separators, escaped names, brackets that never close
      "password",
      "password ",
      '"password"',
      "password:",
      '"otp":"',
      "pass\\u0077ord",
      "pass\\\\\\u0077ord=",
      '"password":[',
      '\\"token\\":{',
      // unbounded separator runs: a secret name, then a long run that never reaches a separator
      '"password"' + " ".repeat(64),
      '\\"otp\\"\\n\\t\\u0022 ',
      "password\\\\\\\\",
      // backslash runs (round 10: each run is consumed once)
      "\\",
      "\\\\u",
      "\\\\\\u00",
      '\\\\"password\\\\"',
      "pass\\\\\\\\u003a",
      // quoted keys (round 11): unterminated, mismatched forms, keys that run to a separator
      '{"aaaaaaaa',
      '{\\"a{"a{\\\\\\"a',
      ',"pass.word',
      "[\\u0022x",
      '{"a":1,"',
      // round 12: unmatched quote units of mixed depths, long names
      '"\\"\\\\\\"\\u0022\\\\u0022',
      '"' + "n".repeat(64),
      '\\\\"x"',
      // round 14: layer-heavy input (each decoded layer is one pass)
      "\\\\\\\\",
      "\\u005c",
      "\\u0022:",
      '\\\\\\"a\\\\\\":',
    ];
    // Best of three: garbage collection and JIT pauses only ever add time.
    const time = (input: string) => {
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        redactString(input);
        redactString(`{${input}}`);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    for (const unit of inputs) {
      time(fill(unit, MB / 16)); // warm up
      const eighth = time(fill(unit, MB / 8));
      const full = time(fill(unit));
      const what = `pattern unit ${JSON.stringify(unit)}: ${Math.round(eighth)} ms for 128 kB, ${Math.round(full)} ms for 1 MB`;
      // Linear: 8× the input takes about 8× the time; quadratic would be 64× (a review measured 15.3× for 4×).
      // The wide gap keeps this stable on a loaded machine. Small times are noisy: 10 ms floor.
      expect(full / Math.max(eighth, 10), what).toBeLessThan(20);
      expect(full, what).toBeLessThan(1500); // ~20–500 ms here; the old quadratic patterns took minutes
    }
  }, 240_000); // many 1 MB inputs, best of three, on a loaded machine: a time budget, not the check itself

  it("runs in linear time on quoted JSON-looking strings nested 0–4 levels deep (review #78)", () => {
    // Codex's input: 'stdout: ' + JSON.stringify('prefix ' + '"{a'.repeat(n)) was 15.3× slower for 4× input.
    const wrap = (x: string, levels: number) => {
      for (let k = 0; k < levels; k++) x = JSON.stringify(x);
      return x;
    };
    const time = (input: string) => {
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        redactString(input);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    const units = [
      '"{a',
      '"[a',
      '"{',
      '"[',
      '\\"{a',
      '"{\\"a',
      '{"a":"{\\"b',
      // both passes at once: broken quoted prefixes followed by real JSON
      '"[\\"ok\\"] {"otp":1} ',
      '"{\\"a {"password":"x"} "[',
    ];
    for (const unit of units)
      for (let levels = 0; levels <= 4; levels++) {
        const make = (n: number) =>
          "stdout: " + wrap("prefix " + unit.repeat(Math.ceil(n / unit.length)), levels);
        time(make(16 << 10)); // warm up
        const small = time(make(32 << 10));
        const large = time(make(256 << 10));
        const what = `${JSON.stringify(unit)} at ${levels} levels: ${Math.round(small)} ms → ${Math.round(large)} ms`;
        // 8× the input: linear ≈ 8×, quadratic ≈ 64×.
        expect(large / Math.max(small, 10), what).toBeLessThan(20);
        expect(large, what).toBeLessThan(1500);
      }
  }, 120_000);
});
