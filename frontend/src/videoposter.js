// Posters — a video still or a PDF's first page — captured in the browser and stored on the
// server as the video's thumbnail (POST /api/files/:id/poster). Shared
// hosting rarely has ffmpeg, and the device that uploads a video can almost
// always decode it (an iPhone its own HEVC .mov), so capture happens there —
// at upload from the local File, or later from the stream for videos that
// predate this, the first time their owner sees them.
//
// Captures run one at a time (decoding several videos at once is heavy on
// phones), and each file is attempted at most once per page load.

import { API, getToken } from './api.js';

const MAX_W = 640;
const TIMEOUT_MS = 20000;

let ownerId = null;
/** Only the owner may store a poster; skip backfills for anyone else's files. */
export function setPosterOwner(id) { ownerId = id ?? null; }

function once(el, ev) {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('video error')); };
    const cleanup = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

function isBlank(g, c) {
  const px = g.getImageData(0, 0, c.width, c.height).data;
  const step = Math.max(4, Math.floor(px.length / 4 / 400) * 4); // ~400 samples
  for (let i = 0; i < px.length; i += step) {
    if (px[i] > 24 || px[i + 1] > 24 || px[i + 2] > 24) return false;
  }
  return true;
}

/** Grab one frame (~1 s in, or a quarter in for short clips) as a JPEG Blob.
 *  `source` is a File/Blob or a same-origin URL. Resolves null on failure. */
export async function capturePoster(source) {
  const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  // 'metadata', not 'auto': we only need one frame, and Safari otherwise
  // starts pulling the whole video.
  v.preload = 'metadata';
  let timer;
  try {
    const work = (async () => {
      v.src = objectUrl || source;
      await once(v, 'loadedmetadata');
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      const at = d > 0 ? Math.min(1, d / 4) : 0;
      // Seeking loads the frame it lands on; with preload=metadata Safari may
      // never fire loadeddata on its own, so only wait for it at t=0.
      const seek = async (t) => { const s = once(v, 'seeked'); v.currentTime = t; await s; };
      if (at > 0) await seek(at);
      else if (v.readyState < 2) await once(v, 'loadeddata');
      if (!v.videoWidth || !v.videoHeight) return null;
      const scale = Math.min(1, MAX_W / v.videoWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      const g = c.getContext('2d');
      g.drawImage(v, 0, 0, c.width, c.height);
      // A black frame is either a fade-in or a video the browser couldn't
      // actually decode. Try once further in; never store a black poster.
      if (isBlank(g, c) && d > 2) { await seek(d / 2); g.drawImage(v, 0, 0, c.width, c.height); }
      if (isBlank(g, c)) return null;
      return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    })();
    const timeout = new Promise((r) => { timer = setTimeout(() => r(null), TIMEOUT_MS); });
    return await Promise.race([work, timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    v.removeAttribute('src');
    try { v.load(); } catch {}
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

// Serial queue + per-file memo (id → Promise<boolean>).
const attempts = new Map();
let chain = Promise.resolve();

async function capture(kind, source) {
  if (kind === 'pdf') {
    const { renderPdfThumb } = await import('./pdfthumb.js');
    return renderPdfThumb(source);
  }
  return capturePoster(source);
}

function schedule(id, kind, source) {
  const p = chain.then(async () => {
    const blob = await capture(kind, source);
    if (!blob) return false;
    try { await API.setPoster(id, blob); return true; } catch { return false; }
  });
  chain = p.catch(() => {});
  attempts.set(id, p);
  return p;
}

/** Right after an upload: capture from the local file (no download needed).
 *  kind: 'video' | 'pdf'. */
export function posterFromUpload(id, file, kind = 'video') {
  if (!id || attempts.has(id)) return attempts.get(id);
  return schedule(id, kind, file);
}

// Safari / anything WebKit (all iOS browsers): frames drawn from a streamed
// video come out black there, and the extra stream per video competes with
// playback on a host with few PHP workers. Capture from the local file at
// upload works fine, so only the video backfill is skipped. PDFs render
// through pdf.js and are fine everywhere.
const WEBKIT = typeof navigator !== 'undefined'
  && (/^((?!chrome|chromium|crios|fxios|edg|android).)*safari/i.test(navigator.userAgent)
    || /iP(hone|ad|od)/.test(navigator.userAgent));

/** Whether a missing poster for this file can be captured from the stream. */
export function canBackfill(file) {
  if (!file?.id || ownerId == null) return false;
  if (file.kind === 'video' && WEBKIT) return false;
  if (file.kind !== 'video' && file.kind !== 'pdf') return false;
  return file.user_id == null || Number(file.user_id) === Number(ownerId);
}

/** A tile without a poster: backfill it from the stream (owner only).
 *  Resolves true once a poster is stored. */
export function ensurePoster(file) {
  if (!file?.id) return Promise.resolve(false);
  if (attempts.has(file.id)) return attempts.get(file.id);
  if (!canBackfill(file)) return Promise.resolve(false);
  return schedule(file.id, file.kind, `${API.fileRawUrl(file.id)}?token=${getToken() || ''}`);
}
