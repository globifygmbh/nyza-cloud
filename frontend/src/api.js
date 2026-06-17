// API client. Reads window.NYZA_BASE (injected by index.php) so the frontend
// works at any subpath (e.g. /cloud/). Falls back to '' for `npm run dev` where
// Vite proxies /api directly.

export const BASE = (typeof window !== 'undefined' && window.NYZA_BASE) || '';

const url = (p) => BASE + p;
const ledgerQ = (year, opts = {}) => '?year=' + year + (opts.month ? '&month=' + opts.month : '') + (opts.quarter ? '&quarter=' + opts.quarter : '');

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
function upload(path, file, extraFields = {}, onProgress, signal) {
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
    if (signal) {
      if (signal.aborted) { xhr.abort(); return reject(Object.assign(new Error('Abgebrochen'), { code: 'aborted' })); }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
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
    xhr.onabort = () => reject(Object.assign(new Error('Abgebrochen'), { code: 'aborted' }));
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(fd);
  });
}

// XHR raw-body PUT/POST for a single chunk (Blob), with progress + Bearer.
function rawPut(path, blob, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url(path));
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (signal) {
      if (signal.aborted) { xhr.abort(); return reject(Object.assign(new Error('Abgebrochen'), { code: 'aborted' })); }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || 'Chunk failed'), { status: xhr.status, code: data.code }));
      } catch { reject(new Error('Chunk failed (' + xhr.status + ')')); }
    };
    xhr.onabort = () => reject(Object.assign(new Error('Abgebrochen'), { code: 'aborted' }));
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
  twoFactorRecoveryCodes: () => request('/api/auth/2fa/recovery-codes', { method: 'POST', body: {} }),
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
  pinFile:     (id) => request('/api/files/' + id + '/pin', { method: 'POST', body: {} }),
  pinFolder:   (id) => request('/api/folders/' + id + '/pin', { method: 'POST', body: {} }),
  labelFile:   (id, label) => request('/api/files/' + id + '/label', { method: 'POST', body: { label: label ?? null } }),
  shareSetLabel: (token, fileId, label, password) => request('/api/s/' + token + '/file/' + fileId + '/label' + (password ? '?p=' + encodeURIComponent(password) : ''), { method: 'POST', body: { label: label ?? null }, skipAuth: true }),
  uploadFile:  (file, folderId, onProgress, signal, mode) =>
    upload('/api/files', file, { folder_id: folderId, mode }, onProgress, signal),
  deleteFile:  (id) => request('/api/files/' + id, { method: 'DELETE' }),
  fileRawUrl:  (id) => url('/api/files/' + id + '/raw'),
  thumbUrl:    (id) => url('/api/files/' + id + '/thumb') + '?token=' + (getToken() || ''),
  unzipFile:   (id) => request('/api/files/' + id + '/unzip', { method: 'POST', body: {} }),
  createText:  (body) => request('/api/files/text', { method: 'POST', body }),
  saveContent: (id, content) => request('/api/files/' + id + '/content', { method: 'PUT', body: { content } }),
  versions:       (id) => request('/api/files/' + id + '/versions'),
  versionContent: (id, vid) => request('/api/files/' + id + '/versions/' + vid),
  versionRawUrl:  (id, vid) => url('/api/files/' + id + '/versions/' + vid + '/raw') + '?token=' + (getToken() || ''),
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
  chunkAppend:   (sid, blob, onProgress, signal) => rawPut('/api/files/chunk/' + sid, blob, onProgress, signal),
  chunkFinalize: (sid, mode) => request('/api/files/chunk/' + sid + '/finalize', { method: 'POST', body: { mode } }),

  // Trash (soft delete)
  trash:        () => request('/api/trash'),
  restoreFile:  (id) => request('/api/files/' + id + '/restore', { method: 'POST', body: {} }),
  deleteForever:(id) => request('/api/files/' + id + '/permanent', { method: 'DELETE' }),
  emptyTrash:   () => request('/api/trash/empty', { method: 'POST', body: {} }),

  // Shares
  shares:      () => request('/api/shares'),
  newShare:    (body) => request('/api/shares', { method: 'POST', body }),
  updateShare: (id, body) => request('/api/shares/' + id, { method: 'PATCH', body }),
  deleteShare: (id) => request('/api/shares/' + id, { method: 'DELETE' }),
  shareEvents: (id) => request('/api/shares/' + id + '/events'),
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
  shareThumbUrl: (token, fileId, password) =>
    url('/api/s/' + token + '/file/' + fileId + '/thumb' + (password ? '?p=' + encodeURIComponent(password) : '')),

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

  // Apps · Tasks
  tasks:         (opts = {}) => { const qs = []; if (opts.assignee) qs.push('assignee=' + opts.assignee); if (opts.owner) qs.push('owner=' + opts.owner); if (opts.mine) qs.push('mine=1'); return request('/api/tasks' + (qs.length ? '?' + qs.join('&') : '')); },
  users:         () => request('/api/users'),

  // Internal sharing between members
  internalShares:  (opts = {}) => request('/api/internal-shares' + (opts.folder_id ? '?folder_id=' + opts.folder_id : opts.file_id ? '?file_id=' + opts.file_id : '')),
  shareInternal:   (body) => request('/api/internal-shares', { method: 'POST', body }),
  unshareInternal: (id) => request('/api/internal-shares/' + id, { method: 'DELETE' }),
  sharedWithMe:    () => request('/api/shared-with-me'),
  tasksArchived: () => request('/api/tasks/archived'),
  newTask:       (body) => request('/api/tasks', { method: 'POST', body }),
  updateTask:    (id, body) => request('/api/tasks/' + id, { method: 'PATCH', body }),
  taskDone:      (id) => request('/api/tasks/' + id + '/done', { method: 'POST', body: {} }),
  taskRestore:   (id) => request('/api/tasks/' + id + '/restore', { method: 'POST', body: {} }),
  deleteTask:    (id) => request('/api/tasks/' + id, { method: 'DELETE' }),

  // Apps · Kontakte (CRM)
  contacts:      (opts = {}) => request('/api/contacts' + (opts.customers ? '?customers=1' : '') + (opts.q ? (opts.customers ? '&' : '?') + 'q=' + encodeURIComponent(opts.q) : '')),
  newContact:    (body) => request('/api/contacts', { method: 'POST', body }),
  updateContact: (id, body) => request('/api/contacts/' + id, { method: 'PATCH', body }),
  deleteContact: (id) => request('/api/contacts/' + id, { method: 'DELETE' }),

  // Apps · Zeiten (time tracking)
  timeEntries:   (opts = {}) => { const qs = []; if (opts.from) qs.push('from=' + opts.from); if (opts.to) qs.push('to=' + opts.to); if (opts.user_id) qs.push('user_id=' + opts.user_id); return request('/api/time' + (qs.length ? '?' + qs.join('&') : '')); },
  timeRunning:   () => request('/api/time/running'),
  timeStart:     (body) => request('/api/time/start', { method: 'POST', body }),
  timeStop:      (id) => request('/api/time/' + id + '/stop', { method: 'POST', body: {} }),
  newTimeEntry:  (body) => request('/api/time', { method: 'POST', body }),
  updateTimeEntry: (id, body) => request('/api/time/' + id, { method: 'PATCH', body }),
  deleteTimeEntry: (id) => request('/api/time/' + id, { method: 'DELETE' }),
  timeBillable:    (contactId) => request('/api/time/billable?contact_id=' + contactId),
  invoiceFromTime: (body) => request('/api/time/invoice', { method: 'POST', body }),

  // Apps · Roadmap
  roadmap:          () => request('/api/roadmap'),
  newRoadmapStep:   (body) => request('/api/roadmap', { method: 'POST', body }),
  updateRoadmapStep:(id, body) => request('/api/roadmap/' + id, { method: 'PATCH', body }),
  deleteRoadmapStep:(id) => request('/api/roadmap/' + id, { method: 'DELETE' }),
  addRoadmapTask:   (id, title) => request('/api/roadmap/' + id + '/tasks', { method: 'POST', body: { title } }),
  updateRoadmapTask:(id, tid, body) => request('/api/roadmap/' + id + '/tasks/' + tid, { method: 'PATCH', body }),
  deleteRoadmapTask:(id, tid) => request('/api/roadmap/' + id + '/tasks/' + tid, { method: 'DELETE' }),

  // Push notifications
  pushKey:        () => request('/api/push/key'),
  pushSubscribe:  (body) => request('/api/push/subscribe', { method: 'POST', body }),
  pushUnsubscribe:(endpoint) => request('/api/push/unsubscribe', { method: 'POST', body: { endpoint } }),
  pushTest:       () => request('/api/push/test', { method: 'POST', body: {} }),

  // Admin · user management
  adminUsers:      () => request('/api/admin/users'),
  adminCreateUser: (body) => request('/api/admin/users', { method: 'POST', body }),
  adminUpdateUser: (id, body) => request('/api/admin/users/' + id, { method: 'PATCH', body }),
  adminDeleteUser: (id) => request('/api/admin/users/' + id, { method: 'DELETE' }),
  adminCron:       () => request('/api/admin/cron'),

  // App settings (namespaced JSON store)
  getSettings:  (ns) => request('/api/settings/' + ns),
  saveSettings: (ns, body) => request('/api/settings/' + ns, { method: 'PUT', body }),

  // Apps · Buchhaltung — documents (Angebote/Rechnungen) + products
  documents:      (type) => request('/api/documents' + (type ? '?type=' + type : '')),
  document:       (id) => request('/api/documents/' + id),
  newDocument:    (body) => request('/api/documents', { method: 'POST', body }),
  updateDocument: (id, body) => request('/api/documents/' + id, { method: 'PATCH', body }),
  deleteDocument: (id) => request('/api/documents/' + id, { method: 'DELETE' }),
  markDocPaid:    (id, paid_date) => request('/api/documents/' + id + '/mark-paid', { method: 'POST', body: { paid_date } }),
  unmarkDocPaid:  (id) => request('/api/documents/' + id + '/unmark-paid', { method: 'POST', body: {} }),
  convertDoc:     (id) => request('/api/documents/' + id + '/convert', { method: 'POST', body: {} }),
  docPdfUrl:      (id, download) => url('/api/documents/' + id + '/pdf') + '?token=' + (getToken() || '') + (download ? '&download=1' : ''),
  archiveDocument: (id) => request('/api/documents/' + id + '/archive', { method: 'POST', body: {} }),
  documentReminders: (id) => request('/api/documents/' + id + '/reminders'),
  createReminder: (id) => request('/api/documents/' + id + '/reminders', { method: 'POST', body: {} }),
  deleteReminder: (id) => request('/api/reminders/' + id, { method: 'DELETE' }),
  reminderPdfUrl: (id, download) => url('/api/reminders/' + id + '/pdf') + '?token=' + (getToken() || '') + (download ? '&download=1' : ''),
  products:       () => request('/api/products'),
  newProduct:     (body) => request('/api/products', { method: 'POST', body }),
  updateProduct:  (id, body) => request('/api/products/' + id, { method: 'PATCH', body }),
  deleteProduct:  (id) => request('/api/products/' + id, { method: 'DELETE' }),

  // Buchhaltung · wiederkehrend (Abos + Perioden)
  subscriptions:     () => request('/api/subscriptions'),
  newSubscription:   (body) => request('/api/subscriptions', { method: 'POST', body }),
  updateSubscription:(id, body) => request('/api/subscriptions/' + id, { method: 'PATCH', body }),
  deleteSubscription:(id) => request('/api/subscriptions/' + id, { method: 'DELETE' }),
  subscriptionPeriods:(id) => request('/api/subscriptions/' + id + '/periods'),

  // Buchhaltung · Ausgaben (expenses)
  expenses:        (opts = {}) => { const qs = []; if (opts.from) qs.push('from=' + opts.from); if (opts.to) qs.push('to=' + opts.to); if (opts.category) qs.push('category=' + encodeURIComponent(opts.category)); return request('/api/expenses' + (qs.length ? '?' + qs.join('&') : '')); },
  newExpense:      (body) => request('/api/expenses', { method: 'POST', body }),
  updateExpense:   (id, body) => request('/api/expenses/' + id, { method: 'PATCH', body }),
  deleteExpense:   (id) => request('/api/expenses/' + id, { method: 'DELETE' }),
  expenseMarkPaid: (id, paid_date) => request('/api/expenses/' + id + '/mark-paid', { method: 'POST', body: { paid_date } }),
  expenseUnmarkPaid:(id) => request('/api/expenses/' + id + '/unmark-paid', { method: 'POST', body: {} }),
  uploadExpenseReceipt: (id, file) => { const fd = new FormData(); fd.append('file', file); return request('/api/expenses/' + id + '/receipt', { method: 'POST', body: fd }); },
  deleteExpenseReceipt: (id) => request('/api/expenses/' + id + '/receipt', { method: 'DELETE' }),
  expenseReceiptUrl: (id, download) => url('/api/expenses/' + id + '/receipt') + '?token=' + (getToken() || '') + (download ? '&download=1' : ''),

  // Buchhaltung · Auswertung
  report:    (year, opts = {}) => request('/api/reports?year=' + year + (opts.month ? '&month=' + opts.month : '') + (opts.quarter ? '&quarter=' + opts.quarter : '')),
  datevUrl:  (year, opts = {}) => url('/api/reports/datev') + '?year=' + year + (opts.month ? '&month=' + opts.month : '') + (opts.quarter ? '&quarter=' + opts.quarter : '') + '&download=1&token=' + (getToken() || ''),
  importParse:  (file) => { const fd = new FormData(); fd.append('file', file); return request('/api/import/parse', { method: 'POST', body: fd }); },
  importCommit: (records) => request('/api/import/commit', { method: 'POST', body: { records } }),

  // Buchhaltung · Doppik (double-entry / GmbH)
  ledgerAccounts:    () => request('/api/ledger/accounts'),
  newLedgerAccount:  (body) => request('/api/ledger/accounts', { method: 'POST', body }),
  deleteLedgerAccount: (number) => request('/api/ledger/accounts/' + number, { method: 'DELETE' }),
  ledgerJournal:     (year, opts = {}) => request('/api/ledger/journal' + ledgerQ(year, opts)),
  ledgerGuv:         (year, opts = {}) => request('/api/ledger/guv' + ledgerQ(year, opts)),
  ledgerBalances:    (year, opts = {}) => request('/api/ledger/balances' + ledgerQ(year, opts)),
  ledgerBalanceSheet:(year) => request('/api/ledger/balance-sheet?year=' + year),
  newLedgerEntry:    (body) => request('/api/ledger/entries', { method: 'POST', body }),
  deleteLedgerEntry: (id) => request('/api/ledger/entries/' + id, { method: 'DELETE' }),
  ledgerDatevUrl:    (year, opts = {}) => url('/api/ledger/datev') + ledgerQ(year, opts) + '&download=1&token=' + (getToken() || ''),
  periodMarkPaid:    (id, paid_date) => request('/api/periods/' + id + '/mark-paid', { method: 'POST', body: { paid_date } }),
  periodUnmarkPaid:  (id) => request('/api/periods/' + id + '/unmark-paid', { method: 'POST', body: {} }),
  periodInvoice:     (id) => request('/api/periods/' + id + '/invoice', { method: 'POST', body: {} }),

  // Apps · Kalender
  calendarEvents: (from, to) => request('/api/calendar/events?from=' + from + '&to=' + to),
  newEvent:       (body) => request('/api/calendar/events', { method: 'POST', body }),
  updateEvent:    (id, body) => request('/api/calendar/events/' + id, { method: 'PATCH', body }),
  deleteEvent:    (id) => request('/api/calendar/events/' + id, { method: 'DELETE' }),
};
