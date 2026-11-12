// OCR of the extractor (#48): tesseract.js (WebAssembly, in this process's worker threads — no child process) with
// the Korean and English LSTM models from the pinned `@tesseract.js-data/kor` / `eng` packages, copied by the
// server into a folder this sandbox may read. Nothing is downloaded: `langPath` is that local folder and no cache
// is written. The server decides whether OCR is available (`ocrCapability`, apps/server/src/files/extract.ts);
// without it the job has no `ocr` and pictures are reported as `ocr_unavailable`.

/**
 * `{ recognize(image) → { text, marks }, close() }`. `marks` are `[start, end, { box: [x0, y0, x1, y1] }]` in the
 * image's pixels, one per word; `text` is the words of a line joined by spaces, lines by newlines.
 */
export async function createOcr({ tesseract, langDir }) {
  const worker = await tesseract.createWorker(["kor", "eng"], 1, {
    langPath: langDir,
    cacheMethod: "none",
    gzip: true,
    // Errors come back as rejections; the worker never logs content.
    errorHandler: () => {},
  });
  return {
    async recognize(image) {
      const r = await worker.recognize(image, {}, { blocks: true, text: false });
      let text = "";
      const marks = [];
      for (const block of r.data.blocks ?? [])
        for (const para of block.paragraphs ?? [])
          for (const line of para.lines ?? []) {
            const words = (line.words ?? []).filter((w) => w.text && w.text.trim());
            if (!words.length) continue;
            if (text) text += "\n";
            words.forEach((w, i) => {
              if (i) text += " ";
              const s = text.length;
              text += w.text.trim();
              marks.push([s, text.length, { box: [w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1] }]);
            });
          }
      return { text, marks };
    },
    close: () => worker.terminate(),
  };
}
