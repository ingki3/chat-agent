#!/usr/bin/env python3
"""Builds the extraction fixtures (#48) in this folder. Run once on a Mac with Pillow:

    python3 -I fixtures/extract/make-fixtures.py

The outputs are committed; tests never run this. Everything is written by hand (PDF objects, ZIP entries, XML),
so each fixture holds exactly what its test expects — and the hostile ones (zip bomb, XXE, zip slip) are
crafted byte by byte. `korean.pdf` comes from macOS `cupsfilter` (a real PDF with an embedded CJK font).
"""
import io
import os
import struct
import subprocess
import zipfile
import zlib

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"


def out(name, data):
    with open(os.path.join(HERE, name), "wb") as f:
        f.write(data)


# ---- PDF -------------------------------------------------------------------------------------------------------


def pdf(objects):
    """objects: list of bytes (object bodies, numbered from 1). Object 1 is the catalog."""
    b = io.BytesIO()
    b.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objects, 1):
        offsets.append(b.tell())
        b.write(b"%d 0 obj\n" % i + body + b"\nendobj\n")
    xref = b.tell()
    b.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for o in offsets:
        b.write(b"%010d 00000 n \n" % o)
    b.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref))
    return b.getvalue()


def stream(data, extra=b""):
    return b"<< /Length %d %s>>\nstream\n" % (len(data), extra) + data + b"\nendstream"


def esc(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").encode("latin-1")


def text_pdf(pages):
    """pages: list of lists of lines (ASCII). Helvetica 12pt, 20pt leading, from (72, 720)."""
    n = len(pages)
    # 1 catalog, 2 pages, 3 font, then (page, content) pairs
    kids = " ".join("%d 0 R" % (4 + 2 * i) for i in range(n)).encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [" + kids + b"] /Count %d >>" % n,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for i, lines in enumerate(pages):
        ops = b"BT /F1 12 Tf 72 720 Td 20 TL\n" + b"".join(b"(" + esc(l) + b") Tj T*\n" for l in lines) + b"ET"
        objs.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>"
            % (5 + 2 * i)
        )
        objs.append(stream(ops))
    return pdf(objs)


def image_pdf(jpegs):
    """One page per JPEG (grayscale), drawn over the whole US Letter page. No text layer: a scan."""
    n = len(jpegs)
    kids = " ".join("%d 0 R" % (3 + 3 * i) for i in range(n)).encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [" + kids + b"] /Count %d >>" % n]
    for i, (jpg, w, h) in enumerate(jpegs):
        page, content, img = 3 + 3 * i, 4 + 3 * i, 5 + 3 * i
        objs.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 %d 0 R >> >> /Contents %d 0 R >>"
            % (img, content)
        )
        objs.append(stream(b"q 612 0 0 792 0 0 cm /Im1 Do Q"))
        objs.append(
            stream(
                jpg,
                b"/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode "
                % (w, h),
            )
        )
    return pdf(objs)


def render(lines, size=(1224, 1584), font_size=44, top=120, step=90):
    img = Image.new("L", size, 255)
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT, font_size)
    for i, line in enumerate(lines):
        d.text((120, top + i * step), line, fill=0, font=f)
    return img


def jpeg(img):
    b = io.BytesIO()
    img.save(b, "JPEG", quality=92)
    return b.getvalue()


def png(img):
    b = io.BytesIO()
    img.save(b, "PNG")
    return b.getvalue()


# ---- ZIP (OOXML) -----------------------------------------------------------------------------------------------


def ooxml(entries):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            z.writestr(name, data)
    return b.getvalue()


CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>'
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def rels(items):
    return (
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join('<Relationship Id="%s" Type="%s/%s" Target="%s"/>' % (i, REL, t, tg) for i, t, tg in items)
        + "</Relationships>"
    )


def wp(*runs):
    return "<w:p>" + "".join('<w:r><w:t xml:space="preserve">%s</w:t></w:r>' % r for r in runs) + "</w:p>"


def wtbl(rows):
    return (
        "<w:tbl>"
        + "".join("<w:tr>" + "".join("<w:tc>%s</w:tc>" % wp(c) for c in row) + "</w:tr>" for row in rows)
        + "</w:tbl>"
    )


def docx(body, head='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'):
    doc = head + '<w:document xmlns:w="%s"><w:body>%s</w:body></w:document>' % (W, body)
    return ooxml(
        [
            ("[Content_Types].xml", CT),
            ("_rels/.rels", rels([("rId1", "officeDocument", "word/document.xml")])),
            ("word/document.xml", doc),
        ]
    )


def xlsx():
    S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    wb = (
        '<workbook xmlns="%s" xmlns:r="%s"><sheets><sheet name="성적" sheetId="1" r:id="rId1"/><sheet name="메모" sheetId="2" r:id="rId2"/></sheets></workbook>'
        % (S, REL)
    )
    sst = '<sst xmlns="%s" count="4" uniqueCount="4"><si><t>이름</t></si><si><t>점수</t></si><si><t>민준</t></si><si><r><t>서</t></r><r><t>연</t></r></si></sst>' % S
    sheet1 = (
        '<worksheet xmlns="%s"><sheetData>'
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>92</v></c></row>'
        '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3"><f>B2+1</f><v>88</v></c></row>'
        "</sheetData></worksheet>"
    ) % S
    sheet2 = (
        '<worksheet xmlns="%s"><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>다음 주 월요일까지 &amp; 제출</t></is></c></row></sheetData></worksheet>'
        % S
    )
    return ooxml(
        [
            ("[Content_Types].xml", CT),
            ("_rels/.rels", rels([("rId1", "officeDocument", "xl/workbook.xml")])),
            ("xl/workbook.xml", wb),
            (
                "xl/_rels/workbook.xml.rels",
                rels([("rId1", "worksheet", "worksheets/sheet1.xml"), ("rId2", "worksheet", "/xl/worksheets/sheet2.xml")]),
            ),
            ("xl/sharedStrings.xml", sst),
            ("xl/worksheets/sheet1.xml", sheet1),
            ("xl/worksheets/sheet2.xml", sheet2),
        ]
    )


def pptx(slide_target="slides/slide1.xml"):
    P = "http://schemas.openxmlformats.org/presentationml/2006/main"
    A = "http://schemas.openxmlformats.org/drawingml/2006/main"

    def slide(*paras):
        return (
            '<p:sld xmlns:p="%s" xmlns:a="%s"><p:cSld><p:spTree><p:sp><p:txBody>%s</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
            % (P, A, "".join("<a:p><a:r><a:t>%s</a:t></a:r></a:p>" % t for t in paras))
        )

    # Shown order: slide2.xml, then slide1.xml, then slide3.xml (the order of sldIdLst, not of the file names).
    pres = (
        '<p:presentation xmlns:p="%s" xmlns:r="%s"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst></p:presentation>'
        % (P, REL)
    )
    return ooxml(
        [
            ("[Content_Types].xml", CT),
            ("_rels/.rels", rels([("rId1", "officeDocument", "ppt/presentation.xml")])),
            ("ppt/presentation.xml", pres),
            (
                "ppt/_rels/presentation.xml.rels",
                rels(
                    [
                        ("rId1", "slide", slide_target),
                        ("rId2", "slide", "slides/slide2.xml"),
                        ("rId3", "slide", "slides/slide3.xml"),
                    ]
                ),
            ),
            ("ppt/slides/slide1.xml", slide("두 번째 장: 실험 방법", "물 200mL를 끓인다")),
            ("ppt/slides/slide2.xml", slide("발표 제목", "환경 동아리 2026")),
            ("ppt/slides/slide3.xml", slide("결론 &lt;요약&gt;")),
        ]
    )


def zip_raw(entries):
    """A ZIP written by hand: entries are (name, data, declared_size or None). Deflate; declared sizes may lie."""
    b = io.BytesIO()
    central = []
    for name, data, declared in entries:
        n = name.encode()
        comp = zlib.compressobj(9, zlib.DEFLATED, -15)
        c = comp.compress(data) + comp.flush()
        crc = zlib.crc32(data) & 0xFFFFFFFF
        size = len(data) if declared is None else declared
        off = b.tell()
        b.write(struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0, 8, 0, 0, crc, len(c), size, len(n), 0) + n + c)
        central.append(
            struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0, 8, 0, 0, crc, len(c), size, len(n), 0, 0, 0, 0, 0, off) + n
        )
    cd = b.tell()
    for c in central:
        b.write(c)
    size = b.tell() - cd
    b.write(struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(central), len(central), size, cd, 0))
    return b.getvalue()


def main():
    # 12 pages of text; page 12 is the one the acceptance prompt asks for.
    pages = [["Report page %d" % (i + 1), "Section %d covers the river survey, part %d." % (i + 1, i + 1)] for i in range(12)]
    pages[11] = [
        "Report page 12",
        "Summary: the river clean-up removed 340 kg of waste.",
        "Volunteers from 12 schools joined in March 2026.",
    ]
    out("report.pdf", text_pdf(pages))

    scan = render(["Agent Lee scan test 2026", "가족 과제 안내문 확인"])
    out("scanned.pdf", image_pdf([(jpeg(scan), scan.width, scan.height)]))
    photo = render(["Receipt total 45000 won", "영수증 합계 확인"], size=(1000, 300), font_size=40, top=40, step=110)
    out("photo.png", png(photo))
    out("photo.jpg", jpeg(photo))

    korean_txt = os.path.join(HERE, ".korean.txt")
    with open(korean_txt, "w", encoding="utf-8") as f:
        f.write("한글 보고서 첫 줄\n과제 제출은 금요일까지입니다.\n")
    with open(os.path.join(HERE, "korean.pdf"), "wb") as f:
        subprocess.run(["/usr/sbin/cupsfilter", "-i", "text/plain", "-m", "application/pdf", korean_txt], stdout=f, stderr=subprocess.DEVNULL, check=True)
    os.remove(korean_txt)

    out(
        "sample.docx",
        docx(
            wp("과제 안내")
            + wp("제출 기한은 ", "11월 30일입니다.")
            + "<w:p></w:p>"
            + wtbl([["항목", "배점"], ["보고서", "40점"], ["발표", "60점"]])
            + wp("문의는 담임 선생님께 &amp; 메일로.")
        ),
    )
    out("sample.xlsx", xlsx())
    out("sample.pptx", pptx())
    out("sample.csv", "이름,점수,비고\n민준,92,\"우수, 발표\"\n서연,88,\"\"\"인용\"\" 포함\"\n".encode("utf-8"))
    out("sample.txt", "첫째 줄입니다.\n둘째 줄에는 숫자 42가 있습니다.\n\n넷째 줄은 끝입니다.\n".encode("utf-8"))
    out("sample.md", "# 제목\n\n본문 문단입니다.\n- 항목 하나\n".encode("utf-8"))

    # Hostile inputs (each must be refused with its code).
    content = [("[Content_Types].xml", CT.encode(), None), ("_rels/.rels", rels([("rId1", "officeDocument", "word/document.xml")]).encode(), None)]
    head = '<w:document xmlns:w="%s"><w:body><w:p><w:r><w:t>' % W
    tail = "</w:t></w:r></w:p></w:body></w:document>"
    # Zip bomb: 300 MB of zeros inside document.xml (about 300 KB compressed), sizes honest.
    bomb = (head + " " * (300 * 1024 * 1024) + tail).encode()
    out("bomb.docx", zip_raw(content + [("word/document.xml", bomb, None)]))
    # The same, but its headers claim 1 KB: the inflater's own limit must stop it.
    out("bomb-lying.docx", zip_raw(content + [("word/document.xml", bomb, 1024)]))
    # XXE: an external entity reading a local file.
    xxe = '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' + head + "&xxe;" + tail
    out("xxe.docx", zip_raw(content + [("word/document.xml", xxe.encode(), None)]))
    # Billion laughs (internal entities only) in a worksheet.
    lol = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData></worksheet>'
    x = xlsx()
    with zipfile.ZipFile(io.BytesIO(x)) as z:
        parts = [(n, z.read(n), None) for n in z.namelist()]
    out("laughs.xlsx", zip_raw([(n, lol.encode() if n == "xl/worksheets/sheet1.xml" else d, s) for n, d, s in parts]))
    # Zip slip: an entry that names a path outside the archive.
    out(
        "slip.docx",
        zip_raw(content + [("word/document.xml", (head + "ok" + tail).encode(), None), ("../../evil.xml", b"<x/>", None)]),
    )
    # A slide relationship that points outside the package.
    out("escape.pptx", pptx(slide_target="../../../../etc/passwd"))


if __name__ == "__main__":
    main()
