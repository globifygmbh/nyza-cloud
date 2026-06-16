// API client. Reads window.NYZA_BASE (injected by index.php) so the frontend
// works at any subpath (e.g. /cloud/). Falls back to '' for `npm run dev` where
// Vite proxies /api directly.

export const BASE = (typeof window !== 'undefined' && window.NYZA_BASE) || '';

const url = (p) => BASE + p;

export function getToken() {
  return localStorage.getItem('nyza.token') || null;
}
export function setToken(t) {
  if (t) localStorage.setItem('nyza.token', t);
  else localStorage.removeItem('nyza.token');
}

async function request(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData) && opts.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
    if (typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  }
  const token = getToken();
  if (token && !opts.skipAuth) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(url(path), { ...opts, headers });
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.status = res.status;
      err.code = data.code;
      err.data = data;
      throw err;
    }
    return data;
  }
  if (!res.ok) {
    const err = new Error('Request failed (' + res.status + ')');
    err.status = res.status;
    throw err;
  }
  return res;
}

// XHR-based upload so we can wire a real progress bar.
function upload(path, file, extraFields = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(extraFields)) {
      if (v != null) fd.append(k, String(v));
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url(path));
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || 'Upload failed'), { status: xhr.status, code: data.code }));
      } catch {
        reject(new Error('Upload failed (' + xhr.status + ')'));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(fd);
  });
}

// XHR raw-body PUT/POST for a single chunk (Blob), with progress + Bearer.
function rawPut(path, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url(path));
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || 'Chunk failed'), { status: xhr.status, code: data.code }));
      } catch { reject(new Error('Chunk failed (' + xhr.status + ')')); }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(blob);
  });
}

// Generic public-path POST with JSON body (no auth) — for client chunk flow.
function pub(path, body) {
  return request(path, { method: 'POST', body, skipAuth: true });
}
function pubRaw(path, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url(path));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || 'Chunk failed'), { status: xhr.status, code: data.code }));
      } catch { reject(new Error('Chunk failed (' + xhr.status + ')')); }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(blob);
  });
}

export const API = {
  // Auth — single-user model. Registration happens once via the setup wizard.
  login:          (body) => request('/api/auth/login', { method: 'POST', body, skipAuth: true }),
  me:             ()     => request('/api/auth/me'),
  changePassword: (body) => request('/api/auth/change-password', { method: 'POST', body }),
  twoFactorLogin:   (challenge, code) => request('/api/auth/2fa/login', { method: 'POST', body: { challenge, code }, skipAuth: true }),
  twoFactorSetup:   () => request('/api/auth/2fa/setup', { method: 'POST', body: {} }),
  twoFactorEnable:  (code) => request('/api/auth/2fa/enable', { method: 'POST', body: { code } }),
  twoFactorDisable: (password, code) => request('/api/auth/2fa/disable', { method: 'POST', body: { password, code } }),
  loginHistory:     () => request('/api/auth/logins'),
  updateProfile:  (body) => request('/api/auth/profile', { method: 'PATCH', body }),
  uploadLogo:     (file) => upload('/api/auth/logo', file, {}),
  deleteLogo:     () => request('/api/auth/logo', { method: 'DELETE' }),
  logoUrl:        (uid) => url('/api/branding/logo/' + uid),

  // Folders
  folders:      (parent) => request('/api/folders' + (parent ? '?parent_id=' + parent : '')),
  allFolders:   ()       => request('/api/folders?all=1'),
  folder:       (id)     => request('/api/folders/' + id),
  newFolder:    (body)   => request('/api/folders', { method: 'POST', body }),
  renameFolder: (id, body) => request('/api/folders/' + id, { method: 'PATCH', body }),
  moveFolder:   (id, parentId) => request('/api/folders/' + id, { method: 'PATCH', body: { parent_id: parentId } }),
  deleteFolder: (id)     => request('/api/folders/' + id, { method: 'DELETE' }),

  // Files
  files:       (folder) => request('/api/files' + (folder ? '?folder_id=' + folder : '')),
  starredFiles:() => request('/api/files?starred=1'),
  recentFiles: () => request('/api/files/recent'),
  starFile:    (id, starred) => request('/api/files/' + id + '/star', { method: 'POST', body: { starred } }),
  uploadFile:  (file, folderId, onProgress) =>
    upload('/api/files', file, { folder_id: folderId }, onProgress),
  deleteFile:  (id) => request('/api/files/' + id, { method: 'DELETE' }),
  fileRawUrl:  (id) => url('/api/files/' + id + '/raw'),
  thumbUrl:    (id) => url('/api/files/' + id + '/thumb') + '?token=' + (getToken() || ''),
  createText:  (body) => request('/api/files/text', { method: 'POST', body }),
  saveContent: (id, content) => request('/api/files/' + id + '/content', { method: 'PUT', body: { content } }),
  versions:       (id) => request('/api/files/' + id + '/versions'),
  versionContent: (id, vid) => request('/api/files/' + id + '/versions/' + vid),
  restoreVersion: (id, vid) => request('/api/files/' + id + '/versions/' + vid + '/restore', { method: 'POST', body: {} }),
  searchFiles: (q) => request('/api/files/search?q=' + encodeURIComponent(q)),
  moveFile:    (id, folderId) => request('/api/files/' + id, { method: 'PATCH', body: { folder_id: folderId } }),
  moveFiles:   (ids, folderId) => request('/api/files/move', { method: 'POST', body: { file_ids: ids, folder_id: folderId } }),
  fileComments:    (id) => request('/api/files/' + id + '/comments'),
  addFileComment:  (id, body) => request('/api/files/' + id + '/comments', { method: 'POST', body: { body } }),
  delFileComment:  (id, cid) => request('/api/files/' + id + '/comments/' + cid, { method: 'DELETE' }),
  shareComments:   (token, fileId, password) => request('/api/s/' + token + '/file/' + fileId + '/comments' + (password ? '?p=' + encodeURIComponent(password) : ''), { skipAuth: true }),
  addShareComment: (token, fileId, body) => request('/api/s/' + token + '/file/' + fileId + '/comments', { method: 'POST', body, skipAuth: true }),
  zip: (body) => fetch(url('/api/files/zip'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
    body: JSON.stringify(body),
  }),
  // Owner chunked/resumable upload (large files)
  chunkInit:     (body) => request('/api/files/chunk/init', { method: 'POST', body }),
  chunkStatus:   (sid) => request('/api/files/chunk/' + sid),
  chunkAppend:   (sid, blob, onProgress) => rawPut('/api/files/chunk/' + sid, blob, onProgress),
  chunkFinalize: (sid) => request('/api/files/chunk/' + sid + '/finalize', { method: 'POST', body: {} }),

  // Trash (soft delete)
  trash:        () => request('/api/trash'),
  restoreFile:  (id) => request('/api/files/' + id + '/restore', { method: 'POST', body: {} }),
  deleteForever:(id) => request('/api/files/' + id + '/permanent', { method: 'DELETE' }),
  emptyTrash:   () => request('/api/trash/empty', { method: 'POST', body: {} }),

  // Shares
  shares:      () => request('/api/shares'),
  newShare:    (body) => request('/api/shares', { method: 'POST', body }),
  deleteShare: (id) => request('/api/shares/' + id, { method: 'DELETE' }),
  publicShare: (token, password) =>
    request('/api/s/' + token + (password ? '?p=' + encodeURIComponent(password) : ''), { skipAuth: true }),
  // download=true forces an attachment (the explicit Download buttons);
  // omit it for inline preview in the MediaViewer.
  shareFileUrl: (token, fileId, password, download = false) => {
    const qs = [];
    if (password) qs.push('p=' + encodeURIComponent(password));
    if (download) qs.push('dl=1');
    return url('/api/s/' + token + '/file/' + fileId + (qs.length ? '?' + qs.join('&') : ''));
  },
  shareZipUrl: (token, password) =>
    url('/api/s/' + token + '/zip' + (password ? '?p=' + encodeURIComponent(password) : '')),

  // Upload links (owner)
  uploadLinks:      () => request('/api/upload-links'),
  newUploadLink:    (body) => request('/api/upload-links', { method: 'POST', body }),
  deleteUploadLink: (id) => request('/api/upload-links/' + id, { method: 'DELETE' }),

  // Public client upload
  publicUploadLink: (token) => request('/api/u/' + token, { skipAuth: true }),
  unlockUploadLink: (token, password) =>
    request('/api/u/' + token + '/unlock', { method: 'POST', body: { password }, skipAuth: true }),
  clientUpload: (token, file, opts = {}, onProgress) =>
    upload('/api/u/' + token + '/upload', file, {
      password: opts.password, uploader_name: opts.uploaderName,
    }, onProgress),
  // Client chunked/resumable upload
  clientChunkInit:     (token, body) => pub('/api/u/' + token + '/chunk/init', body),
  clientChunkStatus:   (token, sid) => request('/api/u/' + token + '/chunk/' + sid, { skipAuth: true }),
  clientChunkAppend:   (token, sid, blob, onProgress) => pubRaw('/api/u/' + token + '/chunk/' + sid, blob, onProgress),
  clientChunkFinalize: (token, sid) => pub('/api/u/' + token + '/chunk/' + sid + '/finalize', {}),

  // Activity / stats
  activity: () => request('/api/activity'),
  stats:    () => request('/api/stats'),
};
