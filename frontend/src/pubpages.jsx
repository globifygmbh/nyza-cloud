// Public pages — no login. Mounted at /s/:token (share view) and /u/:token
// (client upload). Both fetch from public endpoints; no Bearer auth.

import React, { useState, useEffect, useRef } from 'react';
import { API } from './api.js';
import {
  Ic, Glass, Btn, NyzaWordmark, FileIcon, PhotoPlaceholder,
  humanSize, applyAccent,
} from './system.jsx';
import { Dropzone, UploadRow, MediaViewer, UploadReview } from './app.jsx';
import { uploadClient } from './uploads.js';
import { toast } from './toast.jsx';

export function CenteredLoader() {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', zIndex: 1 }}>
      <div style={{ color: 'var(--fg-3)' }}>{Ic.loader(28)}</div>
    </div>
  );
}

export function CenteredMessage({ title, desc }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, position: 'relative', zIndex: 1 }}>
      <Glass style={{ maxWidth: 420, borderRadius: 'var(--r-xl)', padding: 36, textAlign: 'center' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 600, letterSpacing: -0.6, margin: 0 }}>{title}</h1>
        <p style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 12, lineHeight: 1.5 }}>{desc}</p>
      </Glass>
    </div>
  );
}

export function PublicSharePage({ token }) {
  const [state, setState] = useState({ status: 'loading' });
  const [password, setPassword] = useState('');
  const [pwInput, setPwInput] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [viewing, setViewing] = useState(null);

  const load = (pw) => {
    setState({ status: 'loading' });
    API.publicShare(token, pw)
      .then((data) => setState({ status: 'ok', data }))
      .catch((err) => {
        if (err.status === 401 && err.data?.requires_password) setState({ status: 'password' });
        else if (err.status === 410) setState({ status: 'expired' });
        else if (err.status === 404) setState({ status: 'notfound' });
        else setState({ status: 'error', message: err.message });
      });
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (state.data?.owner?.accent) applyAccent(state.data.owner.accent); }, [state.data?.owner?.accent]);

  if (state.status === 'loading') return <CenteredLoader/>;
  if (state.status === 'notfound') return <CenteredMessage title="Nicht gefunden" desc="Dieser Share-Link existiert nicht oder wurde gelöscht."/>;
  if (state.status === 'expired')  return <CenteredMessage title="Link abgelaufen" desc="Dieser Share-Link ist nicht mehr gültig."/>;
  if (state.status === 'error')    return <CenteredMessage title="Fehler" desc={state.message}/>;

  if (state.status === 'password') {
    return (
      <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, position: 'relative', zIndex: 1 }}>
        <Glass style={{ width: '100%', maxWidth: 380, borderRadius: 'var(--r-xl)', padding: 32 }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            <div style={{
              width: 56, height: 56, borderRadius: 'var(--r-lg)',
              background: 'var(--accent-grad)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 12px 32px -8px var(--accent-glow)',
            }}>{Ic.lock(24)}</div>
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, letterSpacing: -0.4, margin: 0, textAlign: 'center' }}>Passwort erforderlich</h1>
          <p style={{ fontSize: 13, color: 'var(--fg-3)', textAlign: 'center', marginTop: 8 }}>Diese Dateien sind passwortgeschützt.</p>
          <form onSubmit={(e) => { e.preventDefault(); setPwBusy(true); setPassword(pwInput); load(pwInput); setPwBusy(false); }}
            style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input type="password" autoFocus value={pwInput} onChange={(e) => setPwInput(e.target.value)} placeholder="Passwort"
              style={{ height: 44, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)' }}/>
            <Btn variant="primary" size="lg" full type="submit" disabled={!pwInput || pwBusy}>Entsperren</Btn>
          </form>
        </Glass>
      </div>
    );
  }

  const data = state.data;
  const isFolder = !!data.folder;
  const items = isFolder ? data.files : (data.file ? [data.file] : []);
  const name = isFolder ? data.folder.name : (data.file?.name || 'Geteilte Datei');
  const totalSize = isFolder ? data.total_size : (data.file?.size || 0);

  return (
    <div style={{ height: '100%', overflow: 'auto', position: 'relative', zIndex: 1 }}>
      <div style={{ padding: '28px 40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {data.owner?.has_logo ? (
            <img src={API.logoUrl(data.owner.id)} alt={data.owner?.name} style={{ maxHeight: 40, maxWidth: 200, objectFit: 'contain' }}/>
          ) : (
            <>
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: 'linear-gradient(135deg, oklch(0.72 0.16 60), oklch(0.55 0.2 25))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontWeight: 700, fontSize: 13,
              }}>{(data.owner?.name || '?').slice(0, 2).toUpperCase()}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 540 }}>{data.owner?.name}</div>
                <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>{data.owner?.email}</div>
              </div>
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--fg-3)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{Ic.lock(11)} Sicher · 256-bit</span>
          <span>·</span>
          <span>via</span>
          <NyzaWordmark size={11}/>
        </div>
      </div>

      <div style={{ padding: '40px 40px 60px', display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 60, alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 24, height: 1, background: 'var(--accent)' }}/>
            Geteilte Dateien für Sie
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 56, fontWeight: 600, letterSpacing: -2, margin: 0, lineHeight: 1.0 }}>{name}</h1>
          <p style={{ fontSize: 16, color: 'var(--fg-2)', marginTop: 18, lineHeight: 1.55, maxWidth: 480 }}>
            {items.length} {items.length === 1 ? 'Datei' : 'Dateien'} · {humanSize(totalSize)}
            {data.expires_at && <> · läuft ab am {new Date(data.expires_at).toLocaleDateString('de-DE')}</>}
          </p>
          {data.allow_download && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 32 }}>
              {isFolder ? (
                <Btn variant="primary" size="xl" icon={Ic.download(20)}
                  onClick={() => location.href = API.shareZipUrl(token, password)}>
                  Alles herunterladen
                </Btn>
              ) : (
                <Btn variant="primary" size="xl" icon={Ic.download(20)}
                  onClick={() => location.href = API.shareFileUrl(token, data.file.id, password, true)}>
                  Datei herunterladen
                </Btn>
              )}
            </div>
          )}
        </div>

        <div style={{ position: 'relative', aspectRatio: '1/1', maxWidth: 440, marginLeft: 'auto' }}>
          {(items.slice(0, 3)).map((it, i) => {
            const cfg = [
              { rot: -8, x: -20, y: 30, z: 1 },
              { rot: 4,  x: 30,  y: 0,  z: 2 },
              { rot: -2, x: 0,   y: -20, z: 3 },
            ][i] || { rot: 0, x: 0, y: 0, z: 1 };
            return (
              <div key={i} style={{
                position: 'absolute', inset: 0, transform: `translate(${cfg.x}px, ${cfg.y}px) rotate(${cfg.rot}deg)`,
                borderRadius: 'var(--r-lg)', overflow: 'hidden', zIndex: cfg.z,
                boxShadow: '0 30px 80px -20px rgba(0,0,0,0.4), 0 0 0 1px var(--border)',
              }}>
                <PhotoPlaceholder hue={(it.hue || 280)} style={{ width: '100%', height: '100%' }} label={'#' + (i + 1)}/>
              </div>
            );
          })}
        </div>
      </div>

      {isFolder && items.length > 0 && (
        <div style={{ padding: '0 40px 80px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0, letterSpacing: -0.3 }}>Inhalt</h2>
            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{items.length} Dateien</span>
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {items.map((f) => {
              const previewable = ['image', 'video', 'pdf', 'audio'].includes(f.kind) || /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i.test(f.name);
              return (
                <div key={f.id} style={{
                  display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px',
                  borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)',
                  cursor: previewable ? 'pointer' : 'default',
                  transition: 'background .15s',
                }}
                onMouseEnter={(e) => { if (previewable) e.currentTarget.style.background = 'var(--surface-hi)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
                onClick={() => previewable && setViewing(f)}>
                  <FileIcon kind={f.kind} size={16} tint={f.hue}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{humanSize(f.size)}</div>
                  </div>
                  {data.allow_download && (
                    <Btn variant="glass" size="sm" icon={Ic.download(13)}
                      onClick={(e) => { e.stopPropagation(); location.href = API.shareFileUrl(token, f.id, password, true); }}>
                      Download
                    </Btn>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {viewing && (() => {
        const gal = items.filter((f) => ['image', 'video', 'pdf', 'audio'].includes(f.kind) || /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i.test(f.name));
        const list = gal.length ? gal : [viewing];
        return (
          <MediaViewer
            items={list}
            startIndex={Math.max(0, list.findIndex((x) => x.id === viewing.id))}
            srcFor={(f) => API.shareFileUrl(token, f.id, password)}
            downloadFor={(f) => data.allow_download ? API.shareFileUrl(token, f.id, password, true) : null}
            comments={{
              load: (f) => API.shareComments(token, f.id, password).then((d) => d.comments || []),
              add: (f, { body, author_name }) => API.addShareComment(token, f.id, { body, author_name, password }).then((d) => d.comments || []),
              askName: true,
            }}
            onClose={() => setViewing(null)}
          />
        );
      })()}
    </div>
  );
}

export function PublicUploadPage({ token }) {
  const [state, setState] = useState({ status: 'loading' });
  const [password, setPassword] = useState('');
  const [pwInput, setPwInput] = useState('');
  const [uploaderName, setUploaderName] = useState('');
  const [uploads, setUploads] = useState([]);
  const [done, setDone] = useState(false);
  const [review, setReview] = useState(null);
  const cameraRef = useRef(null);

  const load = () => {
    setState({ status: 'loading' });
    API.publicUploadLink(token)
      .then((data) => setState({ status: 'ok', data }))
      .catch((err) => {
        if (err.status === 404) setState({ status: 'notfound' });
        else if (err.status === 410) setState({ status: 'expired' });
        else if (err.status === 429) setState({ status: 'limit' });
        else setState({ status: 'error', message: err.message });
      });
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (state.data?.owner?.accent) applyAccent(state.data.owner.accent); }, [state.data?.owner?.accent]);

  const checkPassword = async () => {
    try {
      await API.unlockUploadLink(token, pwInput);
      setPassword(pwInput);
    } catch (e) { toast(e.message, 'error'); }
  };

  if (state.status === 'loading') return <CenteredLoader/>;
  if (state.status === 'notfound') return <CenteredMessage title="Nicht gefunden" desc="Dieser Upload-Link existiert nicht."/>;
  if (state.status === 'expired')  return <CenteredMessage title="Link abgelaufen" desc="Dieser Upload-Link ist nicht mehr gültig."/>;
  if (state.status === 'limit')    return <CenteredMessage title="Limit erreicht" desc="Die maximale Anzahl an Uploads wurde bereits erreicht."/>;
  if (state.status === 'error')    return <CenteredMessage title="Fehler" desc={state.message}/>;

  const link = state.data;

  if (link.requires_password && !password) {
    return (
      <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, position: 'relative', zIndex: 1 }}>
        <Glass style={{ width: '100%', maxWidth: 380, borderRadius: 'var(--r-xl)', padding: 32 }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            <div style={{
              width: 56, height: 56, borderRadius: 'var(--r-lg)',
              background: 'var(--accent-grad)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 12px 32px -8px var(--accent-glow)',
            }}>{Ic.lock(24)}</div>
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, letterSpacing: -0.4, margin: 0, textAlign: 'center' }}>Passwort erforderlich</h1>
          <p style={{ fontSize: 13, color: 'var(--fg-3)', textAlign: 'center', marginTop: 8 }}>Bitte Passwort eingeben, um Dateien hochzuladen.</p>
          <form onSubmit={(e) => { e.preventDefault(); checkPassword(); }}
            style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input type="password" autoFocus value={pwInput} onChange={(e) => setPwInput(e.target.value)} placeholder="Passwort"
              style={{ height: 44, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)' }}/>
            <Btn variant="primary" size="lg" full type="submit" disabled={!pwInput}>Entsperren</Btn>
          </form>
        </Glass>
      </div>
    );
  }

  // Pick → review → confirm → upload.
  const onFiles = (files) => {
    if (link.requires_uploader_name && !uploaderName.trim()) {
      toast('Bitte zuerst deinen Namen eingeben', 'error');
      return;
    }
    setReview(files);
  };

  const doUpload = async (files) => {
    setReview(null);
    const items = files.map((f) => ({
      name: f.name, size: f.size, status: 'queued', pct: 0,
      kind: f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : f.type === 'application/pdf' ? 'pdf' : 'doc',
    }));
    setUploads(items);
    let allOk = true;
    for (let i = 0; i < files.length; i++) {
      setUploads((u) => u.map((x, j) => j === i ? { ...x, status: 'uploading' } : x));
      try {
        await uploadClient(token, files[i],
          { password, uploaderName: uploaderName || undefined },
          (p) => setUploads((u) => u.map((x, j) => j === i ? { ...x, pct: p } : x)));
        setUploads((u) => u.map((x, j) => j === i ? { ...x, status: 'done', pct: 1 } : x));
      } catch (err) {
        allOk = false;
        setUploads((u) => u.map((x, j) => j === i ? { ...x, status: 'error' } : x));
        toast(err.message, 'error');
      }
    }
    if (allOk) setTimeout(() => setDone(true), 600);
  };

  if (done) return <UploadSuccess uploads={uploads} onMore={() => { setDone(false); setUploads([]); load(); }}/>;

  return (
    <div style={{ height: '100%', overflow: 'auto', position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '24px 40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {link.owner?.has_logo ? (
            <img src={API.logoUrl(link.owner.id)} alt={link.owner?.name} style={{ maxHeight: 38, maxWidth: 200, objectFit: 'contain' }}/>
          ) : (
            <>
              <div style={{
                width: 30, height: 30, borderRadius: 8,
                background: 'linear-gradient(135deg, oklch(0.72 0.16 60), oklch(0.55 0.2 25))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontWeight: 700, fontSize: 12,
              }}>{(link.owner?.name || '?').slice(0, 2).toUpperCase()}</div>
              <span style={{ fontSize: 13, fontWeight: 540 }}>{link.owner?.name}</span>
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-3)', padding: '6px 10px', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--success)' }}/>
          Sicherer Upload · keine Anmeldung
        </div>
      </div>

      <div style={{ flex: 1, padding: '20px 40px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 720, textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 14 }}>
            Upload für {link.owner?.name}
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 48, fontWeight: 600, letterSpacing: -1.6, margin: 0, lineHeight: 1.05 }}>
            <span style={{ background: 'var(--accent-grad)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>{link.title}</span>
          </h1>
          {link.description && (
            <p style={{ fontSize: 15, color: 'var(--fg-3)', marginTop: 14, lineHeight: 1.55, maxWidth: 540, margin: '14px auto 0' }}>{link.description}</p>
          )}
        </div>

        {link.requires_uploader_name && (
          <input value={uploaderName} onChange={(e) => setUploaderName(e.target.value)} placeholder="Dein Name"
            style={{ width: '100%', maxWidth: 720, height: 48, padding: '0 16px', marginBottom: 16,
              borderRadius: 'var(--r-md)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)' }}/>
        )}

        {uploads.length > 0 ? (
          <div style={{ width: '100%', maxWidth: 720 }}>
            <Glass style={{ borderRadius: 'var(--r-xl)', padding: 24 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {uploads.map((f, i) => <UploadRow key={i} file={f}/>)}
              </div>
            </Glass>
          </div>
        ) : (
          <div style={{ width: '100%', maxWidth: 720 }}>
            <Dropzone big onFiles={onFiles}
              label="Zieh deine Dateien hier rein"
              sub={'oder klicke zum Auswählen' + (link.max_file_size ? ' · max. ' + humanSize(link.max_file_size) + ' pro Datei' : '')}/>
            {/* Mobile camera capture — opens the camera directly on phones. */}
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
              <Btn variant="glass" size="md" icon={Ic.camera(16)} onClick={() => cameraRef.current?.click()}>Foto aufnehmen</Btn>
            </div>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
              onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length) onFiles(fs); e.target.value = ''; }}/>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginTop: 28, fontSize: 12, color: 'var(--fg-3)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{Ic.lock(13)} Verschlüsselte Übertragung</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{Ic.bolt(13)} Resume bei Abbruch</span>
          {link.remaining != null && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{Ic.check(13)} {link.remaining} Slots frei</span>
          )}
        </div>
      </div>

      {review && (
        <UploadReview files={review} maxFileSize={link.max_file_size || undefined}
          onConfirm={doUpload} onCancel={() => setReview(null)}/>
      )}
    </div>
  );
}

function UploadSuccess({ uploads, onMore }) {
  const total = uploads.reduce((s, u) => s + u.size, 0);
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, position: 'relative', zIndex: 1 }}>
      <div style={{ maxWidth: 480, textAlign: 'center' }}>
        <div style={{ position: 'relative', width: 120, height: 120, margin: '0 auto 28px' }}>
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--success)', opacity: 0.3, filter: 'blur(30px)' }}/>
          <div style={{
            position: 'absolute', inset: 12, borderRadius: '50%',
            background: 'linear-gradient(135deg, oklch(0.78 0.16 155), oklch(0.62 0.18 155))',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
            boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 20px 60px -10px oklch(0.74 0.16 155 / 0.6)',
          }}>{Ic.check(48)}</div>
        </div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 38, fontWeight: 600, letterSpacing: -1.2, margin: 0, lineHeight: 1.05 }}>Upload erfolgreich.</h1>
        <p style={{ fontSize: 15, color: 'var(--fg-2)', marginTop: 14, lineHeight: 1.55 }}>
          {uploads.length} Dateien · {humanSize(total)} wurden sicher übertragen.<br/>
          <span style={{ color: 'var(--fg-3)' }}>Der Empfänger wurde benachrichtigt.</span>
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 28 }}>
          <Btn variant="primary" size="lg" icon={Ic.upload(15)} onClick={onMore}>Weitere hochladen</Btn>
        </div>
      </div>
    </div>
  );
}
