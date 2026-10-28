// Video posters: a still frame captured in the browser and stored on the
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

/** Grab one frame (~1 s in, or a quarter in for short clips) as a JPEG Blob.
 *  `source` is a File/Blob or a same-origin URL. Resolves null on failure. */
export async function capturePoster(source) {
  const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';
  let timer;
  try {
    const work = (async () => {
      v.src = objectUrl || source;
      await once(v, 'loadedmetadata');
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      const at = d > 0 ? Math.min(1, d / 4) : 0;
      if (v.readyState < 2) await once(v, 'loadeddata');
      if (at > 0) { v.currentTime = at; await once(v, 'seeked'); }
      if (!v.videoWidth || !v.videoHeight) return null;
      const scale = Math.min(1, MAX_W / v.videoWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
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

function schedule(id, source) {
  const p = chain.then(async () => {
    const blob = await capturePoster(source);
    if (!blob) return false;
    try { await API.setPoster(id, blob); return true; } catch { return false; }
  });
  chain = p.catch(() => {});
  attempts.set(id, p);
  return p;
}

/** Right after an upload: capture from the local file (no download needed). */
export function posterFromUpload(id, file) {
  if (!id || attempts.has(id)) return attempts.get(id);
  return schedule(id, file);
}

/** A video tile without a poster: backfill it from the stream (owner only).
 *  Resolves true once a poster is stored. */
export function ensurePoster(file) {
  if (!file?.id) return Promise.resolve(false);
  if (attempts.has(file.id)) return attempts.get(file.id);
  if (ownerId == null || (file.user_id != null && Number(file.user_id) !== Number(ownerId))) return Promise.resolve(false);
  return schedule(file.id, `${API.fileRawUrl(file.id)}?token=${getToken() || ''}`);
}
