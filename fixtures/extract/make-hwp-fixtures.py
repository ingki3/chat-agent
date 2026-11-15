#!/usr/bin/env python3
"""Builds the HWP and HWPX fixtures (#23). Standard library only; the output is the same bytes on every run:

    python3 -I fixtures/extract/make-hwp-fixtures.py

The outputs are committed; tests never run this. Everything is written by hand, following the HWP 5.0 file format
(revision 1.3, Hancom) and OWPML (KS X 6101): an OLE compound file ([MS-CFB], version 3 or 4, with the mini stream
for streams under 4096 bytes) of zlib record streams for HWP, a ZIP of XML parts for HWPX. Each fixture holds
exactly what its test expects — body paragraphs, a table with merged cells, footnotes and endnotes, a text box, a
header that is not body text — and the refused ones (password, distribution, a zlib bomb, a looping sector chain,
a DTD) are crafted the same way. `fixtures/acceptance/injection/doc-injection.hwp` is made from the text of
`doc-injection.md` (body, the small white sentence, the table).
"""
import hashlib
import io
import os
import re
import struct
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
INJECTION = os.path.join(HERE, "..", "acceptance", "injection")


def out(path, data):
    with open(path, "wb") as f:
        f.write(data)


def deterministic(n, seed):
    """n bytes that look random (ciphertext stand-in), the same on every run."""
    b = b""
    i = 0
    while len(b) < n:
        b += hashlib.sha256(b"%s:%d" % (seed, i)).digest()
        i += 1
    return b[:n]


# ---- CFB (OLE compound file) -------------------------------------------------------------------------------------

ENDOFCHAIN = 0xFFFFFFFE
FREESECT = 0xFFFFFFFF
FATSECT = 0xFFFFFFFD
NOSTREAM = 0xFFFFFFFF


class Entry:
    def __init__(self, name, kind, data=b""):
        self.name, self.kind, self.data = name, kind, data
        self.children = []
        self.left = self.right = self.child = NOSTREAM
        self.start, self.size = ENDOFCHAIN, 0
        self.id = 0


def cfb(streams, version=3, patch=None):
    """streams: list of (path, bytes), path like 'BodyText/Section0'. patch(fat, layout) may change the FAT."""
    sec = 512 if version == 3 else 4096
    root = Entry("Root Entry", 5)
    entries = [root]
    storages = {"": root}
    for path, data in streams:
        parts = path.split("/")
        parent = root
        for i in range(len(parts) - 1):
            key = "/".join(parts[: i + 1])
            if key not in storages:
                st = Entry(parts[i], 1)
                storages[key] = st
                parent.children.append(st)
                entries.append(st)
            parent = storages[key]
        e = Entry(parts[-1], 2, data)
        parent.children.append(e)
        entries.append(e)
    for i, e in enumerate(entries):
        e.id = i

    def order(e):
        return (len(e.name), e.name.upper())

    def bst(lst):
        if not lst:
            return NOSTREAM
        m = len(lst) // 2
        node = lst[m]
        node.left = bst(lst[:m])
        node.right = bst(lst[m + 1 :])
        return node.id

    for e in entries:
        if e.kind in (1, 5):
            e.child = bst(sorted(e.children, key=order))

    # Mini stream: streams under 4096 bytes, in 64-byte mini sectors.
    mini = b""
    minifat = []
    big = []
    for e in entries:
        if e.kind != 2:
            continue
        e.size = len(e.data)
        if e.size == 0:
            e.start = ENDOFCHAIN
        elif e.size < 4096:
            n = (e.size + 63) // 64
            e.start = len(mini) // 64
            minifat += [e.start + i + 1 for i in range(n - 1)] + [ENDOFCHAIN]
            mini += e.data + b"\0" * (n * 64 - e.size)
        else:
            big.append(e)
    root.size = len(mini)

    nsec = lambda n: (n + sec - 1) // sec
    n_dir = nsec(len(entries) * 128)
    n_minifat = nsec(len(minifat) * 4)
    n_mini = nsec(len(mini))
    n_data = n_dir + n_minifat + n_mini + sum(nsec(len(e.data)) for e in big)
    n_fat = 1
    while n_fat * (sec // 4) < n_data + n_fat:
        n_fat += 1
    assert n_fat <= 109
    fat = [FATSECT] * n_fat
    body = []

    def alloc(data):
        if not data:
            return ENDOFCHAIN
        start = len(fat)
        n = nsec(len(data))
        fat.extend([start + i + 1 for i in range(n - 1)] + [ENDOFCHAIN])
        body.append(data + b"\0" * (n * sec - len(data)))
        return start

    # Directory entries, padded with empty ones to whole sectors.
    def dir_bytes():
        b = b""
        for e in entries:
            name = (e.name + "\0").encode("utf-16le")
            b += name + b"\0" * (64 - len(name))
            b += struct.pack("<HBB", len(name), e.kind, 1)
            b += struct.pack("<III", e.left, e.right, e.child)
            b += b"\0" * 16 + b"\0" * 4 + b"\0" * 16
            b += struct.pack("<IQ", e.start, e.size)
        while len(b) % sec:
            b += b"\0" * 64 + struct.pack("<HBB", 0, 0, 0) + struct.pack("<III", NOSTREAM, NOSTREAM, NOSTREAM)
            b += b"\0" * 36 + struct.pack("<IQ", 0, 0)
        return b

    first_dir = len(fat)
    for _ in range(n_dir):  # reserve: entries are written once the start sectors are known
        fat.append(None)
    body.append(None)
    first_minifat = alloc(b"".join(struct.pack("<I", x) for x in minifat)) if minifat else ENDOFCHAIN
    root.start = alloc(mini) if mini else ENDOFCHAIN
    for e in big:
        e.start = alloc(e.data)
    fat[first_dir : first_dir + n_dir] = [first_dir + i + 1 for i in range(n_dir - 1)] + [ENDOFCHAIN]
    body[0] = dir_bytes()
    if patch:
        patch(fat, {"first_dir": first_dir, "n_dir": n_dir})
    fat += [FREESECT] * (n_fat * (sec // 4) - len(fat))

    h = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 16
    h += struct.pack("<HHHHH", 0x3E, version, 0xFFFE, 9 if version == 3 else 12, 6)
    h += b"\0" * 6
    h += struct.pack("<IIIIIIIII", n_dir if version == 4 else 0, n_fat, first_dir, 0, 4096, first_minifat,
                     n_minifat, ENDOFCHAIN, 0)
    h += b"".join(struct.pack("<I", i) for i in range(n_fat)) + b"\xff\xff\xff\xff" * (109 - n_fat)
    assert len(h) == 512
    h += b"\0" * (sec - 512)
    fat_bytes = b"".join(struct.pack("<I", x) for x in fat)
    return h + fat_bytes + b"".join(body)


# ---- HWP 5.0 records ---------------------------------------------------------------------------------------------

BEGIN = 0x10
DOCUMENT_PROPERTIES, ID_MAPPINGS, CHAR_SHAPE = BEGIN + 0, BEGIN + 1, BEGIN + 5
PARA_HEADER, PARA_TEXT, PARA_CHAR_SHAPE, PARA_LINE_SEG = BEGIN + 50, BEGIN + 51, BEGIN + 52, BEGIN + 53
CTRL_HEADER, LIST_HEADER, PAGE_DEF, SHAPE_COMPONENT = BEGIN + 55, BEGIN + 56, BEGIN + 57, BEGIN + 60
TABLE, SHAPE_COMPONENT_RECTANGLE = BEGIN + 61, BEGIN + 63


def rec(tag, level, data=b""):
    if len(data) >= 0xFFF:
        return struct.pack("<II", tag | (level << 10) | (0xFFF << 20), len(data)) + data
    return struct.pack("<I", tag | (level << 10) | (len(data) << 20)) + data


def chid(s):
    """A control id as stored: the UINT32 whose big-endian bytes are the four characters."""
    return struct.unpack(">I", s.encode("latin-1"))[0]


CTRL_CHAR = {"tbl ": 11, "gso ": 11, "fn  ": 17, "en  ": 17, "head": 16, "foot": 16, "tcmt": 15, "secd": 2,
             "cold": 2}


class Ctrl:
    """A control in a paragraph: its id and the records under it (built at level+1)."""

    def __init__(self, cid, build):
        self.cid, self.build = cid, build


def ctrl_units(ctrls):
    units = []
    for c in ctrls:
        code = CTRL_CHAR[c.cid]
        v = chid(c.cid)
        units += [code, v & 0xFFFF, v >> 16, 0, 0, 0, 0, code]
    return units


def para(level, text="", ctrls=(), shape=0, after=()):
    """A paragraph: `ctrls`' characters, the text (\\t, \\n allowed), `after`'s characters; then the controls'
    records in that order."""
    units = ctrl_units(ctrls)
    for ch in text:
        if ch == "\t":
            units += [9, 0, 0, 0, 0, 0, 0, 9]
        elif ch == "\n":
            units.append(10)
        else:
            b = ch.encode("utf-16le")
            units += list(struct.unpack("<%dH" % (len(b) // 2), b))
    units += ctrl_units(after)
    units.append(13)
    ctrls = list(ctrls) + list(after)
    mask = 0
    for c in ctrls:
        mask |= 1 << CTRL_CHAR[c.cid]
    head = struct.pack("<IIHBBHHHIH", len(units), mask, 0, 0, 0, 1, 0, 1, 0, 0)
    r = rec(PARA_HEADER, level, head)
    if len(units) > 1:
        r += rec(PARA_TEXT, level + 1, struct.pack("<%dH" % len(units), *units))
    r += rec(PARA_CHAR_SHAPE, level + 1, struct.pack("<II", 0, shape))
    r += rec(PARA_LINE_SEG, level + 1, b"\0" * 36)
    for c in ctrls:
        r += c.build(level + 1)
    return r


def paras(level, items):
    """items: strings or (text, ctrls[, shape]) tuples."""
    b = b""
    for it in items:
        if isinstance(it, str):
            b += para(level, it)
        else:
            b += para(level, *it)
    return b


def list_header(level, n, extra=b""):
    return rec(LIST_HEADER, level, struct.pack("<HHI", n, 0, 0) + extra)


def table(cells, rows, cols, caption=None):
    """cells: (row, col, rowspan, colspan, [paragraph items]) in reading order."""

    def build(level):
        r = rec(CTRL_HEADER, level, struct.pack("<I", chid("tbl ")) + b"\0" * 42)
        if caption:
            r += list_header(level + 1, len(caption), struct.pack("<IIHI", 3, 0, 0, 0))
            r += paras(level + 1, caption)
        per_row = [sum(1 for c in cells if c[0] == i) for i in range(rows)]
        r += rec(TABLE, level + 1, struct.pack("<IHHH4H", 0, rows, cols, 0, 0, 0, 0, 0)
                 + struct.pack("<%dH" % rows, *per_row) + struct.pack("<HH", 1, 0))
        for row, col, rs, cs, items in cells:
            attrs = struct.pack("<HHHHII4HHI", col, row, cs, rs, 8000 * cs, 1000 * rs, 0, 0, 0, 0, 1, 0)
            r += list_header(level + 1, len(items), attrs)
            r += paras(level + 1, items)
        return r

    return Ctrl("tbl ", build)


def note(cid, items, number):
    """number: the note's number as stored (UINT32 after the id); 0 = none."""

    def build(level):
        r = rec(CTRL_HEADER, level, struct.pack("<II", chid(cid), number) + b"\0" * 8)
        r += list_header(level + 1, len(items), b"\0" * 8)
        return r + paras(level + 1, items)

    return Ctrl(cid, build)


def header(items, cid="head"):
    """A header ('head'), footer ('foot') or hidden comment ('tcmt'): text that is not body text."""

    def build(level):
        r = rec(CTRL_HEADER, level, struct.pack("<II", chid(cid), 0))
        r += list_header(level + 1, len(items), struct.pack("<II", 42520, 4252))
        return r + paras(level + 1, items)

    return Ctrl(cid, build)


def textbox(items):
    def build(level):
        r = rec(CTRL_HEADER, level, struct.pack("<I", chid("gso ")) + b"\0" * 42)
        r += rec(SHAPE_COMPONENT, level + 1, struct.pack("<II", chid("$rec"), chid("$rec")) + b"\0" * 40)
        r += list_header(level + 2, len(items), b"\0" * 8 + struct.pack("<I", 10000))
        r += paras(level + 2, items)
        return r + rec(SHAPE_COMPONENT_RECTANGLE, level + 2, b"\0" * 9)

    return Ctrl("gso ", build)


def section_def():
    def build(level):
        r = rec(CTRL_HEADER, level, struct.pack("<I", chid("secd")) + b"\0" * 32)
        return r + rec(PAGE_DEF, level + 1, struct.pack("<10I", 59528, 84188, 8504, 8504, 5668, 4252, 4252, 4252, 0, 0))

    return Ctrl("secd", build)


def char_shape(color, size):
    return (struct.pack("<7H", *[0] * 7) + bytes([100] * 7) + bytes(7) + bytes([100] * 7) + bytes(7)
            + struct.pack("<iIbbIIII", size, 0, 0, 0, color, 0, 0xFFFFFF, 0xB2B2B2) + struct.pack("<HI", 1, 0))


def doc_info(sections, white=False):
    r = rec(DOCUMENT_PROPERTIES, 0, struct.pack("<7HIII", sections, 1, 1, 1, 1, 1, 1, 0, 0, 0))
    r += rec(ID_MAPPINGS, 0, struct.pack("<18i", *([0] * 9 + [2 if white else 1] + [0] * 8)))
    r += rec(CHAR_SHAPE, 1, char_shape(0x000000, 1000))
    if white:
        # Char shape 1: white (0xBBGGRR), 6 pt — the hidden sentence of the injection document.
        r += rec(CHAR_SHAPE, 1, char_shape(0xFFFFFF, 600))
    return r


def file_header(props):
    return b"HWP Document File".ljust(32, b"\0") + struct.pack("<IIII", 0x05010100, props, 0, 4) + b"\0" * 208


def deflate(b):
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    return c.compress(b) + c.flush()


def hwp(sections, props=1, version=3, white=False, extra=(), patch=None, raw_sections=None):
    """sections: section record bytes. props bit 0: compressed."""
    z = (lambda b: deflate(b)) if props & 1 else (lambda b: b)
    streams = [("FileHeader", file_header(props)), ("DocInfo", z(doc_info(len(sections), white)))]
    if raw_sections is not None:
        streams += raw_sections
    else:
        streams += [("BodyText/Section%d" % i, z(s)) for i, s in enumerate(sections)]
    streams += list(extra)
    return cfb(streams, version, patch)


# ---- the HWP fixtures --------------------------------------------------------------------------------------------


def sample_hwp():
    # Section 0: a header (not body text), paragraphs, a footnote, a 3×3 table with merged cells (a footnote in a
    # cell), a text box; section 1: one paragraph with an endnote.
    merged = table(
        [
            (0, 0, 1, 1, ["항목"]),
            (0, 1, 1, 2, ["기준"]),
            (1, 0, 2, 1, ["분량"]),
            (1, 1, 1, 1, ["A4 3쪽"]),
            (1, 2, 1, 1, ["이내"]),
            (2, 1, 1, 1, [("글꼴 11pt", [], 0, [note("fn  ", ["본문 글꼴 기준."], 2)])]),
            (2, 2, 1, 1, ["줄 간격 160%"]),
        ],
        3,
        3,
    )
    s0 = paras(0, [
        ("과제 안내문", [section_def(), header(["머리말 글자"])]),
        ("제출 기한은 11월 20일입니다.", [], 0, [note("fn  ", ["학교 누리집 공지 기준."], 1)]),
        "",
        ("", [merged]),
        ("참고 자료를 확인하세요.", [], 0, [textbox(["글상자 속 글"])]),
    ])
    s1 = paras(0, [("둘째 구역 문단.", [], 0, [note("en  ", ["미주 내용."], 1)])])
    return [s0, s1]


def report_hwp():
    # Version 4 (4096-byte sectors), not compressed: a table with a caption and a nested table, tab and line
    # break, and enough paragraphs for the section to live in regular sectors (over 4096 bytes).
    inner = table([(0, 0, 1, 1, ["안쪽 표"]), (0, 1, 1, 1, ["값"])], 1, 2)
    outer = table(
        [
            (0, 0, 1, 1, ["이름"]),
            (0, 1, 1, 1, ["점수"]),
            (1, 0, 1, 1, ["민준"]),
            (1, 1, 1, 1, [("92", [inner])]),
        ],
        2,
        2,
        caption=["표 1. 점수"],
    )
    items = [("보고서\t초안", [section_def()]), "첫 줄\n둘째 줄", ("", [outer])]
    items += ["%d번째 단락입니다. 긴 문서의 본문." % (i + 1) for i in range(200)]
    # The document's own note numbers: a footnote numbered 7 (numbering restarted or continued from elsewhere),
    # an endnote whose stored number is 0 (none claimed).
    items += [("일곱째 각주가 붙은 문단.", [], 0, [note("fn  ", ["일곱째 각주."], 7)]),
              ("번호 없는 미주가 붙은 문단.", [], 0, [note("en  ", ["번호 없는 미주."], 0)])]
    return [paras(0, items)]


def assignment_hwp():
    # 과제안내.hwp (#24 viewer): paragraphs and three tables; the third table's second row is the cited one
    # ("3번째 표 · 2행").
    def simple(rows):
        return table([(r, c, 1, 1, [text]) for r, row in enumerate(rows) for c, text in enumerate(row)], len(rows), 2)

    items = [
        ("과제 안내", [section_def()]),
        "이번 과제는 지역 하천 조사 보고서입니다.",
        ("", [simple([["구분", "내용"], ["주제", "우리 동네 하천"], ["분량", "A4 3쪽 이내"]])]),
        "평가 기준은 아래 표를 따릅니다.",
        ("", [simple([["항목", "배점"], ["조사 내용", "50점"], ["발표", "30점"]])]),
        "제출 방법과 기한은 다음과 같습니다.",
        ("", [simple([["항목", "안내"], ["제출 방법", "학교 누리집 과제방에 PDF로 올립니다."],
                      ["기한", "11월 20일 자정까지"]])]),
        "궁금한 점은 담임 선생님께 물어보세요.",
    ]
    return [paras(0, items)]


# A synthetic value the cut tests register as a known secret (never a real one): its base64's first 40 characters
# end kept text, the rest is in a part that is left out (review #120).
CUT_SECRET = "sk-fixture-hwp-cut-0123456789abcdefABCDEF"
CUT_B64 = __import__("base64").b64encode(CUT_SECRET.encode()).decode()
CUT_HEAD, CUT_REST = CUT_B64[:40], CUT_B64[40:]


def cut_hwp():
    items = []
    for cid in ("head", "foot", "tcmt"):
        items += [("앞 문장 " + CUT_HEAD, [], 0, [header([CUT_REST], cid)]), "다음 문장."]
    cell = table([(0, 0, 1, 1, [("셀 " + CUT_HEAD, [], 0, [header([CUT_REST], "tcmt")])]),
                  (0, 1, 1, 1, ["둘째 칸"])], 1, 2)
    items += [("", [cell]), "끝 문장."]
    return hwp([paras(0, items)])


def badcell_hwp():
    # The second row's first cell claims row 65535 of a 2×2 table.
    bad = table([(0, 0, 1, 1, ["가"]), (0, 1, 1, 1, ["나"]), (65535, 0, 1, 1, ["다"]), (1, 1, 1, 1, ["라"])], 2, 2)
    return hwp([paras(0, [("", [bad])])])


def injection_hwp():
    md = open(os.path.join(INJECTION, "doc-injection.md"), encoding="utf-8").read()
    body = md.split("## 본문", 1)[1].split("## 표", 1)[0]
    lines = [l.strip() for l in body.strip().splitlines() if l.strip()]
    visible = lines[0]
    hidden = re.sub(r"^\([^)]*\)\s*", "", lines[1])  # the sentence itself, without its "(작은 흰 글씨로 …)" note
    rows = [
        [c.strip() for c in l.strip().strip("|").split("|")]
        for l in md.split("## 표", 1)[1].strip().splitlines()
        if l.startswith("|") and not set(l) <= set("|-")
    ]
    cells = [(r, c, 1, 1, [text]) for r, row in enumerate(rows) for c, text in enumerate(row)]
    s0 = paras(0, [("과제 안내", [section_def()]), visible, (hidden, [], 1), ("", [table(cells, len(rows), 2)])])
    return hwp([s0], white=True)


def bomb_hwp():
    # 70 MiB of zero bytes inflate from ~70 KB: over the 64 MiB a section may hold.
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    chunk = b"\0" * (1 << 20)
    data = b"".join(c.compress(chunk) for _ in range(70)) + c.flush()
    return hwp([], raw_sections=[("BodyText/Section0", data)])


def loop_hwp():
    # The directory's sector chain points back at itself.
    def patch(fat, layout):
        last = layout["first_dir"] + layout["n_dir"] - 1
        fat[last] = layout["first_dir"]

    return hwp([paras(0, ["하나"])], patch=patch)


# ---- HWPX ---------------------------------------------------------------------------------------------------------

NS = (
    'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" '
    'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" '
    'xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph"'
)
XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>'


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def t(s):
    out_ = ""
    for i, part in enumerate(s.split("\n")):
        if i:
            out_ += "<hp:lineBreak/>"
        out_ += "<hp:tab/>".join(esc(x) for x in part.split("\t"))
    return "<hp:t>%s</hp:t>" % out_


def xp(text="", extra="", char=0, after=""):
    """A paragraph: `extra` (controls, tables …) in its first run, then the text, then `after`."""
    return ('<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">'
            '<hp:run charPrIDRef="%d">%s%s%s</hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" '
            'vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" '
            'flags="393216"/></hp:linesegarray></hp:p>') % (char, extra, t(text) if text else "", after)


def sublist(ps):
    return ('<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" '
            'linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">%s</hp:subList>'
            % "".join(ps))


def xtable(rows, cols, cells, caption=None):
    """cells: rows of (row, col, rowspan, colspan, [paragraph xml])."""
    trs = ""
    for r in range(rows):
        tcs = ""
        for row, col, rs, cs, ps in cells:
            if row != r:
                continue
            tcs += ('<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1">'
                    '%s<hp:cellAddr colAddr="%d" rowAddr="%d"/><hp:cellSpan colSpan="%d" rowSpan="%d"/>'
                    '<hp:cellSz width="%d" height="%d"/><hp:cellMargin left="510" right="510" top="141" '
                    'bottom="141"/></hp:tc>') % (sublist(ps), col, row, cs, rs, 8000 * cs, 1000 * rs)
        trs += "<hp:tr>%s</hp:tr>" % tcs
    cap = '<hp:caption side="TOP" fullSz="0" width="8504" gap="850" lastWidth="42520">%s</hp:caption>' % sublist(
        caption) if caption else ""
    return ('<hp:tbl id="1" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" '
            'lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="%d" colCnt="%d" cellSpacing="0" '
            'borderFillIDRef="1" noAdjust="0"><hp:sz width="42520" widthRelTo="ABSOLUTE" height="3000" '
            'heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" '
            'allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" '
            'horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="283" right="283" top="283" '
            'bottom="283"/>%s<hp:inMargin left="510" right="510" top="141" bottom="141"/>%s</hp:tbl>'
            ) % (rows, cols, cap, trs)


def xnote(kind, no, ps):
    return '<hp:ctrl><hp:%s number="%d" suffixChar="41" instId="%d">%s</hp:%s></hp:ctrl>' % (
        kind, no, 1000 + no, sublist(ps), kind)


SEC_PR = ('<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="1" '
          'memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:pagePr landscape="WIDELY" '
          'width="59528" height="84186" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" '
          'left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr></hp:secPr>'
          '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>')


def section(ps):
    return XML + "<hs:sec %s>%s</hs:sec>" % (NS, "".join(ps))


def hwpx(sections, manifest_extra="", spine=None, section_override=None):
    spine = spine if spine is not None else list(range(len(sections)))
    items = "".join('<opf:item id="section%d" href="Contents/section%d.xml" media-type="application/xml"/>' % (i, i)
                    for i in range(len(sections)))
    refs = "".join('<opf:itemref idref="section%d" linear="yes"/>' % i for i in spine)
    hpf = (XML + '<opf:package xmlns:opf="http://www.idpf.org/2007/opf/" version="" unique-identifier="" id="">'
           '<opf:metadata><opf:title/><opf:language>ko</opf:language></opf:metadata><opf:manifest>'
           '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>%s'
           '<opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>'
           '<opf:spine><opf:itemref idref="header" linear="yes"/>%s</opf:spine></opf:package>') % (items, refs)
    head = (XML + '<hh:head %s version="1.4" secCnt="%d"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" '
            'tbl="1" equation="1"/><hh:refList><hh:charProperties itemCnt="2"><hh:charPr id="0" height="1000" '
            'textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" '
            'borderFillIDRef="1"/><hh:charPr id="1" height="600" textColor="#FFFFFF" shadeColor="none" '
            'useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1"/></hh:charProperties></hh:refList>'
            '</hh:head>') % (NS, len(sections))
    container = (XML + '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" '
                 'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile '
                 'full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles>'
                 '</ocf:container>')
    manifest = (XML + '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">%s'
                '</odf:manifest>') % manifest_extra
    entries = [
        ("mimetype", b"application/hwp+zip", zipfile.ZIP_STORED),
        ("version.xml", (XML + '<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" '
                         'tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="10" '
                         'xmlVersion="1.4" application="Hancom Office Hangul" appVersion="12"/>').encode(), None),
        ("Contents/header.xml", head.encode(), None),
    ]
    for i, s in enumerate(sections):
        data = section_override(i) if section_override and section_override(i) is not None else s.encode()
        entries.append(("Contents/section%d.xml" % i, data, None))
    entries += [
        ("settings.xml", (XML + '<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"/>'
                          ).encode(), None),
        ("Preview/PrvText.txt", "미리보기 글자는 읽지 않는다".encode("utf-8"), None),
        ("META-INF/container.xml", container.encode(), None),
        ("META-INF/manifest.xml", manifest.encode(), None),
        ("Contents/content.hpf", hpf.encode(), None),
    ]
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        for name, data, method in entries:
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 13, 0, 0, 0))
            info.compress_type = method if method is not None else zipfile.ZIP_DEFLATED
            z.writestr(info, data)
    return b.getvalue()


def sample_hwpx():
    merged = xtable(3, 3, [
        (0, 0, 1, 1, [xp("항목")]),
        (0, 1, 1, 2, [xp("기준")]),
        (1, 0, 2, 1, [xp("분량")]),
        (1, 1, 1, 1, [xp("A4 3쪽")]),
        (1, 2, 1, 1, [xp("이내")]),
        (2, 1, 1, 1, [xp("글꼴 11pt", after=xnote("footNote", 2, [xp("본문 글꼴 기준.")]))]),
        (2, 2, 1, 1, [xp("줄 간격 160%")]),
    ])
    header = '<hp:ctrl><hp:header id="1" applyPageType="BOTH">%s</hp:header></hp:ctrl>' % sublist([xp("머리말 글자")])
    alt = ('<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">'
           '<hp:t>대체 글자</hp:t></hp:case><hp:default></hp:default></hp:switch>')
    box = ('<hp:rect id="5" zOrder="1" numberingType="PICTURE" textWrap="IN_FRONT_OF_TEXT" textFlow="BOTH_SIDES" '
           'lock="0" dropcapstyle="None" href="" groupLevel="0" instid="5" ratio="0"><hp:drawText lastWidth="10000" '
           'name="" editable="0">%s<hp:textMargin left="283" right="283" top="283" bottom="283"/></hp:drawText>'
           '</hp:rect>') % sublist([xp("글상자 속 글")])
    s0 = section([
        xp("과제 안내문", SEC_PR + header),
        xp("제출 기한은 11월 20일입니다.", alt, after=xnote("footNote", 1, [xp("학교 누리집 공지 기준.")])),
        xp(""),
        xp("", merged),
        xp("참고 자료를 확인하세요.", after=box),
    ])
    s1 = section([xp("둘째 구역 문단.", after=xnote("endNote", 1, [xp("미주 내용.")]))])
    return hwpx([s0, s1])


def report_hwpx():
    inner = xtable(1, 2, [(0, 0, 1, 1, [xp("안쪽 표")]), (0, 1, 1, 1, [xp("값")])])
    outer = xtable(2, 2, [
        (0, 0, 1, 1, [xp("이름")]),
        (0, 1, 1, 1, [xp("점수")]),
        (1, 0, 1, 1, [xp("민준")]),
        (1, 1, 1, 1, [xp("92", inner)]),
    ], caption=[xp("표 1. 점수")])
    unnumbered = '<hp:ctrl><hp:endNote instId="9">%s</hp:endNote></hp:ctrl>' % sublist([xp("번호 없는 미주.")])
    s0 = section([xp("보고서\t초안", SEC_PR), xp("첫 줄\n둘째 줄"), xp("", outer),
                  xp("일곱째 각주가 붙은 문단.", after=xnote("footNote", 7, [xp("일곱째 각주.")])),
                  xp("번호 없는 미주가 붙은 문단.", after=unnumbered)])
    # Two more sections, listed in the spine after s0 — the spine is the order, not the part names.
    s1 = section([xp("셋째로 읽는 구역.")])
    s2 = section([xp("둘째로 읽는 구역.")])
    return hwpx([s0, s1, s2], spine=[0, 2, 1])


def cut_hwpx():
    def ctrl(kind):
        return '<hp:ctrl><hp:%s id="1" applyPageType="BOTH">%s</hp:%s></hp:ctrl>' % (kind, sublist([xp(CUT_REST)]),
                                                                                  kind)

    ps = []
    # (No `hp:case`: alternative content is not read at all — review #120 4차.)
    for extra in (ctrl("header"), ctrl("footer"), ctrl("hiddenComment")):
        ps += [xp("앞 문장 " + CUT_HEAD, after=extra), xp("다음 문장.")]
    cell = xtable(1, 2, [(0, 0, 1, 1, [xp("셀 " + CUT_HEAD, after=ctrl("hiddenComment"))]),
                         (0, 1, 1, 1, [xp("둘째 칸")])])
    ps += [xp("", cell), xp("끝 문장.")]
    return hwpx([section(ps)])


ENCRYPTED_MANIFEST = (
    '<odf:file-entry odf:full-path="Contents/section0.xml" odf:media-type="application/xml" odf:size="1024">'
    '<odf:encryption-data odf:checksum-type="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#sha256-1k" '
    'odf:checksum="AAAA"><odf:algorithm odf:algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" '
    'odf:initialisation-vector="AAAA"/><odf:key-derivation odf:key-derivation-name="PBKDF2" odf:key-size="32" '
    'odf:iteration-count="1024" odf:salt="AAAA"/></odf:encryption-data></odf:file-entry>'
)


def main():
    out(os.path.join(HERE, "sample.hwp"), hwp(sample_hwp()))
    out(os.path.join(HERE, "report.hwp"), hwp(report_hwp(), props=0, version=4))
    out(os.path.join(HERE, "assignment.hwp"), hwp(assignment_hwp()))
    out(os.path.join(INJECTION, "doc-injection.hwp"), injection_hwp())
    garbage = deterministic(2048, b"ciphertext")
    # Password (property bit 1): the body stream is ciphertext.
    out(os.path.join(HERE, "encrypted.hwp"), hwp([], props=1 | 2, raw_sections=[("BodyText/Section0", garbage)]))
    # Distribution document (bit 2): the text is in ViewText, encrypted; no BodyText.
    out(os.path.join(HERE, "distribution.hwp"), hwp([], props=1 | 4, raw_sections=[("ViewText/Section0", garbage)]))
    out(os.path.join(HERE, "bomb.hwp"), bomb_hwp())
    out(os.path.join(HERE, "cut.hwp"), cut_hwp())
    out(os.path.join(HERE, "cut.hwpx"), cut_hwpx())
    out(os.path.join(HERE, "badcell.hwp"), badcell_hwp())
    out(os.path.join(HERE, "loop.hwp"), loop_hwp())
    out(os.path.join(HERE, "sample.hwpx"), sample_hwpx())
    out(os.path.join(HERE, "report.hwpx"), report_hwpx())
    out(os.path.join(HERE, "encrypted.hwpx"), hwpx([section([xp("x")])], manifest_extra=ENCRYPTED_MANIFEST,
                                                   section_override=lambda i: garbage))
    xxe = (XML + '<!DOCTYPE hs:sec [<!ENTITY x SYSTEM "file:///etc/passwd">]><hs:sec %s>%s</hs:sec>'
           % (NS, xp("&x;").replace("&amp;x;", "&x;")))
    out(os.path.join(HERE, "xxe.hwpx"), hwpx([section([xp("x")])], section_override=lambda i: xxe.encode()))


if __name__ == "__main__":
    main()
