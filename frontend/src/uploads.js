// Shared upload logic for owner + public-client flows.
// Files above CHUNK_THRESHOLD go through the resumable chunked endpoints
// (init → append* → finalize); smaller ones use a single multipart POST.
// Each chunk is retried a few times on transient network errors → "resume".

import { API } from './api.js';

const CHUNK_THRESHOLD = 8 * 1024 * 1024;   // 8 MB
const CHUNK_SIZE = 8 * 1024 * 1024;        // 8 MB
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome (and other browsers) freeze/throttle background tabs after a few
// minutes to save CPU/battery — queued microtasks (XHR onload/onprogress
// handlers) stop running, so the upload loop stalls until the tab is
// foregrounded again. Holding a Web Lock is one of the documented
// exemptions from that freezing, so we keep one held for the duration of
// the upload run. Falls back to running unguarded where unsupported.
export function withUploadLock(fn) {
  if (typeof navigator === 'undefined' || !navigator.locks || !navigator.locks.request) return fn();
  try {
    return navigator.locks.request('nyza-upload', fn);
  } catch {
    return fn();
  }
}

async function appendWithRetry(appendFn, sid, blob, onChunkProgress) {
  let attempt = 0;
  for (;;) {
    try {
      return await appendFn(sid, blob, onChunkProgress);
    } catch (err) {
      attempt++;
      if (attempt > MAX_RETRIES) throw err;
      await sleep(500 * attempt); // backoff, then resume this chunk
    }
  }
}

// Generic chunked driver. `ops` provides init/append/finalize bound to the
// owner or client endpoints. onProgress(fraction 0..1) is reported across the
// whole file (sum of completed chunks + current chunk progress).
async function chunked(file, ops, onProgress, signal) {
  const total = file.size;
  const initRes = await ops.init({
    file_name: file.name, total_size: total, chunk_size: CHUNK_SIZE,
  });
  const sid = initRes.session_id;
  let sent = 0;
  for (let offset = 0; offset < total; offset += CHUNK_SIZE) {
    if (signal && signal.aborted) throw Object.assign(new Error('Abgebrochen'), { code: 'aborted' });
    const blob = file.slice(offset, Math.min(offset + CHUNK_SIZE, total));
    const base = sent;
    await appendWithRetry((s, b, cb) => ops.append(s, b, cb, signal), sid, blob, (cp) => {
      onProgress && onProgress(Math.min(1, (base + cp * blob.size) / total));
    });
    sent += blob.size;
    onProgress && onProgress(Math.min(1, sent / total));
  }
  return ops.finalize(sid);
}

export async function uploadOwner(file, folderId, onProgress, signal, mode) {
  if (file.size > CHUNK_THRESHOLD) {
    return chunked(file, {
      init: (b) => API.chunkInit({ ...b, folder_id: folderId }),
      append: (sid, blob, cb, sig) => API.chunkAppend(sid, blob, cb, sig),
      finalize: (sid) => API.chunkFinalize(sid, mode),
    }, onProgress, signal);
  }
  return API.uploadFile(file, folderId, onProgress, signal, mode);
}

export async function uploadClient(token, file, opts, onProgress) {
  if (file.size > CHUNK_THRESHOLD) {
    return chunked(file, {
      init: (b) => API.clientChunkInit(token, {
        ...b, password: opts.password, uploader_name: opts.uploaderName, checklist_key: opts.checklistKey,
      }),
      append: (sid, blob, cb) => API.clientChunkAppend(token, sid, blob, cb),
      finalize: (sid) => API.clientChunkFinalize(token, sid),
    }, onProgress);
  }
  return API.clientUpload(token, file, opts, onProgress);
}
