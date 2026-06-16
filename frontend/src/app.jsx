// Authenticated app shell + screens.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { API, getToken, setToken } from './api.js';
import {
  Ic, Glass, Btn, IconBtn, NyzaWordmark, FileIcon, PhotoPlaceholder,
  Toggle, CircularProgress, humanSize, timeAgo,
} from './system.jsx';
import { toast } from './toast.jsx';
import { uploadOwner } from './uploads.js';

// Track viewport for mobile-responsive chrome.
function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 760);
  useEffect(() => {
    const fn = () => setM(window.innerWidth <= 760);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return m;
}

// Authenticated media URL — <img>/<video>/<iframe> can't send an Authorization
// header, so the JWT rides along as ?token= (backend Auth::fromRequest accepts
// it as a fallback).
const fileSrc = (id) => API.fileRawUrl(id) + '?token=' + (getToken() || '');
const fileDownload = (id) => API.fileRawUrl(id) + '?token=' + (getToken() || '');

// Textual files the in-app viewer can show (and, for owners, edit).
const TEXT_EXT = ['txt','md','markdown','csv','tsv','log','json','xml','yml','yaml','ini','conf','cfg','env','js','jsx','ts','tsx','css','scss','less','html','htm','sql','py','rb','go','rs','java','c','cpp','h','hpp','sh','bash'];
function isTextFile(f) {
  const m = (f.mime_type || '').toLowerCase();
  if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml') return true;
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  return TEXT_EXT.includes(ext);
}

// Minimal, XSS-safe markdown → HTML. Everything is HTML-escaped first, then a
// safe tag subset is applied; links are restricted to http(s)/mailto/relative.
function mdEscape(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function mdInline(s) {
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
    const safe = /^(https?:|mailto:|\/)/i.test(u) ? u : '#';
    return '<a href="' + safe + '" target="_blank" rel="noreferrer">' + t + '</a>';
  });
  return s;
}
function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  let html = '', inCode = false, code = [], list = null, para = [];
  const flushP = () => { if (para.length) { html += '<p>' + mdInline(mdEscape(para.join(' '))) + '</p>'; para = []; } };
  const closeL = () => { if (list) { html += '</' + list + '>'; list = null; } };
  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      if (inCode) { html += '<pre><code>' + mdEscape(code.join('\n')) + '</code></pre>'; code = []; inCode = false; }
      else { flushP(); closeL(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(raw); continue; }
    const line = raw.trimEnd();
    let m;
    if (line.trim() === '') { flushP(); closeL(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushP(); closeL(); const l = m[1].length; html += '<h' + l + '>' + mdInline(mdEscape(m[2])) + '</h' + l + '>'; continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { flushP(); if (list !== 'ul') { closeL(); html += '<ul>'; list = 'ul'; } html += '<li>' + mdInline(mdEscape(m[1])) + '</li>'; continue; }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { flushP(); if (list !== 'ol') { closeL(); html += '<ol>'; list = 'ol'; } html += '<li>' + mdInline(mdEscape(m[1])) + '</li>'; continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushP(); closeL(); html += '<blockquote>' + mdInline(mdEscape(m[1])) + '</blockquote>'; continue; }
    para.push(line);
  }
  flushP(); closeL();
  if (inCode) html += '<pre><code>' + mdEscape(code.join('\n')) + '</code></pre>';
  return html;
}

// Fetches a text file and shows it in a monospace pane. Editable (owner) →
// adds a Save button wired to onSave(content). Markdown files get a preview
// toggle. Remount per file via key.
function TextPane({ src, name, editable, onSave }) {
  const [content, setContent] = useState(null);
  const [orig, setOrig] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const isMd = /\.(md|markdown)$/i.test(name);
  useEffect(() => {
    let off = false;
    fetch(src).then((r) => r.text()).then((t) => { if (!off) { setContent(t); setOrig(t); } })
      .catch(() => { if (!off) { setContent(''); setOrig(''); } });
    return () => { off = true; };
  }, [src]);
  const dirty = content !== null && content !== orig;
  const save = async () => {
    setSaving(true);
    try { await onSave(content); setOrig(content); toast('Gespeichert', 'success'); }
    catch (e) { toast(e.message || 'Speichern fehlgeschlagen', 'error'); }
    finally { setSaving(false); }
  };
  return (
    <Glass style={{ width: '100%', maxWidth: 980, height: '100%', borderRadius: 'var(--r-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ color: 'var(--fg-3)' }}>{Ic.fileGen(15)}</span>
        <span style={{ flex: 1, fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'var(--fg-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}{dirty ? ' •' : ''}</span>
        {isMd && (
          <div style={{ display: 'flex', padding: 3, borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
            <button onClick={() => setPreview(false)} style={mdTabStyle(!preview)}>Code</button>
            <button onClick={() => setPreview(true)} style={mdTabStyle(preview)}>Vorschau</button>
          </div>
        )}
        {editable && <Btn variant="primary" size="sm" disabled={!dirty || saving} icon={saving ? Ic.loader(13) : Ic.check(13)} onClick={save}>{saving ? 'Speichert…' : 'Speichern'}</Btn>}
      </div>
      {content === null ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-3)' }}>{Ic.loader(22)}</div>
      ) : (isMd && preview) ? (
        <div className="nyza-md" style={{ flex: 1, overflow: 'auto', padding: '20px 26px' }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}/>
      ) : (
        <textarea value={content} readOnly={!editable} spellCheck={false}
          onChange={(e) => setContent(e.target.value)}
          style={{
            flex: 1, width: '100%', resize: 'none', border: 0, outline: 0, padding: '16px 18px',
            background: 'transparent', color: 'var(--fg)', fontFamily: 'var(--font-mono)',
            fontSize: 13, lineHeight: 1.6, tabSize: 2,
          }}/>
      )}
    </Glass>
  );
}
function mdTabStyle(active) {
  return {
    height: 26, padding: '0 12px', borderRadius: 999, border: 'none', cursor: 'pointer',
    fontFamily: 'inherit', fontSize: 12, fontWeight: 540,
    background: active ? 'var(--accent-grad)' : 'transparent',
    color: active ? '#fff' : 'var(--fg-2)',
  };
}

// ───── MediaViewer — fullscreen modal for images / videos / PDFs / files ───
// Gallery-capable: pass items[] + startIndex + srcFor()/downloadFor() to enable
// ←/→ keys, on-screen arrows and touch-swipe between files. Single-file mode
// (file + src + downloadHref) still works.
export function MediaViewer({ file, src, downloadHref, items, startIndex = 0, srcFor, downloadFor, onSaveText, onClose }) {
  const gallery = Array.isArray(items) && items.length > 0;
  const [idx, setIdx] = useState(startIndex);
  const cur = gallery ? items[idx] : file;
  const curSrc = gallery ? srcFor(cur) : src;
  const curDl = gallery ? (downloadFor ? downloadFor(cur) : null) : downloadHref;
  const touch = useRef(null);
  const textual = isTextFile(cur);

  const go = useCallback((d) => {
    if (!gallery) return;
    setIdx((i) => (i + d + items.length) % items.length);
  }, [gallery, items]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, go]);

  const kind = cur.kind || 'doc';
  const stop = (e) => e.stopPropagation();
  const onTouchStart = (e) => { touch.current = e.touches[0].clientX; };
  const onTouchEnd = (e) => {
    if (touch.current == null) return;
    const dx = e.changedTouches[0].clientX - touch.current;
    if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    touch.current = null;
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      display: 'flex', flexDirection: 'column',
      animation: 'fadeIn 0.2s ease',
    }}>
      <div onClick={stop} style={{
        height: 60, padding: '0 24px', display: 'flex', alignItems: 'center', gap: 16,
        color: '#fff', flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 540, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cur.name}</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
            {humanSize(cur.size)}{cur.mime_type ? ' · ' + cur.mime_type : ''}{gallery && items.length > 1 ? ' · ' + (idx + 1) + ' / ' + items.length : ''}
          </div>
        </div>
        {curDl && (
          <a href={curDl} download={cur.name} style={{ display: 'inline-flex', textDecoration: 'none' }}>
            <Btn variant="glass" size="sm" icon={Ic.download(14)}>Download</Btn>
          </a>
        )}
        <button onClick={onClose} title="Schließen (Esc)" style={{
          width: 36, height: 36, borderRadius: 'var(--r-sm)',
          background: 'rgba(255,255,255,0.08)', border: 'none', cursor: 'pointer',
          color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>{Ic.close(18)}</button>
      </div>

      <div onClick={stop} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, minHeight: 0, position: 'relative',
      }}>
        {gallery && items.length > 1 && (
          <button onClick={() => go(-1)} title="Zurück (←)" style={navArrow('left')}>{Ic.chevronL ? Ic.chevronL(22) : '‹'}</button>
        )}
        {kind === 'video' && (
          <video key={cur.id} controls autoPlay src={curSrc} onClick={stop} style={{
            maxWidth: '100%', maxHeight: '100%', borderRadius: 'var(--r-lg)',
            boxShadow: '0 30px 80px rgba(0,0,0,0.6)', background: '#000',
          }}>
            Dein Browser unterstützt das Format nicht. <a href={curDl}>Download</a>
          </video>
        )}
        {kind === 'image' && (
          <img key={cur.id} src={curSrc} alt={cur.name} onClick={stop} style={{
            maxWidth: '100%', maxHeight: '100%', borderRadius: 'var(--r-md)',
            boxShadow: '0 30px 80px rgba(0,0,0,0.6)', objectFit: 'contain',
          }}/>
        )}
        {kind === 'pdf' && (
          <iframe key={cur.id} src={curSrc} title={cur.name} onClick={stop} style={{
            width: '100%', height: '100%', maxWidth: 1100, border: 0,
            borderRadius: 'var(--r-md)', background: '#fff',
            boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
          }}/>
        )}
        {textual && (
          <TextPane key={cur.id} src={curSrc} name={cur.name}
            editable={!!onSaveText} onSave={(content) => onSaveText(cur, content)}/>
        )}
        {!textual && kind !== 'video' && kind !== 'image' && kind !== 'pdf' && (
          <Glass style={{ padding: '40px 48px', borderRadius: 'var(--r-xl)', textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
              <FileIcon kind={kind} size={42} tint={cur.hue || 280}/>
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, marginBottom: 6 }}>
              Vorschau nicht verfügbar
            </div>
            <div style={{ fontSize: 13, color: 'var(--fg-3)', marginBottom: 20 }}>
              Dieser Dateityp kann nicht direkt im Browser angezeigt werden.
            </div>
            {curDl && (
              <a href={curDl} download={cur.name} style={{ textDecoration: 'none' }}>
                <Btn variant="primary" size="md" icon={Ic.download(15)}>Herunterladen</Btn>
              </a>
            )}
          </Glass>
        )}
        {gallery && items.length > 1 && (
          <button onClick={() => go(1)} title="Weiter (→)" style={navArrow('right')}>{Ic.chevronR(22)}</button>
        )}
      </div>
    </div>
  );
}

function navArrow(side) {
  return {
    position: 'absolute', top: '50%', [side]: 16, transform: 'translateY(-50%)',
    width: 48, height: 48, borderRadius: '50%', border: 'none', cursor: 'pointer',
    background: 'rgba(255,255,255,0.12)', color: '#fff', zIndex: 2,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backdropFilter: 'blur(8px)',
  };
}

// ───── Auth screen — login only (single-user model) ────────────────────────
export function AuthScreen({ onAuth }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const data = await API.login({ email, password });
      setToken(data.token);
      onAuth(data.user);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, position: 'relative', zIndex: 1 }}>
      <Glass style={{ width: '100%', maxWidth: 420, borderRadius: 'var(--r-xl)', padding: 36 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
          <NyzaWordmark size={20}/>
        </div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 600, letterSpacing: -0.8, margin: 0, textAlign: 'center', lineHeight: 1.1 }}>
          Willkommen zurück.
        </h1>
        <p style={{ fontSize: 13, color: 'var(--fg-3)', textAlign: 'center', marginTop: 8 }}>
          Melde dich an, um deine Dateien zu sehen.
        </p>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 28 }}>
          <FieldInput label="E-Mail" type="email" value={email} onChange={setEmail} placeholder="du@beispiel.de"/>
          <FieldInput label="Passwort" type="password" value={password} onChange={setPassword}/>
          <Btn variant="primary" size="lg" full type="submit" disabled={busy} icon={busy ? Ic.loader(16) : null}>
            {busy ? 'Bitte warten…' : 'Anmelden'}
          </Btn>
        </form>
        <div style={{ marginTop: 20, textAlign: 'center', fontSize: 12, color: 'var(--fg-4)' }}>
          Single-User-System. Account-Verwaltung über Setup-Wizard.
        </div>
      </Glass>
    </div>
  );
}

// ───── Change-password modal ───────────────────────────────────────────────
export function ChangePasswordModal({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (next !== next2) { toast('Neue Passwörter stimmen nicht überein', 'error'); return; }
    if (next.length < 10) { toast('Mindestens 10 Zeichen', 'error'); return; }
    setBusy(true);
    try {
      await API.changePassword({ current_password: current, new_password: next });
      toast('Passwort geändert', 'success');
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 420, borderRadius: 'var(--r-xl)', padding: 28 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 16px var(--accent-glow)',
          }}>{Ic.lock(18)}</div>
          <div style={{ flex: 1 }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0, letterSpacing: -0.3 }}>Passwort ändern</h2>
            <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>Mindestens 10 Zeichen</div>
          </div>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <FieldInput label="Aktuelles Passwort" type="password" value={current} onChange={setCurrent}/>
          <FieldInput label="Neues Passwort" type="password" value={next} onChange={setNext}/>
          <FieldInput label="Neues Passwort wiederholen" type="password" value={next2} onChange={setNext2}/>
          <div style={{ display: 'flex', gap: 8, marginTop: 6, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={onClose} type="button">Abbrechen</Btn>
            <Btn variant="primary" type="submit" disabled={busy} icon={busy ? Ic.loader(15) : null}>
              {busy ? 'Speichere…' : 'Passwort ändern'}
            </Btn>
          </div>
        </form>
      </Glass>
    </div>
  );
}

function FieldInput({ label, value, onChange, type = 'text', placeholder }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>{label}</span>
      <input type={type} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          height: 44, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)',
          border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)',
          transition: 'border-color .18s, background .18s',
        }}
        onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
        onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
      />
    </label>
  );
}

// ───── Sidebar ─────────────────────────────────────────────────────────────
function Sidebar({ active, stats, user, onNavigate, onLogout, onTheme, theme, onUpload, onChangePassword }) {
  const items = [
    { id: 'files',    label: 'Meine Dateien', icon: Ic.home,   count: stats?.files },
    { id: 'shared',   label: 'Geteilt',       icon: Ic.share,  count: stats?.shares },
    { id: 'links',    label: 'Upload-Links',  icon: Ic.link,   count: stats?.upload_links, badge: 'NEU' },
    { id: 'activity', label: 'Aktivität',     icon: Ic.clock },
    { id: 'trash',    label: 'Papierkorb',    icon: Ic.trash,  count: stats?.trash || null },
  ];
  const used = stats?.storage_used || 0;
  const quota = stats?.quota || 200 * 1024 * 1024 * 1024;
  const pct = Math.min(100, Math.round((used / quota) * 100));

  return (
    <Glass hi={false} style={{
      width: 248, height: '100%', borderRadius: 0,
      borderRight: '1px solid var(--border)', borderTop: 0, borderLeft: 0, borderBottom: 0,
      display: 'flex', flexDirection: 'column', flexShrink: 0, padding: '20px 14px',
    }}>
      <div style={{ padding: '4px 10px 22px', cursor: 'pointer' }} onClick={() => onNavigate({ name: 'files' })}><NyzaWordmark size={16}/></div>
      <Btn variant="primary" size="md" icon={Ic.upload(16)} full onClick={onUpload}>Hochladen</Btn>
      <div style={{ height: 1, background: 'var(--border)', margin: '18px 4px 12px' }}/>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map((it) => {
          const isActive = it.id === active;
          return (
            <div key={it.id} onClick={() => onNavigate({ name: it.id })} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px',
              borderRadius: 'var(--r-sm)', cursor: 'pointer',
              background: isActive ? 'var(--surface-hi)' : 'transparent',
              color: isActive ? 'var(--fg)' : 'var(--fg-2)',
              fontSize: 14, fontWeight: isActive ? 540 : 460, transition: 'all .18s', position: 'relative',
            }}>
              {isActive && <div style={{ position: 'absolute', left: -14, top: 8, bottom: 8, width: 3, borderRadius: 2, background: 'var(--accent-grad)' }}/>}
              <span style={{ color: isActive ? 'var(--accent)' : 'var(--fg-3)', display: 'inline-flex' }}>{it.icon(16)}</span>
              <span style={{ flex: 1 }}>{it.label}</span>
              {it.badge && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.6, padding: '2px 6px', borderRadius: 4, background: 'var(--accent-grad)', color: '#fff' }}>{it.badge}</span>}
              {it.count != null && <span style={{ color: 'var(--fg-4)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{it.count}</span>}
            </div>
          );
        })}
      </nav>

      <div style={{ marginTop: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ padding: '14px 12px', borderRadius: 'var(--r-md)', background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 540 }}>Speicher</span>
            <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>{humanSize(used)} / {humanSize(quota)}</span>
          </div>
          <div style={{ height: 5, borderRadius: 3, background: 'var(--surface-hi)', overflow: 'hidden', border: '1px solid var(--border)' }}>
            <div style={{ width: pct + '%', height: '100%', background: 'var(--accent-grad)' }}/>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px 0' }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            background: 'linear-gradient(135deg, oklch(0.72 0.16 60), oklch(0.55 0.2 25))',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 600, fontSize: 12,
          }}>{(user?.name || '?').slice(0, 2).toUpperCase()}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 540, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.name || ''}</div>
            <div style={{ fontSize: 10.5, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.email || ''}</div>
          </div>
          <IconBtn size={28} title="Theme" onClick={onTheme}>{theme === 'dark' ? Ic.sun(14) : Ic.moon(14)}</IconBtn>
          <IconBtn size={28} title="Passwort ändern" onClick={onChangePassword}>{Ic.lock(14)}</IconBtn>
          <IconBtn size={28} title="Abmelden" onClick={onLogout}>{Ic.logout(14)}</IconBtn>
        </div>
      </div>
    </Glass>
  );
}

// ───── Mobile bottom nav + FAB + "more" sheet ──────────────────────────────
function MobileNav({ active, onNavigate, onUpload, onMore }) {
  const items = [
    { id: 'files', label: 'Dateien', icon: Ic.home },
    { id: 'shared', label: 'Geteilt', icon: Ic.share },
    { id: '__upload__' },
    { id: 'links', label: 'Links', icon: Ic.link },
    { id: '__more__', label: 'Mehr', icon: Ic.more },
  ];
  return (
    <div style={{
      position: 'fixed', left: 12, right: 12, bottom: 12, height: 64, zIndex: 80,
      borderRadius: 32, padding: '0 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-around',
      background: 'var(--surface)', border: '1px solid var(--border-hi)',
      backdropFilter: 'blur(30px) saturate(180%)', WebkitBackdropFilter: 'blur(30px) saturate(180%)',
      boxShadow: '0 1px 0 var(--inner-hi) inset, 0 20px 40px -10px rgba(0,0,0,0.4)',
    }}>
      {items.map((it) => it.id === '__upload__' ? (
        <button key="up" onClick={onUpload} style={{
          width: 52, height: 52, borderRadius: 26, border: 'none', cursor: 'pointer',
          background: 'var(--accent-grad)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 8px 24px -4px var(--accent-glow)',
        }}>{Ic.plus(24)}</button>
      ) : (
        <button key={it.id} onClick={() => it.id === '__more__' ? onMore() : onNavigate({ name: it.id })} style={{
          background: 'none', border: 'none', cursor: 'pointer', flex: 1,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
          color: active === it.id ? 'var(--accent)' : 'var(--fg-3)', fontSize: 9.5, fontWeight: 540,
        }}>
          {it.icon(20)}{it.label}
        </button>
      ))}
    </div>
  );
}

function MoreSheet({ user, theme, onTheme, onNavigate, onChangePassword, onLogout, onClose }) {
  const item = (icon, label, onClick, danger) => (
    <button onClick={() => { onClick(); onClose(); }} style={{
      display: 'flex', alignItems: 'center', gap: 14, width: '100%', padding: '14px 16px',
      background: 'none', border: 'none', borderRadius: 'var(--r-md)', cursor: 'pointer',
      fontSize: 15, color: danger ? 'var(--danger)' : 'var(--fg)', fontFamily: 'inherit',
    }}>
      <span style={{ color: danger ? 'var(--danger)' : 'var(--fg-3)' }}>{icon}</span>{label}
    </button>
  );
  return (
    <div className="nyza-modal-backdrop" onClick={onClose} style={{ alignItems: 'flex-end' }}>
      <Glass style={{ width: '100%', maxWidth: 520, borderRadius: '24px 24px 0 0', padding: 16, paddingBottom: 28 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--border-hi)', margin: '4px auto 14px' }}/>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 16px 14px' }}>
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'linear-gradient(135deg, oklch(0.72 0.16 60), oklch(0.55 0.2 25))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 600, fontSize: 14 }}>{(user?.name || '?').slice(0, 2).toUpperCase()}</div>
          <div><div style={{ fontSize: 14, fontWeight: 600 }}>{user?.name}</div><div style={{ fontSize: 12, color: 'var(--fg-3)' }}>{user?.email}</div></div>
        </div>
        {item(Ic.clock(18), 'Aktivität', () => onNavigate({ name: 'activity' }))}
        {item(Ic.trash(18), 'Papierkorb', () => onNavigate({ name: 'trash' }))}
        {item(theme === 'dark' ? Ic.sun(18) : Ic.moon(18), theme === 'dark' ? 'Helles Design' : 'Dunkles Design', onTheme)}
        {item(Ic.lock(18), 'Passwort ändern', onChangePassword)}
        {item(Ic.logout(18), 'Abmelden', onLogout, true)}
      </Glass>
    </div>
  );
}

// ───── Top bar ─────────────────────────────────────────────────────────────
function TopBar({ crumbs = ['Meine Dateien'], view, onView, onSearch, search, sort, onSort, right }) {
  return (
    <div className="nyza-topbar" style={{
      height: 64, padding: '0 28px', display: 'flex', alignItems: 'center', gap: 14,
      borderBottom: '1px solid var(--border)', flexShrink: 0,
      background: 'var(--surface-2)', backdropFilter: 'blur(20px)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, minWidth: 0 }}>
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          const label = typeof c === 'string' ? c : c.label;
          const onClick = typeof c === 'object' ? c.onClick : null;
          return (
            <React.Fragment key={i}>
              {i > 0 && <span style={{ color: 'var(--fg-4)' }}>{Ic.chevronR(12)}</span>}
              <span onClick={onClick} style={{
                color: isLast ? 'var(--fg)' : 'var(--fg-3)',
                fontWeight: isLast ? 540 : 440,
                cursor: onClick ? 'pointer' : 'default',
                whiteSpace: 'nowrap',
              }}>{label}</span>
            </React.Fragment>
          );
        })}
      </div>
      <div style={{ flex: 1 }}/>
      {onSearch && (
        <div className="nyza-search" style={{
          display: 'flex', alignItems: 'center', gap: 10, height: 38, padding: '0 14px',
          borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)',
          width: 280, color: 'var(--fg-3)',
        }}>
          <span>{Ic.search(15)}</span>
          <input value={search || ''} onChange={(e) => onSearch(e.target.value)} placeholder="Suchen…" style={{
            flex: 1, border: 0, outline: 0, background: 'transparent', color: 'var(--fg)', fontSize: 13.5, fontFamily: 'inherit',
          }}/>
        </div>
      )}
      {sort && <SortControl sort={sort} onSort={onSort}/>}
      {view !== undefined && (
        <div style={{ display: 'flex', padding: 3, borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
          <IconBtn active={view === 'grid'} onClick={() => onView('grid')} size={32} title="Raster">{Ic.grid(15)}</IconBtn>
          <IconBtn active={view === 'list'} onClick={() => onView('list')} size={32} title="Liste">{Ic.list(15)}</IconBtn>
        </div>
      )}
      {right}
    </div>
  );
}

function SortControl({ sort, onSort }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, []);
  const opts = [
    { id: 'date', label: 'Datum' },
    { id: 'name', label: 'Name' },
    { id: 'size', label: 'Größe' },
  ];
  const cur = opts.find((o) => o.id === sort.by) || opts[0];
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} title="Sortieren" style={{
        height: 38, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 7,
        borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)',
        color: 'var(--fg-2)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
      }}>
        {Ic.list(14)}
        <span>{cur.label}</span>
        <span style={{ color: 'var(--fg-3)' }}>{sort.dir === 'asc' ? '↑' : '↓'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 30,
          background: 'var(--surface)', backdropFilter: 'blur(30px) saturate(180%)',
          WebkitBackdropFilter: 'blur(30px) saturate(180%)',
          border: '1px solid var(--border-hi)', borderRadius: 'var(--r-md)',
          boxShadow: '0 1px 0 var(--inner-hi) inset, 0 16px 40px rgba(0,0,0,0.35)',
          padding: 6, minWidth: 160,
        }}>
          {opts.map((o) => (
            <button key={o.id} onClick={() => { onSort({ by: o.id, dir: sort.by === o.id && sort.dir === 'desc' ? 'asc' : 'desc' }); setOpen(false); }}
              style={{
                display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '8px 10px',
                borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 13, textAlign: 'left',
                background: sort.by === o.id ? 'var(--surface-hi)' : 'transparent',
                color: sort.by === o.id ? 'var(--fg)' : 'var(--fg-2)',
              }}>
              <span style={{ flex: 1 }}>{o.label}</span>
              {sort.by === o.id && <span style={{ color: 'var(--accent)' }}>{sort.dir === 'asc' ? '↑' : '↓'}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ───── Kebab menu (reusable) ───────────────────────────────────────────────
function KebabMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <span onClick={() => setOpen((o) => !o)} title="Mehr" style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex' }}>{Ic.more(16)}</span>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 40, minWidth: 180,
          background: 'var(--surface)', backdropFilter: 'blur(30px) saturate(180%)',
          WebkitBackdropFilter: 'blur(30px) saturate(180%)',
          border: '1px solid var(--border-hi)', borderRadius: 'var(--r-md)',
          boxShadow: '0 1px 0 var(--inner-hi) inset, 0 16px 40px rgba(0,0,0,0.35)', padding: 6,
        }}>
          {items.map((it, i) => (
            <button key={i} onClick={() => { setOpen(false); it.onClick(); }} style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px',
              borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 13, textAlign: 'left', background: 'transparent',
              color: it.danger ? 'var(--danger)' : 'var(--fg)',
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-hi)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
              <span style={{ color: it.danger ? 'var(--danger)' : 'var(--fg-3)', display: 'inline-flex' }}>{it.icon}</span>{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ───── Folder card ─────────────────────────────────────────────────────────
function FolderCard({ folder, onClick, onShare, onDelete, onRename, onMove }) {
  const tones = ({ violet: [280, 250], aurora: [168, 200], sunset: [30, 360], mono: [240, 260] })[folder.tone] || [280, 250];
  return (
    <div onClick={onClick} style={{
      borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)',
      backdropFilter: 'blur(20px) saturate(160%)', WebkitBackdropFilter: 'blur(20px) saturate(160%)',
      overflow: 'hidden', cursor: 'pointer',
      transition: 'transform .25s cubic-bezier(.2,.8,.2,1), box-shadow .25s',
      boxShadow: '0 1px 0 var(--inner-hi) inset, 0 8px 24px -12px rgba(0,0,0,0.25)',
    }}
    onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 1px 0 var(--inner-hi) inset, 0 24px 48px -16px rgba(0,0,0,0.4), 0 0 0 1px var(--border-hi)'; }}
    onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 1px 0 var(--inner-hi) inset, 0 8px 24px -12px rgba(0,0,0,0.25)'; }}>
      <div style={{ height: 132, position: 'relative', overflow: 'hidden' }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: `linear-gradient(135deg, oklch(0.4 0.12 ${tones[0]} / 0.5), oklch(0.3 0.08 ${tones[1]} / 0.7))`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: 'var(--r-md)',
            background: `linear-gradient(135deg, oklch(0.7 0.18 ${tones[0]}), oklch(0.55 0.2 ${tones[1]}))`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 8px 24px -8px oklch(0.65 0.2 ' + tones[0] + ' / 0.6)', color: '#fff',
          }}>{folder.kind === 'gallery' ? Ic.fileImg(28) : Ic.folder(28)}</div>
        </div>
        <div style={{
          position: 'absolute', top: 10, right: 10, padding: '4px 8px', borderRadius: 999,
          fontSize: 10, fontWeight: 600, letterSpacing: 0.4, background: 'rgba(0,0,0,0.5)', color: '#fff',
          backdropFilter: 'blur(10px)', textTransform: 'uppercase',
        }}>{folder.kind === 'gallery' ? '◇ Galerie' : '◇ Dateien'}</div>
      </div>
      <div style={{ padding: '14px 16px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 540, lineHeight: 1.3, letterSpacing: -0.1 }}>{folder.name}</div>
          {(onShare || onDelete || onRename || onMove) && (
            <KebabMenu items={[
              ...(onRename ? [{ label: 'Umbenennen', icon: Ic.fileGen(15), onClick: onRename }] : []),
              ...(onMove ? [{ label: 'Verschieben', icon: Ic.folder(15), onClick: onMove }] : []),
              ...(onShare ? [{ label: 'Teilen', icon: Ic.share(15), onClick: onShare }] : []),
              ...(onDelete ? [{ label: 'Löschen', icon: Ic.trash(15), onClick: onDelete, danger: true }] : []),
            ]}/>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5, color: 'var(--fg-3)' }}>
          <span>{folder.item_count || 0} Dateien</span>
          <span style={{ width: 2, height: 2, borderRadius: 1, background: 'var(--fg-4)' }}/>
          <span>{humanSize(folder.total_size || 0)}</span>
          <span style={{ width: 2, height: 2, borderRadius: 1, background: 'var(--fg-4)' }}/>
          <span>{timeAgo(folder.updated_at)}</span>
        </div>
      </div>
    </div>
  );
}

// ───── File tile (grid) with real thumbnail + selection ────────────────────
function FileTile({ file, selected, selecting, onOpen, onToggleSelect }) {
  const [imgOk, setImgOk] = useState(true);
  const isImage = file.kind === 'image' && imgOk;
  const isNew = !!file.uploader_name;
  return (
    <div style={{
      borderRadius: 'var(--r-md)', background: 'var(--surface)',
      border: '1px solid ' + (selected ? 'var(--accent)' : 'var(--border)'),
      overflow: 'hidden', cursor: 'pointer', position: 'relative',
      boxShadow: selected ? '0 0 0 3px var(--accent-glow)' : '0 1px 0 var(--inner-hi) inset',
      transition: 'all .2s',
    }}
    onClick={() => (selecting ? onToggleSelect() : onOpen())}>
      <div style={{ aspectRatio: '4/3', position: 'relative', background: 'var(--surface-hi)' }}>
        {isImage ? (
          <img src={API.thumbUrl(file.id)} alt={file.name} loading="lazy"
            onError={() => setImgOk(false)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}/>
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <FileIcon kind={file.kind} size={32} tint={file.hue}/>
          </div>
        )}
        {file.kind === 'video' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="#fff"><path d="M3 1l9 6-9 6z"/></svg>
            </div>
          </div>
        )}
        {/* selection checkbox */}
        <div onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
          style={{
            position: 'absolute', top: 8, left: 8, width: 22, height: 22, borderRadius: 6,
            border: '2px solid ' + (selected ? 'transparent' : 'rgba(255,255,255,0.7)'),
            background: selected ? 'var(--accent-grad)' : 'rgba(0,0,0,0.35)',
            display: (selected || selecting) ? 'flex' : 'none',
            alignItems: 'center', justifyContent: 'center', color: '#fff',
            boxShadow: selected ? '0 2px 8px var(--accent-glow)' : 'none',
          }}
          className="file-checkbox">
          {selected && Ic.check(13)}
        </div>
        {isNew && !selected && (
          <div style={{
            position: 'absolute', top: 8, right: 8, padding: '2px 7px', borderRadius: 999,
            fontSize: 9, fontWeight: 700, letterSpacing: 0.4, background: 'var(--accent-grad)', color: '#fff',
            textTransform: 'uppercase', boxShadow: '0 2px 8px var(--accent-glow)',
          }}>Neu</div>
        )}
      </div>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2, display: 'flex', justifyContent: 'space-between' }}>
          <span>{humanSize(file.size)}</span>
          <span>{timeAgo(file.created_at)}</span>
        </div>
        {file.uploader_name && (
          <div style={{ fontSize: 10.5, color: 'var(--accent)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
            {Ic.inbox(11)} von {file.uploader_name}
          </div>
        )}
      </div>
    </div>
  );
}

// ───── File grid + list (reusable) ─────────────────────────────────────────
function FileGrid({ files, selected, onOpen, onToggleSelect, onDragSelect }) {
  const selecting = selected.size > 0;
  const wrapRef = useRef(null);
  const [rect, setRect] = useState(null); // rubber-band {l,t,w,h} in container coords
  const drag = useRef(null);

  const onPointerDown = (e) => {
    // Only start a rubber-band on empty grid background (not on a tile/checkbox),
    // primary button, non-touch.
    if (e.button !== 0 || !onDragSelect) return;
    if (e.target.closest('[data-fid]')) return;
    const box = wrapRef.current.getBoundingClientRect();
    drag.current = { ox: box.left, oy: box.top, sx: e.clientX, sy: e.clientY, base: new Set(selected) };
    setRect({ l: e.clientX - box.left, t: e.clientY - box.top, w: 0, h: 0 });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const onMove = (e) => {
    const d = drag.current; if (!d) return;
    const l = Math.min(d.sx, e.clientX), t = Math.min(d.sy, e.clientY);
    const r = Math.max(d.sx, e.clientX), b = Math.max(d.sy, e.clientY);
    setRect({ l: l - d.ox, t: t - d.oy, w: r - l, h: b - t });
    const ids = new Set(d.base);
    wrapRef.current.querySelectorAll('[data-fid]').forEach((el) => {
      const bb = el.getBoundingClientRect();
      const hit = bb.right >= l && bb.left <= r && bb.bottom >= t && bb.top <= b;
      if (hit) ids.add(Number(el.dataset.fid));
    });
    onDragSelect(ids);
  };
  const onUp = () => {
    drag.current = null; setRect(null);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };

  return (
    <div ref={wrapRef} onPointerDown={onPointerDown} style={{ position: 'relative' }}>
      <div className="file-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }}>
        {files.map((f) => (
          <div data-fid={f.id} key={f.id}>
            <FileTile file={f}
              selected={selected.has(f.id)} selecting={selecting}
              onOpen={() => onOpen(f)} onToggleSelect={() => onToggleSelect(f.id)}/>
          </div>
        ))}
      </div>
      {rect && rect.w > 3 && rect.h > 3 && (
        <div style={{
          position: 'absolute', left: rect.l, top: rect.t, width: rect.w, height: rect.h,
          background: 'color-mix(in oklab, var(--accent) 18%, transparent)',
          border: '1px solid var(--accent)', borderRadius: 6, pointerEvents: 'none', zIndex: 5,
        }}/>
      )}
    </div>
  );
}

function SkeletonGrid({ count = 10 }) {
  return (
    <div className="file-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ borderRadius: 'var(--r-md)', overflow: 'hidden', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="nyza-skeleton" style={{ aspectRatio: '4/3' }}/>
          <div style={{ padding: '10px 12px' }}>
            <div className="nyza-skeleton" style={{ height: 11, borderRadius: 4, width: '70%' }}/>
            <div className="nyza-skeleton" style={{ height: 9, borderRadius: 4, width: '40%', marginTop: 7 }}/>
          </div>
        </div>
      ))}
    </div>
  );
}

function FileList({ files, selected, onOpen, onToggleSelect, onShareFile, onDeleteFile }) {
  const allSel = files.length > 0 && files.every((f) => selected.has(f.id));
  return (
    <div style={{ borderRadius: 'var(--r-md)', overflow: 'hidden', background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '32px 1fr 90px 120px 120px 92px', alignItems: 'center', gap: 16,
        padding: '10px 16px', fontSize: 11, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: 0.5,
        borderBottom: '1px solid var(--border)', background: 'var(--surface-hi)',
      }}>
        <span onClick={() => onToggleSelect('__all__')} style={{ cursor: 'pointer' }}>
          <span style={{
            width: 18, height: 18, borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            border: '1.5px solid ' + (allSel ? 'transparent' : 'var(--border-hi)'),
            background: allSel ? 'var(--accent-grad)' : 'transparent', color: '#fff',
          }}>{allSel && Ic.check(11)}</span>
        </span>
        <span>Name</span><span>Typ</span><span>Größe</span><span>Geändert</span><span style={{ textAlign: 'right' }}>Aktionen</span>
      </div>
      {files.map((r, i) => {
        const sel = selected.has(r.id);
        return (
          <div key={r.id} style={{
            display: 'grid', gridTemplateColumns: '32px 1fr 90px 120px 120px 92px', alignItems: 'center', gap: 16,
            padding: '10px 16px', borderBottom: i < files.length - 1 ? '1px solid var(--border)' : 'none',
            fontSize: 13, transition: 'background .15s', cursor: 'pointer',
            background: sel ? 'color-mix(in oklab, var(--accent) 10%, transparent)' : 'transparent',
          }}
          onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = 'var(--surface-hi)'; }}
          onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = 'transparent'; }}>
            <span onClick={() => onToggleSelect(r.id)} style={{ cursor: 'pointer' }}>
              <span style={{
                width: 18, height: 18, borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                border: '1.5px solid ' + (sel ? 'transparent' : 'var(--border-hi)'),
                background: sel ? 'var(--accent-grad)' : 'transparent', color: '#fff',
              }}>{sel && Ic.check(11)}</span>
            </span>
            <div onClick={() => onOpen(r)} style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <FileIcon kind={r.kind} size={15} tint={r.hue}/>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
              {r.uploader_name && <span style={{ fontSize: 10.5, color: 'var(--accent)', flexShrink: 0 }}>· {r.uploader_name}</span>}
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>{r.kind}</span>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{humanSize(r.size)}</span>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{timeAgo(r.created_at)}</span>
            <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
              <IconBtn size={28} title="Vorschau" onClick={() => onOpen(r)}>{Ic.eye(14)}</IconBtn>
              <IconBtn size={28} title="Teilen" onClick={() => onShareFile(r)}>{Ic.share(13)}</IconBtn>
              <IconBtn size={28} title="Löschen" onClick={() => onDeleteFile(r)}>{Ic.trash(13)}</IconBtn>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ───── Selection action bar ────────────────────────────────────────────────
function SelectionBar({ count, onZip, onMove, onDelete, onClear, busy }) {
  return (
    <div className="nyza-selectionbar" style={{
      position: 'fixed', bottom: 28, left: '50%', transform: 'translateX(-50%)', zIndex: 90,
      display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px 10px 18px',
      borderRadius: 999, background: 'var(--surface)', border: '1px solid var(--border-hi)',
      backdropFilter: 'blur(30px) saturate(180%)', WebkitBackdropFilter: 'blur(30px) saturate(180%)',
      boxShadow: '0 1px 0 var(--inner-hi) inset, 0 20px 50px -10px rgba(0,0,0,0.5)',
      animation: 'slideUp 0.25s cubic-bezier(0.2,0.8,0.2,1)',
    }}>
      <span style={{ fontSize: 13, fontWeight: 540 }}>{count} ausgewählt</span>
      <div style={{ width: 1, height: 22, background: 'var(--border)' }}/>
      <Btn variant="glass" size="sm" icon={busy ? Ic.loader(13) : Ic.download(13)} disabled={busy} onClick={onZip}>ZIP</Btn>
      {onMove && <Btn variant="glass" size="sm" icon={Ic.folder(13)} onClick={onMove}>Verschieben</Btn>}
      <Btn variant="glass" size="sm" icon={Ic.trash(13)} onClick={onDelete}>Löschen</Btn>
      <IconBtn size={30} title="Auswahl aufheben" onClick={onClear}>{Ic.close(15)}</IconBtn>
    </div>
  );
}

// ───── Dropzone ────────────────────────────────────────────────────────────
export function Dropzone({ onFiles, label = 'Dateien hierher ziehen', sub = 'oder klicken zum Auswählen', children, big = false }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  const onDrop = (e) => {
    e.preventDefault(); setOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) onFiles(files);
  };
  return (
    <div className={'dropzone' + (over ? ' is-dragover' : '')}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)} onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      style={{
        padding: 4, borderRadius: 'var(--r-xl)', background: 'var(--accent-grad)', position: 'relative',
        boxShadow: '0 30px 80px -30px var(--accent-glow), 0 8px 32px -8px rgba(0,0,0,0.3)',
        cursor: 'pointer', transition: 'transform .2s',
      }}>
      <div style={{
        background: 'var(--bg)', borderRadius: 'calc(var(--r-xl) - 4px)', padding: big ? '52px 32px' : '32px 24px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', inset: 12, borderRadius: 'var(--r-lg)', border: '2px dashed color-mix(in oklab, var(--accent) 50%, transparent)', pointerEvents: 'none' }}/>
        <div style={{
          width: big ? 88 : 64, height: big ? 88 : 64, borderRadius: 'var(--r-xl)', background: 'var(--accent-grad)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 12px 32px -8px var(--accent-glow)', position: 'relative', zIndex: 1,
        }}>{Ic.upload(big ? 40 : 28)}</div>
        <div style={{ textAlign: 'center', position: 'relative', zIndex: 1 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: big ? 22 : 17, fontWeight: 600, letterSpacing: -0.4 }}>{label}</div>
          <div style={{ fontSize: 13, color: 'var(--fg-3)', marginTop: 4 }}>{sub}</div>
        </div>
        {children}
      </div>
      <input ref={inputRef} type="file" multiple onChange={(e) => {
        const files = Array.from(e.target.files || []);
        if (files.length) onFiles(files);
        e.target.value = '';
      }} style={{ display: 'none' }}/>
    </div>
  );
}

// ───── Upload progress ─────────────────────────────────────────────────────
export function UploadProgress({ items, onClose }) {
  const total = items.reduce((s, x) => s + x.size, 0);
  const done = items.reduce((s, x) => s + (x.status === 'done' ? x.size : x.size * (x.pct || 0)), 0);
  const allDone = items.every((x) => x.status === 'done' || x.status === 'error');
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="nyza-modal-backdrop" onClick={allDone ? onClose : null}>
      <Glass style={{ width: '100%', maxWidth: 560, borderRadius: 'var(--r-xl)', padding: 28 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginBottom: 24 }}>
          <CircularProgress pct={pct} size={104}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 4 }}>
              {allDone ? 'Fertig' : 'Wird hochgeladen…'}
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, letterSpacing: -0.6 }}>
              {items.filter((x) => x.status === 'done').length} von {items.length} Dateien
            </div>
            <div style={{ fontSize: 13, color: 'var(--fg-3)', marginTop: 4 }}>{humanSize(done)} / {humanSize(total)}</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
          {items.map((f, i) => <UploadRow key={i} file={f}/>)}
        </div>
        {allDone && (
          <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
            <Btn variant="primary" size="md" onClick={onClose}>Schließen</Btn>
          </div>
        )}
      </Glass>
    </div>
  );
}

export function UploadRow({ file }) {
  const isDone = file.status === 'done';
  const isError = file.status === 'error';
  const isUp = file.status === 'uploading';
  const pct = Math.round((file.pct || 0) * 100);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 'var(--r-sm)',
      background: isUp ? 'color-mix(in oklab, var(--accent) 6%, transparent)' : 'var(--surface-hi)',
      border: '1px solid ' + (isUp ? 'color-mix(in oklab, var(--accent) 25%, transparent)' : 'var(--border)'),
      position: 'relative', overflow: 'hidden',
    }}>
      {isUp && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pct + '%', background: 'color-mix(in oklab, var(--accent) 14%, transparent)', transition: 'width .2s' }}/>}
      <FileIcon kind={file.kind || 'doc'} size={14} tint={file.hue || 280}/>
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>{humanSize(file.size)}</div>
      </div>
      <div>
        {isDone && <div style={{ width: 22, height: 22, borderRadius: 11, background: 'var(--success)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.check(13)}</div>}
        {isError && <div style={{ fontSize: 11, color: 'var(--danger)' }}>Fehler</div>}
        {isUp && <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{pct}%</div>}
        {!isDone && !isError && !isUp && <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>wartet</span>}
      </div>
    </div>
  );
}

// ───── Share + Upload-Link modals ──────────────────────────────────────────
function ShareToggleRow({ icon, title, desc, on, onToggle }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{
        width: 32, height: 32, borderRadius: 'var(--r-sm)',
        background: on ? 'color-mix(in oklab, var(--accent) 18%, transparent)' : 'var(--surface-hi)',
        color: on ? 'var(--accent)' : 'var(--fg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{icon(15)}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500 }}>{title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 1 }}>{desc}</div>
      </div>
      <Toggle on={on} onClick={onToggle}/>
    </div>
  );
}

export function ShareModal({ folder, file, onClose, onCreated, basePath }) {
  const [withPassword, setWithPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [allowDownload, setAllowDownload] = useState(true);
  const [withExpiry, setWithExpiry] = useState(false);
  const [expiresAt, setExpiresAt] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().slice(0, 10); });
  const [withInvite, setWithInvite] = useState(false);
  const [emails, setEmails] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);

  const create = async () => {
    setBusy(true);
    try {
      const body = { folder_id: folder?.id, file_id: file?.id, allow_download: allowDownload };
      if (withPassword && password) body.password = password;
      if (withExpiry && expiresAt) body.expires_at = expiresAt + ' 23:59:59';
      if (withInvite) {
        const list = emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
        if (list.length) {
          body.emails = list;
          body.message = message;
          body.share_base = location.origin + (basePath || '');
        }
      }
      const data = await API.newShare(body);
      setCreated(data.share);
      if (data.share?.invited) toast(data.share.invited + ' Einladung(en) gesendet', 'success');
      onCreated && onCreated();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };

  const url = created ? location.origin + (basePath || '') + '/s/' + created.token : '';

  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 540, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '24px 28px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
            <div style={{ width: 40, height: 40, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', boxShadow: '0 4px 16px var(--accent-glow)' }}>{Ic.share(18)}</div>
            <div style={{ flex: 1 }}>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0, letterSpacing: -0.3 }}>{(folder?.name || file?.name) + ' teilen'}</h2>
              <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 2 }}>{folder ? `${folder.item_count || 0} Dateien · ${humanSize(folder.total_size || 0)}` : humanSize(file?.size)}</div>
            </div>
            <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
          </div>
          {created ? (
            <div style={{ paddingBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px 8px 16px', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)', marginBottom: 16 }}>
                <span style={{ color: 'var(--fg-3)' }}>{Ic.link(14)}</span>
                <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
                <Btn variant="primary" size="sm" icon={Ic.copy(13)} onClick={() => { navigator.clipboard?.writeText(url); toast('Link kopiert', 'success'); }}>Kopieren</Btn>
              </div>
              <div style={{ fontSize: 12, color: 'var(--fg-3)', textAlign: 'center', padding: 8 }}>Empfänger sehen eine schöne Vorschauseite mit Download-Button.</div>
            </div>
          ) : (
            <>
              <ShareToggleRow icon={Ic.download} title="Download erlauben" desc="ZIP & Einzeldownload" on={allowDownload} onToggle={() => setAllowDownload(!allowDownload)}/>
              <ShareToggleRow icon={Ic.lock} title="Mit Passwort schützen" desc={withPassword ? 'Aktiv' : 'Kein Schutz'} on={withPassword} onToggle={() => setWithPassword(!withPassword)}/>
              {withPassword && <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Passwort eingeben" style={{ width: '100%', height: 38, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)', marginTop: 8 }}/>}
              <ShareToggleRow icon={Ic.clock} title="Ablaufdatum" desc={withExpiry ? expiresAt : 'Nie'} on={withExpiry} onToggle={() => setWithExpiry(!withExpiry)}/>
              {withExpiry && <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={{ width: '100%', height: 38, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)', marginTop: 8, fontFamily: 'inherit' }}/>}
              <ShareToggleRow icon={Ic.users} title="Per E-Mail einladen" desc={withInvite ? 'Empfänger bekommen den Link' : 'Nur Link erstellen'} on={withInvite} onToggle={() => setWithInvite(!withInvite)}/>
              {withInvite && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="E-Mails, durch Komma getrennt"
                    style={{ width: '100%', height: 38, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)' }}/>
                  <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Nachricht (optional)"
                    style={{ width: '100%', minHeight: 56, padding: '10px 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg-2)', resize: 'vertical' }}/>
                </div>
              )}
            </>
          )}
        </div>
        {!created && (
          <div style={{ marginTop: 20, padding: '14px 28px', background: 'var(--surface-hi)', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" size="md" onClick={onClose}>Abbrechen</Btn>
            <Btn variant="primary" size="md" disabled={busy} onClick={create} icon={busy ? Ic.loader(15) : Ic.link(15)}>{busy ? 'Erstelle…' : 'Link erstellen'}</Btn>
          </div>
        )}
      </Glass>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <label style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>{label}</label>
        {hint && <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>· {hint}</span>}
      </div>
      {children}
    </div>
  );
}

function ConstraintBox({ icon, title, enabled, onToggle, children }) {
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 'var(--r-sm)',
      background: enabled ? 'color-mix(in oklab, var(--accent) 8%, var(--surface-hi))' : 'var(--surface-hi)',
      border: '1px solid ' + (enabled ? 'color-mix(in oklab, var(--accent) 30%, transparent)' : 'var(--border)'),
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: 'var(--r-xs)', background: enabled ? 'var(--accent-grad)' : 'var(--surface-hi)', color: enabled ? '#fff' : 'var(--fg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon(14)}</div>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 540 }}>{title}</div>
        <Toggle on={enabled} onClick={onToggle}/>
      </div>
      {children}
    </div>
  );
}

export function UploadLinkModal({ folders, defaultFolderId, onClose, onCreated, basePath }) {
  const [folderId, setFolderId] = useState(defaultFolderId || folders?.[0]?.id || null);
  const [title, setTitle] = useState('Dateien hochladen');
  const [description, setDescription] = useState('');
  const [withPassword, setWithPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [withExpiry, setWithExpiry] = useState(false);
  const [expiresAt, setExpiresAt] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().slice(0, 10); });
  const [maxFiles, setMaxFiles] = useState(20);
  const [maxFileSizeGb, setMaxFileSizeGb] = useState(2);
  const [withMaxFiles, setWithMaxFiles] = useState(true);
  const [withMaxFileSize, setWithMaxFileSize] = useState(true);
  const [reqName, setReqName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);

  const create = async () => {
    if (!folderId) { toast('Zielordner wählen', 'error'); return; }
    setBusy(true);
    try {
      const body = { folder_id: folderId, title, description: description || null, require_uploader_name: reqName };
      if (withPassword && password) body.password = password;
      if (withExpiry && expiresAt) body.expires_at = expiresAt + ' 23:59:59';
      if (withMaxFiles) body.max_files = Number(maxFiles);
      if (withMaxFileSize) body.max_file_size = Math.round(Number(maxFileSizeGb) * 1024 * 1024 * 1024);
      const data = await API.newUploadLink(body);
      setCreated(data.upload_link);
      onCreated && onCreated();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };

  const url = created ? location.origin + (basePath || '') + '/u/' + created.token : '';

  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 600, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '22px 28px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 16px var(--accent-glow)' }}>{Ic.inbox(18)}</div>
          <div style={{ flex: 1 }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0, letterSpacing: -0.3 }}>Upload-Link erstellen</h2>
            <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>Externe können Dateien hochladen — ohne Anmeldung</div>
          </div>
          <IconBtn onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        {created ? (
          <div style={{ padding: '24px 28px' }}>
            <div style={{ marginBottom: 14, fontSize: 14, fontWeight: 540 }}>Upload-Link ist bereit:</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px 8px 16px', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)', marginBottom: 16 }}>
              <span style={{ color: 'var(--fg-3)' }}>{Ic.link(14)}</span>
              <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
              <Btn variant="primary" size="sm" icon={Ic.copy(13)} onClick={() => { navigator.clipboard?.writeText(url); toast('Link kopiert', 'success'); }}>Kopieren</Btn>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-3)', textAlign: 'center', padding: '8px 0 16px' }}>Diesen Link an deinen Kunden senden. Er kann sofort hochladen — ohne Account.</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}><Btn variant="primary" onClick={onClose}>Fertig</Btn></div>
          </div>
        ) : (
          <>
            <div style={{ padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Field label="Titel" hint="Wird auf der Upload-Seite groß angezeigt">
                <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%', height: 40, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)' }}/>
              </Field>
              <Field label="Beschreibung (optional)">
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Hi! Bitte alle Rohdaten hier ablegen." style={{ width: '100%', minHeight: 64, padding: '12px 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5, resize: 'vertical' }}/>
              </Field>
              {folders && folders.length > 0 && (
                <Field label="Zielordner">
                  <select value={folderId || ''} onChange={(e) => setFolderId(Number(e.target.value))} style={{ width: '100%', height: 40, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit' }}>
                    {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </Field>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <ConstraintBox icon={Ic.lock} title="Passwort" enabled={withPassword} onToggle={() => setWithPassword(!withPassword)}>
                  {withPassword && <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" style={{ width: '100%', marginTop: 6, height: 32, padding: '0 10px', borderRadius: 'var(--r-xs)', background: 'var(--bg)', border: '1px solid var(--border)', outline: 'none', fontSize: 12, color: 'var(--fg)' }}/>}
                </ConstraintBox>
                <ConstraintBox icon={Ic.clock} title="Ablauf" enabled={withExpiry} onToggle={() => setWithExpiry(!withExpiry)}>
                  {withExpiry && <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={{ width: '100%', marginTop: 6, height: 32, padding: '0 10px', borderRadius: 'var(--r-xs)', background: 'var(--bg)', border: '1px solid var(--border)', outline: 'none', fontSize: 12, color: 'var(--fg)', fontFamily: 'inherit' }}/>}
                </ConstraintBox>
                <ConstraintBox icon={Ic.fileGen} title="Max. pro Datei" enabled={withMaxFileSize} onToggle={() => setWithMaxFileSize(!withMaxFileSize)}>
                  {withMaxFileSize && <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}><input type="number" min={1} value={maxFileSizeGb} onChange={(e) => setMaxFileSizeGb(e.target.value)} style={{ width: 60, height: 32, padding: '0 10px', borderRadius: 'var(--r-xs)', background: 'var(--bg)', border: '1px solid var(--border)', outline: 'none', fontSize: 12, color: 'var(--fg)' }}/><span style={{ fontSize: 12, color: 'var(--fg-3)' }}>GB</span></div>}
                </ConstraintBox>
                <ConstraintBox icon={Ic.bolt} title="Max. Anzahl" enabled={withMaxFiles} onToggle={() => setWithMaxFiles(!withMaxFiles)}>
                  {withMaxFiles && <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}><input type="number" min={1} value={maxFiles} onChange={(e) => setMaxFiles(e.target.value)} style={{ width: 60, height: 32, padding: '0 10px', borderRadius: 'var(--r-xs)', background: 'var(--bg)', border: '1px solid var(--border)', outline: 'none', fontSize: 12, color: 'var(--fg)' }}/><span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Dateien</span></div>}
                </ConstraintBox>
              </div>
              <ShareToggleRow icon={Ic.users} title="Name des Uploaders abfragen" desc={reqName ? 'Pflichtfeld' : 'Optional'} on={reqName} onToggle={() => setReqName(!reqName)}/>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 28px', borderTop: '1px solid var(--border)', background: 'var(--surface-hi)' }}>
              <span style={{ fontSize: 12, color: 'var(--fg-3)', flex: 1 }}>Sicherer Upload · 256-bit Verschlüsselung</span>
              <Btn variant="ghost" size="md" onClick={onClose}>Abbrechen</Btn>
              <Btn variant="primary" size="md" disabled={busy} onClick={create} icon={busy ? Ic.loader(15) : Ic.link(15)}>{busy ? 'Erstelle…' : 'Link erstellen'}</Btn>
            </div>
          </>
        )}
      </Glass>
    </div>
  );
}

// ───── Rename folder modal ─────────────────────────────────────────────────
export function RenameFolderModal({ folder, onClose, onSaved }) {
  const [name, setName] = useState(folder.name);
  const [kind, setKind] = useState(folder.kind || 'normal');
  const [tone, setTone] = useState(folder.tone || 'violet');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await API.renameFolder(folder.id, { name: name.trim(), kind, tone }); toast('Gespeichert', 'success'); onSaved && onSaved(); onClose(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 440, borderRadius: 'var(--r-xl)', padding: 28 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div style={{ width: 40, height: 40, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 16px var(--accent-glow)' }}>{Ic.folder(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0, letterSpacing: -0.3 }}>Ordner bearbeiten</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()}
            style={{ height: 42, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)' }}/>
          <div style={{ display: 'flex', gap: 10 }}>
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ flex: 1, height: 42, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', color: 'var(--fg)' }}>
              <option value="normal">Dateien</option><option value="gallery">Galerie</option>
            </select>
            <select value={tone} onChange={(e) => setTone(e.target.value)} style={{ flex: 1, height: 42, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', color: 'var(--fg)' }}>
              <option value="violet">Violet</option><option value="aurora">Aurora</option><option value="sunset">Sunset</option><option value="mono">Mono</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
            <Btn variant="primary" disabled={busy || !name.trim()} onClick={save} icon={busy ? Ic.loader(15) : null}>Speichern</Btn>
          </div>
        </div>
      </Glass>
    </div>
  );
}

// ───── Move modal (folder picker) ───────────────────────────────────────────
// `excludeId` removes a folder + its descendants from the targets (moving a
// folder into its own subtree is invalid). `allowRoot` adds a top-level target.
export function MoveModal({ title = 'Verschieben nach', allFolders, excludeId, allowRoot = true, onMove, onClose }) {
  const [busy, setBusy] = useState(false);

  // depth + descendant exclusion from the flat list.
  const byParent = {};
  allFolders.forEach((f) => { (byParent[f.parent_id || 0] ||= []).push(f); });
  const excluded = new Set();
  if (excludeId) {
    const walk = (id) => { excluded.add(id); (byParent[id] || []).forEach((c) => walk(c.id)); };
    walk(excludeId);
  }
  const rows = [];
  const visit = (parentId, depth) => {
    (byParent[parentId] || []).forEach((f) => {
      if (excluded.has(f.id)) return;
      rows.push({ f, depth });
      visit(f.id, depth + 1);
    });
  };
  visit(0, 0);

  const pick = async (target) => {
    setBusy(true);
    try { await onMove(target); } finally { setBusy(false); }
  };

  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 480, borderRadius: 'var(--r-xl)', padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.folder(17)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0 }}>{title}</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ overflowY: 'auto', padding: 8 }}>
          {allowRoot && (
            <button disabled={busy} onClick={() => pick(null)} style={moveRowStyle(0)}>
              <span style={{ color: 'var(--fg-3)' }}>{Ic.home(15)}</span>Hauptebene (kein Ordner)
            </button>
          )}
          {rows.map(({ f, depth }) => (
            <button key={f.id} disabled={busy} onClick={() => pick(f.id)} style={moveRowStyle(depth)}>
              <span style={{ color: 'var(--accent)' }}>{f.kind === 'gallery' ? Ic.fileImg(15) : Ic.folder(15)}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>{f.item_count || 0}</span>
            </button>
          ))}
          {rows.length === 0 && !allowRoot && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>Keine möglichen Zielordner.</div>
          )}
        </div>
      </Glass>
    </div>
  );
}
function moveRowStyle(depth) {
  return {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
    padding: '10px 12px', paddingLeft: 12 + depth * 18,
    borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer',
    fontFamily: 'inherit', fontSize: 13.5, textAlign: 'left',
    background: 'transparent', color: 'var(--fg)',
  };
}

// ───── small shared bits ───────────────────────────────────────────────────
function greeting() {
  const h = new Date().getHours();
  if (h < 11) return 'Guten Morgen';
  if (h < 18) return 'Hallo';
  return 'Guten Abend';
}

function SectionHeader({ title, count, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, letterSpacing: -0.4, margin: 0 }}>{title}</h2>
        {count != null && <span style={{ fontSize: 12, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>}
      </div>
      {action}
    </div>
  );
}

function NewFolderRow({ onCreate, onCancel }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('normal');
  const [tone, setTone] = useState('violet');
  return (
    <div style={{ marginBottom: 18, padding: 14, borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px dashed var(--border-hi)', display: 'flex', alignItems: 'center', gap: 10 }}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onCreate(name.trim(), kind, tone); if (e.key === 'Escape') onCancel(); }}
        placeholder="Ordnername" style={{ flex: 1, height: 36, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13.5, color: 'var(--fg)' }}/>
      <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ height: 36, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)' }}>
        <option value="normal">Dateien</option><option value="gallery">Galerie</option>
      </select>
      <select value={tone} onChange={(e) => setTone(e.target.value)} style={{ height: 36, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)' }}>
        <option value="violet">Violet</option><option value="aurora">Aurora</option><option value="sunset">Sunset</option><option value="mono">Mono</option>
      </select>
      <Btn variant="primary" size="sm" disabled={!name.trim()} onClick={() => onCreate(name.trim(), kind, tone)}>Erstellen</Btn>
      <Btn variant="ghost" size="sm" onClick={onCancel}>Abbrechen</Btn>
    </div>
  );
}

function EmptyHint({ icon, title, desc, actions }) {
  return (
    <div style={{ padding: '48px 24px', borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px dashed var(--border-hi)', textAlign: 'center', marginBottom: 36 }}>
      {icon && <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14, color: 'var(--fg-3)' }}>{icon}</div>}
      <div style={{ fontSize: 15, fontWeight: 540, marginBottom: 6 }}>{title}</div>
      {desc && <div style={{ fontSize: 13, color: 'var(--fg-3)', marginBottom: 16 }}>{desc}</div>}
      {actions && <div style={{ display: 'inline-flex', gap: 8 }}>{actions}</div>}
    </div>
  );
}

// Apply client-side sort to a file array.
function sortFiles(files, sort) {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const copy = [...files];
  copy.sort((a, b) => {
    let r = 0;
    if (sort.by === 'name') r = a.name.localeCompare(b.name, 'de');
    else if (sort.by === 'size') r = (a.size || 0) - (b.size || 0);
    else r = String(a.created_at || '').localeCompare(String(b.created_at || ''));
    return r * dir;
  });
  return copy;
}

// ───── Dashboard (router shell) ────────────────────────────────────────────
export function Dashboard({ user, theme, onTheme, basePath }) {
  const [view, setView] = useState('grid');
  const [sort, setSort] = useState({ by: 'date', dir: 'desc' });
  const [search, setSearch] = useState('');
  const [nav, setNav] = useState({ name: 'files' }); // {name:'files'|'shared'|'links'|'activity'|'folder', id?}
  const [stats, setStats] = useState(null);
  const [folders, setFolders] = useState([]);

  // modals / overlays
  const [shareTarget, setShareTarget] = useState(null);     // {folder} | {file}
  const [showUploadLinkModal, setShowUploadLinkModal] = useState(false);
  const [uploadLinkFolder, setUploadLinkFolder] = useState(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [renameFolderTarget, setRenameFolderTarget] = useState(null);
  const [moveTarget, setMoveTarget] = useState(null); // { kind:'folder'|'files', folder?, ids? }
  const [allFolders, setAllFolders] = useState([]);
  const [viewing, setViewing] = useState(null); // { items, index }
  const openViewer = (f, list) => {
    const items = (list && list.length) ? list : [f];
    setViewing({ items, index: Math.max(0, items.findIndex((x) => x.id === f.id)) });
  };
  const [uploads, setUploads] = useState([]);
  const [showUploadProgress, setShowUploadProgress] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const isMobile = useIsMobile();

  const uploadInputRef = useRef(null);
  const uploadTargetFolder = useRef(null);

  const loadStats = useCallback(() => { API.stats().then(setStats).catch(() => {}); }, []);
  const loadFolders = useCallback(() => { API.folders().then((d) => setFolders(d.folders || [])).catch(() => {}); }, []);
  useEffect(() => { loadStats(); loadFolders(); }, [loadStats, loadFolders]);

  // a token bumped to force child views to reload after uploads/changes
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshAll = () => { loadStats(); loadFolders(); setRefreshTick((t) => t + 1); };

  const runUpload = async (filesArr, folderId = null) => {
    const items = filesArr.map((f) => ({
      name: f.name, size: f.size, status: 'queued', pct: 0,
      kind: f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : f.type === 'application/pdf' ? 'pdf' : 'doc',
    }));
    setUploads(items);
    setShowUploadProgress(true);
    for (let i = 0; i < filesArr.length; i++) {
      setUploads((u) => u.map((x, j) => j === i ? { ...x, status: 'uploading' } : x));
      try {
        await uploadOwner(filesArr[i], folderId, (p) => setUploads((u) => u.map((x, j) => j === i ? { ...x, pct: p } : x)));
        setUploads((u) => u.map((x, j) => j === i ? { ...x, status: 'done', pct: 1 } : x));
      } catch (err) {
        setUploads((u) => u.map((x, j) => j === i ? { ...x, status: 'error' } : x));
        toast(err.message, 'error');
      }
    }
    refreshAll();
  };

  const triggerUpload = (folderId = null) => { uploadTargetFolder.current = folderId; uploadInputRef.current?.click(); };

  const openMove = async (target) => {
    try { const d = await API.allFolders(); setAllFolders(d.folders || []); } catch { setAllFolders([]); }
    setMoveTarget(target);
  };
  const doMove = async (destFolderId) => {
    try {
      if (moveTarget.kind === 'folder') await API.moveFolder(moveTarget.folder.id, destFolderId);
      else await API.moveFiles(moveTarget.ids, destFolderId);
      toast('Verschoben', 'success');
      setMoveTarget(null);
      refreshAll();
    } catch (e) { toast(e.message, 'error'); }
  };

  const newText = async (folderId = null) => {
    try {
      const d = await API.createText({ folder_id: folderId, name: 'Neue Notiz.txt', content: '' });
      refreshAll();
      openViewer(d.file, [d.file]); // opens straight into the editor
    } catch (e) { toast(e.message, 'error'); }
  };

  const activeNav = nav.name === 'folder' ? 'files' : nav.name;

  return (
    <div style={{ display: 'flex', height: '100%', position: 'relative', zIndex: 1 }}>
      {!isMobile && (
        <Sidebar active={activeNav} stats={stats} user={user} onTheme={onTheme} theme={theme}
          onNavigate={(n) => { setNav(n); setSearch(''); }}
          onUpload={() => triggerUpload(null)}
          onChangePassword={() => setShowPasswordModal(true)}
          onLogout={() => { setToken(null); location.reload(); }}/>
      )}

      <div className={isMobile ? 'nyza-mobile-content' : ''} style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {nav.name === 'files' && (
          <FilesView
            user={user} stats={stats} folders={folders} view={view} setView={setView}
            sort={sort} setSort={setSort} search={search} setSearch={setSearch}
            refreshTick={refreshTick}
            onOpenFolder={(f) => setNav({ name: 'folder', id: f.id })}
            onShareFolder={(f) => setShareTarget({ folder: f })}
            onRenameFolder={(f) => setRenameFolderTarget(f)}
            onMoveFolder={(f) => openMove({ kind: 'folder', folder: f })}
            onMoveFiles={(ids) => openMove({ kind: 'files', ids })}
            onDeleteFolder={async (f) => { if (!confirm(`Ordner "${f.name}" und alle Inhalte löschen?`)) return; try { await API.deleteFolder(f.id); toast('Ordner gelöscht', 'success'); refreshAll(); } catch (e) { toast(e.message, 'error'); } }}
            onNewFolder={async (name, kind, tone) => { try { await API.newFolder({ name, kind, tone }); toast('Ordner erstellt', 'success'); refreshAll(); } catch (e) { toast(e.message, 'error'); } }}
            onUpload={() => triggerUpload(null)}
            onNewText={() => newText(null)}
            onUploadLink={() => { setUploadLinkFolder(null); setShowUploadLinkModal(true); }}
            onOpenFile={openViewer}
            onShareFile={(f) => setShareTarget({ file: f })}
            onDeleteFile={async (f) => { try { await API.deleteFile(f.id); toast('Gelöscht', 'success'); refreshAll(); } catch (e) { toast(e.message, 'error'); } }}
          />
        )}
        {nav.name === 'folder' && (
          <FolderView
            folderId={nav.id} view={view} setView={setView} sort={sort} setSort={setSort}
            search={search} setSearch={setSearch} refreshTick={refreshTick}
            onBack={() => setNav({ name: 'files' })}
            onOpenFolder={(f) => setNav({ name: 'folder', id: f.id })}
            onUpload={(fid) => triggerUpload(fid)}
            onNewText={(fid) => newText(fid)}
            onShareFolder={(f) => setShareTarget({ folder: f })}
            onMoveFiles={(ids) => openMove({ kind: 'files', ids })}
            onUploadLink={(f) => { setUploadLinkFolder(f.id); setShowUploadLinkModal(true); }}
            onOpenFile={openViewer}
            onShareFile={(f) => setShareTarget({ file: f })}
            onDeleteFile={async (f) => { try { await API.deleteFile(f.id); toast('Gelöscht', 'success'); refreshAll(); } catch (e) { toast(e.message, 'error'); } }}
            afterChange={refreshAll}
          />
        )}
        {nav.name === 'shared' && (
          <SharesView refreshTick={refreshTick} basePath={basePath} afterChange={refreshAll}/>
        )}
        {nav.name === 'links' && (
          <LinksView refreshTick={refreshTick} basePath={basePath}
            onCreate={() => { setUploadLinkFolder(null); setShowUploadLinkModal(true); }}
            afterChange={refreshAll}/>
        )}
        {nav.name === 'activity' && (
          <ActivityView refreshTick={refreshTick}/>
        )}
        {nav.name === 'trash' && (
          <TrashView refreshTick={refreshTick} onOpenFile={openViewer} afterChange={refreshAll}/>
        )}
      </div>

      {shareTarget && (
        <ShareModal folder={shareTarget.folder} file={shareTarget.file} basePath={basePath}
          onClose={() => setShareTarget(null)} onCreated={refreshAll}/>
      )}
      {showUploadLinkModal && (
        <UploadLinkModal folders={folders} defaultFolderId={uploadLinkFolder} basePath={basePath}
          onClose={() => setShowUploadLinkModal(false)} onCreated={refreshAll}/>
      )}
      {showUploadProgress && (
        <UploadProgress items={uploads} onClose={() => { setShowUploadProgress(false); setUploads([]); }}/>
      )}
      {showPasswordModal && <ChangePasswordModal onClose={() => setShowPasswordModal(false)}/>}
      {renameFolderTarget && (
        <RenameFolderModal folder={renameFolderTarget} onClose={() => setRenameFolderTarget(null)} onSaved={refreshAll}/>
      )}
      {moveTarget && (
        <MoveModal
          title={moveTarget.kind === 'folder' ? 'Ordner verschieben nach' : 'Dateien verschieben nach'}
          allFolders={allFolders}
          excludeId={moveTarget.kind === 'folder' ? moveTarget.folder.id : null}
          onMove={doMove} onClose={() => setMoveTarget(null)}/>
      )}
      {viewing && (
        <MediaViewer items={viewing.items} startIndex={viewing.index}
          srcFor={(f) => fileSrc(f.id)} downloadFor={(f) => fileDownload(f.id)}
          onSaveText={async (f, content) => { await API.saveContent(f.id, content); refreshAll(); }}
          onClose={() => setViewing(null)}/>
      )}

      {isMobile && (
        <MobileNav active={activeNav} onNavigate={(n) => { setNav(n); setSearch(''); }}
          onUpload={() => triggerUpload(null)} onMore={() => setShowMore(true)}/>
      )}
      {showMore && (
        <MoreSheet user={user} theme={theme} onTheme={onTheme}
          onNavigate={(n) => { setNav(n); setSearch(''); }}
          onChangePassword={() => setShowPasswordModal(true)}
          onLogout={() => { setToken(null); location.reload(); }}
          onClose={() => setShowMore(false)}/>
      )}

      <input ref={uploadInputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => {
        const filesArr = Array.from(e.target.files || []);
        if (filesArr.length) runUpload(filesArr, uploadTargetFolder.current);
        e.target.value = '';
      }}/>
    </div>
  );
}

// ───── Files (home) view ───────────────────────────────────────────────────
function FilesView({
  user, stats, folders, view, setView, sort, setSort, search, setSearch, refreshTick,
  onOpenFolder, onShareFolder, onRenameFolder, onMoveFolder, onMoveFiles, onDeleteFolder, onNewFolder, onUpload, onNewText, onUploadLink,
  onOpenFile, onShareFile, onDeleteFile,
}) {
  const [files, setFiles] = useState(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [zipBusy, setZipBusy] = useState(false);
  const [results, setResults] = useState(null); // server search results when searching

  useEffect(() => { API.files().then((d) => setFiles(d.files || [])).catch(() => setFiles([])); }, [refreshTick]);

  // Server-side search across ALL files/folders (debounced).
  const searching = search.trim().length >= 2;
  useEffect(() => {
    if (!searching) { setResults(null); return; }
    let off = false;
    const t = setTimeout(() => {
      API.searchFiles(search.trim()).then((d) => { if (!off) setResults({ files: d.files || [], folders: d.folders || [] }); }).catch(() => { if (!off) setResults({ files: [], folders: [] }); });
    }, 250);
    return () => { off = true; clearTimeout(t); };
  }, [search, searching, refreshTick]);

  const fFolders = folders;
  const fFiles = files === null ? [] : sortFiles(files, sort);

  const toggleSelect = (id) => {
    if (id === '__all__') {
      setSelected((s) => s.size === fFiles.length ? new Set() : new Set(fFiles.map((f) => f.id)));
      return;
    }
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const clearSel = () => setSelected(new Set());
  const doZip = () => downloadZip([...selected], setZipBusy, clearSel);
  const doBulkDelete = async () => {
    if (!confirm(`${selected.size} Datei(en) löschen?`)) return;
    for (const id of selected) { try { await API.deleteFile(id); } catch {} }
    toast('Gelöscht', 'success'); clearSel();
    API.files().then((d) => setFiles(d.files || []));
  };

  return (
    <>
      <TopBar crumbs={['Meine Dateien']} view={view} onView={setView} search={search} onSearch={setSearch} sort={sort} onSort={setSort}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '28px 32px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, marginBottom: 28 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: 'var(--fg-3)', marginBottom: 6 }}>{greeting()}, {user?.name}</div>
            <h1 className="nyza-hero-title" style={{ fontFamily: 'var(--font-display)', fontSize: 38, fontWeight: 600, letterSpacing: -1.2, margin: 0, lineHeight: 1.05 }}>
              Deine Dateien.<span style={{ color: 'var(--fg-3)' }}> Schön sortiert.</span>
            </h1>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="glass" size="md" icon={Ic.fileGen(15)} onClick={onNewText}>Notiz</Btn>
            <Btn variant="glass" size="md" icon={Ic.link(15)} onClick={onUploadLink}>Upload-Link</Btn>
            <Btn variant="primary" size="md" icon={Ic.upload(15)} onClick={onUpload}>Hochladen</Btn>
          </div>
        </div>

        <div className="nyza-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 32 }}>
          {[
            { label: 'Gespeichert', v: humanSize(stats?.storage_used || 0), sub: 'von ' + humanSize(stats?.quota || 0), accent: true },
            { label: 'Dateien gesamt', v: stats?.files || 0, sub: 'in ' + (stats?.folders || 0) + ' Ordnern' },
            { label: 'Aktive Links', v: stats?.upload_links || 0, sub: (stats?.shares || 0) + ' Share-Links' },
            { label: 'Letzte 7 Tage', v: '+' + (stats?.week_uploads || 0), sub: 'Hochgeladen' },
          ].map((s, i) => (
            <div key={i} style={{ padding: '14px 18px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', position: 'relative', overflow: 'hidden' }}>
              {s.accent && <div style={{ position: 'absolute', inset: 0, background: 'var(--accent-grad)', opacity: 0.08 }}/>}
              <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4, position: 'relative' }}>{s.label}</div>
              <div style={{ fontSize: 22, fontFamily: 'var(--font-display)', fontWeight: 600, letterSpacing: -0.6, position: 'relative' }}>{s.v}</div>
              <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2, position: 'relative' }}>{s.sub}</div>
            </div>
          ))}
        </div>

        {searching ? (
          <>
            <SectionHeader title={'Suchergebnisse für „' + search.trim() + '"'} count={results ? (results.files.length + results.folders.length) : null}/>
            {results === null ? <SkeletonGrid count={5}/> : (results.files.length + results.folders.length) === 0 ? (
              <EmptyHint icon={Ic.search(40)} title="Nichts gefunden" desc={'Keine Dateien oder Ordner zu „' + search.trim() + '".'}/>
            ) : (
              <>
                {results.folders.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14, marginBottom: 28 }}>
                    {results.folders.map((f) => <FolderCard key={f.id} folder={f} onClick={() => onOpenFolder(f)}/>)}
                  </div>
                )}
                {results.files.length > 0 && (
                  <FileGrid files={results.files} selected={selected} onOpen={(f) => onOpenFile(f, results.files)} onToggleSelect={toggleSelect} onDragSelect={setSelected}/>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <SectionHeader title="Ordner" count={fFolders.length} action={<Btn variant="glass" size="sm" icon={Ic.plus(13)} onClick={() => setCreatingFolder(true)}>Neuer Ordner</Btn>}/>
            {creatingFolder && <NewFolderRow onCreate={(n, k, t) => { onNewFolder(n, k, t); setCreatingFolder(false); }} onCancel={() => setCreatingFolder(false)}/>}
            {fFolders.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14, marginBottom: 36 }}>
                {fFolders.map((f) => <FolderCard key={f.id} folder={f}
                  onClick={() => onOpenFolder(f)} onShare={() => onShareFolder(f)}
                  onRename={() => onRenameFolder(f)} onMove={() => onMoveFolder(f)}
                  onDelete={() => onDeleteFolder(f)}/>)}
              </div>
            ) : !creatingFolder && (
              <EmptyHint icon={Ic.folder(40)} title="Noch keine Ordner" desc="Lege einen Ordner an oder lade direkt Dateien hoch."
                actions={<><Btn variant="primary" size="md" icon={Ic.plus(14)} onClick={() => setCreatingFolder(true)}>Neuer Ordner</Btn><Btn variant="glass" size="md" icon={Ic.upload(14)} onClick={onUpload}>Hochladen</Btn></>}/>
            )}

            <SectionHeader title="Letzte Dateien" count={files === null ? null : fFiles.length}/>
            {files === null ? (
              <SkeletonGrid/>
            ) : fFiles.length > 0 ? (
              view === 'grid'
                ? <FileGrid files={fFiles} selected={selected} onOpen={(f) => onOpenFile(f, fFiles)} onToggleSelect={toggleSelect} onDragSelect={setSelected}/>
                : <FileList files={fFiles} selected={selected} onOpen={(f) => onOpenFile(f, fFiles)} onToggleSelect={toggleSelect} onShareFile={onShareFile} onDeleteFile={(f) => { onDeleteFile(f); }}/>
            ) : (
              <EmptyHint icon={Ic.upload(40)} title="Noch keine Dateien" desc="Zieh Dateien hierher oder klick auf Hochladen."
                actions={<Btn variant="primary" size="md" icon={Ic.upload(14)} onClick={onUpload}>Erste Datei hochladen</Btn>}/>
            )}
          </>
        )}
      </div>

      {selected.size > 0 && <SelectionBar count={selected.size} busy={zipBusy} onZip={doZip} onMove={() => onMoveFiles([...selected])} onDelete={doBulkDelete} onClear={clearSel}/>}
    </>
  );
}

// ───── Folder detail view ──────────────────────────────────────────────────
function FolderView({
  folderId, view, setView, sort, setSort, search, setSearch, refreshTick,
  onBack, onOpenFolder, onUpload, onNewText, onShareFolder, onMoveFiles, onUploadLink, onOpenFile, onShareFile, onDeleteFile, afterChange,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [zipBusy, setZipBusy] = useState(false);
  const [over, setOver] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    API.folder(folderId).then((d) => { setData(d); setLoading(false); }).catch((e) => { toast(e.message, 'error'); setLoading(false); });
  }, [folderId]);
  useEffect(() => { load(); setSelected(new Set()); }, [load, refreshTick]);

  if (loading && !data) {
    return (<><TopBar crumbs={[{ label: 'Meine Dateien', onClick: onBack }, '…']}/><div data-scroll style={{ flex: 1, overflow: 'auto', padding: '24px 32px' }}><SkeletonGrid/></div></>);
  }
  if (!data) return null;

  const folder = data.folder;
  const subfolders = data.subfolders || [];
  const q = search.toLowerCase();
  const files = sortFiles((data.files || []).filter((f) => !q || f.name.toLowerCase().includes(q)), sort);

  const toggleSelect = (id) => {
    if (id === '__all__') { setSelected((s) => s.size === files.length ? new Set() : new Set(files.map((f) => f.id))); return; }
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const clearSel = () => setSelected(new Set());
  const doZip = () => downloadZip([...selected], setZipBusy, clearSel);
  const doBulkDelete = async () => {
    if (!confirm(`${selected.size} Datei(en) löschen?`)) return;
    for (const id of selected) { try { await API.deleteFile(id); } catch {} }
    toast('Gelöscht', 'success'); clearSel(); load(); afterChange && afterChange();
  };

  return (
    <>
      <TopBar
        crumbs={[{ label: 'Meine Dateien', onClick: onBack }, folder.name]}
        view={view} onView={setView} search={search} onSearch={setSearch} sort={sort} onSort={setSort}
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="glass" size="sm" icon={Ic.fileGen(14)} onClick={() => onNewText(folder.id)}>Notiz</Btn>
            <Btn variant="glass" size="sm" icon={Ic.link(14)} onClick={() => onUploadLink(folder)}>Upload-Link</Btn>
            <Btn variant="glass" size="sm" icon={Ic.share(14)} onClick={() => onShareFolder(folder)}>Teilen</Btn>
            <Btn variant="primary" size="sm" icon={Ic.upload(14)} onClick={() => onUpload(folder.id)}>Hochladen</Btn>
          </div>
        }
      />
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const fs = Array.from(e.dataTransfer.files || []); if (fs.length) onUpload(folder.id, fs); }}
        data-scroll style={{ flex: 1, overflow: 'auto', padding: '24px 32px 80px', position: 'relative', outline: over ? '2px dashed var(--accent)' : 'none', outlineOffset: -12 }}>
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>
            {folder.kind === 'gallery' ? '◇ Galerie' : '◇ Ordner'} · {files.length} Dateien · {humanSize((data.files || []).reduce((s, f) => s + (f.size || 0), 0))}
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 600, letterSpacing: -0.8, margin: 0 }}>{folder.name}</h1>
        </div>

        {subfolders.length > 0 && (
          <>
            <SectionHeader title="Unterordner" count={subfolders.length}/>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14, marginBottom: 32 }}>
              {subfolders.map((f) => <FolderCard key={f.id} folder={f} onClick={() => onOpenFolder(f)}/>)}
            </div>
          </>
        )}

        {files.length > 0 ? (
          view === 'grid'
            ? <FileGrid files={files} selected={selected} onOpen={(f) => onOpenFile(f, files)} onToggleSelect={toggleSelect} onDragSelect={setSelected}/>
            : <FileList files={files} selected={selected} onOpen={(f) => onOpenFile(f, files)} onToggleSelect={toggleSelect} onShareFile={onShareFile} onDeleteFile={(f) => { onDeleteFile(f); }}/>
        ) : (
          <EmptyHint icon={Ic.upload(40)} title="Dieser Ordner ist leer" desc="Zieh Dateien hierher oder lade welche hoch."
            actions={<Btn variant="primary" size="md" icon={Ic.upload(14)} onClick={() => onUpload(folder.id)}>Hochladen</Btn>}/>
        )}
      </div>

      {selected.size > 0 && <SelectionBar count={selected.size} busy={zipBusy} onZip={doZip} onMove={() => onMoveFiles([...selected])} onDelete={doBulkDelete} onClear={clearSel}/>}
    </>
  );
}

// ───── Shares view ─────────────────────────────────────────────────────────
function SharesView({ refreshTick, basePath, afterChange }) {
  const [shares, setShares] = useState(null);
  const load = useCallback(() => { API.shares().then((d) => setShares(d.shares || [])).catch(() => setShares([])); }, []);
  useEffect(() => { load(); }, [load, refreshTick]);

  const del = async (id) => { if (!confirm('Share-Link löschen? Der Link wird sofort ungültig.')) return; try { await API.deleteShare(id); toast('Gelöscht', 'success'); load(); afterChange && afterChange(); } catch (e) { toast(e.message, 'error'); } };
  const copy = (token) => { navigator.clipboard?.writeText(location.origin + (basePath || '') + '/s/' + token); toast('Link kopiert', 'success'); };

  return (
    <>
      <TopBar crumbs={['Geteilt']}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '28px 32px 60px' }}>
        <SectionHeader title="Geteilte Links" count={shares ? shares.length : null}/>
        {shares === null ? (
          <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
        ) : shares.length === 0 ? (
          <EmptyHint icon={Ic.share(40)} title="Noch nichts geteilt" desc="Teile einen Ordner oder eine Datei — der Link erscheint hier."/>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {shares.map((s) => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'color-mix(in oklab, var(--accent) 16%, transparent)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{s.folder_id ? Ic.folder(18) : Ic.fileGen(18)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>/s/{s.token}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span>{s.folder_id ? 'Ordner' : 'Datei'}</span>
                    <span>· {s.view_count || 0} Aufrufe</span>
                    {s.password_hash && <span>· {Ic.lock(10)} Passwort</span>}
                    {!s.allow_download && <span>· kein Download</span>}
                    {s.expires_at && <span>· läuft ab {new Date(s.expires_at).toLocaleDateString('de-DE')}</span>}
                    <span>· erstellt {timeAgo(s.created_at)}</span>
                  </div>
                </div>
                <Btn variant="glass" size="sm" icon={Ic.copy(13)} onClick={() => copy(s.token)}>Kopieren</Btn>
                <a href={(basePath || '') + '/s/' + s.token} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><Btn variant="glass" size="sm" icon={Ic.eye(13)}>Öffnen</Btn></a>
                <IconBtn size={32} title="Löschen" onClick={() => del(s.id)}>{Ic.trash(14)}</IconBtn>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ───── Upload-Links view ───────────────────────────────────────────────────
function LinksView({ refreshTick, basePath, onCreate, afterChange }) {
  const [links, setLinks] = useState(null);
  const load = useCallback(() => { API.uploadLinks().then((d) => setLinks(d.upload_links || [])).catch(() => setLinks([])); }, []);
  useEffect(() => { load(); }, [load, refreshTick]);

  const del = async (id) => { if (!confirm('Upload-Link löschen? Externe können dann nicht mehr hochladen.')) return; try { await API.deleteUploadLink(id); toast('Gelöscht', 'success'); load(); afterChange && afterChange(); } catch (e) { toast(e.message, 'error'); } };
  const copy = (token) => { navigator.clipboard?.writeText(location.origin + (basePath || '') + '/u/' + token); toast('Link kopiert', 'success'); };

  return (
    <>
      <TopBar crumbs={['Upload-Links']} right={<Btn variant="primary" size="sm" icon={Ic.plus(14)} onClick={onCreate}>Neuer Upload-Link</Btn>}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '28px 32px 60px' }}>
        <SectionHeader title="Upload-Links" count={links ? links.length : null}/>
        {links === null ? (
          <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
        ) : links.length === 0 ? (
          <EmptyHint icon={Ic.inbox(40)} title="Noch keine Upload-Links" desc="Erstelle einen Link, über den Externe ohne Login Dateien zu dir hochladen."
            actions={<Btn variant="primary" size="md" icon={Ic.plus(14)} onClick={onCreate}>Upload-Link erstellen</Btn>}/>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {links.map((l) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 4px 12px -4px var(--accent-glow)' }}>{Ic.inbox(18)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 540, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span>→ {l.folder_name || 'Ordner'}</span>
                    <span>· {l.upload_count || 0}{l.max_files ? '/' + l.max_files : ''} Uploads</span>
                    {l.has_password && <span>· {Ic.lock(10)} Passwort</span>}
                    {l.max_file_size && <span>· max {humanSize(l.max_file_size)}</span>}
                    {l.expires_at && <span>· läuft ab {new Date(l.expires_at).toLocaleDateString('de-DE')}</span>}
                  </div>
                </div>
                <Btn variant="glass" size="sm" icon={Ic.copy(13)} onClick={() => copy(l.token)}>Kopieren</Btn>
                <a href={(basePath || '') + '/u/' + l.token} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><Btn variant="glass" size="sm" icon={Ic.eye(13)}>Öffnen</Btn></a>
                <IconBtn size={32} title="Löschen" onClick={() => del(l.id)}>{Ic.trash(14)}</IconBtn>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ───── Activity view (upload history) ──────────────────────────────────────
function ActivityView({ refreshTick }) {
  const [items, setItems] = useState(null);
  useEffect(() => { API.activity().then((d) => setItems(d.activity || [])).catch(() => setItems([])); }, [refreshTick]);

  const meta = (kind) => ({
    file_uploaded:       { icon: Ic.upload,  label: 'Datei hochgeladen', color: 'var(--accent)' },
    external_upload:     { icon: Ic.inbox,   label: 'Externer Upload',   color: 'var(--success)' },
    share_created:       { icon: Ic.share,   label: 'Share-Link erstellt', color: 'var(--accent)' },
    upload_link_created: { icon: Ic.link,    label: 'Upload-Link erstellt', color: 'var(--accent)' },
  }[kind] || { icon: Ic.bolt, label: kind, color: 'var(--fg-3)' });

  return (
    <>
      <TopBar crumbs={['Aktivität']}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '28px 32px 60px' }}>
        <SectionHeader title="Verlauf" count={items ? items.length : null}/>
        {items === null ? (
          <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
        ) : items.length === 0 ? (
          <EmptyHint icon={Ic.clock(40)} title="Noch keine Aktivität" desc="Uploads, geteilte Links und Upload-Links erscheinen hier."/>
        ) : (
          <div style={{ display: 'grid', gap: 8, maxWidth: 760 }}>
            {items.map((a) => {
              const m = meta(a.kind);
              const p = a.payload || {};
              return (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <div style={{ width: 34, height: 34, borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', color: m.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{m.icon(16)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                      {m.label}
                      {p.name && <span style={{ color: 'var(--fg-2)', fontWeight: 400 }}> · {p.name}</span>}
                      {p.uploader_name && <span style={{ color: 'var(--accent)', fontWeight: 400 }}> · von {p.uploader_name}</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2 }}>
                      {p.size != null && <span>{humanSize(p.size)} · </span>}{timeAgo(a.created_at)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

// ───── Papierkorb / Trash view ─────────────────────────────────────────────
function TrashView({ refreshTick, onOpenFile, afterChange }) {
  const [files, setFiles] = useState(null);
  const load = useCallback(() => { API.trash().then((d) => setFiles(d.files || [])).catch(() => setFiles([])); }, []);
  useEffect(() => { load(); }, [load, refreshTick]);

  const restore = async (f) => { try { await API.restoreFile(f.id); toast('Wiederhergestellt', 'success'); load(); afterChange && afterChange(); } catch (e) { toast(e.message, 'error'); } };
  const forever = async (f) => { if (!confirm(`"${f.name}" endgültig löschen?`)) return; try { await API.deleteForever(f.id); toast('Endgültig gelöscht', 'success'); load(); afterChange && afterChange(); } catch (e) { toast(e.message, 'error'); } };
  const empty = async () => { if (!confirm('Papierkorb wirklich leeren? Alle Dateien werden endgültig gelöscht.')) return; try { await API.emptyTrash(); toast('Papierkorb geleert', 'success'); load(); afterChange && afterChange(); } catch (e) { toast(e.message, 'error'); } };

  return (
    <>
      <TopBar crumbs={['Papierkorb']} right={files && files.length > 0 ? <Btn variant="danger" size="sm" icon={Ic.trash(13)} onClick={empty}>Papierkorb leeren</Btn> : null}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '28px 32px 60px' }}>
        <SectionHeader title="Gelöschte Dateien" count={files ? files.length : null}/>
        {files === null ? (
          <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
        ) : files.length === 0 ? (
          <EmptyHint icon={Ic.trash(40)} title="Papierkorb ist leer" desc="Gelöschte Dateien landen hier und können wiederhergestellt werden."/>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {files.map((f) => (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <FileIcon kind={f.kind} size={16} tint={f.hue}/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{humanSize(f.size)} · gelöscht {timeAgo(f.deleted_at)}</div>
                </div>
                <Btn variant="glass" size="sm" icon={Ic.rotate(13)} onClick={() => restore(f)}>Wiederherstellen</Btn>
                <IconBtn size={32} title="Endgültig löschen" onClick={() => forever(f)}>{Ic.trash(14)}</IconBtn>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// Trigger a multi-file ZIP download from the owner /api/files/zip endpoint.
async function downloadZip(fileIds, setBusy, onDone) {
  if (!fileIds.length) return;
  setBusy && setBusy(true);
  try {
    const res = await API.zip({ file_ids: fileIds });
    if (!res.ok) throw new Error('ZIP fehlgeschlagen');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nyza-' + new Date().toISOString().slice(0, 10) + '.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('ZIP wird heruntergeladen', 'success');
    onDone && onDone();
  } catch (e) {
    toast(e.message || 'ZIP fehlgeschlagen', 'error');
  } finally {
    setBusy && setBusy(false);
  }
}
