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

export const API = {
  // Auth — single-user model. Registration happens once via the setup wizard.
  login:          (body) => request('/api/auth/login', { method: 'POST', body, skipAuth: true }),
  me:             ()     => request('/api/auth/me'),
  changePassword: (body) => request('/api/auth/change-password', { method: 'POST', body }),

  // Folders
  folders:      (parent) => request('/api/folders' + (parent ? '?parent_id=' + parent : '')),
  folder:       (id)     => request('/api/folders/' + id),
  newFolder:    (body)   => request('/api/folders', { method: 'POST', body }),
  renameFolder: (id, body) => request('/api/folders/' + id, { method: 'PATCH', body }),
  deleteFolder: (id)     => request('/api/folders/' + id, { method: 'DELETE' }),

  // Files
  files:       (folder) => request('/api/files' + (folder ? '?folder_id=' + folder : '')),
  uploadFile:  (file, folderId, onProgress) =>
    upload('/api/files', file, { folder_id: folderId }, onProgress),
  deleteFile:  (id) => request('/api/files/' + id, { method: 'DELETE' }),
  fileRawUrl:  (id) => url('/api/files/' + id + '/raw'),
  zip: (body) => fetch(url('/api/files/zip'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
    body: JSON.stringify(body),
  }),

  // Shares
  shares:      () => request('/api/shares'),
  newShare:    (body) => request('/api/shares', { method: 'POST', body }),
  deleteShare: (id) => request('/api/shares/' + id, { method: 'DELETE' }),
  publicShare: (token, password) =>
    request('/api/s/' + token + (password ? '?p=' + encodeURIComponent(password) : ''), { skipAuth: true }),
  shareFileUrl: (token, fileId, password) =>
    url('/api/s/' + token + '/file/' + fileId + (password ? '?p=' + encodeURIComponent(password) : '')),
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

  // Activity / stats
  activity: () => request('/api/activity'),
  stats:    () => request('/api/stats'),
};
