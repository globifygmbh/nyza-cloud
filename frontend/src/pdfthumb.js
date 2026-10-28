// First page of a PDF as a JPEG Blob, for the file's thumbnail. Imported
// lazily from videoposter.js so pdf.js only loads when a PDF needs one.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_W = 480;

/** `source` is a File/Blob or a same-origin URL. Resolves null on failure. */
export async function renderPdfThumb(source) {
  let task = null;
  try {
    const params = typeof source === 'string'
      ? { url: source }
      : { data: new Uint8Array(await source.arrayBuffer()) };
    task = pdfjs.getDocument(params);
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const v = page.getViewport({ scale: MAX_W / base.width });
    const c = document.createElement('canvas');
    c.width = Math.round(v.width);
    c.height = Math.round(v.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; // transparent PDF backgrounds → white, not black JPEG
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: v }).promise;
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
  } catch {
    return null;
  } finally {
    if (task) task.destroy();
  }
}
