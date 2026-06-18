// Authenticated app shell + screens.

import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import QRCode from 'qrcode';
import { API, BASE, getToken, setToken, getCompany, setCompany } from './api.js';
import {
  Ic, Glass, Btn, IconBtn, NyzaWordmark, FileIcon, PhotoPlaceholder,
  Toggle, CircularProgress, humanSize, timeAgo, ACCENTS, applyAccent,
} from './system.jsx';
import { toast } from './toast.jsx';
import { confirmDialog, openContextMenu } from './overlays.jsx';
import { uploadOwner } from './uploads.js';

// Heavy CodeMirror editor — only fetched when a text file is actually opened.
const CodeEditor = lazy(() => import('./editor.jsx'));

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
function TextPane({ fileId, src, name, editable, onSave }) {
  const [content, setContent] = useState(null);
  const [orig, setOrig] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [hist, setHist] = useState(null); // null=closed, []|[...] = open list
  const [histBusy, setHistBusy] = useState(false);
  const isMd = /\.(md|markdown)$/i.test(name);
  const loadContent = () => fetch(src).then((r) => r.text()).then((t) => { setContent(t); setOrig(t); }).catch(() => { setContent(''); setOrig(''); });
  useEffect(() => {
    let off = false;
    fetch(src).then((r) => r.text()).then((t) => { if (!off) { setContent(t); setOrig(t); } })
      .catch(() => { if (!off) { setContent(''); setOrig(''); } });
    return () => { off = true; };
  }, [src]);
  const openHist = async () => {
    setHist([]); setHistBusy(true);
    try { const d = await API.versions(fileId); setHist(d.versions || []); }
    catch (e) { toast(e.message, 'error'); setHist(null); }
    finally { setHistBusy(false); }
  };
  const restore = async (vid) => {
    if (!await confirmDialog({ title: 'Version wiederherstellen?', message: 'Die aktuelle Fassung wird vorher automatisch im Verlauf gesichert.', confirmLabel: 'Wiederherstellen', icon: Ic.rotate(22) })) return;
    try { await API.restoreVersion(fileId, vid); await loadContent(); setHist(null); toast('Version wiederhergestellt', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  };
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
        {editable && <Btn variant="glass" size="sm" icon={Ic.clock(13)} onClick={openHist}>Verlauf</Btn>}
        {editable && <Btn variant="primary" size="sm" disabled={!dirty || saving} icon={saving ? Ic.loader(13) : Ic.check(13)} onClick={save}>{saving ? 'Speichert…' : 'Speichern'}</Btn>}
      </div>
      {content === null ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-3)' }}>{Ic.loader(22)}</div>
      ) : (isMd && preview) ? (
        <div className="nyza-md" style={{ flex: 1, overflow: 'auto', padding: '20px 26px' }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}/>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <Suspense fallback={<div style={{ padding: 18, color: 'var(--fg-3)' }}>{Ic.loader(20)}</div>}>
            <CodeEditor value={content} name={name} editable={editable} onChange={(v) => setContent(v)}/>
          </Suspense>
        </div>
      )}
      {hist !== null && (
        <div className="nyza-modal-backdrop" onClick={() => setHist(null)} style={{ zIndex: 210 }}>
          <Glass style={{ width: '100%', maxWidth: 440, borderRadius: 'var(--r-xl)', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: '70vh' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ color: 'var(--accent)' }}>{Ic.clock(18)}</span>
              <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0 }}>Versionsverlauf</h2>
              <IconBtn size={30} onClick={() => setHist(null)}>{Ic.close(16)}</IconBtn>
            </div>
            <div style={{ overflowY: 'auto', padding: 10 }}>
              {histBusy ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--fg-3)' }}>{Ic.loader(20)}</div>
              ) : hist.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>Noch keine früheren Versionen.<br/>Sie entstehen automatisch beim Speichern.</div>
              ) : hist.map((v, i) => (
                <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', marginBottom: 6 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{i === 0 ? 'Letzte Version' : 'Version'} · {humanSize(v.size)}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{timeAgo(v.created_at)}</div>
                  </div>
                  <Btn variant="glass" size="sm" icon={Ic.rotate(13)} onClick={() => restore(v.id)}>Wiederherstellen</Btn>
                </div>
              ))}
            </div>
          </Glass>
        </div>
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
export function MediaViewer({ file, src, downloadHref, items, startIndex = 0, srcFor, downloadFor, onSaveText, comments, onClose }) {
  const gallery = Array.isArray(items) && items.length > 0;
  const [idx, setIdx] = useState(startIndex);
  const cur = gallery ? items[idx] : file;
  const curSrc = gallery ? srcFor(cur) : src;
  const curDl = gallery ? (downloadFor ? downloadFor(cur) : null) : downloadHref;
  const touch = useRef(null);
  const textual = isTextFile(cur);
  const [showComments, setShowComments] = useState(false);

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
  // Recognise audio by kind OR extension, so files uploaded before the audio
  // kind existed (stored as 'doc') still get a player.
  const isAudio = kind === 'audio' || /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i.test(cur.name || '');
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
        {comments && (
          <Btn variant={showComments ? 'primary' : 'glass'} size="sm" icon={Ic.comment(14)} onClick={() => setShowComments((s) => !s)}>Kommentare</Btn>
        )}
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
        {isAudio && kind !== 'video' && (
          <Glass onClick={stop} style={{ width: '100%', maxWidth: 460, padding: '34px 36px', borderRadius: 'var(--r-xl)', textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
              <div style={{ width: 96, height: 96, borderRadius: 'var(--r-lg)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 12px 40px -8px var(--accent-glow)' }}>{Ic.fileAudio(44)}</div>
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, marginBottom: 16, wordBreak: 'break-word' }}>{cur.name}</div>
            <audio key={cur.id} controls autoPlay src={curSrc} style={{ width: '100%' }}>
              Dein Browser unterstützt das Format nicht.
            </audio>
          </Glass>
        )}
        {textual && (
          <TextPane key={cur.id} fileId={cur.id} src={curSrc} name={cur.name}
            editable={!!onSaveText} onSave={(content) => onSaveText(cur, content)}/>
        )}
        {!textual && !isAudio && kind !== 'video' && kind !== 'image' && kind !== 'pdf' && (
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

      {comments && showComments && (
        <CommentsPanel key={cur.id} file={cur} cfg={comments} onClose={() => setShowComments(false)}/>
      )}
    </div>
  );
}

// Comments drawer (right side) used inside the MediaViewer. cfg provides
// load/add (+ optional remove), askName (guest) and a default name.
function CommentsPanel({ file, cfg, onClose }) {
  const [items, setItems] = useState(null);
  const [body, setBody] = useState('');
  const [name, setName] = useState(cfg.defaultName || '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let off = false;
    cfg.load(file).then((c) => { if (!off) setItems(c || []); }).catch(() => { if (!off) setItems([]); });
    return () => { off = true; };
  }, [file.id]);
  const send = async (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    if (cfg.askName && !name.trim()) { toast('Bitte Namen eingeben', 'error'); return; }
    setBusy(true);
    try { const c = await cfg.add(file, { body: body.trim(), author_name: name.trim() }); setItems(c || []); setBody(''); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const remove = async (cid) => {
    try { const c = await cfg.remove(file, cid); setItems(c || []); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div onClick={(e) => e.stopPropagation()} className="nyza-comments" style={{
      position: 'absolute', top: 60, right: 0, bottom: 0, width: 340, maxWidth: '90vw', zIndex: 5,
      background: 'var(--surface)', borderLeft: '1px solid var(--border-hi)',
      backdropFilter: 'blur(30px) saturate(180%)', WebkitBackdropFilter: 'blur(30px) saturate(180%)',
      display: 'flex', flexDirection: 'column', animation: 'slideUp 0.2s ease',
    }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: 'var(--accent)' }}>{Ic.comment(16)}</span>
        <span style={{ flex: 1, fontWeight: 600, fontSize: 14, color: 'var(--fg)' }}>Kommentare{items ? ' · ' + items.length : ''}</span>
        <IconBtn size={28} onClick={onClose}>{Ic.close(15)}</IconBtn>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items === null ? <div style={{ color: 'var(--fg-3)' }}>{Ic.loader(18)}</div>
          : items.length === 0 ? <div style={{ fontSize: 13, color: 'var(--fg-3)', textAlign: 'center', padding: 20 }}>Noch keine Kommentare.</div>
          : items.map((c) => (
            <div key={c.id} style={{ background: 'var(--surface-hi)', borderRadius: 'var(--r-sm)', padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: c.source === 'owner' ? 'var(--accent)' : 'var(--fg)' }}>{c.author_name}</span>
                {c.source === 'owner' && <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: 'var(--accent-grad)', color: '#fff' }}>OWNER</span>}
                <span style={{ flex: 1 }}/>
                <span style={{ fontSize: 10.5, color: 'var(--fg-4)' }}>{timeAgo(c.created_at)}</span>
                {cfg.remove && <span onClick={() => remove(c.id)} style={{ cursor: 'pointer', color: 'var(--fg-4)' }} title="Löschen">{Ic.trash(12)}</span>}
              </div>
              <div style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{c.body}</div>
            </div>
          ))}
      </div>
      <form onSubmit={send} style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {cfg.askName && (
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dein Name"
            style={{ height: 36, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)' }}/>
        )}
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Kommentar schreiben…" rows={2}
          style={{ padding: '10px 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)', resize: 'vertical', fontFamily: 'inherit' }}/>
        <Btn variant="primary" size="sm" full type="submit" disabled={busy || !body.trim()} icon={busy ? Ic.loader(13) : Ic.comment(13)}>Senden</Btn>
      </form>
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
  const [challenge, setChallenge] = useState(null); // 2FA pending token
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const data = await API.login({ email, password });
      if (data.requires_2fa) { setChallenge(data.challenge); setBusy(false); return; }
      setToken(data.token);
      onAuth(data.user);
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  };

  const submit2fa = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const data = await API.twoFactorLogin(challenge, code);
      setToken(data.token);
      onAuth(data.user);
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, position: 'relative', zIndex: 1 }}>
      <Glass style={{ width: '100%', maxWidth: 420, borderRadius: 'var(--r-xl)', padding: 36 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
          <NyzaWordmark size={20}/>
        </div>
        {!challenge ? (
          <>
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
          </>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
              <div style={{ width: 56, height: 56, borderRadius: 'var(--r-lg)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 12px 32px -8px var(--accent-glow)' }}>{Ic.lock(24)}</div>
            </div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 600, letterSpacing: -0.6, margin: 0, textAlign: 'center' }}>Bestätigung</h1>
            <p style={{ fontSize: 13, color: 'var(--fg-3)', textAlign: 'center', marginTop: 8 }}>{useRecovery ? 'Gib einen deiner Recovery-Codes ein.' : '6-stelliger Code aus deiner Authenticator-App.'}</p>
            <form onSubmit={submit2fa} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24 }}>
              {useRecovery
                ? <input autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX" autoCapitalize="characters"
                    style={{ height: 56, textAlign: 'center', letterSpacing: 4, fontSize: 20, fontFamily: 'var(--font-mono)', padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', color: 'var(--fg)' }}/>
                : <input autoFocus inputMode="numeric" maxLength={6} value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000"
                    style={{ height: 56, textAlign: 'center', letterSpacing: 8, fontSize: 24, fontFamily: 'var(--font-mono)', padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', color: 'var(--fg)' }}/>}
              <Btn variant="primary" size="lg" full type="submit" disabled={busy || (useRecovery ? code.trim().length < 6 : code.length !== 6)} icon={busy ? Ic.loader(16) : null}>
                {busy ? 'Prüfe…' : 'Anmelden'}
              </Btn>
              <Btn variant="ghost" size="md" type="button" onClick={() => { setUseRecovery((v) => !v); setCode(''); }}>{useRecovery ? 'Authenticator-Code verwenden' : 'Authenticator verloren? Recovery-Code'}</Btn>
              <Btn variant="ghost" size="md" type="button" onClick={() => { setChallenge(null); setCode(''); setUseRecovery(false); }}>Zurück</Btn>
            </form>
          </>
        )}
      </Glass>
    </div>
  );
}

// ───── Security modal: 2FA (TOTP) + login history ───────────────────────────
export function SecurityModal({ user, onClose, onChanged, onChangePassword }) {
  const [enabled, setEnabled] = useState(!!user.twofa);
  const [setup, setSetup] = useState(null); // { secret, uri, qr }
  const [code, setCode] = useState('');
  const [disablePw, setDisablePw] = useState('');
  const [busy, setBusy] = useState(false);
  const [logins, setLogins] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState(null);

  useEffect(() => { API.loginHistory().then((d) => setLogins(d.logins || [])).catch(() => setLogins([])); }, []);

  const startSetup = async () => {
    setBusy(true);
    try {
      const d = await API.twoFactorSetup();
      const qr = await QRCode.toDataURL(d.uri, { margin: 1, width: 220 });
      setSetup({ secret: d.secret, uri: d.uri, qr });
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const enable = async () => {
    setBusy(true);
    try { const d = await API.twoFactorEnable(code); setEnabled(true); setSetup(null); setCode(''); if (d.recovery_codes) setRecoveryCodes(d.recovery_codes); toast('2FA aktiviert', 'success'); onChanged && onChanged(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const regenCodes = async () => {
    setBusy(true);
    try { const d = await API.twoFactorRecoveryCodes(); setRecoveryCodes(d.recovery_codes || []); toast('Neue Recovery-Codes erstellt', 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true);
    try { await API.twoFactorDisable(disablePw, code); setEnabled(false); setCode(''); setDisablePw(''); toast('2FA deaktiviert', 'success'); onChanged && onChanged(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 520, borderRadius: 'var(--r-xl)', overflow: 'hidden', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.lock(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>Sicherheit</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
          {/* 2FA */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Zwei-Faktor-Authentifizierung</span>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 999, background: enabled ? 'color-mix(in oklab, var(--success) 20%, transparent)' : 'var(--surface-hi)', color: enabled ? 'var(--success)' : 'var(--fg-3)' }}>{enabled ? 'AKTIV' : 'AUS'}</span>
            </div>

            {!enabled && !setup && (
              <>
                <p style={{ fontSize: 13, color: 'var(--fg-3)', margin: '0 0 12px' }}>Schütze dein Konto zusätzlich mit einer Authenticator-App (Google Authenticator, Authy, 1Password …).</p>
                <Btn variant="primary" size="md" disabled={busy} icon={busy ? Ic.loader(15) : Ic.lock(15)} onClick={startSetup}>2FA aktivieren</Btn>
              </>
            )}

            {!enabled && setup && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <p style={{ fontSize: 13, color: 'var(--fg-3)', margin: 0 }}>1. Scanne den QR-Code in deiner App. 2. Gib den 6-stelligen Code ein.</p>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                  <img src={setup.qr} alt="QR" style={{ width: 160, height: 160, borderRadius: 'var(--r-sm)', background: '#fff', padding: 6 }}/>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>Oder manuell eintippen:</div>
                    <code style={{ fontSize: 12, wordBreak: 'break-all', background: 'var(--surface-hi)', padding: '6px 8px', borderRadius: 6, display: 'block' }}>{setup.secret}</code>
                  </div>
                </div>
                <input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000"
                  style={{ height: 48, textAlign: 'center', letterSpacing: 6, fontSize: 20, fontFamily: 'var(--font-mono)', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', color: 'var(--fg)' }}/>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <Btn variant="ghost" onClick={() => { setSetup(null); setCode(''); }}>Abbrechen</Btn>
                  <Btn variant="primary" disabled={busy || code.length !== 6} onClick={enable} icon={busy ? Ic.loader(15) : null}>Aktivieren</Btn>
                </div>
              </div>
            )}

            {enabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p style={{ fontSize: 13, color: 'var(--fg-3)', margin: 0 }}>Zum Deaktivieren Passwort + aktuellen Code eingeben.</p>
                <input type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} placeholder="Aktuelles Passwort"
                  style={{ height: 40, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', color: 'var(--fg)' }}/>
                <input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="Code"
                  style={{ height: 40, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', color: 'var(--fg)', fontFamily: 'var(--font-mono)' }}/>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <Btn variant="glass" size="sm" disabled={busy} icon={Ic.rotate(13)} onClick={regenCodes}>Recovery-Codes neu</Btn>
                  <Btn variant="danger" disabled={busy || code.length !== 6 || !disablePw} onClick={disable}>2FA deaktivieren</Btn>
                </div>
              </div>
            )}

            {recoveryCodes && (
              <div style={{ marginTop: 14, padding: '14px 16px', borderRadius: 'var(--r-md)', background: 'color-mix(in oklab, var(--accent) 8%, transparent)', border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Recovery-Codes — jetzt sicher speichern!</div>
                <p style={{ fontSize: 12, color: 'var(--fg-3)', margin: '0 0 10px' }}>Falls du deinen Authenticator verlierst, kannst du dich mit einem dieser Codes einloggen. Jeder Code funktioniert einmal. Sie werden nur dieses eine Mal angezeigt.</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, marginBottom: 10 }}>
                  {recoveryCodes.map((c) => <code key={c} style={{ fontFamily: 'var(--font-mono)', fontSize: 13, textAlign: 'center', padding: '6px 4px', borderRadius: 6, background: 'var(--surface-hi)' }}>{c}</code>)}
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <Btn variant="glass" size="sm" icon={Ic.copy(13)} onClick={() => { navigator.clipboard?.writeText(recoveryCodes.join('\n')); toast('Codes kopiert', 'success'); }}>Kopieren</Btn>
                  <Btn variant="primary" size="sm" onClick={() => setRecoveryCodes(null)}>Gespeichert</Btn>
                </div>
              </div>
            )}
          </div>

          {/* Password */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Passwort</div>
              <div style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>Login-Passwort ändern</div>
            </div>
            <Btn variant="glass" size="sm" icon={Ic.lock(13)} onClick={() => { onClose(); onChangePassword && onChangePassword(); }}>Ändern</Btn>
          </div>

          {/* Login history */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Login-Verlauf</div>
            {logins === null ? <div style={{ color: 'var(--fg-3)' }}>{Ic.loader(18)}</div>
              : logins.length === 0 ? <div style={{ fontSize: 13, color: 'var(--fg-3)' }}>Noch keine Einträge.</div>
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
                  {logins.map((l, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, padding: '7px 10px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)' }}>
                      <span style={{ width: 7, height: 7, borderRadius: 4, background: l.ok ? 'var(--success)' : 'var(--danger)', flexShrink: 0 }}/>
                      <span style={{ flex: 1, color: 'var(--fg-2)' }}>{l.ip || '—'} · {(l.user_agent || '').slice(0, 40)}</span>
                      <span style={{ color: 'var(--fg-3)' }}>{timeAgo(l.created_at)}</span>
                    </div>
                  ))}
                </div>}
          </div>

          {/* WebDAV (network drive) */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Als Laufwerk verbinden (WebDAV)</div>
            <p style={{ fontSize: 12.5, color: 'var(--fg-3)', margin: '0 0 10px' }}>
              Im Finder „Mit Server verbinden" (⌘K) bzw. in Windows „Netzlaufwerk verbinden" — mit dieser Adresse, deiner E-Mail und deinem Passwort.
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code style={{ flex: 1, fontSize: 12, wordBreak: 'break-all', background: 'var(--surface-hi)', padding: '8px 10px', borderRadius: 6 }}>{location.origin + (BASE || '') + '/webdav/'}</code>
              <Btn variant="glass" size="sm" icon={Ic.copy(13)} onClick={() => { navigator.clipboard?.writeText(location.origin + (BASE || '') + '/webdav/'); toast('Adresse kopiert', 'success'); }}>Kopieren</Btn>
            </div>
          </div>

          {/* Updates */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Updates</div>
              <div style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>Neueste Version aus GitHub installieren</div>
            </div>
            <a href={(BASE || '') + '/?update=1&token=' + (getToken() || '')} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
              <Btn variant="glass" size="sm" icon={Ic.rotate(13)}>Nach Updates suchen</Btn>
            </a>
          </div>
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

// ───── Profile & branding modal ─────────────────────────────────────────────
const GB = 1024 * 1024 * 1024;

function FolderTemplateSettings() {
  const [templates, setTemplates] = useState(() => JSON.parse(localStorage.getItem('nyza.folderTemplates') || '[]'));
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editFolders, setEditFolders] = useState('');

  const save = () => {
    const updated = templates.map((t) => t.id === editId ? { ...t, name: editName.trim(), folders: editFolders.split(',').map((s) => s.trim()).filter(Boolean) } : t);
    setTemplates(updated);
    localStorage.setItem('nyza.folderTemplates', JSON.stringify(updated));
    setEditId(null);
  };
  const addNew = () => {
    const id = Date.now().toString();
    const updated = [...templates, { id, name: 'Neue Vorlage', folders: [] }];
    setTemplates(updated);
    localStorage.setItem('nyza.folderTemplates', JSON.stringify(updated));
    setEditId(id); setEditName('Neue Vorlage'); setEditFolders('');
  };
  const del = (id) => {
    const updated = templates.filter((t) => t.id !== id);
    setTemplates(updated);
    localStorage.setItem('nyza.folderTemplates', JSON.stringify(updated));
    if (editId === id) setEditId(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {templates.map((t) => (
        <div key={t.id} style={{ borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', overflow: 'hidden' }}>
          {editId === t.id ? (
            <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Vorlagenname"
                style={{ height: 36, padding: '0 10px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)' }}/>
              <input value={editFolders} onChange={(e) => setEditFolders(e.target.value)} placeholder="Unterordner kommagetrennt: Planung, Assets, Deliverables"
                style={{ height: 36, padding: '0 10px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)' }}/>
              <div style={{ display: 'flex', gap: 6 }}>
                <Btn variant="primary" size="sm" onClick={save}>Speichern</Btn>
                <Btn variant="ghost" size="sm" onClick={() => setEditId(null)}>Abbrechen</Btn>
              </div>
            </div>
          ) : (
            <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 540 }}>{t.name}</div>
                <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2 }}>{t.folders.length > 0 ? t.folders.join(', ') : 'Keine Unterordner'}</div>
              </div>
              <Btn variant="ghost" size="sm" onClick={() => { setEditId(t.id); setEditName(t.name); setEditFolders(t.folders.join(', ')); }}>Bearbeiten</Btn>
              <IconBtn size={28} title="Löschen" onClick={() => del(t.id)}>{Ic.trash(13)}</IconBtn>
            </div>
          )}
        </div>
      ))}
      <Btn variant="glass" size="sm" icon={Ic.plus(13)} onClick={addNew}>Vorlage hinzufügen</Btn>
    </div>
  );
}

export function ProfileModal({ user, onClose, onSaved }) {
  const [name, setName] = useState(user.name || '');
  const [email, setEmail] = useState(user.email || '');
  const [accent, setAccent] = useState(user.accent || 'violet');
  const [quotaGb, setQuotaGb] = useState(Math.round((user.storage_quota || 200 * GB) / GB));
  const [usedGb, setUsedGb] = useState((user.storage_used || 0) / GB);
  const [logoFile, setLogoFile] = useState(null);
  const [logoPreview, setLogoPreview] = useState(user.has_logo ? API.logoUrl(user.id) + '?v=' + Date.now() : null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  // Pull fresh values on open (login payload may lack quota/email until /me).
  useEffect(() => {
    API.me().then((d) => {
      const u = d.user;
      setName(u.name || ''); setEmail(u.email || ''); setAccent(u.accent || 'violet');
      setQuotaGb(Math.round((u.storage_quota || 200 * GB) / GB));
      setUsedGb((u.storage_used || 0) / GB);
    }).catch(() => {});
  }, []);

  // live-preview accent while picking
  useEffect(() => { applyAccent(accent); }, [accent]);
  useEffect(() => () => { if (!busy) applyAccent(user.accent || 'violet'); }, []); // restore on unmount if not saved

  const pickLogo = (f) => { setLogoFile(f); setRemoveLogo(false); setLogoPreview(URL.createObjectURL(f)); };

  const save = async () => {
    setBusy(true);
    try {
      await API.updateProfile({ name: name.trim(), email: email.trim(), accent, storage_quota: Math.max(1, Number(quotaGb) || 1) * GB });
      if (logoFile) await API.uploadLogo(logoFile);
      else if (removeLogo) await API.deleteLogo();
      const me = await API.me();
      applyAccent(me.user.accent || 'violet');
      toast('Profil gespeichert', 'success');
      onSaved && onSaved(me.user);
      onClose();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 520, borderRadius: 'var(--r-xl)', overflow: 'hidden', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.users(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>Profil & Branding</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
          <FieldInput label="Anzeigename" value={name} onChange={setName}/>
          <FieldInput label="E-Mail" type="email" value={email} onChange={setEmail}/>

          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Speicher-Kontingent</label>
              <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>· aktuell {humanSize(usedGb * GB)} belegt</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="number" min={1} value={quotaGb} onChange={(e) => setQuotaGb(e.target.value)}
                style={{ width: 120, height: 42, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)' }}/>
              <span style={{ fontSize: 14, color: 'var(--fg-2)' }}>GB</span>
              <span style={{ fontSize: 11.5, color: 'var(--fg-4)', marginLeft: 6 }}>begrenzt nur die Anzeige — echter Platz = Server-Festplatte</span>
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)', marginBottom: 8 }}>Akzentfarbe</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {Object.keys(ACCENTS).map((k) => (
                <button key={k} onClick={() => setAccent(k)} title={k} style={{
                  width: 34, height: 34, borderRadius: '50%', cursor: 'pointer',
                  background: `linear-gradient(135deg, ${ACCENTS[k].from}, ${ACCENTS[k].to})`,
                  border: '2px solid ' + (accent === k ? 'var(--fg)' : 'transparent'),
                  boxShadow: accent === k ? '0 0 0 2px var(--bg)' : 'none',
                }}/>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)', marginBottom: 10 }}>Ansicht</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" defaultChecked={localStorage.getItem('nyza.showRecent') !== '0'}
                onChange={(e) => { localStorage.setItem('nyza.showRecent', e.target.checked ? '1' : '0'); window.dispatchEvent(new Event('nyza.prefchange')); }}
                style={{ width: 16, height: 16, accentColor: 'var(--accent)', cursor: 'pointer' }}/>
              <span style={{ fontSize: 14, color: 'var(--fg-2)' }}>„Zuletzt geöffnet" auf der Startseite anzeigen</span>
            </label>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)', marginBottom: 8 }}>Logo (für Share- & Upload-Seiten)</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 64, height: 64, borderRadius: 'var(--r-md)', background: 'var(--surface-hi)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                {logoPreview && !removeLogo ? <img src={logoPreview} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }}/> : <span style={{ color: 'var(--fg-4)' }}>{Ic.fileImg(24)}</span>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn variant="glass" size="sm" icon={Ic.upload(13)} onClick={() => fileRef.current?.click()}>Logo wählen</Btn>
                {(logoPreview && !removeLogo) && <Btn variant="ghost" size="sm" icon={Ic.trash(13)} onClick={() => { setRemoveLogo(true); setLogoFile(null); setLogoPreview(null); }}>Entfernen</Btn>}
              </div>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) pickLogo(f); e.target.value = ''; }}/>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)', marginBottom: 10 }}>Ordnervorlagen</div>
            <FolderTemplateSettings/>
          </div>
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} onClick={save} icon={busy ? Ic.loader(15) : null}>Speichern</Btn>
        </div>
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
function Sidebar({ active, stats, user, onNavigate, onLogout, onTheme, theme, onUpload, onSearch, onSecurity, onProfile }) {
  const items = [
    { id: 'files',    label: 'Meine Dateien', icon: Ic.home,   count: stats?.files },
    { id: 'favorites',label: 'Favoriten',     icon: Ic.star },
    { id: 'shared-with-me', label: 'Mit mir geteilt', icon: Ic.users },
    { id: 'links',    label: 'Links',         icon: Ic.link,   count: ((stats?.shares || 0) + (stats?.upload_links || 0)) || null },
    { id: 'apps',     label: 'Apps',          icon: Ic.grid },
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
      <div style={{ padding: '4px 10px 22px', cursor: 'pointer' }} onClick={() => onNavigate({ name: 'files' })}>
        {user?.has_logo
          ? <img src={API.logoUrl(user.id)} alt="Logo" style={{ maxHeight: 30, maxWidth: 160, objectFit: 'contain' }}/>
          : <NyzaWordmark size={16}/>}
      </div>
      <Btn variant="primary" size="md" icon={Ic.upload(16)} full onClick={onUpload}>Hochladen</Btn>
      <button onClick={onSearch} style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', marginTop: 10, padding: '9px 12px',
        borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)',
        color: 'var(--fg-3)', fontSize: 13, cursor: 'pointer', textAlign: 'left',
      }}>
        <span style={{ display: 'inline-flex' }}>{Ic.search(15)}</span>
        <span style={{ flex: 1 }}>Suchen…</span>
        <kbd style={{ fontSize: 10, border: '1px solid var(--border)', borderRadius: 5, padding: '1px 5px' }}>⌘K</kbd>
      </button>
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
          <IconBtn size={28} title="Profil & Branding" onClick={onProfile}>{Ic.cog(14)}</IconBtn>
          <IconBtn size={28} title="Sicherheit & 2FA" onClick={onSecurity}>{Ic.lock(14)}</IconBtn>
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
    { id: 'links', label: 'Links', icon: Ic.link },
    { id: '__upload__' },
    { id: 'apps', label: 'Apps', icon: Ic.grid },
    { id: '__more__', label: 'Mehr', icon: Ic.more },
  ];
  return (
    <div style={{
      position: 'fixed', left: 12, right: 12, bottom: 'calc(12px + env(safe-area-inset-bottom))', height: 64, zIndex: 80,
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

function MoreSheet({ user, theme, onTheme, onNavigate, onSecurity, onProfile, onLogout, onClose }) {
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
        {item(Ic.cog(18), 'Profil & Branding', onProfile)}
        {item(theme === 'dark' ? Ic.sun(18) : Ic.moon(18), theme === 'dark' ? 'Helles Design' : 'Dunkles Design', onTheme)}
        {item(Ic.lock(18), 'Sicherheit & 2FA', onSecurity)}
        {item(Ic.logout(18), 'Abmelden', onLogout, true)}
      </Glass>
    </div>
  );
}

function FabSheet({ onCreateFolder, onUploadFiles, onUploadFolder, onClose }) {
  return (
    <div className="nyza-modal-backdrop" onClick={onClose} style={{ alignItems: 'flex-end', zIndex: 90 }}>
      <Glass style={{ width: '100%', maxWidth: 520, borderRadius: '24px 24px 0 0', padding: 16, paddingBottom: 28 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--border-hi)', margin: '4px auto 14px' }}/>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-3)', padding: '0 16px 10px' }}>Hinzufügen</div>
        {[
          { icon: Ic.folder(20), label: 'Ordner erstellen', sub: 'Neuen Ordner anlegen', onClick: onCreateFolder },
          { icon: Ic.upload(20), label: 'Datei hochladen', sub: 'Dateien von diesem Gerät', onClick: onUploadFiles },
          { icon: Ic.folderUp(20), label: 'Ordner hochladen', sub: 'Ordner inkl. Unterordner', onClick: onUploadFolder },
        ].map(({ icon, label, sub, onClick }) => (
          <button key={label} onClick={() => { onClick(); onClose(); }} style={{
            display: 'flex', alignItems: 'center', gap: 16, width: '100%', padding: '14px 16px',
            background: 'none', border: 'none', borderRadius: 'var(--r-md)', cursor: 'pointer',
            fontFamily: 'inherit', textAlign: 'left',
          }}>
            <div style={{ width: 44, height: 44, borderRadius: 'var(--r-md)', background: 'var(--surface-hi)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)', flexShrink: 0 }}>{icon}</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--fg)' }}>{label}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 1 }}>{sub}</div>
            </div>
          </button>
        ))}
      </Glass>
    </div>
  );
}

// ───── Top bar ─────────────────────────────────────────────────────────────
function TopBar({ crumbs = ['Meine Dateien'], view, onView, onSearch, search, sort, onSort, selectMode, onSelectMode, right }) {
  return (
    <div className="nyza-topbar" style={{
      height: 64, padding: '0 28px', display: 'flex', alignItems: 'center', gap: 14,
      borderBottom: '1px solid var(--border)', flexShrink: 0,
      background: 'var(--surface-2)', backdropFilter: 'blur(20px)',
    }}>
      <div className="nyza-brand-m" style={{ display: 'none', alignItems: 'center', minWidth: 0 }}>
        <NyzaWordmark size={15}/>
      </div>
      <div className={'nyza-crumbs' + (crumbs.length <= 1 ? ' nyza-crumbs-single' : '')} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, minWidth: 0 }}>
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
      {onSelectMode && (
        <IconBtn active={!!selectMode} onClick={() => onSelectMode(!selectMode)} size={38}
          title={selectMode ? 'Auswahl beenden' : 'Auswählen'}
          style={{ border: '1px solid var(--border)', borderRadius: 999 }}>{Ic.checkSquare(16)}</IconBtn>
      )}
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

// Folder colour palette (Google-Drive-style tags). Each entry drives the card
// gradient, glow and the swatch dot. `h` = oklch hues, `c` = chroma factor
// (gray uses near-zero). Legacy tones (aurora/sunset/mono) stay mapped.
const FOLDER_TONES = {
  violet: { label: 'Violett', h: [282, 265], c: 1 },
  blue:   { label: 'Blau',    h: [245, 255], c: 1 },
  teal:   { label: 'Türkis',  h: [195, 205], c: 1 },
  green:  { label: 'Grün',    h: [150, 158], c: 1 },
  yellow: { label: 'Gelb',    h: [95, 88],  c: 1 },
  orange: { label: 'Orange',  h: [55, 38],  c: 1 },
  red:    { label: 'Rot',     h: [25, 18],  c: 1 },
  pink:   { label: 'Pink',    h: [350, 338], c: 1 },
  gray:   { label: 'Grau',    h: [260, 260], c: 0.06 },
  // legacy values kept for older folders
  aurora: { label: 'Aurora',  h: [168, 200], c: 1 },
  sunset: { label: 'Sunset',  h: [30, 360],  c: 1 },
  mono:   { label: 'Mono',    h: [240, 260], c: 0.15 },
};
// Order shown in the colour picker.
const FOLDER_COLOR_KEYS = ['violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'gray'];
function folderTone(key) { return FOLDER_TONES[key] || FOLDER_TONES.violet; }
function folderDot(key) { const t = folderTone(key); return `oklch(0.68 ${0.2 * t.c} ${t.h[0]})`; }
const FOLDER_SWATCHES = FOLDER_COLOR_KEYS.map((k) => ({ key: k, label: FOLDER_TONES[k].label, dot: folderDot(k) }));

// ───── Tags / labels ───────────────────────────────────────────────────────
const TAG_COLORS = {
  violet: { label: 'Violett', fg: '#7c3aed', bg: 'rgba(124,58,237,0.14)' },
  blue:   { label: 'Blau',    fg: '#2563eb', bg: 'rgba(37,99,235,0.14)' },
  teal:   { label: 'Türkis',  fg: '#0d9488', bg: 'rgba(13,148,136,0.14)' },
  green:  { label: 'Grün',    fg: '#16a34a', bg: 'rgba(22,163,74,0.14)' },
  amber:  { label: 'Bernstein', fg: '#d97706', bg: 'rgba(217,119,6,0.16)' },
  red:    { label: 'Rot',     fg: '#dc2626', bg: 'rgba(220,38,38,0.14)' },
  pink:   { label: 'Pink',    fg: '#db2777', bg: 'rgba(219,39,119,0.14)' },
  slate:  { label: 'Grau',    fg: '#64748b', bg: 'rgba(100,116,139,0.16)' },
};
const TAG_COLOR_KEYS = Object.keys(TAG_COLORS);
const tagColor = (c) => TAG_COLORS[c] || TAG_COLORS.violet;

function TagChip({ tag, onRemove, small }) {
  const c = tagColor(tag.color);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: small ? '1px 7px' : '2px 9px', borderRadius: 999,
      fontSize: small ? 10.5 : 12, fontWeight: 600, lineHeight: 1.5,
      color: c.fg, background: c.bg, whiteSpace: 'nowrap',
    }}>
      {tag.name}
      {onRemove && (
        <span onClick={(e) => { e.stopPropagation(); onRemove(); }} style={{ cursor: 'pointer', display: 'inline-flex', opacity: 0.7 }}>{Ic.close(11)}</span>
      )}
    </span>
  );
}

// Small inline row of chips for cards/rows. `ids` → resolved against `tags`.
function TagChips({ ids, tags, max = 4, small }) {
  if (!ids || !ids.length || !tags) return null;
  const byId = {}; tags.forEach((t) => { byId[t.id] = t; });
  const list = ids.map((id) => byId[id]).filter(Boolean);
  if (!list.length) return null;
  const shown = list.slice(0, max);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {shown.map((t) => <TagChip key={t.id} tag={t} small={small}/>)}
      {list.length > max && <span style={{ fontSize: small ? 10 : 11, color: 'var(--fg-3)' }}>+{list.length - max}</span>}
    </div>
  );
}

// Modal to add/remove/create tags for one entity. selectedIds is a Set.
function TagPickerModal({ title = 'Tags', tags, selectedIds, onToggle, onCreate, onClose }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('violet');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try { await onCreate(n, color); setName(''); } finally { setBusy(false); }
  };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 420, borderRadius: 'var(--r-xl)', padding: 24 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0 }}>{title}</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18, maxHeight: 180, overflowY: 'auto' }}>
          {(tags || []).length === 0 && <div style={{ fontSize: 13, color: 'var(--fg-3)' }}>Noch keine Tags — leg unten einen an.</div>}
          {(tags || []).map((t) => {
            const on = selectedIds.has(t.id);
            const c = tagColor(t.color);
            return (
              <button key={t.id} onClick={() => onToggle(t, !on)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 999,
                fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                color: c.fg, background: on ? c.bg : 'transparent',
                border: '1.5px solid ' + (on ? c.fg : 'var(--border)'),
              }}>
                {on && Ic.check(12)}{t.name}
              </button>
            );
          })}
        </div>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--fg-3)', marginBottom: 8 }}>Neuen Tag anlegen</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} placeholder="Tag-Name"
              style={{ flex: 1, height: 38, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13.5, color: 'var(--fg)' }}/>
            <Btn variant="primary" size="md" disabled={busy || !name.trim()} onClick={create} icon={busy ? Ic.loader(14) : Ic.plus(14)}>Anlegen</Btn>
          </div>
          <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
            {TAG_COLOR_KEYS.map((k) => (
              <span key={k} onClick={() => setColor(k)} title={TAG_COLORS[k].label} style={{
                width: 22, height: 22, borderRadius: '50%', cursor: 'pointer', background: TAG_COLORS[k].fg,
                border: '2px solid ' + (color === k ? 'var(--fg)' : 'transparent'), boxShadow: color === k ? '0 0 0 2px var(--bg)' : 'none',
              }}/>
            ))}
          </div>
        </div>
      </Glass>
    </div>
  );
}

// Loads the tag palette + the {entityId:[tagId]} map for one entity type and
// exposes optimistic create/toggle helpers. Shared by DMS and accounting views.
function useEntityTags(type, refreshTick) {
  const [tags, setTags] = useState([]);
  const [map, setMap] = useState({});
  const reload = useCallback(() => {
    API.tags().then((d) => setTags(d.tags || [])).catch(() => {});
    API.tagMap(type).then((d) => setMap(d.map || {})).catch(() => {});
  }, [type]);
  useEffect(() => { reload(); }, [reload, refreshTick]);
  const createTag = async (name, color) => {
    const d = await API.createTag(name, color);
    setTags((ts) => ts.some((t) => t.id === d.tag.id) ? ts : [...ts, d.tag].sort((a, b) => a.name.localeCompare(b.name)));
    return d.tag;
  };
  const toggle = async (entityId, tag, on) => {
    setMap((m) => {
      const cur = new Set(m[entityId] || []);
      on ? cur.add(tag.id) : cur.delete(tag.id);
      return { ...m, [entityId]: [...cur] };
    });
    try { on ? await API.assignTag(tag.id, type, entityId) : await API.unassignTag(tag.id, type, entityId); }
    catch (e) { toast(e.message, 'error'); reload(); }
  };
  const idsFor = (entityId) => map[String(entityId)] || [];
  return { tags, map, reload, createTag, toggle, idsFor };
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
function FolderCard({ folder, onClick, onShare, onDelete, onRename, onMove, onDropFiles, onContext }) {
  const t = folderTone(folder.tone);
  const tones = t.h;
  const cc = t.c;
  const [dropOver, setDropOver] = useState(false);
  return (
    <div onClick={onClick} onContextMenu={onContext ? (e) => { e.preventDefault(); e.stopPropagation(); onContext(folder, e); } : undefined} style={{
      borderRadius: 'var(--r-lg)', background: 'var(--surface)',
      border: '1px solid ' + (dropOver ? 'var(--accent)' : 'var(--border)'),
      backdropFilter: 'blur(20px) saturate(160%)', WebkitBackdropFilter: 'blur(20px) saturate(160%)',
      overflow: 'hidden', cursor: 'pointer',
      transition: 'transform .25s cubic-bezier(.2,.8,.2,1), box-shadow .25s, border-color .15s',
      boxShadow: dropOver ? '0 0 0 3px var(--accent-glow)' : '0 1px 0 var(--inner-hi) inset, 0 8px 24px -12px rgba(0,0,0,0.25)',
    }}
    onDragOver={onDropFiles ? (e) => { if (e.dataTransfer.types.includes('application/x-nyza-files')) { e.preventDefault(); setDropOver(true); } } : undefined}
    onDragLeave={onDropFiles ? () => setDropOver(false) : undefined}
    onDrop={onDropFiles ? (e) => {
      e.preventDefault(); setDropOver(false);
      try { const ids = JSON.parse(e.dataTransfer.getData('application/x-nyza-files') || '[]'); if (ids.length) onDropFiles(folder.id, ids); } catch {}
    } : undefined}
    onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; }}
    onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}>
      <div className="nyza-folder-head" style={{ height: 132, position: 'relative', overflow: 'hidden' }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: `linear-gradient(135deg, oklch(0.4 ${0.12 * cc} ${tones[0]} / 0.5), oklch(0.3 ${0.08 * cc} ${tones[1]} / 0.7))`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: 'var(--r-md)',
            background: `linear-gradient(135deg, oklch(0.7 ${0.18 * cc} ${tones[0]}), oklch(0.55 ${0.2 * cc} ${tones[1]}))`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 8px 24px -8px oklch(0.65 ' + (0.2 * cc) + ' ' + tones[0] + ' / 0.6)', color: '#fff',
          }}>{folder.kind === 'gallery' ? Ic.fileImg(28) : Ic.folder(28)}</div>
        </div>
        <div style={{
          position: 'absolute', top: 10, right: 10, padding: '4px 8px', borderRadius: 999,
          fontSize: 10, fontWeight: 600, letterSpacing: 0.4, background: 'rgba(0,0,0,0.5)', color: '#fff',
          backdropFilter: 'blur(10px)', textTransform: 'uppercase',
        }}>{folder.kind === 'gallery' ? '◇ Galerie' : '◇ Dateien'}</div>
        {!!folder.pinned && (
          <div style={{ position: 'absolute', top: 10, left: 10, color: 'var(--accent)', background: 'rgba(0,0,0,0.45)', borderRadius: 999, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(6px)' }}
            title="Angepinnt">{Ic.pin(13)}</div>
        )}
      </div>
      <div style={{ padding: '14px 16px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 540, lineHeight: 1.3, letterSpacing: -0.1 }}>{folder.name}</div>
          {onContext ? (
            <span title="Mehr" onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); onContext(folder, { clientX: b.right, clientY: b.bottom, preventDefault() {}, stopPropagation() {} }); }}
              style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}>{Ic.more(16)}</span>
          ) : (onShare || onDelete || onRename || onMove) && (
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
function FileTile({ file, selected, selecting, onActivate, onContext, onToggleSelect, onToggleStar, tagIds, tags }) {
  const [imgOk, setImgOk] = useState(true);
  const isImage = file.kind === 'image' && imgOk;
  const isNew = !!file.uploader_name;
  const starred = !!file.starred;
  return (
    <div className="nyza-tile" style={{
      borderRadius: 'var(--r-md)', background: 'var(--surface)',
      border: '1px solid ' + (selected ? 'var(--accent)' : 'var(--border)'),
      overflow: 'hidden', cursor: 'pointer', position: 'relative',
      boxShadow: selected ? '0 0 0 3px var(--accent-glow)' : '0 1px 0 var(--inner-hi) inset',
      transition: 'all .2s',
    }}
    onClick={(e) => onActivate(e)}
    onContextMenu={onContext ? (e) => onContext(e) : undefined}>
      <div style={{ aspectRatio: '4/3', position: 'relative', background: 'var(--surface-hi)' }}>
        {isImage ? (
          <img src={API.thumbUrl(file.id)} alt={file.name} loading="lazy"
            onError={() => setImgOk(false)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}/>
        ) : file.kind === 'video' ? (
          <video src={`${API.fileRawUrl(file.id)}?token=${getToken()}#t=0.1`}
            muted preload="metadata"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}/>
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
        {file.label && (
          <div style={{ position: 'absolute', bottom: 8, left: 8, width: 12, height: 12, borderRadius: '50%', background: file.label === 'red' ? '#ef4444' : file.label === 'yellow' ? '#eab308' : '#22c55e', boxShadow: '0 1px 4px rgba(0,0,0,0.5)', border: '1.5px solid rgba(255,255,255,0.7)' }}/>
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
        {!!file.pinned && !selected && (
          <div style={{ position: 'absolute', top: 8, left: 8, color: 'var(--accent)', background: 'rgba(0,0,0,0.45)', borderRadius: 999, width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(6px)' }}
            title="Angepinnt">{Ic.pin(11)}</div>
        )}
        {isNew && !selected && (
          <div style={{
            position: 'absolute', top: 8, right: 8, padding: '2px 7px', borderRadius: 999,
            fontSize: 9, fontWeight: 700, letterSpacing: 0.4, background: 'var(--accent-grad)', color: '#fff',
            textTransform: 'uppercase', boxShadow: '0 2px 8px var(--accent-glow)',
          }}>Neu</div>
        )}
        {onToggleStar && !isNew && (
          <div className="file-star" onClick={(e) => { e.stopPropagation(); onToggleStar(); }}
            title={starred ? 'Favorit entfernen' : 'Zu Favoriten'}
            style={{
              position: 'absolute', top: 6, right: 6, width: 26, height: 26, borderRadius: 999,
              display: 'flex', opacity: starred ? 1 : 0, alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(8px)',
              color: starred ? 'oklch(0.82 0.16 85)' : '#fff', cursor: 'pointer',
            }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill={starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="m12 3 2.7 6.1 6.6.6-5 4.4 1.5 6.5L12 17.3 6.2 20.6l1.5-6.5-5-4.4 6.6-.6L12 3z"/></svg>
          </div>
        )}
      </div>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ flex: 1, fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</div>
          {onContext && (
            <span className="file-kebab" title="Mehr" onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); onContext({ clientX: b.right, clientY: b.bottom, preventDefault() {}, stopPropagation() {} }); }}
              style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}>{Ic.more(16)}</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2, display: 'flex', justifyContent: 'space-between' }}>
          <span>{humanSize(file.size)}</span>
          <span>{timeAgo(file.created_at)}</span>
        </div>
        {file.uploader_name && (
          <div style={{ fontSize: 10.5, color: 'var(--accent)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
            {Ic.inbox(11)} von {file.uploader_name}
          </div>
        )}
        {tagIds && tagIds.length > 0 && (
          <div style={{ marginTop: 6 }}><TagChips ids={tagIds} tags={tags} max={3} small/></div>
        )}
      </div>
    </div>
  );
}

// ───── File grid + list (reusable) ─────────────────────────────────────────
function FileGrid({ files, selected, onOpen, onToggleSelect, onDragSelect, onToggleStar, onDragFiles, onContext, selectMode, tagLookup, tags }) {
  const selecting = selected.size > 0 || !!selectMode;
  const wrapRef = useRef(null);
  const lastIdx = useRef(null);

  // Click handling: plain = open; cmd/ctrl = toggle one; shift = range from the
  // last clicked; in select-mode any tap toggles. Mirrors desktop file managers.
  const activate = (f, idx, e) => {
    if (e.metaKey || e.ctrlKey) {
      onToggleSelect(f.id); lastIdx.current = idx; return;
    }
    if (e.shiftKey && lastIdx.current != null && onDragSelect) {
      const [a, b] = [lastIdx.current, idx].sort((x, y) => x - y);
      const range = new Set(selected);
      for (let i = a; i <= b; i++) range.add(files[i].id);
      onDragSelect(range); return;
    }
    if (selecting) { onToggleSelect(f.id); lastIdx.current = idx; return; }
    onOpen(f);
  };
  const context = (f, idx, e) => {
    e.preventDefault(); e.stopPropagation();
    // Right-clicking a file outside the current selection selects just it.
    if (onContext) onContext(f, e, () => { if (!selected.has(f.id)) { onDragSelect ? onDragSelect(new Set([f.id])) : onToggleSelect(f.id); } });
  };
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
        {files.map((f, idx) => (
          <div data-fid={f.id} key={f.id}
            draggable={!!onDragFiles}
            onDragStart={(e) => {
              if (!onDragFiles) return;
              // drag the whole selection if this file is part of it, else just this one
              const ids = selected.has(f.id) && selected.size > 1 ? [...selected] : [f.id];
              e.dataTransfer.setData('application/x-nyza-files', JSON.stringify(ids));
              e.dataTransfer.effectAllowed = 'move';
              onDragFiles(ids);
            }}>
            <FileTile file={f}
              selected={selected.has(f.id)} selecting={selecting}
              tagIds={tagLookup ? tagLookup(f.id) : null} tags={tags}
              onActivate={(e) => activate(f, idx, e)}
              onContext={onContext ? (e) => context(f, idx, e) : null}
              onToggleSelect={() => onToggleSelect(f.id)}
              onToggleStar={onToggleStar ? () => onToggleStar(f) : null}/>
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

const KIND_META = {
  image: { label: 'Bilder', color: 'oklch(0.70 0.17 280)' },
  video: { label: 'Videos', color: 'oklch(0.72 0.16 30)' },
  pdf:   { label: 'PDFs',   color: 'oklch(0.70 0.17 25)' },
  audio: { label: 'Audio',  color: 'oklch(0.74 0.16 145)' },
  doc:   { label: 'Dokumente', color: 'oklch(0.72 0.14 220)' },
};
function StorageBreakdown({ stats }) {
  const total = stats.storage_used || 1;
  const kinds = Object.keys(KIND_META).filter((k) => stats.by_kind[k]?.size > 0);
  if (kinds.length === 0) return null;
  return (
    <div style={{ marginBottom: 28, padding: '16px 18px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 540 }}>Speicher-Aufschlüsselung</span>
        <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{humanSize(stats.storage_used)} belegt</span>
      </div>
      <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: 'var(--surface-hi)' }}>
        {kinds.map((k) => (
          <div key={k} title={KIND_META[k].label} style={{ width: (stats.by_kind[k].size / total * 100) + '%', background: KIND_META[k].color }}/>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12 }}>
        {kinds.map((k) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--fg-2)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: KIND_META[k].color }}/>
            {KIND_META[k].label}
            <span style={{ color: 'var(--fg-3)' }}>{humanSize(stats.by_kind[k].size)} · {stats.by_kind[k].count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// A standalone file list view (Favoriten) — fetches via `fetcher`, supports
// open + star, no folder chrome.
function SimpleFileView({ title, fetcher, refreshTick, onOpenFile, onToggleStar, emptyIcon, emptyTitle, emptyDesc }) {
  const [files, setFiles] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const load = useCallback(() => { fetcher().then((d) => setFiles(d.files || [])).catch(() => setFiles([])); }, [fetcher]);
  useEffect(() => { load(); }, [refreshTick]);
  const toggleSelect = (id) => {
    if (id === '__all__') { setSelected((s) => s.size === (files?.length || 0) ? new Set() : new Set((files || []).map((f) => f.id))); return; }
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const star = async (f) => { await onToggleStar(f); load(); };
  return (
    <>
      <TopBar crumbs={[title]}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '28px 32px 80px' }}>
        <SectionHeader title={title} count={files === null ? null : files.length}/>
        {files === null ? <SkeletonGrid count={6}/>
          : files.length === 0 ? <EmptyHint icon={emptyIcon} title={emptyTitle} desc={emptyDesc}/>
          : <FileGrid files={files} selected={selected} onOpen={(f) => onOpenFile(f, files)} onToggleSelect={toggleSelect} onDragSelect={setSelected} onToggleStar={star} onDragFiles={() => {}}/>}
      </div>
    </>
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

function FileList({ files, selected, onOpen, onToggleSelect, onDragSelect, onShareFile, onDeleteFile, onToggleStar, onContext, selectMode, tagLookup, tags }) {
  const allSel = files.length > 0 && files.every((f) => selected.has(f.id));
  const selecting = selected.size > 0 || !!selectMode;
  const lastIdx = useRef(null);
  const activate = (f, idx, e) => {
    if (e.metaKey || e.ctrlKey) { onToggleSelect(f.id); lastIdx.current = idx; return; }
    if (e.shiftKey && lastIdx.current != null && onDragSelect) {
      const [a, b] = [lastIdx.current, idx].sort((x, y) => x - y);
      const range = new Set(selected);
      for (let i = a; i <= b; i++) range.add(files[i].id);
      onDragSelect(range); return;
    }
    if (selecting) { onToggleSelect(f.id); lastIdx.current = idx; return; }
    onOpen(f);
  };
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
          onContextMenu={onContext ? (e) => { e.preventDefault(); e.stopPropagation(); onContext(r, e, () => { if (!sel) { onDragSelect ? onDragSelect(new Set([r.id])) : onToggleSelect(r.id); } }); } : undefined}
          onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = 'var(--surface-hi)'; }}
          onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = 'transparent'; }}>
            <span onClick={() => onToggleSelect(r.id)} style={{ cursor: 'pointer' }}>
              <span style={{
                width: 18, height: 18, borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                border: '1.5px solid ' + (sel ? 'transparent' : 'var(--border-hi)'),
                background: sel ? 'var(--accent-grad)' : 'transparent', color: '#fff',
              }}>{sel && Ic.check(11)}</span>
            </span>
            <div onClick={(e) => activate(r, i, e)} style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <FileIcon kind={r.kind} size={15} tint={r.hue}/>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
              {r.uploader_name && <span style={{ fontSize: 10.5, color: 'var(--accent)', flexShrink: 0 }}>· {r.uploader_name}</span>}
              {tagLookup && <TagChips ids={tagLookup(r.id)} tags={tags} max={3} small/>}
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>{r.kind}</span>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{humanSize(r.size)}</span>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{timeAgo(r.created_at)}</span>
            <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
              {onToggleStar && <IconBtn size={28} title={r.starred ? 'Favorit entfernen' : 'Zu Favoriten'} onClick={() => onToggleStar(r)} style={{ color: r.starred ? 'oklch(0.82 0.16 85)' : undefined }}>{Ic.star(14)}</IconBtn>}
              <IconBtn size={28} title="Vorschau" onClick={() => onOpen(r)}>{Ic.eye(14)}</IconBtn>
              <IconBtn size={28} title="Teilen" onClick={() => onShareFile(r)}>{Ic.share(13)}</IconBtn>
              {onContext
                ? <IconBtn size={28} title="Mehr" onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); onContext(r, { clientX: b.left, clientY: b.bottom, preventDefault() {}, stopPropagation() {} }, () => {}); }}>{Ic.more(15)}</IconBtn>
                : <IconBtn size={28} title="Löschen" onClick={() => onDeleteFile(r)}>{Ic.trash(13)}</IconBtn>}
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
// Pre-upload review: thumbnails of selected files, remove individual ones,
// total size, then confirm. Used by owner upload + public client upload.
export function UploadReview({ files: initial, title = 'Diese Dateien hochladen?', confirmLabel = 'Hochladen', maxFileSize, conflictChoice = true, onConfirm, onCancel }) {
  const [list, setList] = useState(() => initial.map((f, i) => ({
    key: i + '·' + f.name + '·' + f.size, file: f,
    url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
    kind: f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : f.type === 'application/pdf' ? 'pdf' : 'doc',
  })));
  const [mode, setMode] = useState('replace'); // replace = versionieren · keep_both = umbenennen
  useEffect(() => () => { list.forEach((x) => x.url && URL.revokeObjectURL(x.url)); }, []);
  const remove = (key) => setList((l) => l.filter((x) => x.key !== key));
  const total = list.reduce((s, x) => s + x.file.size, 0);
  const oversize = maxFileSize ? list.filter((x) => x.file.size > maxFileSize) : [];

  return (
    <div className="nyza-modal-backdrop" onClick={onCancel}>
      <Glass style={{ width: '100%', maxWidth: 560, borderRadius: 'var(--r-xl)', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: '85vh' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.upload(18)}</div>
          <div style={{ flex: 1 }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0 }}>{title}</h2>
            <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>{list.length} {list.length === 1 ? 'Datei' : 'Dateien'} · {humanSize(total)}</div>
          </div>
          <IconBtn size={32} onClick={onCancel}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map((x) => {
            const big = maxFileSize && x.file.size > maxFileSize;
            return (
              <div key={x.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid ' + (big ? 'color-mix(in oklab, var(--danger) 40%, transparent)' : 'var(--border)') }}>
                <div style={{ width: 44, height: 44, borderRadius: 8, overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
                  {x.url ? <img src={x.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/> : <FileIcon kind={x.kind} size={18}/>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.file.name}</div>
                  <div style={{ fontSize: 11.5, color: big ? 'var(--danger)' : 'var(--fg-3)' }}>{humanSize(x.file.size)}{big ? ' · zu groß' : ''}</div>
                </div>
                <IconBtn size={30} title="Entfernen" onClick={() => remove(x.key)}>{Ic.close(15)}</IconBtn>
              </div>
            );
          })}
        </div>
        {conflictChoice && (
          <div style={{ padding: '0 24px 4px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Bei gleichem Namen:</span>
            {[['replace', 'Ersetzen (mit Version)'], ['keep_both', 'Beide behalten']].map(([k, l]) => (
              <button key={k} type="button" onClick={() => setMode(k)} style={{ height: 28, padding: '0 12px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, border: '1px solid ' + (mode === k ? 'transparent' : 'var(--border)'), background: mode === k ? 'var(--accent-grad)' : 'var(--surface-hi)', color: mode === k ? '#fff' : 'var(--fg-2)' }}>{l}</button>
            ))}
          </div>
        )}
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          {oversize.length > 0 && <span style={{ fontSize: 12, color: 'var(--danger)', flex: 1 }}>{oversize.length} Datei(en) über dem Limit ({humanSize(maxFileSize)})</span>}
          <span style={{ flex: oversize.length ? 0 : 1 }}/>
          <Btn variant="ghost" onClick={onCancel}>Abbrechen</Btn>
          <Btn variant="primary" disabled={list.length === 0 || oversize.length > 0} icon={Ic.upload(15)}
            onClick={() => onConfirm(list.map((x) => x.file), mode)}>{confirmLabel} ({list.length})</Btn>
        </div>
      </Glass>
    </div>
  );
}

// Non-blocking, minimizable upload widget — bottom-right on desktop (Google-
// Drive style), above the bottom nav on mobile. The actual upload runs in the
// Dashboard, so you can switch views / navigate freely while it continues.
function fmtEta(s) { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); const ss = s % 60; return m > 0 ? m + 'm ' + String(ss).padStart(2, '0') + 's' : ss + 's'; }

export function UploadProgress({ items, onClose, onCancel }) {
  const [min, setMin] = useState(false);
  const total = items.reduce((s, x) => s + x.size, 0);
  const done = items.reduce((s, x) => s + (x.status === 'done' ? x.size : x.status === 'canceled' ? 0 : x.size * (x.pct || 0)), 0);
  const active = items.some((x) => x.status === 'uploading' || x.status === 'queued');
  const errors = items.filter((x) => x.status === 'error').length;
  const canceled = items.filter((x) => x.status === 'canceled').length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const doneCount = items.filter((x) => x.status === 'done').length;

  // Live ETA from a rolling byte-rate sample (survives tab switches; XHR keeps
  // running in the background so progress continues either way).
  const liveRef = useRef({ done: 0, total: 0, active: false });
  liveRef.current = { done, total, active };
  const [eta, setEta] = useState(null);
  const sampleRef = useRef(null);
  useEffect(() => {
    const id = setInterval(() => {
      const L = liveRef.current;
      if (!L.active) { setEta(null); sampleRef.current = null; return; }
      const now = Date.now();
      if (sampleRef.current) {
        const dt = (now - sampleRef.current.t) / 1000;
        if (dt >= 0.7) { const sp = (L.done - sampleRef.current.done) / dt; sampleRef.current = { t: now, done: L.done }; if (sp > 1) setEta((L.total - L.done) / sp); }
      } else sampleRef.current = { t: now, done: L.done };
    }, 1000);
    return () => clearInterval(id);
  }, []);

  let subtitle = `${doneCount} von ${items.length} · ${humanSize(done)} / ${humanSize(total)}`;
  if (active && eta != null) subtitle += ` · noch ${fmtEta(eta)}`;
  const title = active ? 'Wird hochgeladen…' : ('Upload fertig' + (errors ? ` · ${errors} Fehler` : '') + (canceled ? ` · ${canceled} abgebrochen` : ''));
  return (
    <div className="nyza-upload-widget">
      <Glass style={{ borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
        <div onClick={() => setMin((m) => !m)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', cursor: 'pointer' }}>
          <CircularProgress pct={pct} size={42} thick={5}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: -0.1 }}>{title}</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</div>
          </div>
          <IconBtn size={30} title={min ? 'Aufklappen' : 'Minimieren'} onClick={(e) => { e.stopPropagation(); setMin((m) => !m); }}>
            {min ? Ic.chevronU(15) : Ic.chevronD(15)}
          </IconBtn>
          {!active && <IconBtn size={30} title="Schließen" onClick={(e) => { e.stopPropagation(); onClose(); }}>{Ic.close(15)}</IconBtn>}
        </div>
        {!min && (
          <div style={{ borderTop: '1px solid var(--border)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflowY: 'auto' }}>
            {items.map((f) => <UploadRow key={f.id ?? f.name} file={f} onCancel={onCancel}/>)}
          </div>
        )}
      </Glass>
    </div>
  );
}

export function UploadRow({ file, onCancel }) {
  const isDone = file.status === 'done';
  const isError = file.status === 'error';
  const isUp = file.status === 'uploading';
  const isCanceled = file.status === 'canceled';
  const pct = Math.round((file.pct || 0) * 100);
  const doCancel = async (e) => {
    e.stopPropagation();
    if (await confirmDialog({ title: 'Upload abbrechen?', message: `„${file.name}" wird nicht hochgeladen.`, confirmLabel: 'Upload stoppen', danger: true })) onCancel && onCancel(file.id);
  };
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {isDone && <div style={{ width: 22, height: 22, borderRadius: 11, background: 'var(--success)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.check(13)}</div>}
        {isError && <div style={{ fontSize: 11, color: 'var(--danger)' }}>Fehler</div>}
        {isCanceled && <div style={{ fontSize: 11, color: 'var(--fg-4)' }}>Abgebrochen</div>}
        {isUp && <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{pct}%</div>}
        {!isDone && !isError && !isUp && !isCanceled && <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>wartet</span>}
        {(isUp || (!isDone && !isError && !isCanceled)) && onCancel && (
          <span title="Upload abbrechen" onClick={doCancel} style={{ cursor: 'pointer', color: 'var(--fg-4)', display: 'inline-flex' }}>{Ic.close(14)}</span>
        )}
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

function InternalShareModal({ folder, file, onClose }) {
  const [users, setUsers] = useState([]);
  const [shares, setShares] = useState(null);
  const [sel, setSel] = useState('');
  const opts = folder ? { folder_id: folder.id } : { file_id: file.id };
  const load = () => API.internalShares(opts).then((d) => setShares(d.shares || [])).catch(() => setShares([]));
  useEffect(() => { API.users().then((d) => setUsers(d.users || [])).catch(() => {}); load(); }, []);
  const add = async () => { if (!sel) return; try { await API.shareInternal({ ...opts, target_user_id: Number(sel) }); setSel(''); load(); } catch (e) { toast(e.message, 'error'); } };
  const rm = async (id) => { try { await API.unshareInternal(id); load(); } catch (e) { toast(e.message, 'error'); } };
  const sharedIds = new Set((shares || []).map((s) => s.target_user_id));
  const avail = users.filter((u) => !sharedIds.has(u.id));
  const fld = { height: 40, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit' };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 440, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.users(18)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0 }}>Intern teilen</h2>
            <div style={{ fontSize: 12, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{folder?.name || file?.name}</div>
          </div>
          <IconBtn size={30} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ ...fld, flex: 1, cursor: 'pointer' }}>
              <option value="">Mitglied wählen…</option>
              {avail.map((u) => <option key={u.id} value={String(u.id)}>{u.name || u.email}</option>)}
            </select>
            <Btn variant="primary" size="md" disabled={!sel} icon={Ic.plus(14)} onClick={add}>Teilen</Btn>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {shares === null ? <div style={{ color: 'var(--fg-3)', fontSize: 13 }}>{Ic.loader(16)}</div>
              : shares.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>Noch mit niemandem geteilt.</div>
              : shares.map((s) => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)' }}>
                    <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--accent-grad)', color: '#fff', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{(s.target_name || '?').slice(0, 1).toUpperCase()}</span>
                    <span style={{ flex: 1, fontSize: 13 }}>{s.target_name}</span>
                    <span onClick={() => rm(s.id)} title="Entfernen" style={{ cursor: 'pointer', color: 'var(--fg-4)', display: 'inline-flex' }}>{Ic.close(14)}</span>
                  </div>
                ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-4)' }}>Geteilte Mitglieder können den Inhalt ansehen und herunterladen (nur lesen).</div>
        </div>
      </Glass>
    </div>
  );
}

function SharedWithMeView({ onOpenFolder, onOpenFile }) {
  const [data, setData] = useState(null);
  useEffect(() => { API.sharedWithMe().then(setData).catch(() => setData({ folders: [], files: [] })); }, []);
  const folders = data?.folders || [];
  const files = data?.files || [];
  return (
    <>
      <TopBar crumbs={['Mit mir geteilt']}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '28px 32px 60px' }}>
        {data === null ? <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
          : (folders.length === 0 && files.length === 0) ? <EmptyHint icon={Ic.users(40)} title="Nichts geteilt" desc="Hier erscheinen Ordner und Dateien, die andere Mitglieder mit dir teilen."/>
          : (
            <>
              {folders.length > 0 && <><SectionHeader title="Ordner" count={folders.length}/>
                <div style={{ display: 'grid', gap: 8, maxWidth: 820, marginBottom: 28 }}>
                  {folders.map((f) => (
                    <div key={'f' + f.id} className="nyza-listrow" onClick={() => onOpenFolder(f)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer' }}>
                      <span style={{ color: 'var(--accent)' }}>{Ic.folder(18)}</span>
                      <span style={{ flex: 1, fontSize: 14, fontWeight: 540 }}>{f.name}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>von {f.owner_name || '—'}</span>
                    </div>
                  ))}
                </div></>}
              {files.length > 0 && <><SectionHeader title="Dateien" count={files.length}/>
                <div style={{ display: 'grid', gap: 8, maxWidth: 820 }}>
                  {files.map((f) => (
                    <div key={'x' + f.id} className="nyza-listrow" onClick={() => onOpenFile(f, files)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer' }}>
                      <FileIcon kind={(f.mime_type || '').startsWith('image/') ? 'image' : (f.mime_type || '').startsWith('video/') ? 'video' : (f.mime_type === 'application/pdf') ? 'pdf' : 'doc'} size={16}/>
                      <span style={{ flex: 1, fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{humanSize(f.size)} · von {f.owner_name || '—'}</span>
                    </div>
                  ))}
                </div></>}
            </>
          )}
      </div>
    </>
  );
}

export function ShareModal({ folder, file, onClose, onCreated, basePath }) {
  const [withPassword, setWithPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [allowDownload, setAllowDownload] = useState(true);
  const [galleryMode, setGalleryMode] = useState(folder?.kind === 'gallery');
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
      if (folder && galleryMode) body.gallery = true;
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

  // Re-opening share on already-shared content shows the existing link.
  useEffect(() => {
    API.shares().then((d) => {
      const m = (d.shares || []).find((s) => (folder && String(s.folder_id) === String(folder.id)) || (file && String(s.file_id) === String(file.id)));
      if (m) { setCreated(m); initFromShare(m); }
    }).catch(() => {});
  }, []);
  const initFromShare = (m) => {
    setAllowDownload(m.allow_download !== 0 && m.allow_download !== false);
    setGalleryMode(!!m.gallery);
    setWithPassword(!!(m.has_password || m.password_hash));
    setWithExpiry(!!m.expires_at);
    if (m.expires_at) setExpiresAt(String(m.expires_at).slice(0, 10));
  };
  const editShare = async () => {
    setBusy(true);
    try {
      const body = { allow_download: allowDownload, gallery: galleryMode, expires_at: withExpiry && expiresAt ? expiresAt + ' 23:59:59' : '' };
      if (!withPassword) body.clear_password = true;
      else if (password) body.password = password;
      const d = await API.updateShare(created.id, body);
      setCreated(d.share); setPassword('');
      toast('Gespeichert', 'success'); onCreated && onCreated();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const url = created ? location.origin + (basePath || '') + '/s/' + created.token : '';
  const delShare = async () => {
    if (!created?.id) { setCreated(null); return; }
    try { await API.deleteShare(created.id); toast('Link gelöscht', 'success'); setCreated(null); onCreated && onCreated(); }
    catch (e) { toast(e.message, 'error'); }
  };

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
              {/* Edit existing link settings in place */}
              <ShareToggleRow icon={Ic.download} title="Download erlauben" desc="ZIP & Einzeldownload" on={allowDownload} onToggle={() => setAllowDownload(!allowDownload)}/>
              {folder && <ShareToggleRow icon={Ic.fileImg} title="Galerie-Ansicht" desc={galleryMode ? 'Bilder schön als Galerie' : 'Normale Dateiliste'} on={galleryMode} onToggle={() => setGalleryMode(!galleryMode)}/>}
              <ShareToggleRow icon={Ic.lock} title="Mit Passwort schützen" desc={withPassword ? (created.has_password || created.password_hash ? 'Aktiv — leer lassen = unverändert' : 'Neues Passwort setzen') : 'Kein Schutz'} on={withPassword} onToggle={() => setWithPassword(!withPassword)}/>
              {withPassword && <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={created.has_password || created.password_hash ? 'Neues Passwort (leer = unverändert)' : 'Passwort eingeben'} style={{ width: '100%', height: 38, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)', marginTop: 8 }}/>}
              <ShareToggleRow icon={Ic.clock} title="Ablaufdatum" desc={withExpiry ? expiresAt : 'Nie'} on={withExpiry} onToggle={() => setWithExpiry(!withExpiry)}/>
              {withExpiry && <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={{ width: '100%', height: 38, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)', marginTop: 8 }}/>}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                <Btn variant="ghost" size="sm" icon={Ic.trash(13)} onClick={delShare}>Löschen</Btn>
                <Btn variant="glass" size="sm" icon={Ic.plus(13)} onClick={() => { setCreated(null); }}>Neuer Link</Btn>
                <span style={{ flex: 1 }}/>
                <Btn variant="primary" size="sm" disabled={busy} icon={busy ? Ic.loader(13) : Ic.check(13)} onClick={editShare}>Speichern</Btn>
              </div>
            </div>
          ) : (
            <>
              <ShareToggleRow icon={Ic.download} title="Download erlauben" desc="ZIP & Einzeldownload" on={allowDownload} onToggle={() => setAllowDownload(!allowDownload)}/>
              {folder && <ShareToggleRow icon={Ic.fileImg} title="Galerie-Ansicht" desc={galleryMode ? 'Bilder schön als Galerie' : 'Normale Dateiliste'} on={galleryMode} onToggle={() => setGalleryMode(!galleryMode)}/>}
              <ShareToggleRow icon={Ic.lock} title="Mit Passwort schützen" desc={withPassword ? 'Aktiv' : 'Kein Schutz'} on={withPassword} onToggle={() => setWithPassword(!withPassword)}/>
              {withPassword && <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Passwort eingeben" style={{ width: '100%', height: 38, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)', marginTop: 8 }}/>}
              <ShareToggleRow icon={Ic.clock} title="Ablaufdatum" desc={withExpiry ? expiresAt : 'Nie'} on={withExpiry} onToggle={() => setWithExpiry(!withExpiry)}/>
              {withExpiry && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                    {[{ l: '1 Tag', d: 1 }, { l: '7 Tage', d: 7 }, { l: '14 Tage', d: 14 }, { l: '30 Tage', d: 30 }].map((p) => {
                      const dt = (() => { const x = new Date(); x.setDate(x.getDate() + p.d); return x.toISOString().slice(0, 10); })();
                      const active = expiresAt === dt;
                      return (
                        <button key={p.d} type="button" onClick={() => setExpiresAt(dt)} style={{
                          height: 30, padding: '0 12px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
                          border: '1px solid ' + (active ? 'transparent' : 'var(--border)'),
                          background: active ? 'var(--accent-grad)' : 'var(--surface-hi)', color: active ? '#fff' : 'var(--fg-2)',
                        }}>{p.l}</button>
                      );
                    })}
                  </div>
                  <input type="date" value={expiresAt} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpiresAt(e.target.value)} style={{ width: '100%', height: 38, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)', fontFamily: 'inherit' }}/>
                </div>
              )}
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
            <div className="nyza-modal-foot" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 28px', borderTop: '1px solid var(--border)', background: 'var(--surface-hi)' }}>
              <span className="foot-note" style={{ fontSize: 12, color: 'var(--fg-3)', flex: 1 }}>Sicherer Upload · 256-bit Verschlüsselung</span>
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
              {FOLDER_COLOR_KEYS.map((k) => <option key={k} value={k}>{FOLDER_TONES[k].label}</option>)}
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

// Standalone version history for ANY file (not just text). Lists snapshots with
// restore + download — the binary-aware counterpart to the editor's history.
function VersionHistoryModal({ file, onClose, onChanged }) {
  const [list, setList] = useState(null);
  const load = useCallback(() => { API.versions(file.id).then((d) => setList(d.versions || [])).catch((e) => { toast(e.message, 'error'); setList([]); }); }, [file.id]);
  useEffect(() => { load(); }, [load]);
  const restore = async (v) => {
    if (!await confirmDialog({ title: 'Version wiederherstellen?', message: 'Die aktuelle Fassung wird vorher automatisch im Verlauf gesichert.', confirmLabel: 'Wiederherstellen', icon: Ic.rotate(22) })) return;
    try { await API.restoreVersion(file.id, v.id); toast('Version wiederhergestellt', 'success'); load(); onChanged && onChanged(); }
    catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 460, borderRadius: 'var(--r-xl)', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: '74vh' }}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: 'var(--accent)' }}>{Ic.clock(18)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0 }}>Versionsverlauf</h2>
            <div style={{ fontSize: 12, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</div>
          </div>
          <IconBtn size={30} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ overflowY: 'auto', padding: 10 }}>
          {list === null ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-3)' }}>{Ic.loader(20)}</div>
          ) : list.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>Noch keine früheren Versionen.<br/>Sie entstehen automatisch, wenn du eine Datei gleichen Namens erneut hochlädst oder speicherst.</div>
          ) : list.map((v, i) => (
            <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', marginBottom: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{i === 0 ? 'Neueste Version' : 'Version ' + (list.length - i)} · {humanSize(v.size)}</div>
                <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{timeAgo(v.created_at)}</div>
              </div>
              <a href={API.versionRawUrl(file.id, v.id)} download style={{ textDecoration: 'none' }}>
                <IconBtn size={30} title="Diese Version herunterladen">{Ic.download(14)}</IconBtn>
              </a>
              <Btn variant="glass" size="sm" icon={Ic.rotate(13)} onClick={() => restore(v)}>Wiederherstellen</Btn>
            </div>
          ))}
        </div>
      </Glass>
    </div>
  );
}

function NewFolderModal({ title = 'Neuer Ordner', onCreate, onCancel, onClose }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('normal');
  const [tone, setTone] = useState('violet');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState(() => JSON.parse(localStorage.getItem('nyza.folderTemplates') || '[]'));
  const inputRef = useRef(null);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 60); }, []);
  const handleCancel = onCancel || onClose;
  const submit = () => { if (name.trim()) onCreate(name.trim(), kind, tone, templateId || null); };
  return (
    <div className="nyza-modal-backdrop" onClick={onCancel}>
      <Glass style={{ width: '100%', maxWidth: 480, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '22px 24px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>{Ic.folder(18)}</div>
            <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>{title}</h2>
            <IconBtn size={30} onClick={onCancel}>{Ic.close(16)}</IconBtn>
          </div>
          <input ref={inputRef} value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
            placeholder="Ordnername"
            style={{ width: '100%', height: 44, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', marginBottom: 18 }}
            onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }} onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
            {[
              { k: 'normal', icon: Ic.folder(28), label: 'Dateien', desc: 'Normale Datei- und Ordnerverwaltung' },
              { k: 'gallery', icon: Ic.fileImg(28), label: 'Galerie', desc: 'Bilder & Videos in chronologischer Ansicht mit Markierungsfunktion' },
            ].map(({ k, icon, label, desc }) => (
              <button key={k} type="button" onClick={() => setKind(k)} style={{
                padding: '14px 12px', borderRadius: 'var(--r-md)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                border: '2px solid ' + (kind === k ? 'var(--accent)' : 'var(--border)'),
                background: kind === k ? 'color-mix(in oklab, var(--accent) 10%, var(--surface))' : 'var(--surface-hi)',
                boxShadow: kind === k ? '0 0 0 3px var(--accent-glow)' : 'none',
                transition: 'all .15s',
              }}>
                <div style={{ color: kind === k ? 'var(--accent)' : 'var(--fg-3)', marginBottom: 8 }}>{icon}</div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.4 }}>{desc}</div>
              </button>
            ))}
          </div>
          <div style={{ marginBottom: templates.length > 0 ? 16 : 20 }}>
            <div style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-3)', marginBottom: 8 }}>Farbe</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {FOLDER_COLOR_KEYS.map((k) => (
                <button key={k} type="button" onClick={() => setTone(k)} title={FOLDER_TONES[k].label} style={{
                  width: 28, height: 28, borderRadius: '50%', cursor: 'pointer', border: 'none', padding: 0,
                  background: folderDot(k),
                  outline: tone === k ? '2px solid var(--fg)' : '2px solid transparent',
                  outlineOffset: 2,
                }}/>
              ))}
            </div>
          </div>
          {templates.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-3)', marginBottom: 8 }}>Vorlage (optional)</div>
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={{
                width: '100%', height: 40, padding: '0 12px', borderRadius: 'var(--r-sm)',
                background: 'var(--surface-hi)', border: '1px solid var(--border)',
                color: 'var(--fg)', fontSize: 13, fontFamily: 'inherit', outline: 'none',
              }}>
                <option value="">Keine Vorlage</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} ({t.folders.length} Unterordner)</option>
                ))}
              </select>
              {templateId && (
                <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 5 }}>
                  Erstellt: {templates.find((t) => t.id === templateId)?.folders.join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="nyza-modal-foot" style={{ padding: '14px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onCancel}>Abbrechen</Btn>
          <Btn variant="primary" disabled={!name.trim()} onClick={submit} icon={Ic.plus(15)}>Erstellen</Btn>
        </div>
      </Glass>
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

// ───── Global search (⌘K / Ctrl+K palette) ─────────────────────────────────
const eur = (n) => Number(n || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

function GlobalSearch({ onClose, onPickFile, onPickFolder, onGoto }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRes(null); setLoading(false); return; }
    let off = false; setLoading(true);
    const t = setTimeout(() => {
      API.search(term)
        .then((d) => { if (!off) setRes(d); })
        .catch(() => { if (!off) setRes(null); })
        .finally(() => { if (!off) setLoading(false); });
    }, 220);
    return () => { off = true; clearTimeout(t); };
  }, [q]);

  const groups = res ? [
    { key: 'folders',   label: 'Ordner',     icon: Ic.folder,  items: (res.folders || []).map((f) => ({ id: 'fo' + f.id, icon: Ic.folder, title: f.name, sub: 'Ordner', onPick: () => onPickFolder(f) })) },
    { key: 'files',     label: 'Dateien',    icon: Ic.fileGen, items: (res.files || []).map((f) => ({ id: 'fi' + f.id, icon: f.kind === 'image' ? Ic.fileImg : Ic.fileGen, title: f.name, sub: humanSize(f.size || 0), onPick: () => onPickFile(f) })) },
    { key: 'documents', label: 'Rechnungen & Angebote', icon: Ic.filePdf, items: (res.documents || []).map((d) => ({ id: 'do' + d.id, icon: Ic.filePdf, title: (d.type === 'offer' ? 'Angebot ' : 'Rechnung ') + d.number, sub: [d.client, eur(d.gross), d.paid ? 'bezahlt' : 'offen'].filter(Boolean).join(' · '), onPick: () => onGoto('accounting', { type: d.type, id: d.id }) })) },
    { key: 'expenses',  label: 'Ausgaben',   icon: Ic.archive, items: (res.expenses || []).map((e) => ({ id: 'ex' + e.id, icon: Ic.archive, title: e.vendor || e.description || 'Ausgabe', sub: [e.category, eur(e.gross)].filter(Boolean).join(' · '), onPick: () => onGoto('accounting', { type: 'expense', id: e.id }) })) },
    { key: 'contacts',  label: 'Kontakte',   icon: Ic.users,   items: (res.contacts || []).map((c) => ({ id: 'co' + c.id, icon: Ic.users, title: c.name, sub: [c.email, c.city].filter(Boolean).join(' · ') || (c.is_customer ? 'Kunde' : 'Kontakt'), onPick: () => onGoto('contacts', { id: c.id }) })) },
  ].filter((g) => g.items.length) : [];
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="nyza-modal-backdrop" onClick={onClose} style={{ alignItems: 'flex-start', paddingTop: '10vh' }}>
      <Glass style={{ width: '100%', maxWidth: 620, borderRadius: 'var(--r-xl)', padding: 0, overflow: 'hidden', maxHeight: '76vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--fg-3)', display: 'flex' }}>{loading ? Ic.loader(18) : Ic.search(18)}</span>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onClose()}
            placeholder="Dateien, Rechnungen, Ausgaben, Kontakte…"
            style={{ flex: 1, height: 32, border: 'none', outline: 'none', background: 'transparent', fontSize: 16, color: 'var(--fg)' }}/>
          <kbd style={{ fontSize: 11, color: 'var(--fg-3)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 6px' }}>Esc</kbd>
        </div>
        <div style={{ overflowY: 'auto', padding: 8 }}>
          {q.trim().length < 2 && (
            <div style={{ padding: 28, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>Mindestens 2 Zeichen eingeben…</div>
          )}
          {q.trim().length >= 2 && !loading && total === 0 && (
            <div style={{ padding: 28, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>Nichts gefunden zu „{q.trim()}".</div>
          )}
          {groups.map((g) => (
            <div key={g.key} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px 4px', fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--fg-3)' }}>
                <span style={{ display: 'flex' }}>{g.icon(13)}</span>{g.label}
              </div>
              {g.items.map((it) => (
                <button key={it.id} onClick={() => { it.onPick(); onClose(); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '9px 12px', borderRadius: 'var(--r-sm)', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-hi)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                  <span style={{ color: 'var(--fg-2)', display: 'flex', flexShrink: 0 }}>{it.icon(17)}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title}</span>
                    {it.sub && <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.sub}</span>}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </Glass>
    </div>
  );
}

// ───── Dashboard (router shell) ────────────────────────────────────────────
export function Dashboard({ user, onUserChange, theme, onTheme, basePath }) {
  const [view, setView] = useState('grid');
  const [sort, setSort] = useState({ by: 'date', dir: 'desc' });
  const [search, setSearch] = useState('');
  const [nav, setNav] = useState(() => { try { const s = JSON.parse(localStorage.getItem('nyza.nav') || 'null'); if (s && s.name) return s; } catch {} return { name: 'files' }; }); // {name:'files'|'shared'|'links'|'activity'|'folder'|'apps'|'app-*', id?}
  useEffect(() => { try { localStorage.setItem('nyza.nav', JSON.stringify(nav)); } catch {} }, [nav]);
  // ⌘K / Ctrl+K opens the global search palette from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setSearchOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [stats, setStats] = useState(null);
  const [folders, setFolders] = useState([]);

  // modals / overlays
  const [shareTarget, setShareTarget] = useState(null);     // {folder} | {file}
  const [internalTarget, setInternalTarget] = useState(null); // {folder} | {file}
  const [showUploadLinkModal, setShowUploadLinkModal] = useState(false);
  const [uploadLinkFolder, setUploadLinkFolder] = useState(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
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
  const [reviewFiles, setReviewFiles] = useState(null);
  const [showMore, setShowMore] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showFab, setShowFab] = useState(false);
  const [showNewFolderMobile, setShowNewFolderMobile] = useState(false);
  const isMobile = useIsMobile();

  const uploadInputRef = useRef(null);
  const uploadTargetFolder = useRef(null);
  const folderUploadInputRef = useRef(null);
  const folderUploadTargetRef = useRef(null);
  // Upload queue: uploadsRef is the SYNCHRONOUS source of truth (mutated
  // immediately); the React state is just a mirror for rendering. (Using the
  // state updater to set the ref was async → the worker read a stale empty list
  // and uploads stuck at 0%.)
  const uploadsRef = useRef([]);
  const uploadWorking = useRef(false);
  const uploadCtrls = useRef({});
  const uploadIdRef = useRef(0);
  const syncUploadsUI = () => setUploads(uploadsRef.current.slice());
  const patchUpload = (id, patch) => { uploadsRef.current = uploadsRef.current.map((x) => x.id === id ? { ...x, ...patch } : x); syncUploadsUI(); };
  const fileKind = (f) => f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : f.type === 'application/pdf' ? 'pdf' : 'doc';

  const loadStats = useCallback(() => { API.stats().then(setStats).catch(() => {}); }, []);
  const loadFolders = useCallback(() => { API.folders().then((d) => setFolders(d.folders || [])).catch(() => {}); }, []);
  useEffect(() => { loadStats(); loadFolders(); }, [loadStats, loadFolders]);

  // a token bumped to force child views to reload after uploads/changes
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshAll = () => { loadStats(); loadFolders(); setRefreshTick((t) => t + 1); };

  const onLabelFile = async (f, label) => {
    try {
      await API.labelFile(f.id, label);
      refreshAll();
    } catch (e) { toast(e.message, 'error'); }
  };

  const onPinFile = async (f) => {
    try { await API.pinFile(f.id); refreshAll(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const onPinFolder = async (f) => {
    try { await API.pinFolder(f.id); refreshAll(); }
    catch (e) { toast(e.message, 'error'); }
  };

  // Append jobs to the queue and ensure the single worker is running.
  const enqueueUploads = (jobs) => {
    const items = jobs.filter((j) => j.file).map((j) => ({
      id: ++uploadIdRef.current, name: j.file.name, size: j.file.size, status: 'queued', pct: 0,
      kind: fileKind(j.file), file: j.file, folderId: j.folderId ?? null, mode: j.mode || null,
    }));
    if (!items.length) return;
    uploadsRef.current = [...uploadsRef.current, ...items];
    syncUploadsUI();
    setShowUploadProgress(true);
    pumpUploads();
  };

  const pumpUploads = async () => {
    if (uploadWorking.current) return;
    uploadWorking.current = true;
    try {
      for (;;) {
        const next = uploadsRef.current.find((x) => x.status === 'queued');
        if (!next) break;
        const ctrl = new AbortController();
        uploadCtrls.current[next.id] = ctrl;
        patchUpload(next.id, { status: 'uploading' });
        try {
          await uploadOwner(next.file, next.folderId, (p) => patchUpload(next.id, { pct: p }), ctrl.signal, next.mode);
          patchUpload(next.id, { status: 'done', pct: 1, file: null });
          refreshAll();
        } catch (err) {
          if (err && err.code === 'aborted') patchUpload(next.id, { status: 'canceled', file: null });
          else { patchUpload(next.id, { status: 'error', file: null }); toast(err.message, 'error'); }
        } finally { delete uploadCtrls.current[next.id]; }
      }
    } finally { uploadWorking.current = false; }
  };

  const cancelUpload = (id) => {
    const it = uploadsRef.current.find((x) => x.id === id);
    if (!it) return;
    if (it.status === 'queued') patchUpload(id, { status: 'canceled', file: null });
    else if (it.status === 'uploading' && uploadCtrls.current[id]) uploadCtrls.current[id].abort();
  };
  const clearUploads = () => { uploadsRef.current = []; syncUploadsUI(); };

  // Back-compat shim for existing callers.
  const runUpload = (filesArr, folderId = null) => enqueueUploads(filesArr.map((f) => ({ file: f, folderId })));

  const triggerUpload = (folderId = null) => { uploadTargetFolder.current = folderId; uploadInputRef.current?.click(); };
  // Unified upload entry: with dropped files → review+enqueue; without → picker.
  const handleUpload = (folderId = null, filesArr = null) => {
    // Guard: some callers wire onClick={onUpload}, passing a MouseEvent — never
    // treat that as a folder id.
    const fid = (typeof folderId === 'number' || (typeof folderId === 'string' && folderId !== '')) ? folderId : null;
    const files = filesArr && (filesArr instanceof FileList || Array.isArray(filesArr)) && filesArr.length ? Array.from(filesArr) : null;
    uploadTargetFolder.current = fid;
    if (files) setReviewFiles(files);
    else triggerUpload(fid);
  };

  const runFolderUpload = async (filesArr, targetFolderId = null) => {
    const folderMap = {};
    const sorted = [...filesArr].sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath));
    const dirPaths = new Set();
    for (const f of sorted) {
      const parts = f.webkitRelativePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirPaths.add(parts.slice(0, i).join('/'));
      }
    }
    const sortedDirs = [...dirPaths].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    toast('Erstelle Ordnerstruktur…', 'info');
    for (const dirPath of sortedDirs) {
      const parts = dirPath.split('/');
      const name = parts[parts.length - 1];
      const parentPath = parts.slice(0, -1).join('/');
      const parentId = parentPath ? folderMap[parentPath] : targetFolderId;
      try {
        const d = await API.newFolder({ name, parent_id: parentId, kind: 'normal', tone: 'violet' });
        folderMap[dirPath] = d.folder.id;
      } catch (e) {
        toast(`Ordner „${name}" konnte nicht erstellt werden`, 'error');
      }
    }
    enqueueUploads(sorted.map((f) => {
      const parts = f.webkitRelativePath.split('/');
      const dirPath = parts.slice(0, -1).join('/');
      return { file: f, folderId: dirPath ? folderMap[dirPath] : targetFolderId };
    }));
  };

  const triggerFolderUpload = (folderId = null) => {
    folderUploadTargetRef.current = folderId;
    folderUploadInputRef.current?.click();
  };

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

  const toggleStar = async (f) => {
    try { await API.starFile(f.id, !f.starred); refreshAll(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const [versionsTarget, setVersionsTarget] = useState(null);
  const doUnzip = async (f) => {
    if (!await confirmDialog({ title: 'ZIP entpacken?', message: `Der Inhalt von „${f.name}" wird in einen neuen Ordner entpackt.`, confirmLabel: 'Entpacken', icon: Ic.archive(22) })) return;
    toast('Entpacke …', 'info');
    try { const d = await API.unzipFile(f.id); toast(`Entpackt · ${d.extracted} Dateien${d.skipped ? `, ${d.skipped} übersprungen` : ''}`, 'success'); refreshAll(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const downloadOne = (f) => { window.location.href = API.fileRawUrl(f.id) + '?token=' + (getToken() || '') + '&dl=1'; };
  const setFolderColor = async (folder, tone) => {
    try { await API.renameFolder(folder.id, { tone }); refreshAll(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const dropToFolder = async (folderId, ids) => {
    const dest = (allFolders.find((f) => f.id === folderId) || folders.find((f) => f.id === folderId));
    const where = dest ? `„${dest.name}"` : 'diesen Ordner';
    if (!await confirmDialog({ title: 'Verschieben?', message: `${ids.length} ${ids.length === 1 ? 'Datei' : 'Dateien'} nach ${where} verschieben?`, confirmLabel: 'Verschieben', icon: Ic.folder(22) })) return;
    try { await API.moveFiles(ids, folderId); toast(ids.length + ' verschoben', 'success'); refreshAll(); }
    catch (e) { toast(e.message, 'error'); }
  };

  const activeNav = nav.name === 'folder' ? 'files'
    : nav.name === 'shared' ? 'links'
    : nav.name.startsWith('app-') ? 'apps'
    : nav.name;

  return (
    <div style={{ display: 'flex', height: '100%', position: 'relative', zIndex: 1 }}>
      {!isMobile && (
        <Sidebar active={activeNav} stats={stats} user={user} onTheme={onTheme} theme={theme}
          onNavigate={(n) => { setNav(n); setSearch(''); }}
          onUpload={() => triggerUpload(null)}
          onSearch={() => setSearchOpen(true)}
          onSecurity={() => setShowSecurity(true)}
          onProfile={() => setShowProfile(true)}
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
            onFolderColor={setFolderColor}
            onMoveFiles={(ids) => openMove({ kind: 'files', ids })}
            onDeleteFolder={async (f) => { if (!await confirmDialog({ title: 'Ordner in den Papierkorb?', message: `„${f.name}" und alle enthaltenen Dateien werden in den Papierkorb verschoben. Du kannst sie dort wiederherstellen.`, confirmLabel: 'In Papierkorb', danger: true })) return; try { await API.deleteFolder(f.id); toast('Ordner in den Papierkorb', 'success'); refreshAll(); } catch (e) { toast(e.message, 'error'); } }}
            onNewFolder={async (name, kind, tone, templateId) => { try { const d = await API.newFolder({ name, kind, tone }); if (templateId) { const tpls = JSON.parse(localStorage.getItem('nyza.folderTemplates') || '[]'); const tpl = tpls.find((t) => t.id === templateId); if (tpl) { for (const sub of (tpl.folders || [])) { await API.newFolder({ name: sub, kind: 'normal', tone: 'violet', parent_id: d.folder.id }).catch(() => {}); } } } toast('Ordner erstellt', 'success'); refreshAll(); } catch (e) { toast(e.message, 'error'); } }}
            onUpload={(fid, fs) => handleUpload(fid, fs)}
            onNewText={() => newText(null)}
            onUploadLink={() => { setUploadLinkFolder(null); setShowUploadLinkModal(true); }}
            onOpenFile={openViewer}
            onShareFile={(f) => setShareTarget({ file: f })}
            onShareInternalFile={(f) => setInternalTarget({ file: f })}
            onShareInternalFolder={(f) => setInternalTarget({ folder: f })}
            onToggleStar={toggleStar}
            onDropFiles={dropToFolder}
            onUnzip={doUnzip}
            onVersions={(f) => setVersionsTarget(f)}
            onDownloadFile={downloadOne}
            onDeleteFile={async (f) => { if (!await confirmDialog({ title: 'In den Papierkorb?', message: `„${f.name}" wird in den Papierkorb verschoben. Du kannst sie dort wiederherstellen.`, confirmLabel: 'In Papierkorb', danger: true })) return; try { await API.deleteFile(f.id); toast('In den Papierkorb', 'success'); refreshAll(); } catch (e) { toast(e.message, 'error'); } }}
            onPinFile={onPinFile}
            onPinFolder={onPinFolder}
          />
        )}
        {nav.name === 'favorites' && (
          <SimpleFileView title="Favoriten" emptyIcon={Ic.star(40)} emptyTitle="Keine Favoriten"
            emptyDesc="Markiere Dateien mit dem Stern, dann erscheinen sie hier."
            fetcher={() => API.starredFiles()} refreshTick={refreshTick}
            onOpenFile={openViewer} onToggleStar={toggleStar}/>
        )}
        {nav.name === 'shared-with-me' && (
          <SharedWithMeView onOpenFolder={(f) => setNav({ name: 'folder', id: f.id })} onOpenFile={openViewer}/>
        )}
        {nav.name === 'folder' && (
          <FolderView
            folderId={nav.id} view={view} setView={setView} sort={sort} setSort={setSort}
            search={search} setSearch={setSearch} refreshTick={refreshTick}
            onBack={() => setNav({ name: 'files' })}
            onOpenFolder={(f) => setNav({ name: 'folder', id: f.id })}
            onUpload={(fid, fs) => handleUpload(fid, fs)}
            onNewText={(fid) => newText(fid)}
            onShareFolder={(f) => setShareTarget({ folder: f })}
            onMoveFiles={(ids) => openMove({ kind: 'files', ids })}
            onUploadLink={(f) => { setUploadLinkFolder(f.id); setShowUploadLinkModal(true); }}
            onOpenFile={openViewer}
            onShareFile={(f) => setShareTarget({ file: f })}
            onShareInternalFile={(f) => setInternalTarget({ file: f })}
            onShareInternalFolder={(f) => setInternalTarget({ folder: f })}
            onToggleStar={toggleStar}
            onDropFiles={dropToFolder}
            onUnzip={doUnzip}
            onVersions={(f) => setVersionsTarget(f)}
            onDownloadFile={downloadOne}
            onMoveFolder={(f) => openMove({ kind: 'folder', folder: f })}
            onRenameFolder={(f) => setRenameFolderTarget(f)}
            onShareFolderItem={(f) => setShareTarget({ folder: f })}
            onFolderColor={setFolderColor}
            onDeleteFolder={async (f) => { if (!await confirmDialog({ title: 'Ordner in den Papierkorb?', message: `„${f.name}" und alle enthaltenen Dateien werden in den Papierkorb verschoben.`, confirmLabel: 'In Papierkorb', danger: true })) return; try { await API.deleteFolder(f.id); toast('Ordner in den Papierkorb', 'success'); refreshAll(); } catch (e) { toast(e.message, 'error'); } }}
            onDeleteFile={async (f) => { if (!await confirmDialog({ title: 'In den Papierkorb?', message: `„${f.name}" wird in den Papierkorb verschoben. Du kannst sie dort wiederherstellen.`, confirmLabel: 'In Papierkorb', danger: true })) return; try { await API.deleteFile(f.id); toast('In den Papierkorb', 'success'); refreshAll(); } catch (e) { toast(e.message, 'error'); } }}
            afterChange={refreshAll}
            onLabelFile={onLabelFile}
            onPinFile={onPinFile}
            onPinFolder={onPinFolder}
          />
        )}
        {(nav.name === 'links' || nav.name === 'shared') && (
          <LinksHub refreshTick={refreshTick} basePath={basePath}
            initialTab={nav.name === 'shared' ? 'shared' : 'shared'}
            onCreate={() => { setUploadLinkFolder(null); setShowUploadLinkModal(true); }}
            afterChange={refreshAll}/>
        )}
        {nav.name === 'apps' && (
          <AppsView onOpenApp={(id) => setNav({ name: 'app-' + id })}/>
        )}
        {nav.name === 'app-tasks' && (
          <TasksApp onBack={() => setNav({ name: 'apps' })}/>
        )}
        {nav.name === 'app-contacts' && (
          <ContactsApp onBack={() => setNav({ name: 'apps' })}/>
        )}
        {nav.name === 'app-times' && (
          <ZeitenApp onBack={() => setNav({ name: 'apps' })}/>
        )}
        {nav.name === 'app-roadmap' && (
          <RoadmapApp onBack={() => setNav({ name: 'apps' })}/>
        )}
        {nav.name === 'app-settings' && (
          <SettingsApp user={user} onBack={() => setNav({ name: 'apps' })}
            onProfile={() => setShowProfile(true)} onSecurity={() => setShowSecurity(true)}/>
        )}
        {nav.name === 'app-accounting' && (
          <BuchhaltungApp onBack={() => setNav({ name: 'apps' })} onOpenSettings={() => setNav({ name: 'app-settings' })}/>
        )}
        {nav.name === 'app-calendar' && (
          <KalenderApp onBack={() => setNav({ name: 'apps' })}/>
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
      {internalTarget && (
        <InternalShareModal folder={internalTarget.folder} file={internalTarget.file}
          onClose={() => setInternalTarget(null)}/>
      )}
      {showUploadLinkModal && (
        <UploadLinkModal folders={folders} defaultFolderId={uploadLinkFolder} basePath={basePath}
          onClose={() => setShowUploadLinkModal(false)} onCreated={refreshAll}/>
      )}
      {showUploadProgress && (
        <UploadProgress items={uploads} onCancel={cancelUpload} onClose={() => { setShowUploadProgress(false); clearUploads(); }}/>
      )}
      {showPasswordModal && <ChangePasswordModal onClose={() => setShowPasswordModal(false)}/>}
      {showProfile && <ProfileModal user={user} onClose={() => setShowProfile(false)} onSaved={(u) => onUserChange && onUserChange(u)}/>}
      {showSecurity && <SecurityModal user={user} onClose={() => setShowSecurity(false)}
        onChanged={async () => { try { const d = await API.me(); onUserChange && onUserChange(d.user); } catch {} }}
        onChangePassword={() => setShowPasswordModal(true)}/>}
      {renameFolderTarget && (
        <RenameFolderModal folder={renameFolderTarget} onClose={() => setRenameFolderTarget(null)} onSaved={refreshAll}/>
      )}
      {versionsTarget && (
        <VersionHistoryModal file={versionsTarget} onClose={() => setVersionsTarget(null)} onChanged={refreshAll}/>
      )}
      {moveTarget && (
        <MoveModal
          title={moveTarget.kind === 'folder' ? 'Ordner verschieben nach' : 'Dateien verschieben nach'}
          allFolders={allFolders}
          excludeId={moveTarget.kind === 'folder' ? moveTarget.folder.id : null}
          onMove={doMove} onClose={() => setMoveTarget(null)}/>
      )}
      {searchOpen && (
        <GlobalSearch
          onClose={() => setSearchOpen(false)}
          onPickFile={(f) => openViewer(f)}
          onPickFolder={(f) => { setNav({ name: 'folder', id: f.id }); setSearch(''); }}
          onGoto={(app) => { setNav({ name: 'app-' + app }); setSearch(''); }}/>
      )}
      {viewing && (
        <MediaViewer items={viewing.items} startIndex={viewing.index}
          srcFor={(f) => fileSrc(f.id)} downloadFor={(f) => fileDownload(f.id)}
          onSaveText={async (f, content) => { await API.saveContent(f.id, content); refreshAll(); }}
          comments={{
            load: (f) => API.fileComments(f.id).then((d) => d.comments || []),
            add: (f, { body }) => API.addFileComment(f.id, body).then((d) => d.comments || []),
            remove: async (f, cid) => { await API.delFileComment(f.id, cid); return (await API.fileComments(f.id)).comments || []; },
            askName: false, defaultName: user?.name || '',
          }}
          onClose={() => setViewing(null)}/>
      )}

      {isMobile && (
        <MobileNav active={activeNav} onNavigate={(n) => { setNav(n); setSearch(''); }}
          onUpload={() => setShowFab(true)} onMore={() => setShowMore(true)}/>
      )}
      {showMore && (
        <MoreSheet user={user} theme={theme} onTheme={onTheme}
          onNavigate={(n) => { setNav(n); setSearch(''); }}
          onSecurity={() => setShowSecurity(true)}
          onProfile={() => setShowProfile(true)}
          onLogout={() => { setToken(null); location.reload(); }}
          onClose={() => setShowMore(false)}/>
      )}
      {showFab && (
        <FabSheet
          onCreateFolder={() => setShowNewFolderMobile(true)}
          onUploadFiles={() => triggerUpload(null)}
          onUploadFolder={() => triggerFolderUpload(null)}
          onClose={() => setShowFab(false)}/>
      )}
      {showNewFolderMobile && (
        <NewFolderModal
          onClose={() => setShowNewFolderMobile(false)}
          onCancel={() => setShowNewFolderMobile(false)}
          onCreate={async (name, kind, tone, templateId) => {
            const fid = nav.name === 'folder' ? nav.id : null;
            try {
              const d = await API.newFolder({ name, kind, tone, parent_id: fid });
              if (templateId) {
                const templates = JSON.parse(localStorage.getItem('nyza.folderTemplates') || '[]');
                const tmpl = templates.find((t) => t.id === templateId);
                if (tmpl) {
                  for (const sub of tmpl.folders) {
                    try { await API.newFolder({ name: sub, kind: 'normal', tone: 'violet', parent_id: d.folder.id }); } catch {}
                  }
                }
              }
              toast('Ordner erstellt', 'success'); refreshAll(); setShowNewFolderMobile(false);
            } catch (e) { toast(e.message, 'error'); }
          }}
        />
      )}

      {reviewFiles && (
        <UploadReview files={reviewFiles}
          onConfirm={(files, mode) => { const fid = uploadTargetFolder.current; setReviewFiles(null); enqueueUploads(files.map((f) => ({ file: f, folderId: fid, mode }))); }}
          onCancel={() => setReviewFiles(null)}/>
      )}

      <input ref={uploadInputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => {
        const filesArr = Array.from(e.target.files || []);
        if (filesArr.length) setReviewFiles(filesArr);
        e.target.value = '';
      }}/>
      <input ref={folderUploadInputRef} type="file" multiple webkitdirectory="" style={{ display: 'none' }} onChange={(e) => {
        const filesArr = Array.from(e.target.files || []);
        if (filesArr.length) runFolderUpload(filesArr, folderUploadTargetRef.current);
        e.target.value = '';
      }}/>
    </div>
  );
}

// Context-menu item builders — shared by the grid, list and folder cards.
function fileMenuItems(file, o) {
  if (o.multi) {
    return [
      { header: o.count + ' ausgewählt' },
      { label: 'Als ZIP herunterladen', icon: Ic.download(15), onClick: o.onZip },
      o.onMoveMany && { label: 'Verschieben', icon: Ic.folder(15), onClick: o.onMoveMany },
      { separator: true },
      { label: 'In den Papierkorb', icon: Ic.trash(15), danger: true, onClick: o.onDeleteMany },
    ];
  }
  const isZip = /\.zip$/i.test(file.name);
  const f = file;
  return [
    { label: 'Öffnen', icon: Ic.eye(15), onClick: () => o.onOpen(file) },
    { label: 'Herunterladen', icon: Ic.download(15), onClick: () => o.onDownload(file) },
    isZip && o.onUnzip && { label: 'Entpacken', icon: Ic.archive(15), onClick: () => o.onUnzip(file) },
    o.onToggleStar && { label: file.starred ? 'Aus Favoriten entfernen' : 'Zu Favoriten', icon: Ic.star(15), onClick: () => o.onToggleStar(file) },
    o.onPin && { label: file.pinned ? 'Lösen' : 'Anpinnen', icon: Ic.pin(15), onClick: () => o.onPin(file) },
    { separator: true },
    { header: 'Markieren' },
    { label: 'Rot – Überarbeiten',  icon: <span style={{display:'inline-block',width:10,height:10,borderRadius:'50%',background:'#ef4444',marginRight:2}}/>, onClick: () => o.onLabel && o.onLabel(f, 'red') },
    { label: 'Gelb – Auswahl',      icon: <span style={{display:'inline-block',width:10,height:10,borderRadius:'50%',background:'#eab308',marginRight:2}}/>, onClick: () => o.onLabel && o.onLabel(f, 'yellow') },
    { label: 'Grün – Freigegeben',  icon: <span style={{display:'inline-block',width:10,height:10,borderRadius:'50%',background:'#22c55e',marginRight:2}}/>, onClick: () => o.onLabel && o.onLabel(f, 'green') },
    ...(f.label ? [{ label: 'Markierung entfernen', icon: Ic.close(14), onClick: () => o.onLabel && o.onLabel(f, null) }] : []),
    { separator: true },
    o.onShare && { label: 'Teilen (Link)', icon: Ic.share(15), onClick: () => o.onShare(file) },
    o.onShareInternal && { label: 'Intern teilen (Mitglieder)', icon: Ic.users(15), onClick: () => o.onShareInternal(file) },
    o.onMove && { label: 'Verschieben', icon: Ic.folder(15), onClick: () => o.onMove(file) },
    o.onTags && { label: 'Tags…', icon: Ic.bolt(15), onClick: () => o.onTags(file) },
    o.onVersions && { label: 'Versionsverlauf', icon: Ic.clock(15), onClick: () => o.onVersions(file) },
    { separator: true },
    o.onDelete && { label: 'In den Papierkorb', icon: Ic.trash(15), danger: true, onClick: () => o.onDelete(file) },
  ];
}
function folderMenuItems(folder, o) {
  return [
    { label: 'Öffnen', icon: Ic.folder(15), onClick: () => o.onOpen(folder) },
    o.onPin && { label: folder.pinned ? 'Lösen' : 'Anpinnen', icon: Ic.pin(15), onClick: () => o.onPin(folder) },
    o.onRename && { label: 'Umbenennen', icon: Ic.fileGen(15), onClick: () => o.onRename(folder) },
    o.onMove && { label: 'Verschieben', icon: Ic.folder(15), onClick: () => o.onMove(folder) },
    o.onShare && { label: 'Teilen (Link)', icon: Ic.share(15), onClick: () => o.onShare(folder) },
    o.onShareInternal && { label: 'Intern teilen (Mitglieder)', icon: Ic.users(15), onClick: () => o.onShareInternal(folder) },
    o.onColor && { separator: true },
    o.onColor && { header: 'Farbe' },
    o.onColor && { swatches: FOLDER_SWATCHES, current: folder.tone || 'violet', onPick: (key) => o.onColor(folder, key) },
    { separator: true },
    o.onDelete && { label: 'Löschen', icon: Ic.trash(15), danger: true, onClick: () => o.onDelete(folder) },
  ];
}

// ───── Files (home) view ───────────────────────────────────────────────────
function FilesView({
  user, stats, folders, view, setView, sort, setSort, search, setSearch, refreshTick,
  onOpenFolder, onShareFolder, onRenameFolder, onMoveFolder, onFolderColor, onMoveFiles, onDeleteFolder, onNewFolder, onUpload, onNewText, onUploadLink,
  onOpenFile, onShareFile, onShareInternalFile, onShareInternalFolder, onDeleteFile, onToggleStar, onDropFiles, onUnzip, onVersions, onDownloadFile,
  onPinFile, onPinFolder,
}) {
  const [recent, setRecent] = useState([]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [results, setResults] = useState(null); // server search results when searching
  const [showRecentPref, setShowRecentPref] = useState(() => localStorage.getItem('nyza.showRecent') !== '0');
  const [selected, setSelected] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);

  useEffect(() => {
    API.recentFiles().then((d) => setRecent(d.files || [])).catch(() => setRecent([]));
  }, [refreshTick]);

  // Listen for preference changes from ProfileModal
  useEffect(() => {
    const handler = () => setShowRecentPref(localStorage.getItem('nyza.showRecent') !== '0');
    window.addEventListener('nyza.prefchange', handler);
    return () => window.removeEventListener('nyza.prefchange', handler);
  }, []);

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

  const toggleSelect = (id) => {
    const list = results?.files || [];
    if (id === '__all__') { setSelected((s) => s.size === list.length ? new Set() : new Set(list.map((f) => f.id))); return; }
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const fileCtx = (f, e) => openContextMenu(e.clientX, e.clientY, fileMenuItems(f, {
    onOpen: (x) => onOpenFile(x, results?.files || []),
    onDownload: onDownloadFile, onToggleStar, onShare: onShareFile, onShareInternal: onShareInternalFile,
    onDelete: onDeleteFile, onVersions, onUnzip, onPin: onPinFile,
  }));

  const folderCtx = (f, e) => openContextMenu(e.clientX, e.clientY, folderMenuItems(f, {
    onOpen: onOpenFolder, onRename: onRenameFolder, onMove: onMoveFolder, onShare: onShareFolder, onShareInternal: onShareInternalFolder, onColor: onFolderColor, onDelete: onDeleteFolder, onPin: onPinFolder,
  }));
  const bgCtx = (e) => {
    if (e.target.closest('[data-fid]') || e.target.closest('[data-folder-card]')) return;
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Neuer Ordner', icon: Ic.plus(15), onClick: () => setCreatingFolder(true) },
      { label: 'Notiz erstellen', icon: Ic.fileGen(15), onClick: onNewText },
      { label: 'Hochladen', icon: Ic.upload(15), onClick: onUpload },
      { separator: true },
      { label: selectMode ? 'Auswahl beenden' : 'Auswählen', icon: Ic.checkSquare(15), onClick: () => setSelectMode((s) => !s) },
    ]);
  };

  return (
    <>
      <TopBar crumbs={['Meine Dateien']} view={view} onView={setView} search={search} onSearch={setSearch} sort={sort} onSort={setSort}
        selectMode={selectMode} onSelectMode={(v) => { setSelectMode(v); if (!v) setSelected(new Set()); }}/>
      <div data-scroll onContextMenu={bgCtx} style={{ flex: 1, overflow: 'auto', padding: '28px 32px 80px' }}>
        <div className="nyza-hero-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginBottom: 24 }}>
          <Btn variant="glass" size="md" icon={Ic.fileGen(15)} onClick={onNewText}>Notiz</Btn>
          <Btn variant="glass" size="md" icon={Ic.link(15)} onClick={onUploadLink}>Upload-Link</Btn>
          <Btn variant="primary" size="md" icon={Ic.upload(15)} onClick={onUpload}>Hochladen</Btn>
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

        {!searching && stats?.by_kind && (stats.storage_used > 0) && (
          <StorageBreakdown stats={stats}/>
        )}

        {!searching && showRecentPref && recent.length > 0 && (
          <>
            <SectionHeader title="Zuletzt geöffnet"/>
            <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, marginBottom: 28 }}>
              {recent.map((f) => (
                <div key={f.id} onClick={() => onOpenFile(f, recent)} style={{ flexShrink: 0, width: 130, cursor: 'pointer' }}>
                  <div style={{ width: 130, height: 96, borderRadius: 'var(--r-sm)', overflow: 'hidden', background: 'var(--surface-hi)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {f.kind === 'image'
                      ? <img src={API.thumbUrl(f.id)} alt={f.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
                      : f.kind === 'video'
                      ? <video src={`${API.fileRawUrl(f.id)}?token=${getToken()}#t=0.1`} muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}/>
                      : <FileIcon kind={f.kind} size={26} tint={f.hue}/>}
                  </div>
                  <div style={{ fontSize: 11.5, fontWeight: 500, marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {searching ? (
          <>
            <SectionHeader title={'Suchergebnisse für „' + search.trim() + '"'} count={results ? (results.files.length + results.folders.length) : null}/>
            {results === null ? <SkeletonGrid count={5}/> : (results.files.length + results.folders.length) === 0 ? (
              <EmptyHint icon={Ic.search(40)} title="Nichts gefunden" desc={'Keine Dateien oder Ordner zu „' + search.trim() + '".'}/>
            ) : (
              <>
                {results.folders.length > 0 && (
                  <div className="nyza-folder-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14, marginBottom: 28 }}>
                    {results.folders.map((f) => <FolderCard key={f.id} folder={f} onClick={() => onOpenFolder(f)}/>)}
                  </div>
                )}
                {results.files.length > 0 && (
                  <FileGrid files={results.files} selected={selected} onOpen={(f) => onOpenFile(f, results.files)} onToggleSelect={toggleSelect} onDragSelect={setSelected} onToggleStar={onToggleStar} onContext={fileCtx} selectMode={selectMode}/>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <SectionHeader title="Ordner" count={fFolders.length} action={<Btn variant="glass" size="sm" icon={Ic.plus(13)} onClick={() => setCreatingFolder(true)}>Neuer Ordner</Btn>}/>
            {creatingFolder && <NewFolderModal onCreate={(n, k, t, tid) => { onNewFolder(n, k, t, tid); setCreatingFolder(false); }} onCancel={() => setCreatingFolder(false)}/>}
            {fFolders.length > 0 ? (
              <div className="nyza-folder-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14, marginBottom: 36 }}>
                {fFolders.map((f) => <FolderCard key={f.id} folder={f}
                  onClick={() => onOpenFolder(f)} onShare={() => onShareFolder(f)}
                  onRename={() => onRenameFolder(f)} onMove={() => onMoveFolder(f)}
                  onDropFiles={onDropFiles} onContext={folderCtx}
                  onDelete={() => onDeleteFolder(f)}/>)}
              </div>
            ) : !creatingFolder && (
              <EmptyHint icon={Ic.folder(40)} title="Noch keine Ordner" desc="Lege einen Ordner an oder lade direkt Dateien hoch."
                actions={<><Btn variant="primary" size="md" icon={Ic.plus(14)} onClick={() => setCreatingFolder(true)}>Neuer Ordner</Btn><Btn variant="glass" size="md" icon={Ic.upload(14)} onClick={onUpload}>Hochladen</Btn></>}/>
            )}

          </>
        )}
      </div>
    </>
  );
}

// ───── Gallery owner view ──────────────────────────────────────────────────
const LABEL_COLORS = { red: '#ef4444', yellow: '#eab308', green: '#22c55e' };
const LABEL_NAMES  = { red: 'Überarbeiten', yellow: 'Auswahl', green: 'Freigegeben' };

// Parse a MySQL 'Y-m-d H:i:s' (or ISO) string into a Date safely across browsers.
function parsePhotoDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

function GalleryOwnerView({ files, onOpen, onLabel, onContext }) {
  const media = files.filter((f) => f.kind === 'image' || f.kind === 'video');
  const others = files.filter((f) => f.kind !== 'image' && f.kind !== 'video');

  // Group by capture month/year — prefer the photo's EXIF date (taken_at),
  // fall back to the upload date. Sorted newest first.
  const dateOf = (f) => parsePhotoDate(f.taken_at) || parsePhotoDate(f.created_at) || new Date(0);
  const sorted = [...media].sort((a, b) => dateOf(b).getTime() - dateOf(a).getTime());
  const groups = [];
  const seen = {};
  for (const f of sorted) {
    const d = dateOf(f);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!seen[key]) { seen[key] = groups.length; groups.push({ label: d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }), files: [] }); }
    groups[seen[key]].files.push(f);
  }

  return (
    <div>
      {groups.map((g) => (
        <div key={g.label} style={{ marginBottom: 36 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-3)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>{g.label}</span>
            <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>{g.files.length}</span>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }}/>
          </div>
          <div className="nyza-masonry">
            {g.files.map((f) => (
              <div key={f.id} onClick={() => onOpen(f)}
                onContextMenu={onContext ? (e) => { e.preventDefault(); e.stopPropagation(); onContext(f, e); } : undefined}
                style={{ cursor: 'pointer', position: 'relative' }}>
                {f.kind === 'image'
                  ? <img src={API.thumbUrl(f.id)} alt={f.name} loading="lazy" style={{ width: '100%', display: 'block', borderRadius: 'var(--r-md)' }}/>
                  : <video src={`${API.fileRawUrl(f.id)}?token=${getToken()}#t=0.1`} muted preload="metadata" style={{ width: '100%', display: 'block', borderRadius: 'var(--r-md)', pointerEvents: 'none' }}/>
                }
                {onContext && (
                  <span className="gallery-kebab" title="Mehr" onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); onContext(f, { clientX: b.right, clientY: b.bottom, preventDefault() {}, stopPropagation() {} }); }}
                    style={{ position: 'absolute', top: 8, left: 8, width: 28, height: 28, borderRadius: 999, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.more(16)}</span>
                )}
                {!!f.pinned && (
                  <span style={{ position: 'absolute', bottom: 8, left: 8, width: 24, height: 24, borderRadius: 999, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Angepinnt">{Ic.pin(12)}</span>
                )}
                {f.kind === 'video' && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', borderRadius: 'var(--r-md)' }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="12" height="12" viewBox="0 0 14 14" fill="#fff"><path d="M3 1l9 6-9 6z"/></svg>
                    </div>
                  </div>
                )}
                {f.label && (
                  <div style={{ position: 'absolute', top: 8, right: 8, width: 14, height: 14, borderRadius: '50%', background: LABEL_COLORS[f.label], border: '2px solid rgba(255,255,255,0.8)', boxShadow: '0 1px 4px rgba(0,0,0,0.4)' }}
                    title={LABEL_NAMES[f.label]}/>
                )}
                {onLabel && (
                  <div style={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', gap: 4, opacity: 0 }} className="gallery-label-btns">
                    {Object.entries(LABEL_COLORS).map(([lbl, col]) => (
                      <button key={lbl} type="button" onClick={(e) => { e.stopPropagation(); onLabel(f, f.label === lbl ? null : lbl); }}
                        title={LABEL_NAMES[lbl]}
                        style={{ width: 22, height: 22, borderRadius: '50%', border: '2px solid ' + (f.label === lbl ? '#fff' : 'rgba(255,255,255,0.5)'), background: col, cursor: 'pointer', padding: 0 }}/>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {others.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-3)', marginBottom: 12 }}>Andere Dateien</div>
          <FileGrid files={others} selected={new Set()} onOpen={onOpen} onToggleSelect={() => {}} onDragSelect={() => {}} onToggleStar={() => {}} onDragFiles={() => {}} onContext={() => {}} selectMode={false}/>
        </div>
      )}
      {media.length === 0 && others.length === 0 && (
        <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--fg-3)' }}>Noch keine Dateien in dieser Galerie.</div>
      )}
    </div>
  );
}

// ───── Folder detail view ──────────────────────────────────────────────────
function FolderView({
  folderId, view, setView, sort, setSort, search, setSearch, refreshTick,
  onBack, onOpenFolder, onUpload, onNewText, onShareFolder, onMoveFiles, onUploadLink, onOpenFile, onShareFile, onDeleteFile, onToggleStar, onDropFiles, afterChange,
  onUnzip, onVersions, onDownloadFile, onMoveFolder, onRenameFolder, onShareFolderItem, onShareInternalFile, onShareInternalFolder, onDeleteFolder, onFolderColor, onLabelFile,
  onPinFile, onPinFolder,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [creatingSubfolder, setCreatingSubfolder] = useState(false);
  const { tags, idsFor, createTag, toggle: toggleTag } = useEntityTags('file', refreshTick);
  const [tagFilter, setTagFilter] = useState(null);   // tagId | null
  const [tagTarget, setTagTarget] = useState(null);   // file being tagged

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
  const files = sortFiles((data.files || [])
    .filter((f) => !q || f.name.toLowerCase().includes(q))
    .filter((f) => !tagFilter || idsFor(f.id).includes(tagFilter)), sort);

  const toggleSelect = (id) => {
    if (id === '__all__') { setSelected((s) => s.size === files.length ? new Set() : new Set(files.map((f) => f.id))); return; }
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const clearSel = () => { setSelected(new Set()); setSelectMode(false); };
  const doZip = () => downloadZip([...selected], setZipBusy, clearSel);
  const doBulkDelete = async () => {
    if (!await confirmDialog({ title: 'In den Papierkorb?', message: `${selected.size} ${selected.size === 1 ? 'Datei wird' : 'Dateien werden'} in den Papierkorb verschoben.`, confirmLabel: 'In Papierkorb', danger: true })) return;
    for (const id of selected) { try { await API.deleteFile(id); } catch {} }
    toast('In den Papierkorb', 'success'); clearSel(); load(); afterChange && afterChange();
  };
  const fileCtx = (f, e, selectThis) => {
    const multi = selected.has(f.id) && selected.size > 1;
    if (!multi) selectThis && selectThis();
    openContextMenu(e.clientX, e.clientY, fileMenuItems(f, {
      multi, count: selected.size,
      onOpen: (x) => onOpenFile(x, files), onDownload: onDownloadFile, onUnzip,
      onToggleStar, onShare: onShareFile, onShareInternal: onShareInternalFile, onMove: (x) => onMoveFiles([x.id]),
      onVersions, onDelete: onDeleteFile, onLabel: onLabelFile, onTags: (x) => setTagTarget(x),
      onZip: doZip, onMoveMany: () => onMoveFiles([...selected]), onDeleteMany: doBulkDelete,
      onPin: onPinFile,
    }));
  };
  const folderCtx = (f, e) => openContextMenu(e.clientX, e.clientY, folderMenuItems(f, {
    onOpen: onOpenFolder, onRename: onRenameFolder, onMove: onMoveFolder, onShare: onShareFolderItem, onShareInternal: onShareInternalFolder, onColor: onFolderColor, onDelete: onDeleteFolder, onPin: onPinFolder,
  }));
  const bgCtx = (e) => {
    if (e.target.closest('[data-fid]')) return;
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Neuer Unterordner', icon: Ic.folder(15), onClick: () => setCreatingSubfolder(true) },
      { label: 'Notiz erstellen', icon: Ic.fileGen(15), onClick: () => onNewText(folder.id) },
      { label: 'Hochladen', icon: Ic.upload(15), onClick: () => onUpload(folder.id) },
      { separator: true },
      { label: selectMode ? 'Auswahl beenden' : 'Auswählen', icon: Ic.checkSquare(15), onClick: () => setSelectMode((s) => !s) },
    ]);
  };

  return (
    <>
      <TopBar
        crumbs={[{ label: 'Meine Dateien', onClick: onBack }, folder.name]}
        view={view} onView={setView} search={search} onSearch={setSearch} sort={sort} onSort={setSort}
        selectMode={selectMode} onSelectMode={(v) => { setSelectMode(v); if (!v) setSelected(new Set()); }}
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
        onContextMenu={bgCtx}
        data-scroll style={{ flex: 1, overflow: 'auto', padding: '24px 32px 80px', position: 'relative', outline: over ? '2px dashed var(--accent)' : 'none', outlineOffset: -12 }}>
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>
            {folder.kind === 'gallery' ? '◇ Galerie' : '◇ Ordner'} · {files.length} Dateien · {humanSize((data.files || []).reduce((s, f) => s + (f.size || 0), 0))}
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 600, letterSpacing: -0.8, margin: 0 }}>{folder.name}</h1>
        </div>

        <SectionHeader title="Unterordner" count={subfolders.length} action={<Btn variant="glass" size="sm" icon={Ic.plus(13)} onClick={() => setCreatingSubfolder(true)}>Neuer Unterordner</Btn>}/>
        {creatingSubfolder && <NewFolderModal title="Neuer Unterordner" onCreate={async (n, k, t) => { try { await API.newFolder({ name: n, kind: k, tone: t, parent_id: folderId }); toast('Unterordner erstellt', 'success'); setCreatingSubfolder(false); load(); } catch (e) { toast(e.message, 'error'); } }} onCancel={() => setCreatingSubfolder(false)}/>}
        {subfolders.length > 0 && (
          <div className="nyza-folder-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14, marginBottom: 32 }}>
            {subfolders.map((f) => <FolderCard key={f.id} folder={f} onClick={() => onOpenFolder(f)} onDropFiles={onDropFiles} onContext={folderCtx}/>)}
          </div>
        )}

        {tags.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-3)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>{Ic.bolt(13)} Tags:</span>
            {tags.map((t) => {
              const on = tagFilter === t.id; const c = tagColor(t.color);
              return (
                <button key={t.id} onClick={() => setTagFilter(on ? null : t.id)} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 999,
                  fontSize: 12, fontWeight: 600, cursor: 'pointer', color: c.fg,
                  background: on ? c.bg : 'transparent', border: '1.5px solid ' + (on ? c.fg : 'var(--border)'),
                }}>{on && Ic.check(11)}{t.name}<span style={{ opacity: 0.6, fontWeight: 500 }}>{t.count}</span></button>
              );
            })}
            {tagFilter && <button onClick={() => setTagFilter(null)} style={{ fontSize: 12, color: 'var(--fg-3)', background: 'none', border: 'none', cursor: 'pointer' }}>Filter aufheben</button>}
          </div>
        )}

        {folder.kind === 'gallery' ? (
          <GalleryOwnerView files={files} token={null} onOpen={(f) => onOpenFile(f, files)} onLabel={onLabelFile} onContext={(f, e) => fileCtx(f, e)}/>
        ) : files.length > 0 ? (
          view === 'grid'
            ? <FileGrid files={files} selected={selected} onOpen={(f) => onOpenFile(f, files)} onToggleSelect={toggleSelect} onDragSelect={setSelected} onToggleStar={onToggleStar} onDragFiles={() => {}} onContext={fileCtx} selectMode={selectMode} tagLookup={idsFor} tags={tags}/>
            : <FileList files={files} selected={selected} onOpen={(f) => onOpenFile(f, files)} onToggleSelect={toggleSelect} onDragSelect={setSelected} onShareFile={onShareFile} onToggleStar={onToggleStar} onDeleteFile={(f) => { onDeleteFile(f); }} onContext={fileCtx} selectMode={selectMode} tagLookup={idsFor} tags={tags}/>
        ) : (
          <EmptyHint icon={Ic.upload(40)} title="Dieser Ordner ist leer" desc="Zieh Dateien hierher oder lade welche hoch."
            actions={<Btn variant="primary" size="md" icon={Ic.upload(14)} onClick={() => onUpload(folder.id)}>Hochladen</Btn>}/>
        )}
      </div>

      {selected.size > 0 && <SelectionBar count={selected.size} busy={zipBusy} onZip={doZip} onMove={() => onMoveFiles([...selected])} onDelete={doBulkDelete} onClear={clearSel}/>}
      {tagTarget && (
        <TagPickerModal title={'Tags · ' + tagTarget.name} tags={tags}
          selectedIds={new Set(idsFor(tagTarget.id))}
          onToggle={(t, on) => toggleTag(tagTarget.id, t, on)}
          onCreate={createTag}
          onClose={() => setTagTarget(null)}/>
      )}
    </>
  );
}

// ───── Shares view ─────────────────────────────────────────────────────────
function SharesView({ refreshTick, basePath, afterChange, embedded }) {
  const [shares, setShares] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [histId, setHistId] = useState(null);
  const [histData, setHistData] = useState(null);
  const load = useCallback(() => { API.shares().then((d) => setShares(d.shares || [])).catch(() => setShares([])); }, []);
  useEffect(() => { load(); }, [load, refreshTick]);
  const toggleHist = async (id) => {
    if (histId === id) { setHistId(null); setHistData(null); return; }
    setHistId(id); setHistData(null);
    try { setHistData(await API.shareEvents(id)); } catch (e) { toast(e.message, 'error'); setHistData({ events: [] }); }
  };
  const evLabel = (e) => e.type === 'download' ? 'Heruntergeladen: ' + (e.file_name || 'Datei') : e.type === 'zip' ? 'Alles als ZIP heruntergeladen' : 'Link geöffnet';

  const del = async (id) => { if (!await confirmDialog({ title: 'Share-Link löschen?', message: 'Der Link wird sofort ungültig — niemand kann ihn mehr öffnen.', confirmLabel: 'Löschen', danger: true })) return; try { await API.deleteShare(id); toast('Gelöscht', 'success'); load(); afterChange && afterChange(); } catch (e) { toast(e.message, 'error'); } };
  const copy = (token) => { navigator.clipboard?.writeText(location.origin + (basePath || '') + '/s/' + token); toast('Link kopiert', 'success'); };
  const edit = (s) => setEditTarget(s.folder_id ? { folder: { id: s.folder_id, name: s.folder_name || 'Ordner', kind: s.gallery ? 'gallery' : 'normal' } } : { file: { id: s.file_id, name: s.file_name || 'Datei' } });

  const body = (
      <>
        <SectionHeader title="Geteilte Links" count={shares ? shares.length : null}/>
        {shares === null ? (
          <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
        ) : shares.length === 0 ? (
          <EmptyHint icon={Ic.share(40)} title="Noch nichts geteilt" desc="Teile einen Ordner oder eine Datei — der Link erscheint hier."/>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {shares.map((s) => (
              <div key={s.id} style={{ borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', overflow: 'hidden' }}>
              <div className="nyza-listrow" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px' }}>
                <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'color-mix(in oklab, var(--accent) 16%, transparent)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{s.folder_id ? Ic.folder(18) : Ic.fileGen(18)}</div>
                <div className="nyza-listrow-main" style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 540, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.folder_name || s.file_name || (s.folder_id ? 'Ordner' : 'Datei')}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span>{s.folder_id ? 'Ordner' : 'Datei'}</span>
                    {!!s.gallery && <span>· {Ic.fileImg(10)} Galerie</span>}
                    <span>· {s.view_count || 0} Aufrufe</span>
                    {s.password_hash && <span>· {Ic.lock(10)} Passwort</span>}
                    {!s.allow_download && <span>· kein Download</span>}
                    {s.expires_at && <span>· läuft ab {new Date(s.expires_at).toLocaleDateString('de-DE')}</span>}
                    <span>· erstellt {timeAgo(s.created_at)}</span>
                  </div>
                </div>
                <Btn variant="glass" size="sm" icon={Ic.clock(13)} onClick={() => toggleHist(s.id)}>Verlauf</Btn>
                <Btn variant="glass" size="sm" icon={Ic.cog(13)} onClick={() => edit(s)}>Bearbeiten</Btn>
                <Btn variant="glass" size="sm" icon={Ic.copy(13)} onClick={() => copy(s.token)}>Kopieren</Btn>
                <a href={(basePath || '') + '/s/' + s.token} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><Btn variant="glass" size="sm" icon={Ic.eye(13)}>Öffnen</Btn></a>
                <IconBtn size={32} title="Löschen" onClick={() => del(s.id)}>{Ic.trash(14)}</IconBtn>
              </div>
              {histId === s.id && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '10px 16px 14px', background: 'var(--surface-hi)' }}>
                  {histData === null ? <div style={{ color: 'var(--fg-3)', fontSize: 12, padding: 8 }}>{Ic.loader(16)}</div>
                    : (histData.events || []).length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--fg-3)', padding: 6 }}>Noch keine Aktivität.</div>
                    : (<>
                        <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginBottom: 8 }}>{(histData.summary?.views ?? histData.views) || 0} Aufrufe · {(histData.summary?.downloads ?? histData.downloads) || 0} Downloads</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                          {histData.events.map((e) => (
                            <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                              <span style={{ color: e.type === 'view' ? 'var(--fg-3)' : 'var(--accent)', display: 'inline-flex' }}>{e.type === 'view' ? Ic.eye(13) : Ic.download(13)}</span>
                              <span style={{ flex: 1, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{evLabel(e)}</span>
                              {e.ip && <span style={{ color: 'var(--fg-4)' }}>{e.ip}</span>}
                              <span style={{ color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>{timeAgo(e.created_at)}</span>
                            </div>
                          ))}
                        </div>
                      </>)}
                </div>
              )}
              </div>
            ))}
          </div>
        )}
        {editTarget && <ShareModal folder={editTarget.folder} file={editTarget.file} basePath={basePath} onClose={() => setEditTarget(null)} onCreated={() => { load(); afterChange && afterChange(); }}/>}
      </>
  );

  if (embedded) return body;
  return (
    <>
      <TopBar crumbs={['Geteilt']}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '28px 32px 60px' }}>{body}</div>
    </>
  );
}

// ───── Upload-Links view ───────────────────────────────────────────────────
function LinksView({ refreshTick, basePath, onCreate, afterChange, embedded }) {
  const [links, setLinks] = useState(null);
  const load = useCallback(() => { API.uploadLinks().then((d) => setLinks(d.upload_links || [])).catch(() => setLinks([])); }, []);
  useEffect(() => { load(); }, [load, refreshTick]);

  const del = async (id) => { if (!await confirmDialog({ title: 'Upload-Link löschen?', message: 'Externe können über diesen Link dann keine Dateien mehr hochladen.', confirmLabel: 'Löschen', danger: true })) return; try { await API.deleteUploadLink(id); toast('Gelöscht', 'success'); load(); afterChange && afterChange(); } catch (e) { toast(e.message, 'error'); } };
  const copy = (token) => { navigator.clipboard?.writeText(location.origin + (basePath || '') + '/u/' + token); toast('Link kopiert', 'success'); };

  const body = (
      <>
        <SectionHeader title="Upload-Links" count={links ? links.length : null}/>
        {links === null ? (
          <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
        ) : links.length === 0 ? (
          <EmptyHint icon={Ic.inbox(40)} title="Noch keine Upload-Links" desc="Erstelle einen Link, über den Externe ohne Login Dateien zu dir hochladen."
            actions={<Btn variant="primary" size="md" icon={Ic.plus(14)} onClick={onCreate}>Upload-Link erstellen</Btn>}/>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {links.map((l) => (
              <div key={l.id} className="nyza-listrow" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 4px 12px -4px var(--accent-glow)' }}>{Ic.inbox(18)}</div>
                <div className="nyza-listrow-main" style={{ flex: 1, minWidth: 0 }}>
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
      </>
  );

  if (embedded) return body;
  return (
    <>
      <TopBar crumbs={['Upload-Links']} right={<Btn variant="primary" size="sm" icon={Ic.plus(14)} onClick={onCreate}>Neuer Upload-Link</Btn>}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '28px 32px 60px' }}>{body}</div>
    </>
  );
}

// ───── Links hub — Geteilt + Upload-Links unter einem Menüpunkt ─────────────
function LinksHub({ refreshTick, basePath, onCreate, afterChange, initialTab = 'shared' }) {
  const [tab, setTab] = useState(initialTab);
  const tabs = [
    { id: 'shared', label: 'Geteilt', icon: Ic.share },
    { id: 'links',  label: 'Upload-Links', icon: Ic.inbox },
  ];
  return (
    <>
      <TopBar crumbs={['Links']}
        right={tab === 'links'
          ? <Btn variant="primary" size="sm" icon={Ic.plus(14)} onClick={onCreate}>Neuer Upload-Link</Btn>
          : null}
      />
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '24px 32px 60px' }}>
        <div style={{ display: 'inline-flex', gap: 4, padding: 4, marginBottom: 22, borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
          {tabs.map((t) => {
            const on = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 16px',
                borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 540,
                background: on ? 'var(--accent-grad)' : 'transparent', color: on ? '#fff' : 'var(--fg-2)',
                boxShadow: on ? '0 4px 12px -4px var(--accent-glow)' : 'none', transition: 'all .18s',
              }}>{t.icon(14)}{t.label}</button>
            );
          })}
        </div>
        {tab === 'shared'
          ? <SharesView embedded refreshTick={refreshTick} basePath={basePath} afterChange={afterChange}/>
          : <LinksView embedded refreshTick={refreshTick} basePath={basePath} onCreate={onCreate} afterChange={afterChange}/>}
      </div>
    </>
  );
}

// ───── Apps launcher — Handy-Style Kacheln ──────────────────────────────────
function AppsView({ onOpenApp }) {
  const live = [
    { id: 'tasks',    label: 'Tasks',    desc: 'Aufgaben & To-dos', icon: Ic.checkSquare(26), grad: 'linear-gradient(135deg, oklch(0.72 0.18 282), oklch(0.64 0.17 248))' },
    { id: 'contacts', label: 'Kontakte', desc: 'Kunden & Adressen',  icon: Ic.users(26),      grad: 'linear-gradient(135deg, oklch(0.7 0.16 240), oklch(0.66 0.16 210))' },
    { id: 'times',    label: 'Zeiten',   desc: 'Zeiterfassung',      icon: Ic.clock(26),      grad: 'linear-gradient(135deg, oklch(0.74 0.16 200), oklch(0.66 0.16 230))' },
    { id: 'roadmap',  label: 'Roadmap',  desc: 'Planung & Meilensteine', icon: Ic.bolt(26),   grad: 'linear-gradient(135deg, oklch(0.74 0.18 30), oklch(0.66 0.2 360))' },
    { id: 'settings', label: 'Einstellungen', desc: 'Konfiguration',     icon: Ic.cog(26),    grad: 'linear-gradient(135deg, oklch(0.6 0.02 260), oklch(0.5 0.02 260))' },
    { id: 'accounting', label: 'Buchhaltung', desc: 'Rechnungen & Angebote', icon: Ic.archive(26), grad: 'linear-gradient(135deg, oklch(0.74 0.17 155), oklch(0.68 0.15 175))' },
    { id: 'calendar',   label: 'Kalender',     desc: 'Termine & Events',       icon: Ic.clock(26),   grad: 'linear-gradient(135deg, oklch(0.72 0.2 350), oklch(0.66 0.2 320))' },
  ];
  const soon = [];
  const Tile = ({ a, disabled }) => (
    <button disabled={disabled} onClick={disabled ? undefined : () => onOpenApp(a.id)} style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '6px 4px',
      background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit',
      opacity: disabled ? 0.5 : 1, position: 'relative',
    }}
    onMouseEnter={(e) => { if (!disabled) e.currentTarget.firstChild.style.transform = 'translateY(-3px)'; }}
    onMouseLeave={(e) => { e.currentTarget.firstChild.style.transform = 'translateY(0)'; }}>
      <div style={{
        width: 68, height: 68, borderRadius: 20, background: a.grad, color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 10px 24px -8px rgba(0,0,0,0.4)',
        transition: 'transform .22s cubic-bezier(.2,.8,.2,1)', position: 'relative',
      }}>
        {a.icon}
        {disabled && (
          <span style={{ position: 'absolute', top: -6, right: -6, fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, padding: '2px 6px', borderRadius: 999, background: 'var(--surface)', color: 'var(--fg-3)', border: '1px solid var(--border-hi)', textTransform: 'uppercase' }}>Bald</span>
        )}
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 540, color: 'var(--fg)' }}>{a.label}</div>
        <div style={{ fontSize: 10.5, color: 'var(--fg-3)', marginTop: 2 }}>{a.desc}</div>
      </div>
    </button>
  );
  return (
    <>
      <TopBar crumbs={['Apps']}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '28px 32px 80px' }}>
        <SectionHeader title="Apps"/>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 22, marginBottom: 40 }}>
          {live.map((a) => <Tile key={a.id} a={a}/>)}
        </div>
        {soon.length > 0 && <>
          <SectionHeader title="In Entwicklung"/>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 22 }}>
            {soon.map((a) => <Tile key={a.id} a={a} disabled/>)}
          </div>
        </>}
      </div>
    </>
  );
}

// ───── Tasks app — Asana-style sections ─────────────────────────────────────
const TASK_PRIO = {
  0: { label: 'Niedrig', color: 'var(--fg-3)', dot: 'oklch(0.6 0.02 260)' },
  1: { label: 'Normal',  color: 'var(--accent)', dot: 'oklch(0.66 0.18 250)' },
  2: { label: 'Hoch',    color: '#ef4444', dot: '#ef4444' },
};
function taskDayDiff(due) {
  if (!due) return null;
  const d = new Date(due + 'T00:00:00');
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - now.getTime()) / 86400000);
}
// Full due moment (date + optional time). Time defaults to end-of-day so a
// date-only task only goes overdue once the day is actually over.
function taskDueAt(t) {
  if (!t.due_date) return null;
  const time = t.due_time ? (t.due_time.length === 5 ? t.due_time + ':00' : t.due_time) : '23:59:59';
  return new Date(t.due_date + 'T' + time);
}
function taskIsOverdue(t) {
  const at = taskDueAt(t);
  return at ? at.getTime() < Date.now() : false;
}
function fmtDue(t) {
  if (!t.due_date) return null;
  const diff = taskDayDiff(t.due_date);
  const time = t.due_time ? ' · ' + t.due_time.slice(0, 5) : '';
  if (diff === 0) return 'Heute' + time;
  if (diff === 1) return 'Morgen' + time;
  if (diff === -1) return 'Gestern' + time;
  const d = new Date(t.due_date + 'T00:00:00');
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: d.getFullYear() !== new Date().getFullYear() ? '2-digit' : undefined }) + time;
}

function TasksApp({ onBack }) {
  const [tasks, setTasks] = useState(null);
  const [archived, setArchived] = useState(null);
  const [showArchive, setShowArchive] = useState(false);
  const [editing, setEditing] = useState(null); // task object or {} for new
  const [users, setUsers] = useState([]);
  const [filter, setFilter] = useState('all'); // all | mine | <userId>

  useEffect(() => { API.users().then((d) => setUsers(d.users || [])).catch(() => {}); }, []);
  const load = useCallback(() => {
    const opts = filter === 'mine' ? { mine: 1 } : (filter !== 'all' ? { assignee: filter } : {});
    API.tasks(opts).then((d) => setTasks(d.tasks || [])).catch(() => setTasks([]));
  }, [filter]);
  const loadArchive = useCallback(() => {
    API.tasksArchived().then((d) => setArchived(d.tasks || [])).catch(() => setArchived([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (showArchive) loadArchive(); }, [showArchive, loadArchive]);

  const complete = async (t) => { try { await API.taskDone(t.id); load(); } catch (e) { toast(e.message, 'error'); } };
  const restore = async (t) => { try { await API.taskRestore(t.id); loadArchive(); load(); } catch (e) { toast(e.message, 'error'); } };
  const del = async (t) => {
    if (!await confirmDialog({ title: 'Aufgabe löschen?', message: `„${t.title}" wird endgültig gelöscht.`, confirmLabel: 'Löschen', danger: true })) return;
    try { await API.deleteTask(t.id); load(); if (showArchive) loadArchive(); } catch (e) { toast(e.message, 'error'); }
  };
  const save = async (data) => {
    try {
      if (data.id) await API.updateTask(data.id, { title: data.title, notes: data.notes, due_date: data.due_date, due_time: data.due_time, priority: data.priority, assignee_id: data.assignee_id });
      else await API.newTask({ title: data.title, notes: data.notes, due_date: data.due_date, due_time: data.due_time, priority: data.priority, assignee_id: data.assignee_id });
      setEditing(null); load();
    } catch (e) { toast(e.message, 'error'); }
  };

  // Bucket active tasks into the Asana-style sections.
  const buckets = { overdue: [], today: [], week: [], later: [], none: [] };
  for (const t of (tasks || [])) {
    const diff = taskDayDiff(t.due_date);
    if (diff === null) buckets.none.push(t);
    else if (diff < 0 || (diff === 0 && taskIsOverdue(t))) buckets.overdue.push(t);
    else if (diff === 0) buckets.today.push(t);
    else if (diff <= 7) buckets.week.push(t);
    else buckets.later.push(t);
  }
  const sections = [
    { id: 'overdue', label: 'Überfällig', color: '#ef4444', items: buckets.overdue },
    { id: 'today',   label: 'Heute fällig', color: 'var(--accent)', items: buckets.today },
    { id: 'week',    label: 'Nächste 7 Tage', color: 'var(--fg-2)', items: buckets.week },
    { id: 'later',   label: 'Später', color: 'var(--fg-2)', items: buckets.later },
    { id: 'none',    label: 'Ohne Fälligkeit', color: 'var(--fg-3)', items: buckets.none },
  ].filter((s) => s.items.length > 0);

  const Row = ({ t, archivedRow }) => {
    const prio = TASK_PRIO[t.priority] || TASK_PRIO[1];
    const overdue = !archivedRow && taskIsOverdue(t);
    return (
      <div className="nyza-listrow" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer' }}
        onClick={() => !archivedRow && setEditing(t)}>
        {archivedRow ? (
          <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--surface-hi)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--success)', flexShrink: 0 }}>{Ic.check(13)}</div>
        ) : (
          <button onClick={(e) => { e.stopPropagation(); complete(t); }} title="Erledigt"
            style={{ width: 22, height: 22, borderRadius: '50%', border: '2px solid var(--border-hi)', background: 'transparent', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'transparent', transition: 'all .15s' }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-hi)'; e.currentTarget.style.color = 'transparent'; }}>
            {Ic.check(12)}
          </button>
        )}
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: prio.dot, flexShrink: 0 }} title={'Priorität: ' + prio.label}/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: archivedRow ? 'line-through' : 'none', color: archivedRow ? 'var(--fg-3)' : 'var(--fg)' }}>{t.title}</div>
          {t.notes && <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.notes}</div>}
        </div>
        {t.assignee_name && <span title={'Zugewiesen: ' + t.assignee_name} style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--accent-grad)', color: '#fff', fontSize: 10, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{(t.assignee_name || '?').slice(0, 1).toUpperCase()}</span>}
        {t.due_date && (
          <span style={{ fontSize: 12, fontWeight: 500, color: overdue ? '#ef4444' : 'var(--fg-3)', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {Ic.clock(12)}{fmtDue(t)}
          </span>
        )}
        {archivedRow ? (
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <IconBtn size={30} title="Wiederherstellen" onClick={(e) => { e.stopPropagation?.(); restore(t); }}>{Ic.rotate(14)}</IconBtn>
            <IconBtn size={30} title="Löschen" onClick={(e) => { e.stopPropagation?.(); del(t); }}>{Ic.trash(14)}</IconBtn>
          </div>
        ) : (
          <span className="task-kebab" title="Mehr" onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); openContextMenu(b.right, b.bottom, [
            { label: 'Bearbeiten', icon: Ic.fileGen(15), onClick: () => setEditing(t) },
            { label: 'Erledigt', icon: Ic.check(15), onClick: () => complete(t) },
            { separator: true },
            { label: 'Löschen', icon: Ic.trash(15), danger: true, onClick: () => del(t) },
          ]); }}
            style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}>{Ic.more(16)}</span>
        )}
      </div>
    );
  };

  return (
    <>
      <TopBar crumbs={[{ label: 'Apps', onClick: onBack }, 'Tasks']}
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {!showArchive && users.length > 0 && (
              <select value={filter} onChange={(e) => setFilter(e.target.value)} title="Filter" style={{ height: 32, padding: '0 10px', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 12.5, color: 'var(--fg)', fontFamily: 'inherit', cursor: 'pointer' }}>
                <option value="all">Alle</option>
                <option value="mine">Meine</option>
                {users.map((u) => <option key={u.id} value={String(u.id)}>{u.name || u.email}</option>)}
              </select>
            )}
            <Btn variant="glass" size="sm" icon={Ic.archive(14)} onClick={() => setShowArchive((s) => !s)}>{showArchive ? 'Aktuelle' : 'Archiv'}</Btn>
            <Btn variant="primary" size="sm" icon={Ic.plus(14)} onClick={() => setEditing({ priority: 1 })}>Neue Aufgabe</Btn>
          </div>
        }
      />
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '24px 32px 80px' }}>
        {showArchive ? (
          <>
            <SectionHeader title="Archiv" count={archived ? archived.length : null}/>
            <div style={{ fontSize: 12, color: 'var(--fg-3)', marginBottom: 16, marginTop: -8 }}>Erledigte Aufgaben werden nach 7 Tagen automatisch gelöscht.</div>
            {archived === null ? <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
              : archived.length === 0 ? <EmptyHint icon={Ic.archive(40)} title="Archiv ist leer" desc="Abgehakte Aufgaben landen hier."/>
              : <div style={{ display: 'grid', gap: 8, maxWidth: 820 }}>{archived.map((t) => <Row key={t.id} t={t} archivedRow/>)}</div>}
          </>
        ) : tasks === null ? (
          <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
        ) : tasks.length === 0 ? (
          <EmptyHint icon={Ic.checkSquare(40)} title="Keine Aufgaben" desc="Lege deine erste Aufgabe an und behalte den Überblick."
            actions={<Btn variant="primary" size="md" icon={Ic.plus(14)} onClick={() => setEditing({ priority: 1 })}>Neue Aufgabe</Btn>}/>
        ) : (
          <div style={{ maxWidth: 820 }}>
            {sections.map((s) => (
              <div key={s.id} style={{ marginBottom: 28 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color }}/>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)' }}>{s.label}</span>
                  <span style={{ fontSize: 12, color: 'var(--fg-4)' }}>{s.items.length}</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }}/>
                </div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {s.items.map((t) => <Row key={t.id} t={t}/>)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {editing && <TaskEditModal task={editing} users={users} onSave={save} onClose={() => setEditing(null)}/>}
    </>
  );
}

function TaskEditModal({ task, users = [], onSave, onClose }) {
  const [title, setTitle] = useState(task.title || '');
  const [notes, setNotes] = useState(task.notes || '');
  const [due, setDue] = useState(task.due_date || '');
  const [time, setTime] = useState(task.due_time ? task.due_time.slice(0, 5) : '');
  const [priority, setPriority] = useState(task.priority ?? 1);
  const [assignee, setAssignee] = useState(task.assignee_id ? String(task.assignee_id) : '');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim()) { toast('Titel erforderlich', 'error'); return; }
    setBusy(true);
    await onSave({ id: task.id, title: title.trim(), notes: notes.trim() || null, due_date: due || null, due_time: due ? (time || null) : null, priority, assignee_id: assignee || null });
    setBusy(false);
  };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 460, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.checkSquare(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>{task.id ? 'Aufgabe bearbeiten' : 'Neue Aufgabe'}</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Titel</span>
            <input value={title} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="Was ist zu tun?"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) submit(); }}
              style={{ height: 44, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)' }}/>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Notiz</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Details (optional)" rows={3}
              style={{ padding: '10px 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', resize: 'vertical' }}/>
          </label>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ flex: '1 1 130px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Fälligkeit</span>
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)}
                style={{ height: 44, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit' }}/>
            </label>
            <label style={{ flex: '1 1 110px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Uhrzeit</span>
              <input type="time" value={time} disabled={!due} onChange={(e) => setTime(e.target.value)}
                style={{ height: 44, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', opacity: due ? 1 : 0.5 }}/>
            </label>
            <label style={{ flex: '1 1 130px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Priorität</span>
              <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}
                style={{ height: 44, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', cursor: 'pointer' }}>
                <option value={0}>Niedrig</option>
                <option value={1}>Normal</option>
                <option value={2}>Hoch</option>
              </select>
            </label>
          </div>
          {users.length > 0 && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Zugewiesen an</span>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}
                style={{ height: 44, padding: '0 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', cursor: 'pointer' }}>
                <option value="">— niemand —</option>
                {users.map((u) => <option key={u.id} value={String(u.id)}>{u.name || u.email}</option>)}
              </select>
            </label>
          )}
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} onClick={submit} icon={busy ? Ic.loader(15) : Ic.check(15)}>Speichern</Btn>
        </div>
      </Glass>
    </div>
  );
}

// ───── Kontakte app (CRM) ───────────────────────────────────────────────────
function ContactsApp({ onBack }) {
  const [contacts, setContacts] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | customers
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => {
    API.contacts({ customers: filter === 'customers', q: search.trim() || undefined })
      .then((d) => setContacts(d.contacts || [])).catch(() => setContacts([]));
  }, [filter, search]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const save = async (data) => {
    try {
      if (data.id) await API.updateContact(data.id, data);
      else await API.newContact(data);
      setEditing(null); load();
    } catch (e) { toast(e.message, 'error'); }
  };
  const del = async (c) => {
    if (!await confirmDialog({ title: 'Kontakt löschen?', message: `„${c.name}" wird endgültig gelöscht.`, confirmLabel: 'Löschen', danger: true })) return;
    try { await API.deleteContact(c.id); load(); } catch (e) { toast(e.message, 'error'); }
  };
  const toggleCustomer = async (c) => {
    try { await API.updateContact(c.id, { is_customer: c.is_customer ? 0 : 1 }); load(); }
    catch (e) { toast(e.message, 'error'); }
  };

  const initials = (n) => (n || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const sub = (c) => [c.contact_person, c.email, c.phone].filter(Boolean)[0] || (c.city ? c.city : '');

  return (
    <>
      <TopBar crumbs={[{ label: 'Apps', onClick: onBack }, 'Kontakte']}
        search={search} onSearch={setSearch}
        right={<Btn variant="primary" size="sm" icon={Ic.plus(14)} onClick={() => setEditing({ kind: 'person' })}>Neuer Kontakt</Btn>}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '24px 32px 80px' }}>
        <div style={{ display: 'inline-flex', gap: 4, padding: 4, marginBottom: 22, borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
          {[{ id: 'all', label: 'Alle' }, { id: 'customers', label: 'Kunden' }].map((t) => {
            const on = filter === t.id;
            return (
              <button key={t.id} onClick={() => setFilter(t.id)} style={{
                height: 34, padding: '0 18px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 540,
                background: on ? 'var(--accent-grad)' : 'transparent', color: on ? '#fff' : 'var(--fg-2)',
                boxShadow: on ? '0 4px 12px -4px var(--accent-glow)' : 'none', transition: 'all .18s',
              }}>{t.label}</button>
            );
          })}
        </div>

        {contacts === null ? (
          <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
        ) : contacts.length === 0 ? (
          <EmptyHint icon={Ic.users(40)} title={search ? 'Nichts gefunden' : 'Noch keine Kontakte'}
            desc={search ? 'Keine Kontakte zu deiner Suche.' : 'Lege Kontakte an und markiere sie bei Bedarf als Kunde.'}
            actions={!search && <Btn variant="primary" size="md" icon={Ic.plus(14)} onClick={() => setEditing({ kind: 'person' })}>Neuer Kontakt</Btn>}/>
        ) : (
          <div style={{ display: 'grid', gap: 8, maxWidth: 860 }}>
            {contacts.map((c) => (
              <div key={c.id} className="nyza-listrow" onClick={() => setEditing(c)}
                style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer' }}>
                <div style={{ width: 40, height: 40, borderRadius: c.kind === 'company' ? 'var(--r-sm)' : '50%', flexShrink: 0, background: c.is_customer ? 'var(--accent-grad)' : 'var(--surface-hi)', color: c.is_customer ? '#fff' : 'var(--fg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, border: c.is_customer ? 'none' : '1px solid var(--border)' }}>
                  {c.kind === 'company' ? Ic.folder(18) : initials(c.name)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 540, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                    {!!c.is_customer && <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: '2px 7px', borderRadius: 999, background: 'color-mix(in oklab, var(--accent) 18%, transparent)', color: 'var(--accent)', textTransform: 'uppercase', flexShrink: 0 }}>Kunde</span>}
                  </div>
                  {sub(c) && <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub(c)}</div>}
                </div>
                <span className="task-kebab" title="Mehr" onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); openContextMenu(b.right, b.bottom, [
                  { label: 'Bearbeiten', icon: Ic.fileGen(15), onClick: () => setEditing(c) },
                  { label: c.is_customer ? 'Kundenstatus entfernen' : 'Als Kunde markieren', icon: Ic.star(15), onClick: () => toggleCustomer(c) },
                  { separator: true },
                  { label: 'Löschen', icon: Ic.trash(15), danger: true, onClick: () => del(c) },
                ]); }}
                  style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}>{Ic.more(16)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {editing && <ContactEditModal contact={editing} onSave={save} onClose={() => setEditing(null)}/>}
    </>
  );
}

function ContactEditModal({ contact, onSave, onClose }) {
  const [f, setF] = useState({
    kind: contact.kind || 'person', name: contact.name || '', contact_person: contact.contact_person || '',
    email: contact.email || '', phone: contact.phone || '', street: contact.street || '',
    zip: contact.zip || '', city: contact.city || '', country: contact.country || '',
    vat_id: contact.vat_id || '', notes: contact.notes || '', is_customer: !!contact.is_customer,
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const input = (k, ph, type = 'text') => (
    <input type={type} value={f[k]} onChange={(e) => set(k, e.target.value)} placeholder={ph}
      style={{ height: 42, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', width: '100%' }}/>
  );
  const submit = async () => {
    if (!f.name.trim()) { toast('Name erforderlich', 'error'); return; }
    setBusy(true);
    await onSave({ id: contact.id, ...f, name: f.name.trim(), is_customer: f.is_customer ? 1 : 0 });
    setBusy(false);
  };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 520, borderRadius: 'var(--r-xl)', overflow: 'hidden', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.users(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>{contact.id ? 'Kontakt bearbeiten' : 'Neuer Kontakt'}</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {[{ id: 'person', label: 'Person' }, { id: 'company', label: 'Firma' }].map((k) => (
              <button key={k.id} onClick={() => set('kind', k.id)} style={{
                flex: 1, height: 36, borderRadius: 'var(--r-sm)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 540,
                border: '1px solid ' + (f.kind === k.id ? 'var(--accent)' : 'var(--border)'),
                background: f.kind === k.id ? 'color-mix(in oklab, var(--accent) 12%, transparent)' : 'transparent',
                color: f.kind === k.id ? 'var(--accent)' : 'var(--fg-2)',
              }}>{k.label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>{f.kind === 'company' ? 'Firmenname' : 'Name'}</span>
            {input('name', f.kind === 'company' ? 'Firma GmbH' : 'Max Mustermann')}
          </div>
          {f.kind === 'company' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Ansprechpartner</span>
              {input('contact_person', 'Vor- und Nachname')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>E-Mail</span>{input('email', 'mail@beispiel.at', 'email')}</div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Telefon</span>{input('phone', '+43 …')}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Straße</span>{input('street', 'Straße 1')}</div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ width: 110, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>PLZ</span>{input('zip', '1010')}</div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Ort</span>{input('city', 'Wien')}</div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Land</span>{input('country', 'Österreich')}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>USt-IdNr / UID</span>{input('vat_id', 'ATU…')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Notiz</span>
            <textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} placeholder="Notiz (optional)"
              style={{ padding: '10px 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', resize: 'vertical' }}/>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={f.is_customer} onChange={(e) => set('is_customer', e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--accent)', cursor: 'pointer' }}/>
            <span style={{ fontSize: 14, color: 'var(--fg-2)' }}>Als Kunde markieren</span>
          </label>
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} onClick={submit} icon={busy ? Ic.loader(15) : Ic.check(15)}>Speichern</Btn>
        </div>
      </Glass>
    </div>
  );
}

// ───── Zeiten app (time tracking) ───────────────────────────────────────────
function fmtDur(sec) {
  if (sec == null) return '–';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m > 0) return m + 'm';
  return (sec % 60) + 's';
}
function fmtClock(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
}
// Server stores datetimes in UTC (like the rest of the app); append 'Z' so the
// browser converts to local time for display and elapsed math.
function dtParse(s) { return s ? new Date(String(s).replace(' ', 'T') + 'Z') : null; }
function fmtHM(s) { const d = dtParse(s); return d ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : ''; }
function localDateKey(s) { const d = dtParse(s); if (!d) return ''; const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function todayKeyLocal() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function ymdOf(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function mondayOf(date) { const x = new Date(date); x.setHours(0, 0, 0, 0); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x; }
function addDays(date, n) { const x = new Date(date); x.setDate(x.getDate() + n); return x; }
function dayLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - now.getTime()) / 86400000);
  if (diff === 0) return 'Heute';
  if (diff === -1) return 'Gestern';
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

function ZeitenApp({ onBack }) {
  const [entries, setEntries] = useState(null);
  const [running, setRunning] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [task, setTask] = useState('');
  const [contactId, setContactId] = useState('');
  const [modal, setModal] = useState(null); // {} new | entry edit
  const [invoiceModal, setInvoiceModal] = useState(false);
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [users, setUsers] = useState([]);
  const [viewUser, setViewUser] = useState(''); // '' = own; else another member's id (read-only)
  const readOnly = viewUser !== '';

  const load = useCallback(() => {
    const from = ymdOf(weekStart), to = ymdOf(addDays(weekStart, 6));
    API.timeEntries({ from, to, user_id: viewUser || undefined }).then((d) => setEntries(d.entries || [])).catch(() => setEntries([]));
    if (viewUser) { setRunning(null); return; }
    API.timeRunning().then((d) => setRunning(d.entry || null)).catch(() => {});
  }, [weekStart, viewUser]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { API.contacts({}).then((d) => setContacts(d.contacts || [])).catch(() => {}); API.users().then((d) => setUsers(d.users || [])).catch(() => {}); }, []);
  // Tick once a second while a timer runs so the elapsed display stays live.
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [running]);

  const start = async () => {
    try { await API.timeStart({ task: task.trim() || null, contact_id: contactId || null }); setTask(''); setContactId(''); load(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const stop = async () => { if (!running) return; try { await API.timeStop(running.id); load(); } catch (e) { toast(e.message, 'error'); } };
  const save = async (data) => {
    try {
      if (data.id) await API.updateTimeEntry(data.id, data);
      else await API.newTimeEntry(data);
      setModal(null); load();
    } catch (e) { toast(e.message, 'error'); }
  };
  const del = async (en) => {
    if (!await confirmDialog({ title: 'Eintrag löschen?', message: 'Dieser Zeiteintrag wird gelöscht.', confirmLabel: 'Löschen', danger: true })) return;
    try { await API.deleteTimeEntry(en.id); load(); } catch (e) { toast(e.message, 'error'); }
  };

  const liveElapsed = running ? Math.max(0, Math.floor((now - dtParse(running.started_at).getTime()) / 1000)) : 0;

  // Group completed entries by calendar day (newest first) with per-day totals.
  const done = (entries || []).filter((e) => !e.running);
  const groups = [];
  const idx = {};
  for (const e of done) {
    const key = localDateKey(e.started_at);
    if (!(key in idx)) { idx[key] = groups.length; groups.push({ key, total: 0, items: [] }); }
    groups[idx[key]].items.push(e);
    groups[idx[key]].total += e.duration || 0;
  }
  const todayKey = todayKeyLocal();
  const todayTotal = (groups.find((g) => g.key === todayKey)?.total || 0) + (running ? liveElapsed : 0);
  const weekEnd = addDays(weekStart, 6);
  const weekLabel = `${weekStart.toLocaleDateString('de-DE', { day: 'numeric', month: 'long' })} – ${weekEnd.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const weekTotal = groups.reduce((a, g) => a + g.total, 0);

  return (
    <>
      <TopBar crumbs={[{ label: 'Apps', onClick: onBack }, 'Zeiten']}
        right={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {users.length > 0 && (
            <select value={viewUser} onChange={(e) => setViewUser(e.target.value)} title="Wessen Zeiten" style={{ height: 32, padding: '0 10px', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 12.5, color: 'var(--fg)', fontFamily: 'inherit', cursor: 'pointer' }}>
              <option value="">Meine Zeiten</option>
              {users.map((u) => <option key={u.id} value={String(u.id)}>{u.name || u.email}</option>)}
            </select>
          )}
          {!readOnly && <Btn variant="glass" size="sm" icon={Ic.fileGen(14)} onClick={() => setInvoiceModal(true)}>Rechnung</Btn>}
          {!readOnly && <Btn variant="glass" size="sm" icon={Ic.plus(14)} onClick={() => setModal({})}>Manuell</Btn>}
        </div>}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '24px 32px 80px' }}>
        {readOnly && <div style={{ maxWidth: 860, marginBottom: 14, padding: '10px 14px', borderRadius: 'var(--r-md)', background: 'var(--surface-hi)', border: '1px solid var(--border)', fontSize: 13, color: 'var(--fg-2)' }}>Ansicht der Zeiten von <strong>{(users.find((u) => String(u.id) === viewUser) || {}).name || 'Mitglied'}</strong> — nur lesen.</div>}
        {/* Live tracker */}
        {!readOnly && <Glass style={{ borderRadius: 'var(--r-lg)', padding: 18, marginBottom: 8, maxWidth: 860 }}>
          {running ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 34, fontWeight: 600, letterSpacing: -1, fontVariantNumeric: 'tabular-nums', color: 'var(--accent)', minWidth: 150 }}>{fmtClock(liveElapsed)}</div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 14, fontWeight: 540 }}>{running.task || 'Ohne Aufgabe'}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 2 }}>{running.contact_name ? running.contact_name + ' · ' : ''}seit {fmtHM(running.started_at)}</div>
              </div>
              <Btn variant="danger" size="lg" icon={<span style={{ width: 12, height: 12, borderRadius: 3, background: 'currentColor', display: 'inline-block' }}/>} onClick={stop}>Stopp</Btn>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="Woran arbeitest du?"
                onKeyDown={(e) => { if (e.key === 'Enter') start(); }}
                style={{ flex: 1, minWidth: 180, height: 48, padding: '0 16px', borderRadius: 'var(--r-md)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 15, color: 'var(--fg)', fontFamily: 'inherit' }}/>
              <select value={contactId} onChange={(e) => setContactId(e.target.value)}
                style={{ height: 48, padding: '0 12px', borderRadius: 'var(--r-md)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', cursor: 'pointer', maxWidth: 200 }}>
                <option value="">— Kunde —</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <Btn variant="primary" size="lg" icon={<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1l9 6-9 6z"/></svg>} onClick={start}>Start</Btn>
            </div>
          )}
        </Glass>}
        <div style={{ fontSize: 12, color: 'var(--fg-3)', margin: '0 0 14px', maxWidth: 860 }}>{readOnly ? 'Heute' : 'Heute erfasst'}: <strong style={{ color: 'var(--fg-2)' }}>{fmtDur(todayTotal)}</strong></div>

        {/* Week switcher */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, maxWidth: 860, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <IconBtn size={34} title="Vorige Woche" onClick={() => setWeekStart((w) => addDays(w, -7))} style={{ border: '1px solid var(--border)', borderRadius: 999 }}>{Ic.chevronL(16)}</IconBtn>
            <IconBtn size={34} title="Nächste Woche" onClick={() => setWeekStart((w) => addDays(w, 7))} style={{ border: '1px solid var(--border)', borderRadius: 999 }}>{Ic.chevronR(16)}</IconBtn>
          </div>
          <div style={{ fontSize: 14, fontWeight: 540, display: 'flex', alignItems: 'center', gap: 8 }}>{Ic.clock(14)}{weekLabel}</div>
          {ymdOf(weekStart) !== ymdOf(mondayOf(new Date())) && (
            <Btn variant="glass" size="sm" onClick={() => setWeekStart(mondayOf(new Date()))}>Heute</Btn>
          )}
          <div style={{ flex: 1 }}/>
          <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>Woche: <strong style={{ color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>{fmtDur(weekTotal)}</strong></span>
        </div>

        {entries === null ? (
          <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
        ) : done.length === 0 ? (
          <EmptyHint icon={Ic.clock(40)} title="Keine Zeiten in dieser Woche" desc="Starte den Timer, wechsle die Woche oder trage eine Zeit manuell ein."/>
        ) : (
          <div style={{ maxWidth: 860 }}>
            {groups.map((g) => (
              <div key={g.key} style={{ marginBottom: 26 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)' }}>{dayLabel(g.key)}</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }}/>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>{fmtDur(g.total)}</span>
                </div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {g.items.map((en) => (
                    <div key={en.id} className="nyza-listrow" onClick={() => { if (!readOnly) setModal(en); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', cursor: readOnly ? 'default' : 'pointer' }}>
                      <div style={{ fontSize: 12, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flexShrink: 0, width: 96 }}>{fmtHM(en.started_at)}–{fmtHM(en.ended_at)}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{en.task || 'Ohne Aufgabe'}</div>
                        {(en.contact_name || en.note) && <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{[en.contact_name, en.note].filter(Boolean).join(' · ')}</div>}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtDur(en.duration)}</div>
                      {!readOnly && <span className="task-kebab" title="Mehr" onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); openContextMenu(b.right, b.bottom, [
                        { label: 'Bearbeiten', icon: Ic.fileGen(15), onClick: () => setModal(en) },
                        { label: 'Löschen', icon: Ic.trash(15), danger: true, onClick: () => del(en) },
                      ]); }}
                        style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}>{Ic.more(16)}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {modal && <TimeEntryModal entry={modal} contacts={contacts} onSave={save} onClose={() => setModal(null)}/>}
      {invoiceModal && <TimeInvoiceModal contacts={contacts} onClose={() => setInvoiceModal(false)} onDone={() => { setInvoiceModal(false); load(); }}/>}
    </>
  );
}

function TimeInvoiceModal({ contacts, onClose, onDone }) {
  const [contactId, setContactId] = useState('');
  const [entries, setEntries] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [rate, setRate] = useState(80);
  const [taxRate, setTaxRate] = useState(20);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!contactId) { setEntries(null); setSel(new Set()); return; }
    setEntries(null); setSel(new Set());
    API.timeBillable(contactId).then((d) => setEntries(d.entries || [])).catch(() => setEntries([]));
  }, [contactId]);

  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const open = (entries || []).filter((e) => !e.invoice_id);
  const allSel = open.length > 0 && open.every((e) => sel.has(e.id));
  const toggleAll = () => setSel(() => allSel ? new Set() : new Set(open.map((e) => e.id)));

  const selHours = (entries || []).filter((e) => sel.has(e.id)).reduce((a, e) => a + (e.duration || 0) / 3600, 0);
  const net = Math.round(selHours * (Number(rate) || 0) * 100) / 100;
  const gross = Math.round(net * (1 + (Number(taxRate) || 0) / 100) * 100) / 100;

  const create = async () => {
    if (sel.size === 0) { toast('Keine Einträge gewählt', 'error'); return; }
    setBusy(true);
    try {
      const r = await API.invoiceFromTime({ contact_id: Number(contactId), entry_ids: [...sel], hourly_rate: Number(rate) || 0, tax_rate: Number(taxRate) || 0 });
      toast('Rechnung ' + (r.number || '') + ' erstellt', 'success');
      if (r.invoice_id) window.open(API.docPdfUrl(r.invoice_id, false), '_blank');
      onDone();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  const fld = { height: 40, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit' };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 640, borderRadius: 'var(--r-xl)', overflow: 'hidden', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.fileGen(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>Rechnung aus Zeiten</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Kunde</span>
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} style={{ ...fld, cursor: 'pointer', width: '100%' }}>
              <option value="">— Kunde wählen —</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>

          {!contactId ? (
            <div style={{ color: 'var(--fg-3)', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>Wähle einen Kunden, um abrechenbare Zeiten zu sehen.</div>
          ) : entries === null ? (
            <div style={{ color: 'var(--fg-3)', padding: 16 }}>{Ic.loader(20)}</div>
          ) : entries.length === 0 ? (
            <div style={{ color: 'var(--fg-3)', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>Keine erfassten Zeiten für diesen Kunden.</div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--fg-2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={allSel} onChange={toggleAll} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}/>
                  Alle offenen wählen
                </label>
                <div style={{ flex: 1 }}/>
                <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{open.length} offen · {entries.length - open.length} verrechnet</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {entries.map((e) => {
                  const billed = !!e.invoice_id;
                  const checked = sel.has(e.id);
                  return (
                    <div key={e.id} onClick={() => !billed && toggle(e.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface)', border: '1px solid ' + (checked ? 'var(--accent)' : 'var(--border)'), cursor: billed ? 'default' : 'pointer', opacity: billed ? 0.45 : 1 }}>
                      <input type="checkbox" disabled={billed} checked={checked} onChange={() => toggle(e.id)} onClick={(ev) => ev.stopPropagation()} style={{ width: 16, height: 16, accentColor: 'var(--accent)', flexShrink: 0 }}/>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.task || 'Ohne Aufgabe'}</div>
                        <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 1 }}>{localDateKey(e.started_at) && new Date(dtParse(e.started_at)).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} · {fmtHM(e.started_at)}–{fmtHM(e.ended_at)}{billed ? ` · ${e.invoice_number || 'verrechnet'}` : ''}</div>
                      </div>
                      <div style={{ fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtDur(e.duration)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--fg-2)' }}>Std-Satz €<input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} style={{ ...fld, width: 84, textAlign: 'right' }}/></label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--fg-2)' }}>USt
            <select value={taxRate} onChange={(e) => setTaxRate(e.target.value)} style={{ ...fld, width: 70, cursor: 'pointer' }}><option value={20}>20%</option><option value={13}>13%</option><option value={10}>10%</option><option value={0}>0%</option></select>
          </label>
          <div style={{ flex: 1, minWidth: 120, textAlign: 'right', fontSize: 12.5, color: 'var(--fg-3)' }}>
            {selHours.toFixed(2).replace('.', ',')} h · Netto <strong style={{ color: 'var(--fg-2)' }}>{fmtEUR(net)}</strong> · Brutto <strong style={{ color: 'var(--accent)' }}>{fmtEUR(gross)}</strong>
          </div>
          <Btn variant="primary" disabled={busy || sel.size === 0} onClick={create} icon={busy ? Ic.loader(15) : Ic.check(15)}>Rechnung erstellen</Btn>
        </div>
      </Glass>
    </div>
  );
}

function TimeEntryModal({ entry, contacts, onSave, onClose }) {
  const startD = dtParse(entry.started_at);
  const endD = dtParse(entry.ended_at);
  const pad = (n) => String(n).padStart(2, '0');
  const toDate = (d) => d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : new Date().toISOString().slice(0, 10);
  const toTime = (d) => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
  const [date, setDate] = useState(toDate(startD));
  const [start, setStart] = useState(toTime(startD) || '09:00');
  const [end, setEnd] = useState(toTime(endD) || '10:00');
  const [task, setTask] = useState(entry.task || '');
  const [contactId, setContactId] = useState(entry.contact_id ? String(entry.contact_id) : '');
  const [note, setNote] = useState(entry.note || '');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!date || !start || !end) { toast('Datum, Start und Ende erforderlich', 'error'); return; }
    if (end <= start) { toast('Ende muss nach dem Start liegen', 'error'); return; }
    setBusy(true);
    await onSave({ id: entry.id, task: task.trim() || null, note: note.trim() || null, contact_id: contactId || null, started_at: new Date(`${date}T${start}`).toISOString(), ended_at: new Date(`${date}T${end}`).toISOString() });
    setBusy(false);
  };
  const fld = { height: 42, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', width: '100%' };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 480, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.clock(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>{entry.id ? 'Zeit bearbeiten' : 'Zeit eintragen'}</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Aufgabe</span>
            <input value={task} autoFocus onChange={(e) => setTask(e.target.value)} placeholder="Woran gearbeitet?" style={fld}/>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 140px', display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Tag</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={fld}/></div>
            <div style={{ flex: '1 1 90px', display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Start</span><input type="time" value={start} onChange={(e) => setStart(e.target.value)} style={fld}/></div>
            <div style={{ flex: '1 1 90px', display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Ende</span><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} style={fld}/></div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Kunde</span>
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} style={{ ...fld, cursor: 'pointer' }}>
              <option value="">— Kein Kunde —</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Notiz</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Notiz (optional)" style={{ ...fld, height: 'auto', padding: '10px 12px', resize: 'vertical' }}/>
          </div>
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} onClick={submit} icon={busy ? Ic.loader(15) : Ic.check(15)}>Speichern</Btn>
        </div>
      </Glass>
    </div>
  );
}

// ───── Roadmap app ──────────────────────────────────────────────────────────
function RoadmapApp({ onBack }) {
  const [steps, setSteps] = useState(null);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(null); // step id with open add-task input
  const [addText, setAddText] = useState('');

  const load = useCallback(() => { API.roadmap().then((d) => setSteps(d.steps || [])).catch(() => setSteps([])); }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (data) => {
    try { if (data.id) await API.updateRoadmapStep(data.id, data); else await API.newRoadmapStep(data); setEditing(null); load(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const del = async (s) => { if (!await confirmDialog({ title: 'Schritt löschen?', message: `„${s.title}" inkl. Aufgaben wird gelöscht.`, confirmLabel: 'Löschen', danger: true })) return; try { await API.deleteRoadmapStep(s.id); load(); } catch (e) { toast(e.message, 'error'); } };
  const toggleStep = async (s) => { try { await API.updateRoadmapStep(s.id, { completed: s.completed ? 0 : 1 }); load(); } catch (e) { toast(e.message, 'error'); } };
  const toggleTask = async (s, t) => { try { await API.updateRoadmapTask(s.id, t.id, { completed: t.completed ? 0 : 1 }); load(); } catch (e) { toast(e.message, 'error'); } };
  const delTask = async (s, t) => { try { await API.deleteRoadmapTask(s.id, t.id); load(); } catch (e) { toast(e.message, 'error'); } };
  const addTask = async (s) => { const t = addText.trim(); if (!t) { setAdding(null); return; } try { await API.addRoadmapTask(s.id, t); setAddText(''); load(); } catch (e) { toast(e.message, 'error'); } };

  const list = steps || [];
  const totalSteps = list.length;
  const doneSteps = list.filter((s) => s.completed).length;
  const allTasks = list.reduce((a, s) => a + s.progress.total, 0);
  const doneTasks = list.reduce((a, s) => a + s.progress.done, 0);
  const overall = totalSteps ? Math.round(doneSteps / totalSteps * 100) : 0;
  const activeIdx = list.findIndex((s) => !s.completed);

  return (
    <>
      <TopBar crumbs={[{ label: 'Apps', onClick: onBack }, 'Roadmap']}
        right={<Btn variant="primary" size="sm" icon={Ic.plus(14)} onClick={() => setEditing({ color: 'violet' })}>Neuer Schritt</Btn>}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '24px 32px 80px' }}>
        {steps === null ? (
          <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
        ) : list.length === 0 ? (
          <EmptyHint icon={Ic.bolt(40)} title="Noch keine Roadmap" desc="Lege Schritte mit Datum, Labels und Aufgaben an."
            actions={<Btn variant="primary" size="md" icon={Ic.plus(14)} onClick={() => setEditing({ color: 'violet' })}>Neuer Schritt</Btn>}/>
        ) : (
          <div style={{ maxWidth: 820 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 28 }}>
              {[{ l: 'Schritte', v: totalSteps, s: doneSteps + ' erledigt' }, { l: 'Aufgaben', v: doneTasks + '/' + allTasks, s: 'erledigt' }, { l: 'Fortschritt', v: overall + '%', s: doneSteps + ' von ' + totalSteps, accent: true }].map((c, i) => (
                <div key={i} style={{ padding: '14px 18px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', position: 'relative', overflow: 'hidden' }}>
                  {c.accent && <div style={{ position: 'absolute', inset: 0, background: 'var(--accent-grad)', opacity: 0.08 }}/>}
                  <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4, position: 'relative' }}>{c.l}</div>
                  <div style={{ fontSize: 22, fontFamily: 'var(--font-display)', fontWeight: 600, letterSpacing: -0.6, position: 'relative' }}>{c.v}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2, position: 'relative' }}>{c.s}</div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {list.map((s, i) => {
                const dot = folderDot(s.color);
                const active = i === activeIdx;
                return (
                  <div key={s.id} style={{
                    position: 'relative', borderRadius: 'var(--r-lg)', background: 'var(--surface)',
                    border: '1px solid ' + (active ? 'color-mix(in oklab, ' + dot + ' 50%, var(--border))' : 'var(--border)'),
                    padding: '16px 18px 16px 20px', overflow: 'hidden',
                    boxShadow: active ? '0 0 0 1px ' + dot + ', 0 8px 30px -12px ' + dot : '0 1px 0 var(--inner-hi) inset',
                    opacity: s.completed ? 0.72 : 1,
                  }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: dot }}/>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                      <button onClick={() => toggleStep(s)} title={s.completed ? 'Wieder offen' : 'Abschließen'}
                        style={{ marginTop: 1, width: 24, height: 24, borderRadius: '50%', flexShrink: 0, cursor: 'pointer',
                          border: '2px solid ' + (s.completed ? 'transparent' : dot),
                          background: s.completed ? dot : 'transparent', color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {!!s.completed && Ic.check(13)}
                      </button>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 15.5, fontWeight: 600, letterSpacing: -0.2, textDecoration: s.completed ? 'line-through' : 'none' }}>{s.title}</span>
                          {s.date && <span style={{ fontSize: 11, color: 'var(--fg-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>{Ic.clock(11)}{new Date(s.date + 'T00:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })}</span>}
                          {active && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.4, padding: '2px 7px', borderRadius: 999, background: dot, color: '#fff', textTransform: 'uppercase' }}>Aktiv</span>}
                        </div>
                        {s.labels.length > 0 && (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                            {s.labels.map((l, j) => <span key={j} style={{ fontSize: 10.5, fontWeight: 540, padding: '2px 8px', borderRadius: 999, background: 'color-mix(in oklab, ' + dot + ' 16%, transparent)', color: dot }}>{l}</span>)}
                          </div>
                        )}
                        {s.description && <div style={{ fontSize: 13, color: 'var(--fg-2)', marginTop: 8, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{s.description}</div>}

                        {s.progress.total > 0 && (
                          <div style={{ marginTop: 12 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                              <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'var(--surface-hi)', overflow: 'hidden' }}>
                                <div style={{ width: s.progress.percent + '%', height: '100%', background: dot }}/>
                              </div>
                              <span style={{ fontSize: 11, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>{s.progress.done}/{s.progress.total}</span>
                            </div>
                          </div>
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                          {s.tasks.map((t) => (
                            <div key={t.id} className="rm-task" style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                              <button onClick={() => toggleTask(s, t)} style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, cursor: 'pointer', border: '1.5px solid ' + (t.completed ? 'transparent' : 'var(--border-hi)'), background: t.completed ? dot : 'transparent', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{!!t.completed && Ic.check(11)}</button>
                              <span style={{ flex: 1, fontSize: 13, color: t.completed ? 'var(--fg-3)' : 'var(--fg)', textDecoration: t.completed ? 'line-through' : 'none' }}>{t.title}</span>
                              <span className="rm-task-del" onClick={() => delTask(s, t)} title="Löschen" style={{ cursor: 'pointer', color: 'var(--fg-4)', display: 'inline-flex' }}>{Ic.close(13)}</span>
                            </div>
                          ))}
                          {adding === s.id ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                              <input autoFocus value={addText} onChange={(e) => setAddText(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') addTask(s); if (e.key === 'Escape') { setAdding(null); setAddText(''); } }}
                                onBlur={() => addTask(s)} placeholder="Aufgabe…"
                                style={{ flex: 1, height: 32, padding: '0 10px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)', fontFamily: 'inherit' }}/>
                            </div>
                          ) : (
                            <button onClick={() => { setAdding(s.id); setAddText(''); }} style={{ alignSelf: 'flex-start', marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: 'var(--fg-3)', padding: '2px 0' }}>{Ic.plus(12)} Aufgabe</button>
                          )}
                        </div>
                      </div>
                      <span className="task-kebab" title="Mehr" onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); openContextMenu(b.right, b.bottom, [
                        { label: 'Bearbeiten', icon: Ic.fileGen(15), onClick: () => setEditing(s) },
                        { label: s.completed ? 'Wieder offen' : 'Abschließen', icon: Ic.check(15), onClick: () => toggleStep(s) },
                        { separator: true },
                        { label: 'Löschen', icon: Ic.trash(15), danger: true, onClick: () => del(s) },
                      ]); }}
                        style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}>{Ic.more(16)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {editing && <RoadmapStepModal step={editing} onSave={save} onClose={() => setEditing(null)}/>}
    </>
  );
}

function RoadmapStepModal({ step, onSave, onClose }) {
  const [title, setTitle] = useState(step.title || '');
  const [description, setDescription] = useState(step.description || '');
  const [date, setDate] = useState(step.date || '');
  const [labels, setLabels] = useState((step.labels || []).join(', '));
  const [color, setColor] = useState(step.color || 'violet');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim()) { toast('Titel erforderlich', 'error'); return; }
    setBusy(true);
    await onSave({ id: step.id, title: title.trim(), description: description.trim() || null, date: date || null, labels, color });
    setBusy(false);
  };
  const fld = { height: 42, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', width: '100%' };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 480, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.bolt(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>{step.id ? 'Schritt bearbeiten' : 'Neuer Schritt'}</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Titel</span><input value={title} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="Phase / Meilenstein" style={fld}/></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Beschreibung</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Optional" style={{ ...fld, height: 'auto', padding: '10px 12px', resize: 'vertical' }}/></div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Datum</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={fld}/></div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Labels</span><input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="Web, Design" style={fld}/></div>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)', marginBottom: 8 }}>Farbe</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {FOLDER_SWATCHES.map((sw) => (
                <button key={sw.key} title={sw.label} onClick={() => setColor(sw.key)} style={{ width: 26, height: 26, borderRadius: '50%', cursor: 'pointer', background: sw.dot, border: color === sw.key ? '2px solid var(--fg)' : '2px solid transparent', boxShadow: color === sw.key ? '0 0 0 2px var(--bg)' : 'none' }}/>
              ))}
            </div>
          </div>
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} onClick={submit} icon={busy ? Ic.loader(15) : Ic.check(15)}>Speichern</Btn>
        </div>
      </Glass>
    </div>
  );
}

// ───── Einstellungen app ────────────────────────────────────────────────────
const LEGAL_FORMS = ['Einzelunternehmen', 'GmbH', 'OG', 'KG', 'AG', 'Sonstige'];

function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const NOTIF_TYPES = [
  { k: 'calendar', label: 'Kalender-Erinnerungen', desc: 'Kurz bevor ein Termin beginnt' },
  { k: 'task_due', label: 'Aufgaben fällig', desc: 'Wenn eine Aufgabe fällig wird' },
  { k: 'invoices', label: 'Offene Rechnungen', desc: 'Überfällige Rechnungen' },
  { k: 'expenses', label: 'Offene Belege', desc: 'Unbezahlte Ausgaben' },
];

function NotificationsSection() {
  const [perm, setPerm] = useState(() => (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'));
  const [subscribed, setSubscribed] = useState(false);
  const [prefs, setPrefs] = useState(null);
  const [busy, setBusy] = useState(false);
  const supported = typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;

  useEffect(() => {
    API.getSettings('notifications').then((d) => setPrefs(d.settings || {})).catch(() => setPrefs({}));
    if (supported) navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((s) => setSubscribed(!!s)).catch(() => {});
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      const p = await Notification.requestPermission();
      setPerm(p);
      if (p !== 'granted') { toast('Benachrichtigungen nicht erlaubt', 'error'); return; }
      const reg = await navigator.serviceWorker.ready;
      const { public_key } = await API.pushKey();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(public_key) });
      const j = sub.toJSON();
      await API.pushSubscribe({ endpoint: j.endpoint, keys: j.keys });
      setSubscribed(true);
      // sensible defaults on first enable
      if (prefs && Object.keys(prefs).length === 0) { const d = { calendar: true, task_due: true, invoices: true, expenses: false }; setPrefs(d); await API.saveSettings('notifications', d); }
      toast('Benachrichtigungen aktiviert', 'success');
    } catch (e) { toast(e.message || 'Fehlgeschlagen', 'error'); } finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true);
    try { const reg = await navigator.serviceWorker.ready; const s = await reg.pushManager.getSubscription(); if (s) { await API.pushUnsubscribe(s.endpoint).catch(() => {}); await s.unsubscribe(); } setSubscribed(false); toast('Deaktiviert', 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const togglePref = async (k) => { const next = { ...prefs, [k]: !prefs[k] }; setPrefs(next); try { await API.saveSettings('notifications', next); } catch (e) { toast(e.message, 'error'); } };

  return (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '16px 18px' }}>
      {!supported ? (
        <div style={{ fontSize: 13, color: 'var(--fg-3)' }}>Dieses Gerät/dieser Browser unterstützt keine Push-Benachrichtigungen. Auf dem iPhone: Seite über „Teilen → Zum Home-Bildschirm" installieren, dann hier aktivieren (iOS 16.4+).</div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: subscribed ? 14 : 0 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Push-Benachrichtigungen</div>
              <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 2 }}>{subscribed ? 'Auf diesem Gerät aktiv' : 'Auf diesem Gerät aktivieren (auch iOS-Homescreen-App)'}</div>
            </div>
            {subscribed
              ? <div style={{ display: 'flex', gap: 8 }}><Btn variant="glass" size="sm" disabled={busy} onClick={() => API.pushTest().then(() => toast('Test gesendet', 'success')).catch((e) => toast(e.message, 'error'))}>Test</Btn><Btn variant="ghost" size="sm" disabled={busy} onClick={disable}>Aus</Btn></div>
              : <Btn variant="primary" size="sm" disabled={busy} icon={busy ? Ic.loader(14) : Ic.bolt(14)} onClick={enable}>Aktivieren</Btn>}
          </div>
          {subscribed && prefs && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {NOTIF_TYPES.map((t) => <ShareToggleRow key={t.k} icon={Ic.bolt} title={t.label} desc={t.desc} on={!!prefs[t.k]} onToggle={() => togglePref(t.k)}/>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CronSection() {
  const [token, setToken] = useState(null);
  useEffect(() => { API.adminCron().then((d) => setToken(d.token || '')).catch(() => setToken('')); }, []);
  const url = location.origin + (BASE || '') + '/api/cron?token=' + (token || 'DEIN_TOKEN');
  const cron = `*/5 * * * * curl -fsS "${url}" >/dev/null 2>&1`;
  const copy = (t) => { navigator.clipboard?.writeText(t); toast('Kopiert', 'success'); };
  const codeBox = (label, value) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <code style={{ flex: 1, fontSize: 11.5, fontFamily: 'var(--font-mono)', background: 'var(--surface-hi)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', wordBreak: 'break-all', color: 'var(--fg)' }}>{value}</code>
        <Btn variant="glass" size="sm" icon={Ic.copy(13)} onClick={() => copy(value)}>Kopieren</Btn>
      </div>
    </div>
  );
  return (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '16px 18px' }}>
      <p style={{ fontSize: 12.5, color: 'var(--fg-3)', margin: '0 0 14px' }}>
        Lege diesen Cronjob bei deinem Hosting an (alle 5 Minuten). Er prüft fällige Termine, Aufgaben, Rechnungen und Belege und sendet die Push-Benachrichtigungen.
      </p>
      {token === null ? <div style={{ color: 'var(--fg-3)' }}>{Ic.loader(18)}</div> : (
        <>
          {codeBox('Cronjob (crontab -e)', cron)}
          {codeBox('Nur die URL', url)}
          <div style={{ fontSize: 11.5, color: 'var(--fg-4)', marginTop: 4 }}>Tipp: Eigenen Token in <code>config.php</code> via <code>'cron_token' =&gt; '…'</code> setzen — dann hier sichtbar. Token geheim halten.</div>
        </>
      )}
    </div>
  );
}

function CompaniesAdminSection({ onChanged }) {
  const [list, setList] = useState(null);
  const [name, setName] = useState('');
  const [membersFor, setMembersFor] = useState(null);
  const load = () => API.companies().then((d) => setList(d.companies || [])).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  const create = async () => { if (!name.trim()) return; try { await API.createCompany(name.trim()); setName(''); load(); onChanged && onChanged(); } catch (e) { toast(e.message, 'error'); } };
  const rename = async (co) => { const n = window.prompt('Firma umbenennen', co.name); if (!n || !n.trim()) return; try { await API.renameCompany(co.id, n.trim()); load(); onChanged && onChanged(); } catch (e) { toast(e.message, 'error'); } };
  const del = async (co) => { if (!await confirmDialog({ title: 'Firma löschen?', message: `„${co.name}" wird gelöscht. Geht nur, wenn keine Buchungen mehr dran hängen.`, confirmLabel: 'Löschen', danger: true })) return; try { await API.deleteCompany(co.id); load(); onChanged && onChanged(); } catch (e) { toast(e.message, 'error'); } };
  const fld = { height: 40, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', flex: 1 };
  return (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '16px 18px' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Neue Firma (z. B. Globify GmbH)" onKeyDown={(e) => { if (e.key === 'Enter') create(); }} style={fld}/>
        <Btn variant="primary" size="md" icon={Ic.plus(14)} onClick={create}>Anlegen</Btn>
      </div>
      {list === null ? <div style={{ color: 'var(--fg-3)' }}>{Ic.loader(18)}</div> : (
        <div style={{ display: 'grid', gap: 6 }}>
          {list.map((co) => (
            <div key={co.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)' }}>
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: 540 }}>{co.name}</span>
              <Btn variant="glass" size="sm" icon={Ic.users(13)} onClick={() => setMembersFor(co)}>Mitglieder</Btn>
              <span onClick={() => rename(co)} title="Umbenennen" style={{ cursor: 'pointer', color: 'var(--fg-3)', display: 'inline-flex' }}>{Ic.fileGen(15)}</span>
              <span onClick={() => del(co)} title="Löschen" style={{ cursor: 'pointer', color: 'var(--fg-4)', display: 'inline-flex' }}>{Ic.trash(15)}</span>
            </div>
          ))}
        </div>
      )}
      {membersFor && <CompanyMembersModal company={membersFor} onClose={() => setMembersFor(null)}/>}
    </div>
  );
}

function CompanyMembersModal({ company, onClose }) {
  const [members, setMembers] = useState(null);
  const [users, setUsers] = useState([]);
  const [sel, setSel] = useState('');
  const load = () => API.companyMembers(company.id).then((d) => setMembers(d.members || [])).catch(() => setMembers([]));
  useEffect(() => { load(); API.users().then((d) => setUsers(d.users || [])).catch(() => {}); }, []);
  const add = async () => { if (!sel) return; try { await API.addCompanyMember(company.id, Number(sel)); setSel(''); load(); } catch (e) { toast(e.message, 'error'); } };
  const rm = async (uid) => { try { await API.removeCompanyMember(company.id, uid); load(); } catch (e) { toast(e.message, 'error'); } };
  const memberIds = new Set((members || []).map((m) => m.user_id));
  const avail = users.filter((u) => !memberIds.has(u.id));
  const fld = { height: 40, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', flex: 1, cursor: 'pointer' };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 420, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0 }}>Mitglieder · {company.name}</h2>
          <IconBtn size={30} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={sel} onChange={(e) => setSel(e.target.value)} style={fld}><option value="">Mitglied hinzufügen…</option>{avail.map((u) => <option key={u.id} value={String(u.id)}>{u.name || u.email}</option>)}</select>
            <Btn variant="primary" size="md" disabled={!sel} icon={Ic.plus(14)} onClick={add}>Hinzu</Btn>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {members === null ? <div style={{ color: 'var(--fg-3)', fontSize: 13 }}>{Ic.loader(16)}</div>
              : members.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>Noch keine Mitglieder.</div>
              : members.map((m) => (
                  <div key={m.user_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)' }}>
                    <span style={{ flex: 1, fontSize: 13 }}>{m.name || m.email}</span>
                    <span onClick={() => rm(m.user_id)} title="Entfernen" style={{ cursor: 'pointer', color: 'var(--fg-4)', display: 'inline-flex' }}>{Ic.close(14)}</span>
                  </div>
                ))}
          </div>
        </div>
      </Glass>
    </div>
  );
}

function UserAdminSection({ currentUser }) {
  const [users, setUsers] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = () => API.adminUsers().then((d) => setUsers(d.users || [])).catch((e) => { toast(e.message, 'error'); setUsers([]); });
  useEffect(() => { load(); }, []);
  const save = async (data) => {
    try { if (data.id) await API.adminUpdateUser(data.id, data); else await API.adminCreateUser(data); setEditing(null); load(); toast('Gespeichert', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  };
  const del = async (u) => {
    if (!await confirmDialog({ title: 'Benutzer löschen?', message: `„${u.name || u.email}" und alle seine Daten werden gelöscht.`, confirmLabel: 'Löschen', danger: true })) return;
    try { await API.adminDeleteUser(u.id); load(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <Btn variant="primary" size="sm" icon={Ic.plus(14)} onClick={() => setEditing({ role: 'user' })}>Benutzer anlegen</Btn>
      </div>
      {users === null ? <div style={{ color: 'var(--fg-3)', padding: 12 }}>{Ic.loader(20)}</div> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {users.map((u) => (
            <div key={u.id} className="nyza-listrow" onClick={() => setEditing(u)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer', opacity: u.active ? 1 : 0.55 }}>
              <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, flexShrink: 0 }}>{(u.name || u.email || '?').slice(0, 1).toUpperCase()}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 540, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.name || u.email}{u.id === currentUser?.id ? ' (du)' : ''}</div>
                <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{u.email}</div>
              </div>
              {u.role === 'admin' && <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'color-mix(in oklab, var(--accent) 18%, transparent)', color: 'var(--accent)' }}>ADMIN</span>}
              {!u.active && <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--fg-4)' }}>GESPERRT</span>}
              {u.id !== currentUser?.id && <span className="task-kebab" title="Löschen" onClick={(e) => { e.stopPropagation(); del(u); }} style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex' }}>{Ic.trash(15)}</span>}
            </div>
          ))}
        </div>
      )}
      {editing && <UserModal u={editing} self={editing.id === currentUser?.id} onSave={save} onClose={() => setEditing(null)}/>}
    </div>
  );
}

function UserModal({ u, self, onSave, onClose }) {
  const [name, setName] = useState(u.name || '');
  const [email, setEmail] = useState(u.email || '');
  const [role, setRole] = useState(u.role || 'user');
  const [active, setActive] = useState(u.active != null ? !!u.active : true);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!email.trim()) { toast('E-Mail erforderlich', 'error'); return; }
    if (!u.id && password.length < 8) { toast('Passwort min. 8 Zeichen', 'error'); return; }
    if (password && password.length < 8) { toast('Passwort min. 8 Zeichen', 'error'); return; }
    setBusy(true);
    const body = { id: u.id, name: name.trim() || null, role, active: active ? 1 : 0 };
    if (!u.id) body.email = email.trim();
    if (password) body.password = password;
    await onSave(body);
    setBusy(false);
  };
  const fld = { height: 42, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', width: '100%' };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 420, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0 }}>{u.id ? 'Benutzer bearbeiten' : 'Neuer Benutzer'}</h2>
          <IconBtn size={30} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Voller Name" style={fld}/></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>E-Mail {u.id && <span style={{ color: 'var(--fg-4)' }}>(nicht änderbar)</span>}</span><input type="email" value={email} disabled={!!u.id} onChange={(e) => setEmail(e.target.value)} placeholder="name@firma.at" style={{ ...fld, opacity: u.id ? 0.6 : 1 }}/></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>{u.id ? 'Neues Passwort (optional)' : 'Passwort'}</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={u.id ? 'leer = unverändert' : 'min. 8 Zeichen'} style={fld}/></label>
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Rolle</span>
              <select value={role} onChange={(e) => setRole(e.target.value)} disabled={self} style={{ ...fld, cursor: self ? 'not-allowed' : 'pointer', opacity: self ? 0.6 : 1 }}><option value="user">Benutzer</option><option value="admin">Admin</option></select>
            </label>
            <label style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, marginTop: 22, cursor: self ? 'not-allowed' : 'pointer', fontSize: 13.5, opacity: self ? 0.6 : 1 }}>
              <input type="checkbox" checked={active} disabled={self} onChange={(e) => setActive(e.target.checked)} style={{ width: 17, height: 17, accentColor: 'var(--accent)' }}/> Aktiv
            </label>
          </div>
          {self && <div style={{ fontSize: 11.5, color: 'var(--fg-4)' }}>Eigene Rolle/Sperre kann nicht geändert werden.</div>}
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} onClick={submit} icon={busy ? Ic.loader(15) : Ic.check(15)}>Speichern</Btn>
        </div>
      </Glass>
    </div>
  );
}

function SettingsApp({ user, onBack, onProfile, onSecurity }) {
  const [c, setC] = useState(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === 'admin';
  const [companies, setCompanies] = useState([]);
  const [profileCompany, setProfileCompany] = useState(() => getCompany());

  useEffect(() => {
    API.companies().then((d) => { setCompanies(d.companies || []); if (!profileCompany && d.active) setProfileCompany(String(d.active)); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!profileCompany) { setC({}); return; }
    setC(null);
    API.companyProfile(profileCompany).then((d) => setC(d.profile || {})).catch(() => setC({}));
  }, [profileCompany]);
  const set = (k, v) => setC((s) => ({ ...s, [k]: v }));
  const accountingMode = (c?.legal_form === 'GmbH' || c?.legal_form === 'AG') ? 'double_entry' : 'single_entry';

  const save = async () => {
    if (!profileCompany) { toast('Keine Firma gewählt', 'error'); return; }
    setBusy(true);
    try { await API.saveCompanyProfile(profileCompany, { ...c, accounting_mode: accountingMode }); toast('Gespeichert', 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  const fld = { height: 42, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', width: '100%' };
  // Plain render helpers (NOT components) so inputs keep focus across keystrokes.
  const field = (label, k, opts = {}) => (
    <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>{label}</span>
      {opts.area
        ? <textarea value={c[k] || ''} onChange={(e) => set(k, e.target.value)} placeholder={opts.ph} rows={2} style={{ ...fld, height: 'auto', padding: '10px 12px', resize: 'vertical' }}/>
        : <input type={opts.type || 'text'} value={c[k] || ''} onChange={(e) => set(k, e.target.value)} placeholder={opts.ph} style={fld}/>}
    </label>
  );
  const row = (...kids) => <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>{kids}</div>;
  const card = (title, kids) => (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '18px 20px', marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 14 }}>{title}</div>
      {kids}
    </div>
  );

  return (
    <>
      <TopBar crumbs={[{ label: 'Apps', onClick: onBack }, 'Einstellungen']}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '24px 32px 80px' }}>
        <div style={{ maxWidth: 760 }}>
          {/* Konto */}
          <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>Konto</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 28 }}>
            {[{ label: 'Profil & Branding', desc: 'Name, Logo, Akzentfarbe, Speicher, Vorlagen', icon: Ic.cog(18), onClick: onProfile },
              { label: 'Sicherheit & 2FA', desc: 'Passwort & Zwei-Faktor', icon: Ic.lock(18), onClick: onSecurity }].map((it) => (
              <button key={it.label} onClick={it.onClick} style={{ textAlign: 'left', display: 'flex', gap: 12, alignItems: 'flex-start', padding: '14px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer', fontFamily: 'inherit' }}>
                <div style={{ width: 34, height: 34, borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{it.icon}</div>
                <div><div style={{ fontSize: 13.5, fontWeight: 540 }}>{it.label}</div><div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2 }}>{it.desc}</div></div>
              </button>
            ))}
          </div>

          <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>Benachrichtigungen</div>
          <div style={{ marginBottom: 28 }}><NotificationsSection/></div>

          {isAdmin && (<>
            <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>Benutzerverwaltung · Admin</div>
            <div style={{ marginBottom: 28 }}><UserAdminSection currentUser={user}/></div>
            <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>Firmen (Mandanten) · Admin</div>
            <div style={{ marginBottom: 28 }}><CompaniesAdminSection onChanged={() => API.companies().then((d) => setCompanies(d.companies || [])).catch(() => {})}/></div>
            <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>Cron-Jobs · Admin</div>
            <div style={{ marginBottom: 28 }}><CronSection/></div>
          </>)}

          {/* Firma & Rechnungen */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' }}>Buchhaltung · Firmenprofil</span>
            {companies.length > 1 && (
              <select value={profileCompany} onChange={(e) => setProfileCompany(e.target.value)} style={{ height: 28, padding: '0 8px', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--fg)', fontFamily: 'inherit', cursor: 'pointer' }}>
                {companies.map((co) => <option key={co.id} value={String(co.id)}>{co.name}</option>)}
              </select>
            )}
          </div>

          {c === null ? <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div> : (
            <>
              {card('Unternehmen', <>
                {row(
                  <label key="lf" style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 160 }}>
                    <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Rechtsform</span>
                    <select value={c.legal_form || 'Einzelunternehmen'} onChange={(e) => set('legal_form', e.target.value)} style={{ ...fld, cursor: 'pointer' }}>
                      {LEGAL_FORMS.map((lf) => <option key={lf} value={lf}>{lf}</option>)}
                    </select>
                  </label>,
                  field('Geschäftsjahr-Beginn', 'fiscal_year_start', { ph: '01-01' })
                )}
                <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginBottom: 12, marginTop: -4 }}>
                  Buchhaltungsmodus: <strong style={{ color: 'var(--fg-2)' }}>{accountingMode === 'double_entry' ? 'Doppelte Buchhaltung (EKR07)' : 'Einnahmen-Ausgaben-Rechnung'}</strong> — automatisch aus der Rechtsform.
                </div>
                {row(field('Firmenname (rechtlich)', 'legal_name', { ph: 'Globify GmbH' }), field('Markenname', 'brand_name', { ph: 'Nyza' }))}
                {row(field('Inhaber / Geschäftsführer', 'owner', { ph: 'Vor- und Nachname' }))}
                {row(field('UID / USt-IdNr.', 'uid', { ph: 'ATU…' }), field('Steuernummer', 'tax_number', {}), field('Firmenbuchnr.', 'firmenbuch_nr', { ph: 'FN …' }))}
              </>)}

              {card('Adresse & Kontakt', <>
                {row(field('Straße', 'street', { ph: 'Straße 1' }))}
                {row(field('PLZ', 'zip', { ph: '1010' }), field('Ort', 'city', { ph: 'Wien' }), field('Land', 'country', { ph: 'Österreich' }))}
                {row(field('E-Mail', 'email', { type: 'email', ph: 'office@…' }), field('Telefon', 'phone', { ph: '+43 …' }), field('Website', 'website', { ph: 'www…' }))}
              </>)}

              {card('Bankverbindung', <>
                {row(field('Bank', 'bank_name', { ph: 'Bankname' }), field('Kontoinhaber', 'account_holder', {}))}
                {row(field('IBAN', 'iban', { ph: 'AT…' }), field('BIC', 'bic', {}))}
              </>)}

              {card('Rechnungen & Angebote', <>
                {row(field('Zahlungsziel (Tage)', 'payment_term_days', { type: 'number', ph: '14' }), field('Unterschrift / Name', 'signature_name', { ph: 'z. B. Geschäftsführer' }))}
                {row(field('Einleitung Angebot', 'offer_intro', { ph: 'Sehr geehrte…', area: true }), field('Einleitung Rechnung', 'invoice_intro', { ph: 'Sehr geehrte…', area: true }))}
                {row(field('Fußtext Angebot', 'offer_footer', { ph: 'Gültigkeitshinweis', area: true }), field('Fußtext Rechnung', 'invoice_footer', { ph: 'Zahlungshinweis', area: true }))}
                {row(field('Grußformel', 'closing', { ph: 'Mit freundlichen Grüßen', area: true }))}
              </>)}

              {card('Mahnwesen', <>
                {row(field('Gebühr 1. Mahnung (€)', 'reminder_fee_1', { type: 'number', ph: '0' }), field('Gebühr 2. Mahnung (€)', 'reminder_fee_2', { type: 'number', ph: '10' }), field('Gebühr 3. Mahnung (€)', 'reminder_fee_3', { type: 'number', ph: '20' }))}
              </>)}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, position: 'sticky', bottom: 0, padding: '12px 0', background: 'linear-gradient(transparent, var(--bg) 40%)' }}>
                <Btn variant="primary" disabled={busy} onClick={save} icon={busy ? Ic.loader(15) : Ic.check(15)}>Speichern</Btn>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ───── Buchhaltung app (Phase 1: Angebote/Rechnungen + Produkte) ─────────────
const DOC_STATUS = {
  paid:     { label: 'Bezahlt',     color: '#22c55e' },
  overdue:  { label: 'Überfällig',  color: '#ef4444' },
  due_soon: { label: 'Bald fällig', color: '#eab308' },
  open:     { label: 'Offen',       color: 'var(--fg-3)' },
  upcoming: { label: 'Geplant',     color: 'var(--fg-3)' },
  accepted: { label: 'Angenommen',  color: '#22c55e' },
};
function fmtEUR(n) { return (Number(n) || 0).toLocaleString('de-AT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
function fmtDateShort(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'; }

function BuchhaltungApp({ onBack, onOpenSettings }) {
  const [tab, setTab] = useState('invoice');
  const [docs, setDocs] = useState(null);
  const [subs, setSubs] = useState(null);
  const [products, setProducts] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [exps, setExps] = useState(null);
  const [rep, setRep] = useState(null);
  const [repYear, setRepYear] = useState(() => new Date().getFullYear());
  const [repPeriod, setRepPeriod] = useState('year');
  const [importOpen, setImportOpen] = useState(false);
  const [doubleEntry, setDoubleEntry] = useState(false);
  const [editing, setEditing] = useState(null);
  const [prodEditing, setProdEditing] = useState(null);
  const [subEditing, setSubEditing] = useState(null);
  const [expEditing, setExpEditing] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [activeCompany, setActiveCompany] = useState(() => getCompany());

  const load = useCallback(() => {
    if (tab === 'products') { API.products().then((d) => setProducts(d.products || [])).catch(() => setProducts([])); return; }
    if (tab === 'subscriptions') { setSubs(null); API.subscriptions().then((d) => setSubs(d.subscriptions || [])).catch(() => setSubs([])); return; }
    if (tab === 'expenses') { setExps(null); API.expenses().then((d) => setExps(d.expenses || [])).catch(() => setExps([])); return; }
    if (tab === 'reports') { setRep(null); API.report(repYear, periodOpts(repPeriod)).then((d) => setRep(d)).catch(() => setRep(null)); return; }
    setDocs(null);
    API.documents(tab).then((d) => setDocs(d.documents || [])).catch(() => setDocs([]));
  }, [tab, repYear, repPeriod, activeCompany]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    API.companies().then((d) => { setCompanies(d.companies || []); const a = getCompany() || (d.active ? String(d.active) : ''); if (a) { setCompany(a); setActiveCompany((prev) => prev !== a ? a : prev); } }).catch(() => {});
  }, []);
  useEffect(() => {
    API.contacts({}).then((d) => setContacts(d.contacts || [])).catch(() => {});
    API.products().then((d) => setProducts(d.products || [])).catch(() => {});
    if (activeCompany) API.companyProfile(activeCompany).then((d) => { const p = d.profile || {}; setDoubleEntry(p.accounting_mode === 'double_entry' || p.legal_form === 'GmbH' || p.legal_form === 'AG'); }).catch(() => {});
  }, [activeCompany]);
  const switchCompany = (id) => { setCompany(id); setActiveCompany(id); };

  const openDoc = async (id) => { try { const d = await API.document(id); setEditing(d.document); } catch (e) { toast(e.message, 'error'); } };
  const saveDoc = async (data) => { try { let r; if (data.id) r = await API.updateDocument(data.id, data); else r = await API.newDocument(data); setEditing(null); load(); return r; } catch (e) { toast(e.message, 'error'); } };
  const delDoc = async (doc) => { if (!await confirmDialog({ title: 'Löschen?', message: `${doc.number} wird gelöscht.`, confirmLabel: 'Löschen', danger: true })) return; try { await API.deleteDocument(doc.id); load(); } catch (e) { toast(e.message, 'error'); } };
  const togglePaid = async (doc) => { try { if (doc.paid_at) await API.unmarkDocPaid(doc.id); else await API.markDocPaid(doc.id); load(); } catch (e) { toast(e.message, 'error'); } };
  const convert = async (doc) => { try { const d = await API.convertDoc(doc.id); toast('Rechnung ' + (d.document?.number || '') + ' erstellt', 'success'); setTab('invoice'); } catch (e) { toast(e.message, 'error'); } };
  const createReminder = async (doc) => { try { const r = await API.createReminder(doc.id); toast(r.stage + '. Mahnung erstellt', 'success'); load(); if (r.reminder && r.reminder.id) window.open(API.reminderPdfUrl(r.reminder.id, false), '_blank'); } catch (e) { toast(e.message, 'error'); } };
  const lastReminderPdf = async (doc) => { try { const d = await API.documentReminders(doc.id); const last = (d.reminders || []).slice(-1)[0]; if (last) window.open(API.reminderPdfUrl(last.id, false), '_blank'); } catch (e) { toast(e.message, 'error'); } };
  const removeLastReminder = async (doc) => { try { const d = await API.documentReminders(doc.id); const last = (d.reminders || []).slice(-1)[0]; if (last) { await API.deleteReminder(last.id); toast('Mahnung entfernt', 'success'); load(); } } catch (e) { toast(e.message, 'error'); } };
  const archiveDoc = async (doc) => { try { await API.archiveDocument(doc.id); toast('PDF im DMS archiviert', 'success'); load(); } catch (e) { toast(e.message, 'error'); } };
  const delProduct = async (p) => { if (!await confirmDialog({ title: 'Produkt löschen?', message: `„${p.name}" wird gelöscht.`, confirmLabel: 'Löschen', danger: true })) return; try { await API.deleteProduct(p.id); API.products().then((d) => setProducts(d.products || [])); } catch (e) { toast(e.message, 'error'); } };
  const saveProduct = async (data) => { try { if (data.id) await API.updateProduct(data.id, data); else await API.newProduct(data); setProdEditing(null); API.products().then((d) => setProducts(d.products || [])); } catch (e) { toast(e.message, 'error'); } };
  const saveSub = async (data) => { try { if (data.id) await API.updateSubscription(data.id, data); else await API.newSubscription(data); setSubEditing(null); load(); } catch (e) { toast(e.message, 'error'); } };
  const delSub = async (s) => { if (!await confirmDialog({ title: 'Abo löschen?', message: `„${s.name}" inkl. Perioden wird gelöscht.`, confirmLabel: 'Löschen', danger: true })) return; try { await API.deleteSubscription(s.id); load(); } catch (e) { toast(e.message, 'error'); } };
  const toggleActive = async (s) => { try { await API.updateSubscription(s.id, { active: s.active ? 0 : 1 }); load(); } catch (e) { toast(e.message, 'error'); } };
  const payPeriod = async (s) => { if (!s.current_period) return; try { await API.periodMarkPaid(s.current_period.id); toast('Periode bezahlt', 'success'); load(); } catch (e) { toast(e.message, 'error'); } };
  const invoicePeriod = async (s) => { if (!s.current_period) return; try { const r = await API.periodInvoice(s.current_period.id); toast('Rechnung erstellt', 'success'); load(); if (r.invoice_id) window.open(API.docPdfUrl(r.invoice_id, false), '_blank'); } catch (e) { toast(e.message, 'error'); } };
  const saveExp = async (data) => { try { if (data.id) await API.updateExpense(data.id, data); else await API.newExpense(data); setExpEditing(null); load(); } catch (e) { toast(e.message, 'error'); } };
  const delExp = async (x) => { if (!await confirmDialog({ title: 'Ausgabe löschen?', message: `${x.vendor || x.category} wird gelöscht.`, confirmLabel: 'Löschen', danger: true })) return; try { await API.deleteExpense(x.id); load(); } catch (e) { toast(e.message, 'error'); } };
  const toggleExpPaid = async (x) => { try { if (x.paid_at) await API.expenseUnmarkPaid(x.id); else await API.expenseMarkPaid(x.id); load(); } catch (e) { toast(e.message, 'error'); } };

  const tabs = [{ id: 'invoice', label: 'Rechnungen' }, { id: 'offer', label: 'Angebote' }, { id: 'subscriptions', label: 'Abos' }, { id: 'expenses', label: 'Ausgaben' }, { id: 'reports', label: 'Auswertung' }, ...(doubleEntry ? [{ id: 'ledger', label: 'Doppik' }] : []), { id: 'products', label: 'Produkte' }];
  const newBtn = tab === 'products' ? <Btn variant="primary" size="sm" icon={Ic.plus(14)} onClick={() => setProdEditing({})}>Produkt</Btn>
    : tab === 'subscriptions' ? <Btn variant="primary" size="sm" icon={Ic.plus(14)} onClick={() => setSubEditing({ interval_unit: 'monthly', tax_rate: 20, active: 1 })}>Neues Abo</Btn>
    : tab === 'expenses' ? <Btn variant="primary" size="sm" icon={Ic.plus(14)} onClick={() => setExpEditing({ category: 'Sonstiges', tax_rate: 20, deductible: 1 })}>Neue Ausgabe</Btn>
    : tab === 'reports' ? <div style={{ display: 'flex', gap: 8 }}><Btn variant="glass" size="sm" icon={Ic.fileGen(14)} onClick={() => setImportOpen(true)}>CSV-Import</Btn><Btn variant="glass" size="sm" icon={Ic.download(14)} onClick={() => { window.location.href = API.datevUrl(repYear, periodOpts(repPeriod)); }}>DATEV-CSV</Btn></div>
    : <Btn variant="primary" size="sm" icon={Ic.plus(14)} onClick={() => setEditing({ type: tab })}>{tab === 'offer' ? 'Neues Angebot' : 'Neue Rechnung'}</Btn>;

  return (
    <>
      <TopBar crumbs={[{ label: 'Apps', onClick: onBack }, 'Buchhaltung']} right={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {companies.length > 1 && (
          <select value={activeCompany} onChange={(e) => switchCompany(e.target.value)} title="Firma" style={{ height: 32, padding: '0 10px', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 12.5, color: 'var(--fg)', fontFamily: 'inherit', cursor: 'pointer', maxWidth: 180 }}>
            {companies.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
          </select>
        )}
        {newBtn}
      </div>}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '24px 32px 80px' }}>
        <div className="no-scrollbar" style={{ overflowX: 'auto', marginBottom: 22, maxWidth: '100%', WebkitOverflowScrolling: 'touch' }}>
          <div style={{ display: 'inline-flex', gap: 4, padding: 4, width: 'max-content', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
            {tabs.map((t) => {
              const on = tab === t.id;
              return <button key={t.id} onClick={() => setTab(t.id)} style={{ height: 34, padding: '0 16px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 540, whiteSpace: 'nowrap', background: on ? 'var(--accent-grad)' : 'transparent', color: on ? '#fff' : 'var(--fg-2)', boxShadow: on ? '0 4px 12px -4px var(--accent-glow)' : 'none' }}>{t.label}</button>;
            })}
          </div>
        </div>

        {tab === 'products' ? (
          products.length === 0 ? (
            <EmptyHint icon={Ic.archive(40)} title="Keine Produkte" desc="Lege wiederverwendbare Leistungen mit Preis & USt-Satz an."
              actions={<Btn variant="primary" size="md" icon={Ic.plus(14)} onClick={() => setProdEditing({})}>Produkt</Btn>}/>
          ) : (
            <div style={{ display: 'grid', gap: 8, maxWidth: 760 }}>
              {products.map((p) => (
                <div key={p.id} className="nyza-listrow" onClick={() => setProdEditing(p)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 540 }}>{p.name}</div>
                    {p.description && <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.description}</div>}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{fmtEUR(p.unit_price_net)}<span style={{ fontSize: 11, color: 'var(--fg-3)', fontWeight: 400 }}> /{p.unit} · {p.tax_rate}%</span></div>
                  <span className="task-kebab" onClick={(e) => { e.stopPropagation(); delProduct(p); }} title="Löschen" style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex' }}>{Ic.trash(15)}</span>
                </div>
              ))}
            </div>
          )
        ) : tab === 'reports' ? (
          <AuswertungView data={rep} year={repYear} onYear={(dy) => setRepYear((y) => y + dy)} period={repPeriod} onPeriod={setRepPeriod}/>
        ) : tab === 'ledger' ? (
          <DoppikView/>
        ) : tab === 'expenses' ? (
          exps === null ? (
            <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
          ) : exps.length === 0 ? (
            <EmptyHint icon={Ic.archive(40)} title="Keine Ausgaben" desc="Erfasse Kosten mit USt/Vorsteuer und hänge optional einen Beleg an."
              actions={<Btn variant="primary" size="md" icon={Ic.plus(14)} onClick={() => setExpEditing({ category: 'Sonstiges', tax_rate: 20, deductible: 1 })}>Neue Ausgabe</Btn>}/>
          ) : (
            <div style={{ display: 'grid', gap: 8, maxWidth: 860 }}>
              {exps.map((x) => (
                <div key={x.id} className="nyza-listrow" onClick={() => setExpEditing(x)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer' }}>
                  <div style={{ fontSize: 12, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums', width: 78, flexShrink: 0 }}>{fmtDateShort(x.exp_date)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.vendor || x.description || x.category}</span>
                      {x.has_receipt && <span title="Beleg vorhanden" style={{ color: 'var(--fg-3)', display: 'inline-flex' }}>{Ic.paperclip ? Ic.paperclip(13) : Ic.fileGen(13)}</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2 }}>{x.category}{x.contact_name ? ' · ' + x.contact_name : ''}{!x.deductible ? ' · keine Vorsteuer' : ''}</div>
                  </div>
                  <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: '3px 8px', borderRadius: 999, background: x.paid_at ? 'color-mix(in oklab, #22c55e 18%, transparent)' : 'var(--surface-hi)', color: x.paid_at ? '#22c55e' : 'var(--fg-3)', textTransform: 'uppercase', flexShrink: 0 }}>{x.paid_at ? 'Bezahlt' : 'Offen'}</span>
                  <div style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', width: 110, textAlign: 'right', flexShrink: 0 }}>{fmtEUR(x.gross)}</div>
                  <span className="task-kebab" title="Mehr" onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); openContextMenu(b.right, b.bottom, [
                    ...(x.has_receipt ? [{ label: 'Beleg ansehen', icon: Ic.eye(15), onClick: () => window.open(API.expenseReceiptUrl(x.id, false), '_blank') }] : []),
                    { label: x.paid_at ? 'Als offen markieren' : 'Als bezahlt markieren', icon: Ic.check(15), onClick: () => toggleExpPaid(x) },
                    { label: 'Bearbeiten', icon: Ic.fileGen(15), onClick: () => setExpEditing(x) },
                    { separator: true },
                    { label: 'Löschen', icon: Ic.trash(15), danger: true, onClick: () => delExp(x) },
                  ]); }}
                    style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}>{Ic.more(16)}</span>
                </div>
              ))}
            </div>
          )
        ) : tab === 'subscriptions' ? (
          subs === null ? (
            <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
          ) : subs.length === 0 ? (
            <EmptyHint icon={Ic.copy(40)} title="Keine Abos" desc="Lege wiederkehrende Leistungen an — das System erzeugt automatisch fällige Perioden."
              actions={<Btn variant="primary" size="md" icon={Ic.plus(14)} onClick={() => setSubEditing({ interval_unit: 'monthly', tax_rate: 20, active: 1 })}>Neues Abo</Btn>}/>
          ) : (
            <div style={{ display: 'grid', gap: 8, maxWidth: 860 }}>
              {subs.map((s) => {
                const iv = SUB_INTERVALS[s.interval_unit] || s.interval_unit;
                const cp = s.current_period;
                const pst = cp ? (DOC_STATUS[cp.status] || { label: cp.status, color: 'var(--fg-3)' }) : null;
                return (
                  <div key={s.id} className="nyza-listrow" onClick={() => setSubEditing(s)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer', opacity: s.active ? 1 : 0.55 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 540, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                        <span style={{ fontSize: 9.5, fontWeight: 600, padding: '2px 7px', borderRadius: 999, background: 'var(--surface-hi)', color: 'var(--fg-3)' }}>{iv}</span>
                        {!s.active && <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--fg-4)', textTransform: 'uppercase' }}>pausiert</span>}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2 }}>
                        {s.contact_name || 'Ohne Kunde'}{cp ? ` · nächste Periode ${fmtDateShort(cp.due_date)}` : ''}
                      </div>
                    </div>
                    {pst && <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: '3px 8px', borderRadius: 999, background: 'color-mix(in oklab, ' + pst.color + ' 18%, transparent)', color: pst.color, textTransform: 'uppercase', flexShrink: 0 }}>{pst.label}</span>}
                    <div style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', width: 120, textAlign: 'right', flexShrink: 0 }}>{fmtEUR(s.gross_price)}<span style={{ fontSize: 10.5, color: 'var(--fg-3)', fontWeight: 400 }}> brutto</span></div>
                    <span className="task-kebab" title="Mehr" onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); openContextMenu(b.right, b.bottom, [
                      ...(cp ? [{ label: 'Periode als bezahlt', icon: Ic.check(15), onClick: () => payPeriod(s) }, { label: 'Rechnung erstellen', icon: Ic.fileGen(15), onClick: () => invoicePeriod(s) }] : []),
                      { label: 'Bearbeiten', icon: Ic.fileGen(15), onClick: () => setSubEditing(s) },
                      { label: s.active ? 'Pausieren' : 'Aktivieren', icon: Ic.clock(15), onClick: () => toggleActive(s) },
                      { separator: true },
                      { label: 'Löschen', icon: Ic.trash(15), danger: true, onClick: () => delSub(s) },
                    ]); }}
                      style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}>{Ic.more(16)}</span>
                  </div>
                );
              })}
            </div>
          )
        ) : docs === null ? (
          <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div>
        ) : docs.length === 0 ? (
          <EmptyHint icon={Ic.fileGen(40)} title={tab === 'offer' ? 'Keine Angebote' : 'Keine Rechnungen'} desc="Erstelle dein erstes Dokument. Tipp: Firmenprofil in den Einstellungen ausfüllen."
            actions={<><Btn variant="primary" size="md" icon={Ic.plus(14)} onClick={() => setEditing({ type: tab })}>{tab === 'offer' ? 'Neues Angebot' : 'Neue Rechnung'}</Btn><Btn variant="glass" size="md" icon={Ic.cog(14)} onClick={onOpenSettings}>Firmenprofil</Btn></>}/>
        ) : (
          <div style={{ display: 'grid', gap: 8, maxWidth: 860 }}>
            {docs.map((d) => {
              const st = DOC_STATUS[d.payment_status] || DOC_STATUS.open;
              return (
                <div key={d.id} className="nyza-listrow" onClick={() => openDoc(d.id)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', width: 92, flexShrink: 0 }}>{d.number}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.contact_name || d.client_snapshot?.name || 'Ohne Kunde'}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2 }}>{fmtDateShort(d.doc_date)}</div>
                  </div>
                  <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: '3px 8px', borderRadius: 999, background: 'color-mix(in oklab, ' + st.color + ' 18%, transparent)', color: st.color, textTransform: 'uppercase', flexShrink: 0 }}>{st.label}</span>
                  {d.reminder_stage > 0 && <span title="Mahnstufe" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: '3px 8px', borderRadius: 999, background: 'color-mix(in oklab, #ef4444 18%, transparent)', color: '#ef4444', flexShrink: 0 }}>{d.reminder_stage}. MAHN.</span>}
                  <div style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', width: 110, textAlign: 'right', flexShrink: 0 }}>{fmtEUR(d.gross)}</div>
                  {d.archived_file_id ? <span title="Im DMS archiviert" style={{ color: '#22c55e', display: 'inline-flex', flexShrink: 0 }}>{Ic.archive(15)}</span> : null}
                  <span title="PDF öffnen" onClick={(e) => { e.stopPropagation(); window.open(API.docPdfUrl(d.id, false), '_blank'); }} style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}>{Ic.eye(16)}</span>
                  <span title="PDF herunterladen" onClick={(e) => { e.stopPropagation(); window.location.href = API.docPdfUrl(d.id, true); }} style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}>{Ic.download(16)}</span>
                  <span className="task-kebab" title="Mehr" onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); openContextMenu(b.right, b.bottom, [
                    { label: 'PDF öffnen', icon: Ic.eye(15), onClick: () => window.open(API.docPdfUrl(d.id, false), '_blank') },
                    { label: 'PDF herunterladen', icon: Ic.download(15), onClick: () => { window.location.href = API.docPdfUrl(d.id, true); } },
                    { label: d.archived_file_id ? 'Erneut im DMS archivieren' : 'Im DMS archivieren', icon: Ic.archive(15), onClick: () => archiveDoc(d) },
                    { label: 'Bearbeiten', icon: Ic.fileGen(15), onClick: () => openDoc(d.id) },
                    ...(d.type === 'invoice' ? [{ label: d.paid_at ? 'Als offen markieren' : 'Als bezahlt markieren', icon: Ic.check(15), onClick: () => togglePaid(d) }] : []),
                    ...(d.type === 'invoice' && !d.paid_at && (d.reminder_stage || 0) < 3 ? [{ label: (d.reminder_stage || 0) + 1 + '. Mahnung erstellen', icon: Ic.clock(15), onClick: () => createReminder(d) }] : []),
                    ...(d.type === 'invoice' && (d.reminder_stage || 0) > 0 ? [{ label: 'Letzte Mahnung (PDF)', icon: Ic.eye(15), onClick: () => lastReminderPdf(d) }, { label: 'Mahnung zurücksetzen', icon: Ic.rotate(15), onClick: () => removeLastReminder(d) }] : []),
                    ...(d.type === 'offer' ? [{ label: 'In Rechnung umwandeln', icon: Ic.copy(15), onClick: () => convert(d) }] : []),
                    { separator: true },
                    { label: 'Löschen', icon: Ic.trash(15), danger: true, onClick: () => delDoc(d) },
                  ]); }}
                    style={{ color: 'var(--fg-3)', cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}>{Ic.more(16)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editing && <DocumentEditor doc={editing} contacts={contacts} products={products} onSave={saveDoc} onClose={() => setEditing(null)}
        onOpenPdf={(id) => window.open(API.docPdfUrl(id, false), '_blank')}/>}
      {prodEditing && <ProductModal product={prodEditing} onSave={saveProduct} onClose={() => setProdEditing(null)}/>}
      {subEditing && <SubscriptionModal sub={subEditing} contacts={contacts} onSave={saveSub} onClose={() => setSubEditing(null)}/>}
      {expEditing && <ExpenseModal exp={expEditing} contacts={contacts} onSave={saveExp} onClose={() => setExpEditing(null)} onChanged={load}/>}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); load(); }}/>}
    </>
  );
}

function parseNum(s) {
  if (s == null) return 0;
  let t = String(s).trim().replace(/[^\d.,\-]/g, '');
  if (t === '' || t === '-') return 0;
  const hasC = t.includes(','), hasD = t.includes('.');
  if (hasC && hasD) { if (t.lastIndexOf(',') > t.lastIndexOf('.')) t = t.replace(/\./g, '').replace(',', '.'); else t = t.replace(/,/g, ''); }
  else if (hasC) t = t.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}

function ImportModal({ onClose, onDone }) {
  const [step, setStep] = useState('file');
  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]);
  const [map, setMap] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const guess = (cols) => {
    const find = (...keys) => { for (let i = 0; i < cols.length; i++) { const h = cols[i].toLowerCase(); if (keys.some((k) => h.includes(k))) return String(i); } return ''; };
    const amtGross = find('brutto', 'gross', 'gesamt', 'summe', 'total');
    const amtNet = find('netto', 'net ');
    const kindCol = find('typ', 'art', 'type');
    return {
      kind: kindCol ? 'column' : 'expense', kindCol, incomeMatch: 'einnahme',
      date: find('datum', 'date'),
      amount: amtGross || amtNet || find('betrag', 'amount'),
      amountMode: amtNet && !amtGross ? 'net' : 'gross',
      rateCol: find('ust', 'mwst', 'steuer', 'satz', 'vat', '%'),
      rateDefault: 20,
      desc: find('beschreibung', 'text', 'bezeichnung', 'description', 'verwendung', 'zweck'),
      category: find('kategorie', 'category', 'konto'),
      categoryDefault: 'Import',
      partner: find('partner', 'kunde', 'lieferant', 'name', 'firma', 'empf'),
      number: find('belegnummer', 'rechnungsnummer', 'nummer', 'beleg', 'nr'),
    };
  };

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setBusy(true);
    try { const d = await API.importParse(file); setColumns(d.columns || []); setRows(d.rows || []); setMap(guess(d.columns || [])); setStep('map'); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); e.target.value = ''; }
  };

  const col = (i, row) => (i === '' || i == null) ? '' : (row[Number(i)] ?? '');
  const buildRecord = (row) => {
    let kind = 'expense';
    if (map.kind === 'income') kind = 'income';
    else if (map.kind === 'expense') kind = 'expense';
    else if (map.kind === 'column') { const v = col(map.kindCol, row).toLowerCase(); kind = (map.incomeMatch && v.includes(map.incomeMatch.toLowerCase())) ? 'income' : 'expense'; }
    const amount = parseNum(col(map.amount, row));
    const rate = map.rateCol !== '' ? parseNum(col(map.rateCol, row)) : Number(map.rateDefault) || 0;
    let net, gross;
    if (map.amountMode === 'net') { net = amount; gross = Math.round(net * (1 + rate / 100) * 100) / 100; }
    else { gross = amount; net = rate > 0 ? Math.round(gross / (1 + rate / 100) * 100) / 100 : gross; }
    return {
      kind, date: col(map.date, row),
      net, tax_rate: rate, gross,
      partner: col(map.partner, row) || null,
      description: col(map.desc, row) || null,
      category: col(map.category, row) || map.categoryDefault || 'Import',
      number: col(map.number, row) || null,
    };
  };

  const records = map ? rows.map(buildRecord) : [];
  const valid = records.filter((r) => r.gross > 0 || r.net > 0);
  const incomeN = valid.filter((r) => r.kind === 'income').length;
  const expenseN = valid.length - incomeN;

  const doImport = async () => {
    if (!valid.length) { toast('Keine gültigen Zeilen', 'error'); return; }
    setBusy(true);
    try { const r = await API.importCommit(valid); toast(`${r.imported} importiert (${r.income} Einnahmen, ${r.expense} Ausgaben)`, 'success'); onDone(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };

  const sel = { height: 38, padding: '0 10px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)', fontFamily: 'inherit', cursor: 'pointer', width: '100%' };
  const colSelect = (key, label, opt = {}) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: opt.flex || 1, minWidth: opt.min || 130 }}>
      <span style={{ fontSize: 11.5, fontWeight: 540, color: 'var(--fg-2)' }}>{label}</span>
      <select value={map[key]} onChange={(e) => setMap({ ...map, [key]: e.target.value })} style={sel}>
        <option value="">{opt.none || '— keine —'}</option>
        {columns.map((c, i) => <option key={i} value={i}>{c || ('Spalte ' + (i + 1))}</option>)}
      </select>
    </label>
  );

  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: step === 'map' ? 820 : 460, borderRadius: 'var(--r-xl)', overflow: 'hidden', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.fileGen(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>Alte Buchhaltung importieren</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>

        {step === 'file' ? (
          <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.6, margin: 0 }}>
              Lade deine CSV (z. B. DATEV-Liste oder Excel-Export). Im nächsten Schritt ordnest du die Spalten zu und siehst eine Vorschau, bevor importiert wird.
              Belegdateien legst du separat im DMS ab.
            </p>
            <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" onChange={onFile} style={{ display: 'none' }}/>
            <Btn variant="primary" size="lg" disabled={busy} icon={busy ? Ic.loader(15) : Ic.plus(15)} onClick={() => fileRef.current && fileRef.current.click()}>CSV auswählen</Btn>
          </div>
        ) : (
          <>
            <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', letterSpacing: 0.5, textTransform: 'uppercase' }}>Spalten zuordnen</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 150 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 540, color: 'var(--fg-2)' }}>Buchungstyp</span>
                  <select value={map.kind} onChange={(e) => setMap({ ...map, kind: e.target.value })} style={sel}>
                    <option value="expense">Alle als Ausgaben</option>
                    <option value="income">Alle als Einnahmen</option>
                    <option value="column">Aus Spalte bestimmen</option>
                  </select>
                </label>
                {map.kind === 'column' && colSelect('kindCol', 'Typ-Spalte')}
                {map.kind === 'column' && (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 130 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 540, color: 'var(--fg-2)' }}>= Einnahme, wenn enthält</span>
                    <input value={map.incomeMatch} onChange={(e) => setMap({ ...map, incomeMatch: e.target.value })} placeholder="einnahme" style={{ ...sel, cursor: 'text' }}/>
                  </label>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                {colSelect('date', 'Datum')}
                {colSelect('amount', 'Betrag')}
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 120 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 540, color: 'var(--fg-2)' }}>Betrag ist</span>
                  <select value={map.amountMode} onChange={(e) => setMap({ ...map, amountMode: e.target.value })} style={sel}><option value="gross">brutto</option><option value="net">netto</option></select>
                </label>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                {colSelect('rateCol', 'USt-Satz (Spalte)')}
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 130 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 540, color: 'var(--fg-2)' }}>USt-Satz Standard</span>
                  <select value={map.rateDefault} onChange={(e) => setMap({ ...map, rateDefault: Number(e.target.value) })} style={sel}><option value={20}>20%</option><option value={13}>13%</option><option value={10}>10%</option><option value={0}>0%</option></select>
                </label>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                {colSelect('partner', 'Partner / Kunde')}
                {colSelect('desc', 'Beschreibung')}
                {colSelect('category', 'Kategorie')}
                {colSelect('number', 'Belegnummer')}
              </div>

              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 4 }}>Vorschau ({valid.length} gültige Zeilen)</div>
              <div style={{ maxHeight: 240, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
                <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
                  <thead><tr style={{ color: 'var(--fg-3)', textAlign: 'right', position: 'sticky', top: 0, background: 'var(--surface)' }}>
                    <th style={{ textAlign: 'left', fontWeight: 500, padding: '6px 8px' }}>Typ</th><th style={{ textAlign: 'left', fontWeight: 500 }}>Datum</th><th style={{ textAlign: 'left', fontWeight: 500 }}>Partner</th><th style={{ fontWeight: 500 }}>Satz</th><th style={{ fontWeight: 500 }}>Netto</th><th style={{ fontWeight: 500, padding: '6px 8px' }}>Brutto</th>
                  </tr></thead>
                  <tbody>{records.slice(0, 12).map((r, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', opacity: (r.gross > 0 || r.net > 0) ? 1 : 0.4 }}>
                      <td style={{ padding: '5px 8px', color: r.kind === 'income' ? '#22c55e' : 'var(--fg-2)' }}>{r.kind === 'income' ? 'Einn.' : 'Ausg.'}</td>
                      <td>{r.date || '—'}</td><td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.partner || '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--fg-3)' }}>{r.tax_rate}%</td><td style={{ textAlign: 'right' }}>{fmtEUR(r.net)}</td><td style={{ textAlign: 'right', fontWeight: 600, padding: '5px 8px' }}>{fmtEUR(r.gross)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              {records.length > 12 && <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>… und {records.length - 12} weitere Zeilen</div>}
            </div>
            <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{incomeN} Einnahmen · {expenseN} Ausgaben</span>
              <div style={{ flex: 1 }}/>
              <Btn variant="ghost" onClick={() => setStep('file')}>Zurück</Btn>
              <Btn variant="primary" disabled={busy || !valid.length} onClick={doImport} icon={busy ? Ic.loader(15) : Ic.check(15)}>{valid.length} importieren</Btn>
            </div>
          </>
        )}
      </Glass>
    </div>
  );
}

const MONTH_ABBR = ['Jän', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MONTH_FULL = ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
function periodOpts(p) {
  if (!p || p === 'year') return {};
  if (p[0] === 'q') return { quarter: Number(p.slice(1)) };
  if (p[0] === 'm') return { month: Number(p.slice(1)) };
  return {};
}

// Maps the cash-basis report onto the Austrian UVA (U30) Kennzahlen so the
// figures can be typed straight into FinanzOnline. Click any amount to copy it.
function UvaPreview({ data }) {
  const KZ_BASE = { 20: '022', 10: '029', 13: '006' }; // Bemessungsgrundlage per rate
  const copy = (n) => {
    const s = Number(n || 0).toFixed(2).replace('.', ',');
    if (navigator.clipboard) navigator.clipboard.writeText(s).then(() => toast('Kopiert: ' + s, 'success')).catch(() => {});
  };
  const amount = (n, bold) => (
    <span onClick={() => copy(n)} title="Klicken zum Kopieren" style={{ cursor: 'pointer', fontVariantNumeric: 'tabular-nums', fontWeight: bold ? 700 : 500, borderBottom: '1px dotted var(--border-hi)' }}>{fmtEUR(n)}</span>
  );
  const kz = (code) => <span style={{ display: 'inline-block', minWidth: 42, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent)', fontWeight: 700 }}>KZ {code}</span>;
  const rows = (data.income_by_rate || []).filter((r) => r.net > 0 || r.tax > 0);
  const ustTotal = data.income.tax;
  const vst = data.expense.vst;
  const zahllast = data.ust_zahllast;
  const r = (label, code, base, ust, bold) => (
    <tr style={{ borderTop: '1px solid var(--border)' }}>
      <td style={{ padding: '7px 0' }}>{code ? kz(code) : <span style={{ display: 'inline-block', minWidth: 42 }}/>}<span style={{ fontWeight: bold ? 700 : 500 }}>{label}</span></td>
      <td style={{ textAlign: 'right' }}>{base != null ? amount(base, bold) : ''}</td>
      <td style={{ textAlign: 'right' }}>{ust != null ? amount(ust, bold) : ''}</td>
    </tr>
  );
  return (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '16px 18px', marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-display)' }}>UVA-Vorschau (FinanzOnline)</div>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, padding: '2px 7px', borderRadius: 999, background: 'var(--accent-grad)', color: '#fff' }}>AT · U30</span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginBottom: 14 }}>
        Umsatzsteuervoranmeldung {data.period ? '· ' + data.period.label : ''} · Basis: Ist (Zahldatum) · Beträge zum Abtippen — klick zum Kopieren
      </div>
      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'var(--fg-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            <th style={{ textAlign: 'left', fontWeight: 500, paddingBottom: 6 }}>Kennzahl</th>
            <th style={{ textAlign: 'right', fontWeight: 500 }}>Bemessungsgrundlage</th>
            <th style={{ textAlign: 'right', fontWeight: 500 }}>Umsatzsteuer</th>
          </tr>
        </thead>
        <tbody>
          {r('Gesamtbetrag Bemessungsgrundlage', '000', data.income.net, null, true)}
          {rows.map((x) => r((x.rate === 20 ? 'Normalsteuersatz' : x.rate === 10 ? 'Ermäßigt' : x.rate === 13 ? 'Ermäßigt' : 'Sonstiger Satz') + ' ' + x.rate + ' %', KZ_BASE[x.rate], x.net, x.tax))}
          {r('Summe Umsatzsteuer', null, null, ustTotal, true)}
          {r('Gesamtbetrag der Vorsteuern', '060', null, vst, false)}
          <tr style={{ borderTop: '2px solid var(--border-hi)' }}>
            <td style={{ padding: '9px 0' }}>{kz('095')}<span style={{ fontWeight: 700 }}>{zahllast >= 0 ? 'Vorauszahlung (Zahllast)' : 'Überschuss (Gutschrift)'}</span></td>
            <td/>
            <td style={{ textAlign: 'right' }}>{amount(Math.abs(zahllast), true)}</td>
          </tr>
        </tbody>
      </table>
      <div style={{ fontSize: 10.5, color: 'var(--fg-4)', marginTop: 10 }}>
        Hinweis: Vorschau auf Ist-Basis. Reverse-Charge, ig. Erwerbe/Lieferungen und steuerfreie Umsätze sind nicht berücksichtigt — bei Bedarf manuell ergänzen.
      </div>
    </div>
  );
}

function AuswertungView({ data, year, onYear, period, onPeriod }) {
  const card = (label, value, sub, accent) => (
    <div style={{ padding: '14px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', position: 'relative', overflow: 'hidden' }}>
      {accent && <div style={{ position: 'absolute', inset: 0, background: 'var(--accent-grad)', opacity: 0.08 }}/>}
      <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4, position: 'relative' }}>{label}</div>
      <div style={{ fontSize: 20, fontFamily: 'var(--font-display)', fontWeight: 600, letterSpacing: -0.5, position: 'relative' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2, position: 'relative' }}>{sub}</div>}
    </div>
  );
  const pct = (r) => r + ' %';

  // Quarter sums from monthly.
  const quarters = [0, 0, 0, 0];
  if (data) data.monthly.forEach((m) => { quarters[Math.floor((m.month - 1) / 3)] += m.profit; });
  const maxCust = data && data.by_customer.length ? Math.max(...data.by_customer.map((c) => c.net), 1) : 1;
  const maxMonth = data ? Math.max(1, ...data.monthly.map((m) => Math.max(m.income_net, m.expense_net))) : 1;

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <IconBtn size={34} title="Vorjahr" onClick={() => onYear(-1)} style={{ border: '1px solid var(--border)', borderRadius: 999 }}>{Ic.chevronL(16)}</IconBtn>
        <div style={{ fontSize: 18, fontWeight: 600, fontFamily: 'var(--font-display)', minWidth: 64, textAlign: 'center' }}>{year}</div>
        <IconBtn size={34} title="Folgejahr" onClick={() => onYear(1)} style={{ border: '1px solid var(--border)', borderRadius: 999 }}>{Ic.chevronR(16)}</IconBtn>
        <select value={period} onChange={(e) => onPeriod(e.target.value)} style={{ height: 34, padding: '0 12px', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)', fontFamily: 'inherit', cursor: 'pointer' }}>
          <option value="year">Gesamtes Jahr</option>
          <optgroup label="Quartal">{[1, 2, 3, 4].map((q) => <option key={'q' + q} value={'q' + q}>Q{q}</option>)}</optgroup>
          <optgroup label="Monat">{MONTH_FULL.map((m, i) => <option key={'m' + (i + 1)} value={'m' + (i + 1)}>{m}</option>)}</optgroup>
        </select>
        <span style={{ fontSize: 11.5, color: 'var(--fg-3)', marginLeft: 6 }}>Basis: Zahldatum (EÜR){data && data.period ? ' · ' + data.period.label : ''}</span>
      </div>

      {!data ? <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 14 }}>
            {card('Einnahmen (netto)', fmtEUR(data.income.net), data.income.count + ' Rechnungen')}
            {card('Ausgaben (netto)', fmtEUR(data.expense.net), data.expense.count + ' Belege')}
            {card('Gewinn', fmtEUR(data.profit), 'vor Steuern', true)}
            {card('USt-Zahllast', fmtEUR(data.ust_zahllast), 'USt − Vorsteuer')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 28 }}>
            {card('Offen', fmtEUR(data.open.total), data.open.count + ' Rechnungen')}
            {card('Überfällig', fmtEUR(data.overdue.total), data.overdue.count + ' Rechnungen')}
            {card('MRR', fmtEUR(data.recurring.mrr), data.recurring.active + ' aktive Abos')}
            {card('ARR', fmtEUR(data.recurring.arr), 'hochgerechnet')}
          </div>

          {/* Gegenrechnung */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginBottom: 28 }}>
            <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '14px 18px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 10 }}>Ergebnis {data.period ? '· ' + data.period.label : ''}</div>
              {[['Einnahmen (netto)', data.income.net], ['− Ausgaben (netto)', -data.expense.net]].map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', color: 'var(--fg-2)' }}><span>{r[0]}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtEUR(r[1])}</span></div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700, marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--border)' }}><span>= Gewinn</span><span style={{ fontVariantNumeric: 'tabular-nums', color: data.profit < 0 ? '#ef4444' : 'var(--fg)' }}>{fmtEUR(data.profit)}</span></div>
            </div>
            <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '14px 18px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 10 }}>Umsatzsteuer-Zahllast</div>
              {[['Umsatzsteuer (Einnahmen)', data.income.tax], ['− Vorsteuer (Ausgaben)', -data.expense.vst]].map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', color: 'var(--fg-2)' }}><span>{r[0]}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtEUR(r[1])}</span></div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700, marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--border)' }}><span>= Zahllast</span><span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--accent)' }}>{fmtEUR(data.ust_zahllast)}</span></div>
            </div>
          </div>

          {/* USt / Vorsteuer per rate */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 28 }}>
            <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '14px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 10 }}>Umsatzsteuer (Einnahmen)</div>
              {data.income_by_rate.length === 0 ? <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>Keine Daten</div> : (
                <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
                  <thead><tr style={{ color: 'var(--fg-3)', textAlign: 'right' }}><th style={{ textAlign: 'left', fontWeight: 500, paddingBottom: 6 }}>Satz</th><th style={{ fontWeight: 500 }}>Netto</th><th style={{ fontWeight: 500 }}>USt</th></tr></thead>
                  <tbody>{data.income_by_rate.map((r) => (
                    <tr key={r.rate} style={{ fontVariantNumeric: 'tabular-nums' }}><td style={{ padding: '3px 0' }}>{pct(r.rate)}</td><td style={{ textAlign: 'right' }}>{fmtEUR(r.net)}</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtEUR(r.tax)}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
            <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '14px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 10 }}>Vorsteuer (Ausgaben)</div>
              {data.expense_by_rate.length === 0 ? <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>Keine Daten</div> : (
                <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
                  <thead><tr style={{ color: 'var(--fg-3)', textAlign: 'right' }}><th style={{ textAlign: 'left', fontWeight: 500, paddingBottom: 6 }}>Satz</th><th style={{ fontWeight: 500 }}>Netto</th><th style={{ fontWeight: 500 }}>Vorsteuer</th></tr></thead>
                  <tbody>{data.expense_by_rate.map((r) => (
                    <tr key={r.rate} style={{ fontVariantNumeric: 'tabular-nums' }}><td style={{ padding: '3px 0' }}>{pct(r.rate)}{r.tax_nondeduct > 0 ? ' *' : ''}</td><td style={{ textAlign: 'right' }}>{fmtEUR(r.net)}</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtEUR(r.vst)}</td></tr>
                  ))}</tbody>
                </table>
              )}
              {data.expense_by_rate.some((r) => r.tax_nondeduct > 0) && <div style={{ fontSize: 10.5, color: 'var(--fg-4)', marginTop: 8 }}>* enthält nicht abzugsfähige Beträge (nicht in Vorsteuer)</div>}
            </div>
          </div>

          {/* UVA-Vorschau (FinanzOnline, AT) */}
          <UvaPreview data={data}/>

          {/* Quarters */}
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 10 }}>Gewinn pro Quartal</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 28 }}>
            {quarters.map((q, i) => (
              <div key={i} style={{ padding: '12px 14px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>Q{i + 1}</div>
                <div style={{ fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: q < 0 ? '#ef4444' : 'var(--fg)' }}>{fmtEUR(q)}</div>
              </div>
            ))}
          </div>

          {/* Monthly bars */}
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 12 }}>Monatsverlauf (netto)</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 130, marginBottom: 6 }}>
            {data.monthly.map((m) => (
              <div key={m.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, height: '100%', justifyContent: 'flex-end' }} title={`${MONTH_ABBR[m.month - 1]}: +${fmtEUR(m.income_net)} / −${fmtEUR(m.expense_net)}`}>
                <div style={{ width: '100%', display: 'flex', gap: 2, alignItems: 'flex-end', height: '100%' }}>
                  <div style={{ flex: 1, height: (m.income_net / maxMonth * 100) + '%', background: 'var(--accent)', borderRadius: '3px 3px 0 0', minHeight: m.income_net > 0 ? 2 : 0 }}/>
                  <div style={{ flex: 1, height: (m.expense_net / maxMonth * 100) + '%', background: 'var(--fg-4)', borderRadius: '3px 3px 0 0', minHeight: m.expense_net > 0 ? 2 : 0 }}/>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 28 }}>
            {data.monthly.map((m) => <div key={m.month} style={{ flex: 1, textAlign: 'center', fontSize: 9.5, color: 'var(--fg-4)' }}>{MONTH_ABBR[m.month - 1]}</div>)}
          </div>

          {/* Revenue per customer */}
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 12 }}>Umsatz pro Kunde (netto, bezahlt)</div>
          {data.by_customer.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>Keine bezahlten Rechnungen in {year}.</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.by_customer.map((c, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 150, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 }}>{c.name}</div>
                  <div style={{ flex: 1, height: 18, borderRadius: 5, background: 'var(--surface-hi)', overflow: 'hidden' }}>
                    <div style={{ width: (c.net / maxCust * 100) + '%', height: '100%', background: 'var(--accent-grad)', minWidth: 2 }}/>
                  </div>
                  <div style={{ width: 100, textAlign: 'right', fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtEUR(c.net)}</div>
                </div>
              ))}
            </div>
          )}

          {/* Individual bookings */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginTop: 28 }}>
            {txTable('Einnahmen', data.income_tx, false)}
            {txTable('Ausgaben', data.expense_tx, true)}
          </div>
        </>
      )}
    </div>
  );
}

function txTable(title, rows, isExpense) {
  const total = (rows || []).reduce((a, r) => a + r.net, 0);
  return (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{(rows || []).length} · netto <strong style={{ color: 'var(--fg-2)', fontVariantNumeric: 'tabular-nums' }}>{fmtEUR(total)}</strong></span>
      </div>
      {(!rows || rows.length === 0) ? <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>Keine Buchungen im Zeitraum.</div> : (
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
            <thead><tr style={{ color: 'var(--fg-3)', textAlign: 'right', position: 'sticky', top: 0, background: 'var(--surface)' }}>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '0 0 6px' }}>Datum</th>
              <th style={{ textAlign: 'left', fontWeight: 500 }}>Beleg / Partner</th>
              <th style={{ fontWeight: 500 }}>Satz</th>
              <th style={{ fontWeight: 500 }}>Netto</th>
              <th style={{ fontWeight: 500 }}>{isExpense ? 'VSt' : 'USt'}</th>
              <th style={{ fontWeight: 500 }}>Brutto</th>
            </tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i} style={{ fontVariantNumeric: 'tabular-nums', borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '4px 0', color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>{fmtDateShort(r.date)}</td>
                <td style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(r.ref ? r.ref + ' · ' : '') + (r.partner || '')}{isExpense && r.deductible === 0 ? ' (o. VSt)' : ''}</td>
                <td style={{ textAlign: 'right', color: 'var(--fg-3)' }}>{r.rate}%</td>
                <td style={{ textAlign: 'right' }}>{fmtEUR(r.net)}</td>
                <td style={{ textAlign: 'right', color: 'var(--fg-3)' }}>{fmtEUR(r.tax)}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtEUR(r.gross)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DoppikView() {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [period, setPeriod] = useState('year');
  const [sub, setSub] = useState('journal');
  const [data, setData] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [entryModal, setEntryModal] = useState(false);

  useEffect(() => { API.ledgerAccounts().then((d) => setAccounts(d.accounts || [])).catch(() => {}); }, []);
  const load = useCallback(() => {
    setData(null);
    const o = periodOpts(period);
    const p = sub === 'journal' ? API.ledgerJournal(year, o)
      : sub === 'guv' ? API.ledgerGuv(year, o)
      : sub === 'salden' ? API.ledgerBalances(year, o)
      : sub === 'balance' ? API.ledgerBalanceSheet(year)
      : API.ledgerAccounts();
    p.then((d) => setData(d)).catch((e) => { toast(e.message, 'error'); setData({}); });
  }, [sub, year, period]);
  useEffect(() => { load(); }, [load]);

  const subs = [{ id: 'journal', label: 'Journal' }, { id: 'guv', label: 'GuV' }, { id: 'balance', label: 'Bilanz' }, { id: 'salden', label: 'Saldenliste' }, { id: 'accounts', label: 'Konten' }];
  const reloadAccounts = () => API.ledgerAccounts().then((d) => setAccounts(d.accounts || []));

  const sel = { height: 32, padding: '0 10px', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)', fontFamily: 'inherit', cursor: 'pointer' };
  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <IconBtn size={32} onClick={() => setYear((y) => y - 1)} style={{ border: '1px solid var(--border)', borderRadius: 999 }}>{Ic.chevronL(15)}</IconBtn>
        <div style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-display)', minWidth: 52, textAlign: 'center' }}>{year}</div>
        <IconBtn size={32} onClick={() => setYear((y) => y + 1)} style={{ border: '1px solid var(--border)', borderRadius: 999 }}>{Ic.chevronR(15)}</IconBtn>
        {sub !== 'balance' && sub !== 'accounts' && (
          <select value={period} onChange={(e) => setPeriod(e.target.value)} style={sel}>
            <option value="year">Ganzes Jahr</option>
            <optgroup label="Quartal">{[1, 2, 3, 4].map((q) => <option key={'q' + q} value={'q' + q}>Q{q}</option>)}</optgroup>
            <optgroup label="Monat">{MONTH_FULL.map((m, i) => <option key={'m' + (i + 1)} value={'m' + (i + 1)}>{m}</option>)}</optgroup>
          </select>
        )}
        <div style={{ flex: 1 }}/>
        {sub === 'journal' && <Btn variant="glass" size="sm" icon={Ic.download(13)} onClick={() => { window.location.href = API.ledgerDatevUrl(year, periodOpts(period)); }}>DATEV</Btn>}
        {sub === 'journal' && <Btn variant="primary" size="sm" icon={Ic.plus(13)} onClick={() => setEntryModal(true)}>Buchung</Btn>}
        {sub === 'accounts' && <Btn variant="primary" size="sm" icon={Ic.plus(13)} onClick={() => setEntryModal('account')}>Konto</Btn>}
      </div>

      <div className="no-scrollbar" style={{ overflowX: 'auto', marginBottom: 18 }}>
        <div style={{ display: 'inline-flex', gap: 4, padding: 4, width: 'max-content', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
          {subs.map((s) => { const on = sub === s.id; return <button key={s.id} onClick={() => setSub(s.id)} style={{ height: 30, padding: '0 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 540, whiteSpace: 'nowrap', background: on ? 'var(--accent-grad)' : 'transparent', color: on ? '#fff' : 'var(--fg-2)' }}>{s.label}</button>; })}
        </div>
      </div>

      {data === null ? <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(22)}</div> : (
        <>
          {sub === 'journal' && <LedgerJournal data={data}/>}
          {sub === 'guv' && <LedgerGuv data={data}/>}
          {sub === 'balance' && <LedgerBalanceSheet data={data}/>}
          {sub === 'salden' && <LedgerSalden data={data}/>}
          {sub === 'accounts' && <LedgerAccounts accounts={accounts} onReload={reloadAccounts}/>}
        </>
      )}

      {entryModal === true && <LedgerEntryModal accounts={accounts} onClose={() => setEntryModal(false)} onSaved={() => { setEntryModal(false); load(); }}/>}
      {entryModal === 'account' && <LedgerAccountModal onClose={() => setEntryModal(false)} onSaved={() => { setEntryModal(false); reloadAccounts(); }}/>}
    </div>
  );
}

function LedgerJournal({ data }) {
  const entries = data.entries || [];
  if (!entries.length) return <div style={{ fontSize: 13, color: 'var(--fg-3)' }}>Keine Buchungen im Zeitraum.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {entries.map((e, i) => (
        <div key={i} style={{ borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '10px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>{fmtDateShort(e.date)}</span>
            <span style={{ fontSize: 13, fontWeight: 540, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.description || e.ref}</span>
            {e.ref && <span style={{ fontSize: 10.5, color: 'var(--fg-4)' }}>{e.ref}</span>}
          </div>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
            <tbody>{e.lines.map((l, j) => (
              <tr key={j}>
                <td style={{ width: 56, color: 'var(--fg-3)' }}>{l.account}</td>
                <td style={{ color: 'var(--fg-2)' }}>{l.name}</td>
                <td style={{ textAlign: 'right', width: 100, color: l.debit > 0 ? 'var(--fg)' : 'var(--fg-4)' }}>{l.debit > 0 ? fmtEUR(l.debit) : '—'}</td>
                <td style={{ textAlign: 'right', width: 100, color: l.credit > 0 ? 'var(--fg)' : 'var(--fg-4)' }}>{l.credit > 0 ? fmtEUR(l.credit) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, padding: '8px 14px', fontSize: 12.5, color: 'var(--fg-2)', fontVariantNumeric: 'tabular-nums' }}>
        <span>Soll: <strong>{fmtEUR(data.totals?.debit || 0)}</strong></span>
        <span>Haben: <strong>{fmtEUR(data.totals?.credit || 0)}</strong></span>
      </div>
    </div>
  );
}

function LedgerGuv({ data }) {
  const blk = (title, rows) => (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '14px 16px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 10 }}>{title}</div>
      {rows.length === 0 ? <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>—</div> : rows.map((r) => (
        <div key={r.account} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '3px 0', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ color: 'var(--fg-2)' }}><span style={{ color: 'var(--fg-4)' }}>{r.account}</span> {r.name}</span><span>{fmtEUR(r.amount)}</span>
        </div>
      ))}
    </div>
  );
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 16 }}>
        {blk('Erlöse', data.income || [])}
        {blk('Aufwände', data.expense || [])}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ color: 'var(--fg-3)' }}>Erlöse {fmtEUR(data.total_income || 0)} − Aufwand {fmtEUR(data.total_expense || 0)} =</span>
        <strong style={{ color: (data.result || 0) < 0 ? '#ef4444' : 'var(--accent)' }}>Ergebnis {fmtEUR(data.result || 0)}</strong>
      </div>
    </div>
  );
}

function LedgerBalanceSheet({ data }) {
  const side = (title, rows, total) => (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '14px 16px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 10 }}>{title}</div>
      {rows.map((r) => (
        <div key={r.account} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '3px 0', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ color: 'var(--fg-2)' }}><span style={{ color: 'var(--fg-4)' }}>{r.account}</span> {r.name}</span><span>{fmtEUR(r.amount)}</span>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums' }}><span>Summe</span><span>{fmtEUR(total)}</span></div>
    </div>
  );
  const passiva = [...(data.liabilities || []), ...(data.equity || [])];
  return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginBottom: 12 }}>Stichtag {fmtDateShort(data.as_of)} · Jahresergebnis {fmtEUR(data.result || 0)}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        {side('Aktiva', data.assets || [], data.total_assets || 0)}
        {side('Passiva (Verbindl. + Eigenkapital)', passiva, data.total_equity_liabilities || 0)}
      </div>
    </div>
  );
}

function LedgerSalden({ data }) {
  const rows = data.accounts || data.rows || [];
  return (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '14px 16px', overflowX: 'auto' }}>
      <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums', minWidth: 460 }}>
        <thead><tr style={{ color: 'var(--fg-3)', textAlign: 'right' }}>
          <th style={{ textAlign: 'left', fontWeight: 500, padding: '0 0 8px' }}>Konto</th><th style={{ textAlign: 'left', fontWeight: 500 }}>Bezeichnung</th><th style={{ fontWeight: 500 }}>Soll</th><th style={{ fontWeight: 500 }}>Haben</th><th style={{ fontWeight: 500 }}>Saldo</th>
        </tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.account} style={{ borderTop: '1px solid var(--border)' }}>
            <td style={{ color: 'var(--fg-3)', padding: '4px 0' }}>{r.account}</td><td>{r.name}</td>
            <td style={{ textAlign: 'right' }}>{fmtEUR(r.debit)}</td><td style={{ textAlign: 'right' }}>{fmtEUR(r.credit)}</td>
            <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtEUR(r.balance)}</td>
          </tr>
        ))}</tbody>
        <tfoot><tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
          <td colSpan={2} style={{ padding: '6px 0' }}>Summe</td><td style={{ textAlign: 'right' }}>{fmtEUR(data.totals?.debit || 0)}</td><td style={{ textAlign: 'right' }}>{fmtEUR(data.totals?.credit || 0)}</td><td/>
        </tr></tfoot>
      </table>
    </div>
  );
}

function LedgerAccounts({ accounts, onReload }) {
  const TYPE_DE = { asset: 'Aktiva', liability: 'Passiva', equity: 'Eigenkapital', income: 'Erlös', expense: 'Aufwand' };
  const del = async (a) => { try { await API.deleteLedgerAccount(a.number); onReload(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {accounts.map((a) => (
        <div key={a.number} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <span style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums', color: 'var(--fg-3)', width: 44 }}>{a.number}</span>
          <span style={{ flex: 1, fontSize: 13 }}>{a.name}</span>
          <span style={{ fontSize: 10.5, color: 'var(--fg-3)', padding: '2px 7px', borderRadius: 999, background: 'var(--surface-hi)' }}>{TYPE_DE[a.type] || a.type}</span>
          <span onClick={() => del(a)} title="Entfernen" style={{ cursor: 'pointer', color: 'var(--fg-4)', display: 'inline-flex' }}>{Ic.close(13)}</span>
        </div>
      ))}
    </div>
  );
}

function LedgerAccountModal({ onClose, onSaved }) {
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState('expense');
  const [busy, setBusy] = useState(false);
  const fld = { height: 42, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', width: '100%' };
  const submit = async () => {
    if (!number.trim() || !name.trim()) { toast('Nummer und Name nötig', 'error'); return; }
    setBusy(true);
    try { await API.newLedgerAccount({ number: number.trim(), name: name.trim(), type }); onSaved(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 400, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0 }}>Neues Konto</h2>
          <IconBtn size={30} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Nr. (z. B. 7500)" style={{ ...fld, width: 130 }}/>
            <select value={type} onChange={(e) => setType(e.target.value)} style={{ ...fld, cursor: 'pointer' }}>
              <option value="asset">Aktiva</option><option value="liability">Passiva</option><option value="equity">Eigenkapital</option><option value="income">Erlös</option><option value="expense">Aufwand</option>
            </select>
          </div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bezeichnung" style={fld}/>
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} onClick={submit} icon={busy ? Ic.loader(15) : Ic.check(15)}>Speichern</Btn>
        </div>
      </Glass>
    </div>
  );
}

function LedgerEntryModal({ accounts, onClose, onSaved }) {
  const [date, setDate] = useState(todayKeyLocal());
  const [desc, setDesc] = useState('');
  const [lines, setLines] = useState([{ account: '', debit: '', credit: '' }, { account: '', debit: '', credit: '' }]);
  const [busy, setBusy] = useState(false);
  const setLine = (i, k, v) => setLines((a) => a.map((l, j) => j === i ? { ...l, [k]: v } : l));
  const addLine = () => setLines((a) => [...a, { account: '', debit: '', credit: '' }]);
  const rmLine = (i) => setLines((a) => a.length > 2 ? a.filter((_, j) => j !== i) : a);
  const sumD = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
  const sumC = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(sumD - sumC) < 0.005 && sumD > 0;
  const submit = async () => {
    if (!balanced) { toast('Soll und Haben müssen gleich sein', 'error'); return; }
    const ls = lines.filter((l) => l.account && ((Number(l.debit) || 0) > 0 || (Number(l.credit) || 0) > 0))
      .map((l) => ({ account: l.account, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 }));
    if (ls.length < 2) { toast('Mind. zwei Zeilen', 'error'); return; }
    setBusy(true);
    try { await API.newLedgerEntry({ entry_date: date, description: desc.trim() || null, lines: ls }); onSaved(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const fld = { height: 36, padding: '0 8px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13, color: 'var(--fg)', fontFamily: 'inherit' };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 560, borderRadius: 'var(--r-xl)', overflow: 'hidden', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0 }}>Manuelle Buchung</h2>
          <IconBtn size={30} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...fld, height: 42, width: 160 }}/>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Buchungstext" style={{ ...fld, height: 42, flex: 1 }}/>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {lines.map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select value={l.account} onChange={(e) => setLine(i, 'account', e.target.value)} style={{ ...fld, flex: 1, minWidth: 0, cursor: 'pointer' }}>
                  <option value="">Konto…</option>
                  {accounts.map((a) => <option key={a.number} value={a.number}>{a.number} {a.name}</option>)}
                </select>
                <input type="number" step="0.01" value={l.debit} onChange={(e) => setLine(i, 'debit', e.target.value)} placeholder="Soll" style={{ ...fld, width: 90, textAlign: 'right' }}/>
                <input type="number" step="0.01" value={l.credit} onChange={(e) => setLine(i, 'credit', e.target.value)} placeholder="Haben" style={{ ...fld, width: 90, textAlign: 'right' }}/>
                <span onClick={() => rmLine(i)} style={{ cursor: 'pointer', color: 'var(--fg-4)', display: 'inline-flex' }}>{Ic.close(13)}</span>
              </div>
            ))}
            <button onClick={addLine} style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: 'var(--fg-3)' }}>{Ic.plus(12)} Zeile</button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 18, fontSize: 12.5, fontVariantNumeric: 'tabular-nums', color: balanced ? 'var(--fg-2)' : '#ef4444' }}>
            <span>Soll {fmtEUR(sumD)}</span><span>Haben {fmtEUR(sumC)}</span><span>{balanced ? '✓ ausgeglichen' : 'Differenz ' + fmtEUR(sumD - sumC)}</span>
          </div>
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy || !balanced} onClick={submit} icon={busy ? Ic.loader(15) : Ic.check(15)}>Buchen</Btn>
        </div>
      </Glass>
    </div>
  );
}

const SUB_INTERVALS = { monthly: 'monatlich', quarterly: 'quartalsweise', yearly: 'jährlich' };
const EXP_CATEGORIES = ['Wareneinkauf', 'Hardware', 'Software', 'Büro', 'Werbung/Marketing', 'Reisekosten', 'Kfz', 'Beratung/Recht', 'Miete', 'Gebühren/Bank', 'Telefon/Internet', 'Fortbildung', 'Sonstiges'];

function ExpenseModal({ exp, contacts, onSave, onClose, onChanged }) {
  const [date, setDate] = useState(exp.exp_date || todayKeyLocal());
  const [vendor, setVendor] = useState(exp.vendor || '');
  const [contactId, setContactId] = useState(exp.contact_id ? String(exp.contact_id) : '');
  const [category, setCategory] = useState(exp.category || 'Sonstiges');
  const [description, setDescription] = useState(exp.description || '');
  const [gross, setGross] = useState(exp.gross != null ? exp.gross : 0);
  const [taxRate, setTaxRate] = useState(exp.tax_rate != null ? exp.tax_rate : 20);
  const [deductible, setDeductible] = useState(exp.deductible != null ? !!exp.deductible : true);
  const [paid, setPaid] = useState(!!exp.paid_at);
  const [hasReceipt, setHasReceipt] = useState(!!exp.has_receipt);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const g = Number(gross) || 0, r = Number(taxRate) || 0;
  const net = r > 0 ? Math.round((g / (1 + r / 100)) * 100) / 100 : g;
  const vat = Math.round((g - net) * 100) / 100;

  const submit = async () => {
    setBusy(true);
    await onSave({ id: exp.id, exp_date: date || null, vendor: vendor.trim() || null, contact_id: contactId || null, category, description: description.trim() || null, gross: g, tax_rate: r, deductible: deductible ? 1 : 0, paid_at: paid ? (date || todayKeyLocal()) : '' });
    setBusy(false);
  };
  const pickReceipt = () => fileRef.current && fileRef.current.click();
  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file || !exp.id) { if (!exp.id) toast('Erst speichern, dann Beleg anhängen', 'error'); return; }
    setUploading(true);
    try { await API.uploadExpenseReceipt(exp.id, file); setHasReceipt(true); toast('Beleg hochgeladen', 'success'); onChanged && onChanged(); }
    catch (err) { toast(err.message, 'error'); } finally { setUploading(false); e.target.value = ''; }
  };
  const removeReceipt = async () => { try { await API.deleteExpenseReceipt(exp.id); setHasReceipt(false); onChanged && onChanged(); } catch (err) { toast(err.message, 'error'); } };

  const fld = { height: 42, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', width: '100%' };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 500, borderRadius: 'var(--r-xl)', overflow: 'hidden', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.archive(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>{exp.id ? 'Ausgabe bearbeiten' : 'Neue Ausgabe'}</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Datum</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={fld}/></label>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Kategorie</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ ...fld, cursor: 'pointer' }}>{EXP_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
            </label>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Lieferant / Wofür</span><input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="z. B. Amazon, Hosting…" style={fld}/></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Kunde (optional, weiterverrechenbar)</span>
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} style={{ ...fld, cursor: 'pointer' }}><option value="">— keiner —</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Betrag (brutto)</span><input type="number" step="0.01" value={gross} onChange={(e) => setGross(e.target.value)} style={{ ...fld, textAlign: 'right' }}/></label>
            <label style={{ width: 90, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>USt %</span>
              <select value={taxRate} onChange={(e) => setTaxRate(e.target.value)} style={{ ...fld, cursor: 'pointer' }}><option value={20}>20</option><option value={13}>13</option><option value={10}>10</option><option value={0}>0</option></select>
            </label>
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: -6 }}>Netto {fmtEUR(net)} · Vorsteuer {fmtEUR(vat)}</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13.5 }}>
            <input type="checkbox" checked={deductible} onChange={(e) => setDeductible(e.target.checked)} style={{ width: 17, height: 17, accentColor: 'var(--accent)' }}/> Vorsteuer abzugsfähig
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13.5 }}>
            <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} style={{ width: 17, height: 17, accentColor: 'var(--accent)' }}/> Bereits bezahlt
          </label>
          {/* Receipt */}
          <div style={{ paddingTop: 6, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)', marginBottom: 8 }}>Beleg</div>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" onChange={onFile} style={{ display: 'none' }}/>
            {!exp.id ? (
              <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>Speichere die Ausgabe, danach kannst du einen Beleg anhängen.</div>
            ) : hasReceipt ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Btn variant="glass" size="sm" icon={Ic.eye(13)} onClick={() => window.open(API.expenseReceiptUrl(exp.id, false), '_blank')}>Beleg ansehen</Btn>
                <Btn variant="glass" size="sm" icon={Ic.plus(13)} onClick={pickReceipt}>Ersetzen</Btn>
                <Btn variant="ghost" size="sm" icon={Ic.trash(13)} onClick={removeReceipt}>Entfernen</Btn>
              </div>
            ) : (
              <Btn variant="glass" size="sm" disabled={uploading} icon={uploading ? Ic.loader(13) : Ic.plus(13)} onClick={pickReceipt}>Beleg hochladen</Btn>
            )}
          </div>
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} onClick={submit} icon={busy ? Ic.loader(15) : Ic.check(15)}>Speichern</Btn>
        </div>
      </Glass>
    </div>
  );
}

function SubscriptionModal({ sub, contacts, onSave, onClose }) {
  const [name, setName] = useState(sub.name || '');
  const [contactId, setContactId] = useState(sub.contact_id ? String(sub.contact_id) : '');
  const [interval, setInterval] = useState(sub.interval_unit || 'monthly');
  const [net, setNet] = useState(sub.net_price != null ? sub.net_price : 0);
  const [taxRate, setTaxRate] = useState(sub.tax_rate != null ? sub.tax_rate : 20);
  const [startDate, setStartDate] = useState(sub.start_date || todayKeyLocal());
  const [active, setActive] = useState(sub.active != null ? !!sub.active : true);
  const [description, setDescription] = useState(sub.description || '');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) { toast('Name erforderlich', 'error'); return; }
    setBusy(true);
    await onSave({ id: sub.id, name: name.trim(), contact_id: contactId || null, interval_unit: interval, net_price: Number(net) || 0, tax_rate: Number(taxRate) || 0, start_date: startDate || null, active: active ? 1 : 0, description: description.trim() || null });
    setBusy(false);
  };
  const fld = { height: 42, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', width: '100%' };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 480, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.copy(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>{sub.id ? 'Abo bearbeiten' : 'Neues Abo'}</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Bezeichnung</span><input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="z. B. Website-Wartung" style={fld}/></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Kunde</span>
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} style={{ ...fld, cursor: 'pointer' }}><option value="">— Kunde wählen —</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Intervall</span>
              <select value={interval} onChange={(e) => setInterval(e.target.value)} style={{ ...fld, cursor: 'pointer' }}>{Object.entries(SUB_INTERVALS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </label>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Start ab</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={fld}/></label>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Preis netto</span><input type="number" step="0.01" value={net} onChange={(e) => setNet(e.target.value)} style={fld}/></label>
            <label style={{ width: 90, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>USt %</span>
              <select value={taxRate} onChange={(e) => setTaxRate(e.target.value)} style={{ ...fld, cursor: 'pointer' }}><option value={20}>20</option><option value={13}>13</option><option value={10}>10</option><option value={0}>0</option></select>
            </label>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Notiz</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Optional" style={{ ...fld, height: 'auto', padding: '10px 12px', resize: 'vertical' }}/></label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13.5 }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} style={{ width: 17, height: 17, accentColor: 'var(--accent)' }}/> Aktiv (erzeugt fällige Perioden)
          </label>
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} onClick={submit} icon={busy ? Ic.loader(15) : Ic.check(15)}>Speichern</Btn>
        </div>
      </Glass>
    </div>
  );
}

function DocumentEditor({ doc, contacts, products, onSave, onClose, onOpenPdf }) {
  const today = new Date().toISOString().slice(0, 10);
  const [contactId, setContactId] = useState(doc.contact_id ? String(doc.contact_id) : '');
  const [docDate, setDocDate] = useState(doc.doc_date || today);
  const [deliveryDate, setDeliveryDate] = useState(doc.delivery_date || '');
  const [intro, setIntro] = useState(doc.intro_text || '');
  const [footer, setFooter] = useState(doc.footer_text || '');
  const [notes, setNotes] = useState(doc.notes || '');
  const [items, setItems] = useState(() => (doc.items && doc.items.length)
    ? doc.items.map((it) => ({ description: it.description, quantity: it.quantity, unit: it.unit, unit_price_net: it.unit_price_net, tax_rate: it.tax_rate }))
    : [{ description: '', quantity: 1, unit: 'Stk', unit_price_net: 0, tax_rate: 20 }]);
  const [busy, setBusy] = useState(false);
  const type = doc.type || 'invoice';

  const setItem = (i, k, v) => setItems((arr) => arr.map((it, j) => j === i ? { ...it, [k]: v } : it));
  const addRow = () => setItems((arr) => [...arr, { description: '', quantity: 1, unit: 'Stk', unit_price_net: 0, tax_rate: 20 }]);
  const rmRow = (i) => setItems((arr) => arr.length > 1 ? arr.filter((_, j) => j !== i) : arr);
  const addProduct = (pid) => { const p = products.find((x) => String(x.id) === String(pid)); if (!p) return; setItems((arr) => [...arr, { description: p.name, quantity: 1, unit: p.unit, unit_price_net: p.unit_price_net, tax_rate: p.tax_rate }]); };

  const lineNet = (it) => Math.round((Number(it.quantity) || 0) * (Number(it.unit_price_net) || 0) * 100) / 100;
  const net = items.reduce((a, it) => a + lineNet(it), 0);
  const tax = items.reduce((a, it) => a + Math.round(lineNet(it) * (Number(it.tax_rate) || 0)) / 100, 0);
  const gross = net + tax;

  const submit = async () => {
    setBusy(true);
    const r = await onSave({ id: doc.id, type, contact_id: contactId || null, doc_date: docDate || null, delivery_date: deliveryDate || null, intro_text: intro || null, footer_text: footer || null, notes: notes || null, items });
    setBusy(false);
    return r;
  };

  const fld = { height: 40, padding: '0 10px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13.5, color: 'var(--fg)', fontFamily: 'inherit', width: '100%' };
  const numIn = { ...fld, textAlign: 'right' };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 760, borderRadius: 'var(--r-xl)', overflow: 'hidden', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.fileGen(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>
            {doc.id ? (type === 'offer' ? 'Angebot ' : 'Rechnung ') + doc.number : (type === 'offer' ? 'Neues Angebot' : 'Neue Rechnung')}
          </h2>
          {doc.id && <IconBtn size={32} title="PDF öffnen" onClick={() => onOpenPdf(doc.id)}>{Ic.eye(16)}</IconBtn>}
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ flex: '2 1 220px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Kunde</span>
              <select value={contactId} onChange={(e) => setContactId(e.target.value)} style={{ ...fld, cursor: 'pointer' }}>
                <option value="">— Kunde wählen —</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label style={{ flex: '1 1 130px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Datum</span>
              <input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} style={fld}/>
            </label>
            <label style={{ flex: '1 1 130px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Leistungsdatum</span>
              <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} style={fld}/>
            </label>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Einleitung</span>
            <textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={2} placeholder="Sehr geehrte Damen und Herren, …" style={{ ...fld, height: 'auto', padding: '8px 10px', resize: 'vertical' }}/>
          </div>

          {/* Items */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Positionen</span>
              {products.length > 0 && (
                <select value="" onChange={(e) => { addProduct(e.target.value); e.target.value = ''; }} style={{ height: 30, padding: '0 8px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--fg-2)', cursor: 'pointer', fontFamily: 'inherit' }}>
                  <option value="">+ Produkt einfügen</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name} · {fmtEUR(p.unit_price_net)}</option>)}
                </select>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {items.map((it, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input value={it.description} onChange={(e) => setItem(i, 'description', e.target.value)} placeholder="Beschreibung" style={{ ...fld, flex: 1, minWidth: 0 }}/>
                  <input type="number" step="0.01" value={it.quantity} onChange={(e) => setItem(i, 'quantity', e.target.value)} title="Menge" style={{ ...numIn, width: 64 }}/>
                  <input value={it.unit} onChange={(e) => setItem(i, 'unit', e.target.value)} title="Einheit" style={{ ...fld, width: 56 }}/>
                  <input type="number" step="0.01" value={it.unit_price_net} onChange={(e) => setItem(i, 'unit_price_net', e.target.value)} title="Einzelpreis netto" style={{ ...numIn, width: 90 }}/>
                  <select value={it.tax_rate} onChange={(e) => setItem(i, 'tax_rate', e.target.value)} title="USt-Satz" style={{ ...fld, width: 64, cursor: 'pointer' }}>
                    <option value={20}>20%</option><option value={13}>13%</option><option value={10}>10%</option><option value={0}>0%</option>
                  </select>
                  <div style={{ width: 84, textAlign: 'right', fontSize: 13, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtEUR(lineNet(it))}</div>
                  <span onClick={() => rmRow(i)} title="Entfernen" style={{ cursor: 'pointer', color: 'var(--fg-4)', display: 'inline-flex', flexShrink: 0 }}>{Ic.close(14)}</span>
                </div>
              ))}
            </div>
            <button onClick={addRow} style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: 'var(--fg-3)' }}>{Ic.plus(12)} Position</button>
          </div>

          {/* Totals */}
          <div style={{ alignSelf: 'flex-end', minWidth: 220, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--fg-2)' }}><span>Netto</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtEUR(net)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--fg-2)' }}><span>USt</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtEUR(tax)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 15, marginTop: 4, paddingTop: 6, borderTop: '1px solid var(--border)' }}><span>Gesamt</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtEUR(gross)}</span></div>
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Fußtext</span><textarea value={footer} onChange={(e) => setFooter(e.target.value)} rows={2} placeholder="Zahlbar innerhalb 14 Tagen …" style={{ ...fld, height: 'auto', padding: '8px 10px', resize: 'vertical' }}/></label>
            <label style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Interne Notiz</span><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Nicht auf dem PDF" style={{ ...fld, height: 'auto', padding: '8px 10px', resize: 'vertical' }}/></label>
          </div>
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} onClick={submit} icon={busy ? Ic.loader(15) : Ic.check(15)}>Speichern</Btn>
        </div>
      </Glass>
    </div>
  );
}

function ProductModal({ product, onSave, onClose }) {
  const [name, setName] = useState(product.name || '');
  const [description, setDescription] = useState(product.description || '');
  const [unit, setUnit] = useState(product.unit || 'Stk');
  const [price, setPrice] = useState(product.unit_price_net != null ? product.unit_price_net : 0);
  const [taxRate, setTaxRate] = useState(product.tax_rate != null ? product.tax_rate : 20);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) { toast('Name erforderlich', 'error'); return; }
    setBusy(true);
    await onSave({ id: product.id, name: name.trim(), description: description.trim() || null, unit: unit.trim() || 'Stk', unit_price_net: Number(price) || 0, tax_rate: Number(taxRate) || 0 });
    setBusy(false);
  };
  const fld = { height: 42, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', width: '100%' };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 460, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.archive(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>{product.id ? 'Produkt bearbeiten' : 'Neues Produkt'}</h2>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Name</span><input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Leistung / Produkt" style={fld}/></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Beschreibung</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Optional" style={{ ...fld, height: 'auto', padding: '10px 12px', resize: 'vertical' }}/></label>
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Einheit</span><input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Stk" style={fld}/></label>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Preis netto</span><input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} style={fld}/></label>
            <label style={{ width: 90, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>USt %</span>
              <select value={taxRate} onChange={(e) => setTaxRate(e.target.value)} style={{ ...fld, cursor: 'pointer' }}><option value={20}>20</option><option value={13}>13</option><option value={10}>10</option><option value={0}>0</option></select>
            </label>
          </div>
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} onClick={submit} icon={busy ? Ic.loader(15) : Ic.check(15)}>Speichern</Btn>
        </div>
      </Glass>
    </div>
  );
}

// ───── Kalender app ──────────────────────────────────────────────────────
const WD_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const HOUR_H = 44;
const evStart = (e) => new Date(String(e.starts_at).replace(' ', 'T'));
const evEnd = (e) => new Date(String(e.ends_at).replace(' ', 'T'));
const sameYmd = (a, b) => ymdOf(a) === ymdOf(b);
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const dayInEvent = (e, day) => { const ds = new Date(day); ds.setHours(0, 0, 0, 0); const de = new Date(day); de.setHours(23, 59, 59, 0); return evStart(e) <= de && evEnd(e) >= ds; };

function KalenderApp({ onBack }) {
  const [view, setView] = useState('week');
  const [anchor, setAnchor] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [events, setEvents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null);
  const [contacts, setContacts] = useState([]);

  // Visible range per view.
  let rangeStart, rangeEnd, days;
  if (view === 'day') { rangeStart = new Date(anchor); rangeEnd = new Date(anchor); days = [new Date(anchor)]; }
  else if (view === 'week') { rangeStart = mondayOf(anchor); rangeEnd = addDays(rangeStart, 6); days = Array.from({ length: 7 }, (_, i) => addDays(rangeStart, i)); }
  else { const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1); rangeStart = mondayOf(first); rangeEnd = addDays(rangeStart, 41); days = Array.from({ length: 42 }, (_, i) => addDays(rangeStart, i)); }

  const load = useCallback(() => {
    API.calendarEvents(ymdOf(rangeStart), ymdOf(rangeEnd)).then((d) => setEvents(d.events || [])).catch(() => setEvents([]));
  }, [ymdOf(rangeStart), ymdOf(rangeEnd)]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { API.tasks().then((d) => setTasks(d.tasks || [])).catch(() => {}); API.contacts({}).then((d) => setContacts(d.contacts || [])).catch(() => {}); }, []);

  const ql = q.trim().toLowerCase();
  const matchEv = (e) => !ql || [e.title, e.location, e.person, e.contact_name].some((s) => (s || '').toLowerCase().includes(ql));
  const evs = events.filter(matchEv);
  const taskItems = tasks.filter((t) => t.due_date && (!ql || (t.title || '').toLowerCase().includes(ql)));
  const tasksOn = (day) => taskItems.filter((t) => t.due_date === ymdOf(day));

  const move = (dir) => setAnchor((a) => view === 'day' ? addDays(a, dir) : view === 'week' ? addDays(a, dir * 7) : new Date(a.getFullYear(), a.getMonth() + dir, 1));
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); setAnchor(d); };

  const rangeLabel = view === 'month'
    ? anchor.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
    : view === 'day'
      ? anchor.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : `${rangeStart.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })} – ${rangeEnd.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  const save = async (data) => { try { if (data.id) await API.updateEvent(data.id, data); else await API.newEvent(data); setModal(null); load(); } catch (e) { toast(e.message, 'error'); } };
  const del = async (ev) => { if (!await confirmDialog({ title: 'Termin löschen?', message: `„${ev.title}" wird gelöscht.`, confirmLabel: 'Löschen', danger: true })) return; try { await API.deleteEvent(ev.id); setModal(null); load(); } catch (e) { toast(e.message, 'error'); } };
  const newAt = (day, hour) => { const s = new Date(day); s.setHours(hour ?? 9, 0, 0, 0); const e = new Date(s); e.setHours((hour ?? 9) + 1); setModal({ _start: s, _end: e }); };

  const viewTabs = [{ id: 'day', label: 'Tag' }, { id: 'week', label: 'Woche' }, { id: 'month', label: 'Monat' }];
  return (
    <>
      <TopBar crumbs={[{ label: 'Apps', onClick: onBack }, 'Kalender']}
        right={<Btn variant="primary" size="sm" icon={Ic.plus(14)} onClick={() => newAt(view === 'month' ? new Date() : anchor, 9)}>Termin</Btn>}/>
      <div data-scroll style={{ flex: 1, overflow: 'auto', padding: '18px 24px 40px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <Btn variant="glass" size="sm" onClick={today}>Heute</Btn>
          <div style={{ display: 'flex', gap: 2 }}>
            <IconBtn size={32} onClick={() => move(-1)} style={{ border: '1px solid var(--border)', borderRadius: 999 }}>{Ic.chevronL(16)}</IconBtn>
            <IconBtn size={32} onClick={() => move(1)} style={{ border: '1px solid var(--border)', borderRadius: 999 }}>{Ic.chevronR(16)}</IconBtn>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-display)' }}>{rangeLabel}</div>
          <div style={{ flex: 1 }}/>
          <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
            {viewTabs.map((t) => { const on = view === t.id; return <button key={t.id} onClick={() => setView(t.id)} style={{ height: 30, padding: '0 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 540, background: on ? 'var(--accent-grad)' : 'transparent', color: on ? '#fff' : 'var(--fg-2)' }}>{t.label}</button>; })}
          </div>
        </div>
        <div style={{ marginBottom: 14, position: 'relative', maxWidth: 360 }}>
          <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-3)' }}>{Ic.search(15)}</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Termine, Tasks, Urlaube durchsuchen…" style={{ width: '100%', height: 38, padding: '0 12px 0 36px', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13.5, color: 'var(--fg)', fontFamily: 'inherit' }}/>
        </div>

        {view === 'month'
          ? <CalMonth days={days} anchor={anchor} evs={evs} tasksOn={tasksOn} onOpen={setModal} onDay={(d) => { setAnchor(d); setView('day'); }}/>
          : <CalTimeGrid days={days} evs={evs} tasksOn={tasksOn} onOpen={setModal} onSlot={newAt}/>}
      </div>
      {modal && <EventModal ev={modal} contacts={contacts} onSave={save} onDelete={del} onClose={() => setModal(null)}/>}
    </>
  );
}

function CalMonth({ days, anchor, evs, tasksOn, onOpen, onDay }) {
  const month = anchor.getMonth();
  const todayY = ymdOf(new Date());
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', background: 'var(--surface-hi)' }}>
        {WD_SHORT.map((w) => <div key={w} style={{ padding: '6px 8px', fontSize: 11, fontWeight: 600, color: 'var(--fg-3)', textAlign: 'center' }}>{w}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: 'minmax(96px, 1fr)' }}>
        {days.map((day, i) => {
          const inMonth = day.getMonth() === month;
          const isToday = ymdOf(day) === todayY;
          const dayEvs = evs.filter((e) => dayInEvent(e, day)).sort((a, b) => (b.all_day || b.type === 'absence' ? 1 : 0) - (a.all_day || a.type === 'absence' ? 1 : 0) || evStart(a) - evStart(b));
          const tks = tasksOn(day);
          const items = [...dayEvs, ...tks.map((t) => ({ _task: t }))];
          return (
            <div key={i} style={{ borderRight: (i % 7 !== 6) ? '1px solid var(--border)' : 'none', borderTop: i >= 7 ? '1px solid var(--border)' : 'none', padding: 5, background: inMonth ? 'transparent' : 'var(--surface)', minWidth: 0, cursor: 'pointer' }} onClick={() => onDay(day)}>
              <div style={{ fontSize: 11.5, fontWeight: isToday ? 700 : 500, color: isToday ? '#fff' : (inMonth ? 'var(--fg-2)' : 'var(--fg-4)'), width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: isToday ? 'var(--accent)' : 'transparent', marginBottom: 3 }}>{day.getDate()}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {items.slice(0, 3).map((it, j) => it._task
                  ? <div key={'t' + j} onClick={(ev) => { ev.stopPropagation(); }} style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'color-mix(in oklab, #eab308 20%, transparent)', color: '#eab308', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: it._task.done_at ? 'line-through' : 'none' }}>✓ {it._task.title}</div>
                  : <div key={j} onClick={(ev) => { ev.stopPropagation(); onOpen(it); }} style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'color-mix(in oklab, ' + folderDot(it.color) + ' 22%, transparent)', color: folderDot(it.color), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{(it.all_day || it.type === 'absence') ? '' : hm(evStart(it)) + ' '}{it.title}</div>)}
                {items.length > 3 && <div style={{ fontSize: 10, color: 'var(--fg-3)' }}>+{items.length - 3} mehr</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CalTimeGrid({ days, evs, tasksOn, onOpen, onSlot }) {
  const todayY = ymdOf(new Date());
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const allDayFor = (day) => evs.filter((e) => (e.all_day || e.type === 'absence') && dayInEvent(e, day));
  const timedFor = (day) => evs.filter((e) => !e.all_day && e.type !== 'absence' && sameYmd(evStart(e), day));
  const colTmpl = `52px repeat(${days.length}, 1fr)`;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: 'grid', gridTemplateColumns: colTmpl, background: 'var(--surface-hi)', borderBottom: '1px solid var(--border)' }}>
        <div/>
        {days.map((d, i) => { const isToday = ymdOf(d) === todayY; return (
          <div key={i} style={{ padding: '6px 4px', textAlign: 'center', borderLeft: '1px solid var(--border)' }}>
            <div style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{WD_SHORT[(d.getDay() + 6) % 7]}</div>
            <div style={{ fontSize: 14, fontWeight: isToday ? 700 : 540, color: isToday ? 'var(--accent)' : 'var(--fg)' }}>{d.getDate()}</div>
          </div>
        ); })}
      </div>
      {/* All-day band */}
      <div style={{ display: 'grid', gridTemplateColumns: colTmpl, borderBottom: '1px solid var(--border)', minHeight: 26 }}>
        <div style={{ fontSize: 9, color: 'var(--fg-4)', padding: '4px', textAlign: 'right' }}>ganzt.</div>
        {days.map((d, i) => (
          <div key={i} style={{ borderLeft: '1px solid var(--border)', padding: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {allDayFor(d).map((e) => <div key={e.id} onClick={() => onOpen(e)} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, cursor: 'pointer', background: e.type === 'absence' ? 'color-mix(in oklab, #d97706 30%, transparent)' : 'color-mix(in oklab, ' + folderDot(e.color) + ' 26%, transparent)', color: e.type === 'absence' ? '#f59e0b' : folderDot(e.color), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.title}{e.person ? ' · ' + e.person : ''}</div>)}
            {tasksOn(d).map((t) => <div key={'t' + t.id} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'color-mix(in oklab, #eab308 20%, transparent)', color: '#eab308', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: t.done_at ? 'line-through' : 'none' }}>✓ {t.title}</div>)}
          </div>
        ))}
      </div>
      {/* Hours grid */}
      <div style={{ overflowY: 'auto', maxHeight: '58vh' }}>
        <div style={{ display: 'grid', gridTemplateColumns: colTmpl, position: 'relative' }}>
          <div>
            {hours.map((h) => <div key={h} style={{ height: HOUR_H, fontSize: 9.5, color: 'var(--fg-4)', textAlign: 'right', paddingRight: 6, transform: 'translateY(-6px)' }}>{h > 0 ? String(h).padStart(2, '0') + ':00' : ''}</div>)}
          </div>
          {days.map((day, di) => (
            <div key={di} style={{ borderLeft: '1px solid var(--border)', position: 'relative' }}>
              {hours.map((h) => <div key={h} onClick={() => onSlot(day, h)} style={{ height: HOUR_H, borderTop: '1px solid var(--border)', cursor: 'pointer' }}/>)}
              {timedFor(day).map((e) => {
                const s = evStart(e), en = evEnd(e);
                const top = (s.getHours() * 60 + s.getMinutes()) / 60 * HOUR_H;
                const dur = Math.max(20, (Math.min(24 * 60, (en.getHours() * 60 + en.getMinutes())) - (s.getHours() * 60 + s.getMinutes())) / 60 * HOUR_H);
                return (
                  <div key={e.id} onClick={() => onOpen(e)} style={{ position: 'absolute', top, left: 2, right: 2, height: dur, background: 'color-mix(in oklab, ' + folderDot(e.color) + ' 26%, var(--surface))', borderLeft: '3px solid ' + folderDot(e.color), borderRadius: 4, padding: '2px 5px', overflow: 'hidden', cursor: 'pointer' }}>
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: folderDot(e.color), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.title}</div>
                    <div style={{ fontSize: 9.5, color: 'var(--fg-3)' }}>{hm(s)}–{hm(en)}{e.location ? ' · ' + e.location : ''}</div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EventModal({ ev, contacts, onSave, onDelete, onClose }) {
  const pad = (n) => String(n).padStart(2, '0');
  const toDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const s0 = ev.starts_at ? new Date(ev.starts_at.replace(' ', 'T')) : (ev._start || new Date());
  const e0 = ev.ends_at ? new Date(ev.ends_at.replace(' ', 'T')) : (ev._end || new Date(s0.getTime() + 3600000));
  const [title, setTitle] = useState(ev.title || '');
  const [type, setType] = useState(ev.type || 'event');
  const [allDay, setAllDay] = useState(!!ev.all_day || ev.type === 'absence');
  const [sDate, setSDate] = useState(toDate(s0));
  const [sTime, setSTime] = useState(toTime(s0));
  const [eDate, setEDate] = useState(toDate(e0));
  const [eTime, setETime] = useState(toTime(e0));
  const [location, setLocation] = useState(ev.location || '');
  const [person, setPerson] = useState(ev.person || '');
  const [contactId, setContactId] = useState(ev.contact_id ? String(ev.contact_id) : '');
  const [color, setColor] = useState(ev.color || 'violet');
  const [note, setNote] = useState(ev.note || '');
  const [busy, setBusy] = useState(false);
  const isAbsence = type === 'absence';
  const fullDay = allDay || isAbsence;

  const submit = async () => {
    if (!title.trim()) { toast('Titel erforderlich', 'error'); return; }
    const starts = fullDay ? `${sDate}T00:00` : `${sDate}T${sTime}`;
    const ends = fullDay ? `${eDate}T23:59` : `${eDate}T${eTime}`;
    setBusy(true);
    await onSave({ id: ev.id, title: title.trim(), type, all_day: fullDay ? 1 : 0, starts_at: starts, ends_at: ends, location: location.trim() || null, person: person.trim() || null, contact_id: contactId || null, color, note: note.trim() || null });
    setBusy(false);
  };
  const fld = { height: 42, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', width: '100%' };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 480, borderRadius: 'var(--r-xl)', overflow: 'hidden', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.clock(18)}</div>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>{ev.id ? 'Termin bearbeiten' : 'Neuer Termin'}</h2>
          {ev.id && <IconBtn size={32} title="Löschen" onClick={() => onDelete(ev)}>{Ic.trash(16)}</IconBtn>}
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 13, overflowY: 'auto' }}>
          {ev.id && ev.created_by_name && <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>Erstellt von {ev.created_by_name}</div>}
          <input value={title} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder={isAbsence ? 'z. B. Urlaub' : 'Titel'} style={{ ...fld, fontSize: 15 }}/>
          <div style={{ display: 'flex', gap: 8 }}>
            {[['event', 'Termin'], ['absence', 'Urlaub/Abwesenheit']].map(([k, l]) => (
              <button key={k} onClick={() => setType(k)} style={{ flex: 1, height: 36, borderRadius: 'var(--r-sm)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 540, border: '1px solid ' + (type === k ? 'var(--accent)' : 'var(--border)'), background: type === k ? 'color-mix(in oklab, var(--accent) 14%, transparent)' : 'var(--surface-hi)', color: type === k ? 'var(--accent)' : 'var(--fg-2)' }}>{l}</button>
            ))}
          </div>
          {!isAbsence && <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13.5 }}><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} style={{ width: 17, height: 17, accentColor: 'var(--accent)' }}/> Ganztägig</label>}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ flex: '1 1 130px', display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Von</span><input type="date" value={sDate} onChange={(e) => setSDate(e.target.value)} style={fld}/></label>
            {!fullDay && <label style={{ width: 110, display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Beginn</span><input type="time" value={sTime} onChange={(e) => setSTime(e.target.value)} style={fld}/></label>}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ flex: '1 1 130px', display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Bis</span><input type="date" value={eDate} onChange={(e) => setEDate(e.target.value)} style={fld}/></label>
            {!fullDay && <label style={{ width: 110, display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Ende</span><input type="time" value={eTime} onChange={(e) => setETime(e.target.value)} style={fld}/></label>}
          </div>
          {isAbsence
            ? <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Person</span><input value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Name" style={fld}/></label>
            : <>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Ort</span><input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Ort (optional)" style={fld}/></label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Kunde</span>
                  <select value={contactId} onChange={(e) => setContactId(e.target.value)} style={{ ...fld, cursor: 'pointer' }}><option value="">— keiner —</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                </label>
              </>}
          <div>
            <div style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)', marginBottom: 8 }}>Farbe</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {FOLDER_SWATCHES.map((sw) => <button key={sw.key} onClick={() => setColor(sw.key)} style={{ width: 26, height: 26, borderRadius: '50%', cursor: 'pointer', background: sw.dot, border: color === sw.key ? '2px solid var(--fg)' : '2px solid transparent' }}/>)}
            </div>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Notiz</span><textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Optional" style={{ ...fld, height: 'auto', padding: '10px 12px', resize: 'vertical' }}/></label>
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} onClick={submit} icon={busy ? Ic.loader(15) : Ic.check(15)}>Speichern</Btn>
        </div>
      </Glass>
    </div>
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
  const forever = async (f) => { if (!await confirmDialog({ title: 'Endgültig löschen?', message: `„${f.name}" wird unwiderruflich gelöscht. Das kann nicht rückgängig gemacht werden.`, confirmLabel: 'Endgültig löschen', danger: true })) return; try { await API.deleteForever(f.id); toast('Endgültig gelöscht', 'success'); load(); afterChange && afterChange(); } catch (e) { toast(e.message, 'error'); } };
  const empty = async () => { if (!await confirmDialog({ title: 'Papierkorb leeren?', message: 'Alle Dateien im Papierkorb werden unwiderruflich gelöscht.', confirmLabel: 'Papierkorb leeren', danger: true })) return; try { await API.emptyTrash(); toast('Papierkorb geleert', 'success'); load(); afterChange && afterChange(); } catch (e) { toast(e.message, 'error'); } };

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
              <div key={f.id} className="nyza-listrow" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <FileIcon kind={f.kind} size={16} tint={f.hue}/>
                <div className="nyza-listrow-main" style={{ flex: 1, minWidth: 0 }}>
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
