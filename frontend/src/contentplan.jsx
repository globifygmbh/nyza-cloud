// Content Plan — per-client editorial calendar with monthly approval links.
//
// Two faces of the same data:
//   <ContentPlanApp/>          the team's view (clients, month calendar, editor)
//   <PublicContentPlanPage/>   what the customer opens via /cp/:token — one
//                              month of one client, with approve / rework /
//                              reject per item and a comment thread.
//
// Kept in its own module (not app.jsx) and importing only shared primitives so
// there is no import cycle between app.jsx and the public page.

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { API } from './api.js';
import { Ic, Glass, Btn, IconBtn, NyzaWordmark, humanSize } from './system.jsx';
import { toast } from './toast.jsx';
import { confirmDialog } from './overlays.jsx';

// ───────────────────────── vocab ─────────────────────────────────────────────

export const CP_FORMATS = [
  { id: 'post',  label: 'Beitrag',      short: 'B',  icon: (s) => Ic.images(s) },
  { id: 'story', label: 'Story',        short: 'S',  icon: (s) => Ic.clock(s) },
  { id: 'reel',  label: 'Reel / TikTok', short: 'R', icon: (s) => Ic.fileVid(s) },
];
export const CP_PLATFORMS = [
  { id: 'instagram', label: 'Instagram', color: '#e1306c' },
  { id: 'facebook',  label: 'Facebook',  color: '#1877f2' },
  { id: 'tiktok',    label: 'TikTok',    color: '#111111' },
  { id: 'linkedin',  label: 'LinkedIn',  color: '#0a66c2' },
  { id: 'youtube',   label: 'YouTube',   color: '#ff0000' },
  { id: 'pinterest', label: 'Pinterest', color: '#bd081c' },
];
export const CP_STATUS = {
  idea:      { label: 'Idee',            color: '#94a3b8' },
  draft:     { label: 'In Arbeit',       color: '#f59e0b' },
  ready:     { label: 'Zur Freigabe',    color: '#7c5cff' },
  scheduled: { label: 'Eingeplant',      color: '#0ea5e9' },
  posted:    { label: 'Gepostet',        color: '#22c55e' },
};
export const CP_REVIEW = {
  pending:  { label: 'Offen',        color: '#94a3b8' },
  approved: { label: 'Freigegeben',  color: '#22c55e' },
  revision: { label: 'Überarbeiten', color: '#f59e0b' },
  rejected: { label: 'Abgelehnt',    color: '#ef4444' },
};

const MONTHS = ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const todayStr = () => { const t = new Date(); return ymd(t.getFullYear(), t.getMonth() + 1, t.getDate()); };
const fmtDate = (s) => { if (!s) return ''; const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`; };
const fmtWeekday = (s) => { const d = new Date(s + 'T00:00:00'); return ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()]; };

function useIsMobile(bp = 760) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.innerWidth < bp);
  useEffect(() => {
    const on = () => setM(window.innerWidth < bp);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [bp]);
  return m;
}

/** Cells for a Monday-first month grid: leading nulls, then 1..N, then trailing nulls. */
function monthCells(year, month) {
  const first = new Date(year, month - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  return cells;
}

const fld = { height: 40, padding: '0 10px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 13.5, color: 'var(--fg)', fontFamily: 'inherit', width: '100%' };
const area = { ...fld, height: 'auto', padding: '9px 10px', resize: 'vertical', lineHeight: 1.45 };
const lbl = { fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' };

function Pill({ color, children, title, style = {} }) {
  return (
    <span title={title} style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: '3px 8px', borderRadius: 999, textTransform: 'uppercase', background: 'color-mix(in oklab, ' + color + ' 18%, transparent)', color, flexShrink: 0, whiteSpace: 'nowrap', ...style }}>{children}</span>
  );
}

/** Multi-select chip row. */
function Chips({ options, value, onChange, render }) {
  const set = new Set(value || []);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {options.map((o) => {
        const on = set.has(o.id);
        return (
          <button key={o.id} type="button" onClick={() => { const n = new Set(set); on ? n.delete(o.id) : n.add(o.id); onChange([...n]); }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 999, fontSize: 12.5, fontWeight: 540, cursor: 'pointer', fontFamily: 'inherit',
              background: on ? 'color-mix(in oklab, ' + (o.color || 'var(--accent)') + ' 16%, transparent)' : 'var(--surface-hi)',
              border: '1.5px solid ' + (on ? (o.color || 'var(--accent)') : 'var(--border)'), color: on ? (o.color || 'var(--accent)') : 'var(--fg-2)' }}>
            {render ? render(o, on) : o.label}
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────── preview (phone frame) ────────────────────────────

/**
 * A rough platform-style preview so the customer sees roughly how it will look.
 * Shows the first 'result' media (falls back to 'idea'), in a 4:5 feed frame or
 * a 9:16 story frame depending on the item's formats.
 */
export function ContentPreview({ item, clientName, mediaUrl, style = {} }) {
  const media = (item.media || []);
  const main = media.find((m) => m.kind === 'result' && (m.is_image || m.is_video)) || media.find((m) => m.is_image || m.is_video);
  const formats = item.formats || [];
  const story = formats.includes('story') && !formats.includes('post');
  const reel = formats.includes('reel') && !formats.includes('post') && !story;
  const tall = story || reel;
  const initial = (clientName || '?').slice(0, 1).toUpperCase();
  const caption = (item.caption || item.idea || '').trim();

  return (
    <div style={{ width: '100%', maxWidth: 300, margin: '0 auto', ...style }}>
      <div style={{ borderRadius: 28, background: '#000', padding: 8, boxShadow: '0 20px 50px -20px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08)' }}>
        <div style={{ borderRadius: 22, overflow: 'hidden', background: '#0b0b0f', color: '#fff', fontFamily: 'inherit', position: 'relative', aspectRatio: tall ? '9 / 17.5' : '9 / 16.5', display: 'flex', flexDirection: 'column' }}>
          {!tall && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 8px' }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg,#f9ce34,#ee2a7b,#6228d7)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}>{initial}</div>
              <div style={{ fontSize: 12, fontWeight: 600, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{clientName || 'Kunde'}</div>
              <span style={{ opacity: 0.8 }}>{Ic.more(14)}</span>
            </div>
          )}
          <div style={{ position: 'relative', flex: tall ? 1 : 'none', aspectRatio: tall ? undefined : '4 / 5', background: '#1a1a22', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            {main ? (
              main.is_video
                ? <video src={mediaUrl(main.id)} muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
                : <img src={mediaUrl(main.id)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
            ) : (
              <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11.5, textAlign: 'center', padding: 20 }}>{Ic.images(26)}<div style={{ marginTop: 8 }}>Noch kein Bild/Video</div></div>
            )}
            {tall && (<>
              <div style={{ position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', gap: 3 }}>{[0, 1, 2].map((i) => <div key={i} style={{ flex: 1, height: 2.5, borderRadius: 2, background: i === 0 ? '#fff' : 'rgba(255,255,255,0.35)' }}/>)}</div>
              <div style={{ position: 'absolute', top: 18, left: 10, display: 'flex', alignItems: 'center', gap: 7 }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'linear-gradient(135deg,#f9ce34,#ee2a7b,#6228d7)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>{initial}</div>
                <span style={{ fontSize: 11.5, fontWeight: 600, textShadow: '0 1px 3px rgba(0,0,0,0.6)' }}>{clientName || 'Kunde'}</span>
              </div>
              {reel && (
                <div style={{ position: 'absolute', right: 8, bottom: 70, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', opacity: 0.95 }}>
                  <div style={{ textAlign: 'center', fontSize: 9 }}>♥<div>2.1K</div></div>
                  <div style={{ textAlign: 'center', fontSize: 9 }}>{Ic.comment(16)}<div>184</div></div>
                  <div style={{ textAlign: 'center', fontSize: 9 }}>{Ic.share(16)}<div>96</div></div>
                </div>
              )}
              {caption && (
                <div style={{ position: 'absolute', left: 10, right: reel ? 48 : 10, bottom: 14, fontSize: 11, lineHeight: 1.4, textShadow: '0 1px 3px rgba(0,0,0,0.7)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{caption}</div>
              )}
            </>)}
          </div>
          {!tall && (
            <div style={{ padding: '10px 12px 14px', fontSize: 11.5, lineHeight: 1.45 }}>
              <div style={{ display: 'flex', gap: 14, marginBottom: 8, opacity: 0.9 }}><span>♥</span>{Ic.comment(14)}{Ic.share(14)}</div>
              <div style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                <b style={{ marginRight: 5 }}>{clientName || 'Kunde'}</b>{caption || <span style={{ opacity: 0.45 }}>Noch kein Text</span>}
              </div>
            </div>
          )}
        </div>
      </div>
      <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--fg-4)', marginTop: 8 }}>Vorschau — Orientierung, nicht pixelgenau</div>
    </div>
  );
}

// ───────────────────────── media strip ──────────────────────────────────────

function MediaStrip({ media, mediaUrl, onOpen, onDelete, compact }) {
  if (!media || !media.length) return null;
  const sz = compact ? 56 : 84;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {media.map((m) => (
        <div key={m.id} style={{ position: 'relative', width: sz, height: sz, borderRadius: 10, overflow: 'hidden', background: 'var(--surface-hi)', border: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => onOpen && onOpen(m)} title={m.name}>
          {m.is_image ? <img src={mediaUrl(m.id)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
            : m.is_video ? <video src={mediaUrl(m.id)} muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
            : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-3)' }}>{Ic.fileGen(20)}</div>}
          {m.is_video && <span style={{ position: 'absolute', left: 4, bottom: 4, color: '#fff', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.7))' }}>{Ic.fileVid(12)}</span>}
          {onDelete && (
            <span onClick={(e) => { e.stopPropagation(); onDelete(m); }} title="Entfernen" style={{ position: 'absolute', top: 3, right: 3, width: 18, height: 18, borderRadius: '50%', background: 'rgba(0,0,0,0.6)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.close(10)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function Lightbox({ media, url, onClose }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      {media.is_video
        ? <video src={url} controls autoPlay playsInline style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8 }} onClick={(e) => e.stopPropagation()}/>
        : media.is_image
          ? <img src={url} alt="" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8 }} onClick={(e) => e.stopPropagation()}/>
          : <a href={url + '&download=1'} onClick={(e) => e.stopPropagation()} style={{ color: '#fff' }}>{media.name} herunterladen</a>}
      <span style={{ position: 'absolute', top: 16, right: 16, color: '#fff', cursor: 'pointer' }}>{Ic.close(22)}</span>
    </div>
  );
}

// ───────────────────────── month grid (shared) ──────────────────────────────

/**
 * Calendar for one month. `items` are already filtered to that month; several
 * per day are normal. `renderChip` draws one item inside a cell.
 */
function MonthGrid({ year, month, items, onDay, onItem, renderChip, mobile, highlightGaps }) {
  const cells = useMemo(() => monthCells(year, month), [year, month]);
  const byDay = useMemo(() => {
    const m = {};
    for (const it of items) (m[it.plan_date] ||= []).push(it);
    return m;
  }, [items]);
  const today = todayStr();

  if (mobile) {
    // Agenda: every day of the month, so gaps are as visible as content.
    const days = cells.filter(Boolean);
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 6 }}>
        {days.map((d) => {
          const key = ymd(year, month, d);
          const list = byDay[key] || [];
          const isToday = key === today;
          return (
            <div key={d} onClick={() => onDay && onDay(key)} style={{ display: 'flex', gap: 10, padding: '8px 10px', borderRadius: 'var(--r-sm)', background: list.length ? 'var(--surface)' : 'transparent', border: '1px solid ' + (list.length ? 'var(--border)' : 'transparent'), cursor: onDay ? 'pointer' : 'default', opacity: list.length ? 1 : 0.55 }}>
              <div style={{ width: 38, flexShrink: 0, textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: 'var(--fg-3)' }}>{fmtWeekday(key)}</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: isToday ? 'var(--accent)' : 'var(--fg)' }}>{d}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {list.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--fg-4)', paddingTop: 6 }}>—</div>}
                {list.map((it) => <div key={it.id} onClick={(e) => { e.stopPropagation(); onItem && onItem(it); }}>{renderChip(it)}</div>)}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0,1fr))', gap: 6, marginBottom: 6 }}>
        {WEEKDAYS.map((w) => <div key={w} style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-3)', textAlign: 'center', letterSpacing: 0.5 }}>{w}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0,1fr))', gap: 6 }}>
        {cells.map((d, i) => {
          if (!d) return <div key={'e' + i} style={{ minHeight: 96, borderRadius: 'var(--r-sm)', background: 'transparent' }}/>;
          const key = ymd(year, month, d);
          const list = byDay[key] || [];
          const isToday = key === today;
          const gap = highlightGaps && list.length === 0 && key >= today;
          return (
            <div key={key} onClick={() => onDay && onDay(key)} style={{ minHeight: 96, borderRadius: 'var(--r-sm)', background: 'var(--surface)', border: '1px solid ' + (isToday ? 'var(--accent)' : gap ? 'color-mix(in oklab, #f59e0b 45%, var(--border))' : 'var(--border)'), padding: 6, display: 'flex', flexDirection: 'column', gap: 4, cursor: onDay ? 'pointer' : 'default', minWidth: 0, borderStyle: gap ? 'dashed' : 'solid' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: isToday ? 'var(--accent)' : 'var(--fg-2)' }}>{d}</span>
                {list.length > 0 && <span style={{ fontSize: 9.5, color: 'var(--fg-4)' }}>{list.length}</span>}
              </div>
              {list.map((it) => <div key={it.id} onClick={(e) => { e.stopPropagation(); onItem && onItem(it); }}>{renderChip(it)}</div>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The small card inside a calendar cell. Colour = customer verdict. */
function ItemChip({ item, dense, mediaUrl }) {
  const rv = CP_REVIEW[item.review_status] || CP_REVIEW.pending;
  const st = CP_STATUS[item.status] || CP_STATUS.idea;
  const fm = (item.formats || []).map((f) => CP_FORMATS.find((x) => x.id === f)?.short).filter(Boolean).join('+');
  const media = item.media || [];
  const thumb = media.find((m) => m.kind === 'result' && m.is_image) || media.find((m) => m.is_image);
  const hasResult = media.some((m) => m.kind === 'result');
  return (
    <div title={item.title} style={{ borderRadius: 7, overflow: 'hidden', background: 'color-mix(in oklab, ' + rv.color + ' 14%, var(--surface-hi))', borderLeft: '3px solid ' + rv.color, fontSize: 11, minWidth: 0, cursor: 'pointer' }}>
      {thumb && mediaUrl && !dense && (
        <div style={{ height: 44, background: 'var(--surface-hi)' }}><img src={mediaUrl(thumb.id)} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}/></div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: dense ? '3px 6px' : '4px 7px' }}>
        {item.plan_time && <span style={{ fontSize: 9.5, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{item.plan_time}</span>}
        {fm && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--fg-3)', flexShrink: 0 }}>{fm}</span>}
        <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 520 }}>{item.title}</span>
        {item.linked_to_id && <span title="Gehört zu einem anderen Eintrag" style={{ color: 'var(--fg-4)', flexShrink: 0 }}>{Ic.link(10)}</span>}
        {hasResult && <span title="Ergebnis hochgeladen" style={{ color: st.color, flexShrink: 0 }}>{Ic.check(10)}</span>}
      </div>
    </div>
  );
}

// ───────────────────────── comments thread (shared) ─────────────────────────

function Thread({ comments, onSend, placeholder, sending }) {
  const [txt, setTxt] = useState('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {(comments || []).length === 0 && <div style={{ fontSize: 12, color: 'var(--fg-4)' }}>Noch keine Kommentare.</div>}
      {(comments || []).map((c) => {
        const dec = c.decision ? CP_REVIEW[c.decision] : null;
        return (
          <div key={c.id} style={{ padding: '8px 10px', borderRadius: 'var(--r-sm)', background: c.from_team ? 'color-mix(in oklab, var(--accent) 8%, var(--surface-hi))' : 'var(--surface-hi)', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600 }}>{c.author}</span>
              {dec && <Pill color={dec.color}>{dec.label}</Pill>}
              <span style={{ fontSize: 10.5, color: 'var(--fg-4)', marginLeft: 'auto' }}>{(c.created_at || '').slice(0, 16).replace('T', ' ')}</span>
            </div>
            <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{c.body}</div>
          </div>
        );
      })}
      {onSend && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={txt} onChange={(e) => setTxt(e.target.value)} placeholder={placeholder || 'Kommentar…'} onKeyDown={(e) => { if (e.key === 'Enter' && txt.trim()) { onSend(txt.trim()); setTxt(''); } }} style={fld}/>
          <Btn variant="primary" size="md" disabled={!txt.trim() || sending} onClick={() => { if (txt.trim()) { onSend(txt.trim()); setTxt(''); } }}>Senden</Btn>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════ TEAM APP ═════════════════════════════════════════

function ItemEditor({ item, date, clientId, clientName, siblings, onClose, onSaved, onDeleted }) {
  const isNew = !item?.id;
  const [it, setIt] = useState(() => item?.id ? item : { plan_date: date, plan_time: '', title: '', idea: '', caption: '', formats: ['post'], platforms: ['instagram'], status: 'idea', linked_to_id: null, media: [], comments: [], review_status: 'pending' });
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [uploading, setUploading] = useState(null);
  const ideaRef = useRef(null);
  const resultRef = useRef(null);
  const set = (k, v) => setIt((s) => ({ ...s, [k]: v }));

  // A new item has no id to attach media to — save first, then upload.
  const ensureSaved = async () => {
    if (it.id) return it.id;
    const d = await API.cpCreateItem({ client_id: clientId, plan_date: it.plan_date, plan_time: it.plan_time || null, title: it.title, idea: it.idea, caption: it.caption, formats: it.formats, platforms: it.platforms, status: it.status, linked_to_id: it.linked_to_id });
    setIt(d.item);
    onSaved && onSaved(d.item, true);
    return d.item.id;
  };

  const save = async (close = true) => {
    setBusy(true);
    try {
      let saved;
      if (it.id) {
        const d = await API.cpUpdateItem(it.id, { plan_date: it.plan_date, plan_time: it.plan_time || null, title: it.title, idea: it.idea, caption: it.caption, formats: it.formats, platforms: it.platforms, status: it.status, linked_to_id: it.linked_to_id });
        saved = d.item;
      } else {
        const d = await API.cpCreateItem({ client_id: clientId, plan_date: it.plan_date, plan_time: it.plan_time || null, title: it.title, idea: it.idea, caption: it.caption, formats: it.formats, platforms: it.platforms, status: it.status, linked_to_id: it.linked_to_id });
        saved = d.item;
      }
      setIt(saved);
      onSaved && onSaved(saved, isNew);
      toast('Gespeichert', 'success');
      if (close) onClose();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  const upload = async (kind, files) => {
    if (!files || !files.length) return;
    setUploading(kind);
    try {
      const id = await ensureSaved();
      let last = null;
      for (const f of Array.from(files)) last = await API.cpUploadMedia(id, f, kind);
      if (last) { setIt(last.item); onSaved && onSaved(last.item, false); }
      toast(files.length > 1 ? files.length + ' Dateien hochgeladen' : 'Hochgeladen', 'success');
    } catch (e) { toast(e.message, 'error'); } finally { setUploading(null); }
  };

  const delMedia = async (m) => {
    try { await API.cpDeleteMedia(m.id); const d = await API.cpItem(it.id); setIt(d.item); onSaved && onSaved(d.item, false); } catch (e) { toast(e.message, 'error'); }
  };

  const del = async () => {
    if (!await confirmDialog({ title: 'Eintrag löschen?', message: `„${it.title || 'Ohne Titel'}" wird samt Dateien und Kommentaren gelöscht.`, confirmLabel: 'Löschen', danger: true })) return;
    try { await API.cpDeleteItem(it.id); onDeleted && onDeleted(it); onClose(); } catch (e) { toast(e.message, 'error'); }
  };

  const duplicate = async () => {
    try { const d = await API.cpDuplicateItem(it.id, it.plan_date); onSaved && onSaved(d.item, true); toast('Dupliziert — der neue Eintrag liegt am selben Tag', 'success'); onClose(); }
    catch (e) { toast(e.message, 'error'); }
  };

  const resetReview = async () => {
    try { const d = await API.cpUpdateItem(it.id, { review_status: 'pending' }); setIt(d.item); onSaved && onSaved(d.item, false); toast('Freigabe zurückgesetzt — der Kunde sieht den Eintrag wieder als offen', 'success'); } catch (e) { toast(e.message, 'error'); }
  };

  const comment = async (body) => {
    try { const id = await ensureSaved(); const d = await API.cpAddComment(id, body); setIt((s) => ({ ...s, comments: d.comments })); } catch (e) { toast(e.message, 'error'); }
  };

  const rv = CP_REVIEW[it.review_status] || CP_REVIEW.pending;
  const ideaMedia = (it.media || []).filter((m) => m.kind === 'idea');
  const resultMedia = (it.media || []).filter((m) => m.kind === 'result');
  const linkable = (siblings || []).filter((s) => s.id !== it.id);

  const Drop = ({ kind, inputRef, label, hint }) => (
    <div onClick={() => inputRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); upload(kind, e.dataTransfer.files); }}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 'var(--r-sm)', border: '1.5px dashed var(--border-hi)', background: 'var(--surface-hi)', cursor: 'pointer', color: 'var(--fg-3)', fontSize: 12.5 }}>
      <span style={{ color: 'var(--accent)' }}>{uploading === kind ? Ic.loader(16) : Ic.upload(16)}</span>
      <span><b style={{ color: 'var(--fg)', fontWeight: 540 }}>{label}</b> — {hint}</span>
      <input ref={inputRef} type="file" multiple accept="image/*,video/*,.pdf" style={{ display: 'none' }} onChange={(e) => { upload(kind, e.target.files); e.target.value = ''; }}/>
    </div>
  );

  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 1040, borderRadius: 'var(--r-xl)', overflow: 'hidden', maxHeight: '94vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0, minWidth: 160 }}>{isNew ? 'Neuer Eintrag' : it.title || 'Eintrag'}</h2>
          {!isNew && <Pill color={rv.color} title={it.review_comment || ''}>{rv.label}</Pill>}
          {!isNew && it.review_status !== 'pending' && <Btn variant="glass" size="sm" icon={Ic.rotate(13)} onClick={resetReview}>Freigabe zurücksetzen</Btn>}
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>

        <div className="nyza-cp-editor" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 0, overflowY: 'auto', flex: 1 }}>
          <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0, borderRight: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ flex: '1 1 150px', display: 'flex', flexDirection: 'column', gap: 5 }}><span style={lbl}>Datum</span><input type="date" value={it.plan_date || ''} onChange={(e) => set('plan_date', e.target.value)} style={fld}/></label>
              <label style={{ flex: '0 1 120px', display: 'flex', flexDirection: 'column', gap: 5 }}><span style={lbl}>Uhrzeit</span><input type="time" value={it.plan_time || ''} onChange={(e) => set('plan_time', e.target.value)} style={fld}/></label>
              <label style={{ flex: '1 1 170px', display: 'flex', flexDirection: 'column', gap: 5 }}><span style={lbl}>Interner Status</span>
                <select value={it.status} onChange={(e) => set('status', e.target.value)} style={{ ...fld, cursor: 'pointer' }}>{Object.entries(CP_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
              </label>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={lbl}>Titel / Thema</span><input value={it.title} autoFocus={isNew} onChange={(e) => set('title', e.target.value)} placeholder="z. B. Gewinnspiel Sommer" style={fld}/></label>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={lbl}>Format <span style={{ color: 'var(--fg-4)', fontWeight: 400 }}>— mehrere möglich, z. B. Beitrag + Story</span></span>
              <Chips options={CP_FORMATS} value={it.formats} onChange={(v) => set('formats', v)} render={(o) => <>{o.icon(13)} {o.label}</>}/>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={lbl}>Plattformen</span>
              <Chips options={CP_PLATFORMS} value={it.platforms} onChange={(v) => set('platforms', v)}/>
            </div>
            {linkable.length > 0 && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={lbl}>Gehört zu <span style={{ color: 'var(--fg-4)', fontWeight: 400 }}>— z. B. die Story, die auf den Beitrag verlinkt</span></span>
                <select value={it.linked_to_id || ''} onChange={(e) => set('linked_to_id', e.target.value ? Number(e.target.value) : null)} style={{ ...fld, cursor: 'pointer' }}>
                  <option value="">— eigenständig —</option>
                  {linkable.map((s) => <option key={s.id} value={s.id}>{fmtDate(s.plan_date)} · {s.title}</option>)}
                </select>
              </label>
            )}

            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={lbl}>Idee / Briefing <span style={{ color: 'var(--fg-4)', fontWeight: 400 }}>— was soll gezeigt werden?</span></span>
              <textarea value={it.idea || ''} onChange={(e) => set('idea', e.target.value)} rows={3} placeholder="Konzept, Bildidee, Ablauf…" style={area}/></label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Drop kind="idea" inputRef={ideaRef} label="Idee-Material" hint="Referenzen, Skizzen, Moodbilder"/>
              <MediaStrip media={ideaMedia} mediaUrl={(id) => API.cpMediaUrl(id)} onOpen={setViewing} onDelete={delMedia} compact/>
            </div>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={lbl}>Text / Caption <span style={{ color: 'var(--fg-4)', fontWeight: 400 }}>— so wie er gepostet wird, inkl. Hashtags</span></span>
              <textarea value={it.caption || ''} onChange={(e) => set('caption', e.target.value)} rows={4} placeholder="Caption…" style={area}/></label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Drop kind="result" inputRef={resultRef} label="Fertiges Ergebnis" hint="Bild / Video, das der Kunde freigibt"/>
              <MediaStrip media={resultMedia} mediaUrl={(id) => API.cpMediaUrl(id)} onOpen={setViewing} onDelete={delMedia}/>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              <span style={lbl}>Kommentare {it.review_comment && it.review_status !== 'pending' && <span style={{ color: rv.color, fontWeight: 400 }}>— Kunde: „{it.review_comment}"</span>}</span>
              <Thread comments={it.comments} onSend={comment} placeholder="Antwort an den Kunden / interne Notiz…"/>
            </div>
          </div>

          <div style={{ padding: '18px 18px' }}>
            <ContentPreview item={it} clientName={clientName} mediaUrl={(id) => API.cpMediaUrl(id)}/>
            {it.reviewed_at && (
              <div style={{ marginTop: 14, fontSize: 11.5, color: 'var(--fg-3)', textAlign: 'center' }}>
                {rv.label} von {it.reviewed_by || 'Kunde'} · {(it.reviewed_at || '').slice(0, 16).replace('T', ' ')}
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
          {!isNew && <Btn variant="ghost" icon={Ic.trash(14)} onClick={del} style={{ color: '#ef4444' }}>Löschen</Btn>}
          {!isNew && <Btn variant="ghost" icon={Ic.copy(14)} onClick={duplicate} title="Kopie am selben Tag anlegen — Datum danach im neuen Eintrag ändern">Duplizieren</Btn>}
          <span style={{ flex: 1 }}/>
          <Btn variant="ghost" onClick={onClose}>Schließen</Btn>
          <Btn variant="primary" disabled={busy} icon={busy ? Ic.loader(15) : Ic.check(15)} onClick={() => save(true)}>Speichern</Btn>
        </div>
      </Glass>
      {viewing && <Lightbox media={viewing} url={API.cpMediaUrl(viewing.id)} onClose={() => setViewing(null)}/>}
    </div>
  );
}

function ShareModal({ client, year, month, onClose }) {
  const [share, setShare] = useState(null);
  const [pw, setPw] = useState('');
  const [intro, setIntro] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    API.cpCreateShare({ client_id: client.id, year, month }).then((d) => { setShare(d.share); setIntro(d.share.intro || ''); }).catch((e) => toast(e.message, 'error'));
  }, [client.id, year, month]);
  const link = share ? location.origin + (window.NYZA_BASE || '') + '/cp/' + share.token : '';
  const copy = () => { navigator.clipboard?.writeText(link).then(() => toast('Link kopiert', 'success')).catch(() => {}); };
  const save = async () => {
    setBusy(true);
    try { const body = { intro }; if (pw !== '') body.password = pw; const d = await API.cpUpdateShare(share.id, body); setShare(d.share); setPw(''); toast('Gespeichert', 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const clearPw = async () => { try { const d = await API.cpUpdateShare(share.id, { password: '' }); setShare(d.share); toast('Passwort entfernt', 'success'); } catch (e) { toast(e.message, 'error'); } };
  const revoke = async () => {
    if (!await confirmDialog({ title: 'Link zurückziehen?', message: 'Der Kunde kann diesen Monat dann nicht mehr öffnen. Beim nächsten Teilen entsteht ein neuer Link.', confirmLabel: 'Zurückziehen', danger: true })) return;
    try { await API.cpDeleteShare(share.id); onClose(); toast('Link zurückgezogen', 'success'); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 520, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0 }}>{MONTHS[month - 1]} {year} teilen · {client.name}</h2>
          <IconBtn size={30} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!share ? <div style={{ color: 'var(--fg-3)' }}>{Ic.loader(18)}</div> : (<>
            <div style={{ fontSize: 12.5, color: 'var(--fg-3)', lineHeight: 1.5 }}>
              Der Link bleibt für diesen Monat immer gleich — alles, was du später hinzufügst oder änderst, sieht der Kunde automatisch. Einträge mit Status „Idee" bleiben intern.
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input readOnly value={link} onFocus={(e) => e.target.select()} style={{ ...fld, fontSize: 12.5 }}/>
              <Btn variant="primary" size="md" icon={Ic.copy(14)} onClick={copy}>Kopieren</Btn>
              <Btn variant="glass" size="md" icon={Ic.eye(14)} onClick={() => window.open(link, '_blank', 'noopener')}>Öffnen</Btn>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={lbl}>Begrüßung (optional)</span>
              <textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={2} placeholder="Hallo! Hier ist der Contentplan für …" style={area}/></label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={lbl}>Passwort {share.has_password ? <span style={{ color: '#22c55e', fontWeight: 400 }}>— gesetzt</span> : <span style={{ color: 'var(--fg-4)', fontWeight: 400 }}>— keins</span>}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="text" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={share.has_password ? 'Neues Passwort…' : 'Optional'} style={fld}/>
                {share.has_password && <Btn variant="ghost" size="md" onClick={clearPw}>Entfernen</Btn>}
              </div>
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Btn variant="ghost" size="sm" onClick={revoke} style={{ color: '#ef4444' }}>Link zurückziehen</Btn>
              <span style={{ flex: 1 }}/>
              <Btn variant="primary" disabled={busy} icon={busy ? Ic.loader(14) : Ic.check(14)} onClick={save}>Speichern</Btn>
            </div>
          </>)}
        </div>
      </Glass>
    </div>
  );
}

function ClientModal({ client, onSave, onClose }) {
  const [name, setName] = useState(client?.name || '');
  const [note, setNote] = useState(client?.note || '');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) { toast('Name erforderlich', 'error'); return; }
    setBusy(true);
    try { await onSave({ name: name.trim(), note: note.trim() || null }); onClose(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 420, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0 }}>{client?.id ? 'Kunde bearbeiten' : 'Neuer Kunde'}</h2>
          <IconBtn size={30} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={lbl}>Name</span><input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="z. B. Spacehub" onKeyDown={(e) => e.key === 'Enter' && submit()} style={fld}/></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={lbl}>Notiz (intern)</span><textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Ansprechperson, Tonalität, Besonderheiten…" style={area}/></label>
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} icon={busy ? Ic.loader(15) : Ic.check(15)} onClick={submit}>Speichern</Btn>
        </div>
      </Glass>
    </div>
  );
}

export function ContentPlanApp({ onBack }) {
  const mobile = useIsMobile(900);
  const now = new Date();
  const [clients, setClients] = useState(null);
  const [clientId, setClientId] = useState(() => localStorage.getItem('nyza.cp.client') || '');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [items, setItems] = useState(null);
  const [editing, setEditing] = useState(null);   // { item } | { date }
  const [sharing, setSharing] = useState(false);
  const [clientModal, setClientModal] = useState(null); // null | {} | client
  const [showClients, setShowClients] = useState(false);
  const [view, setView] = useState(() => localStorage.getItem('nyza.cp.view') || 'calendar');
  useEffect(() => { localStorage.setItem('nyza.cp.view', view); }, [view]);

  const loadClients = () => API.cpClients().then((d) => {
    const list = d.clients || [];
    setClients(list);
    if (list.length && !list.find((c) => String(c.id) === String(clientId))) setClientId(String(list[0].id));
  }).catch((e) => { toast(e.message, 'error'); setClients([]); });
  useEffect(() => { loadClients(); }, []);
  useEffect(() => { if (clientId) localStorage.setItem('nyza.cp.client', clientId); }, [clientId]);

  const client = (clients || []).find((c) => String(c.id) === String(clientId)) || null;
  const load = () => {
    if (!client) { setItems([]); return; }
    setItems(null);
    API.cpItems(client.id, year, month).then((d) => setItems(d.items || [])).catch((e) => { toast(e.message, 'error'); setItems([]); });
  };
  useEffect(() => { load(); }, [client?.id, year, month]);

  const shift = (n) => { let m = month + n, y = year; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } setMonth(m); setYear(y); };
  const goToday = () => { setYear(now.getFullYear()); setMonth(now.getMonth() + 1); };

  const upsert = (saved) => setItems((list) => {
    const l = list || [];
    const inMonth = saved.plan_date >= ymd(year, month, 1) && saved.plan_date <= ymd(year, month, 31);
    const rest = l.filter((x) => x.id !== saved.id);
    return inMonth ? [...rest, saved].sort((a, b) => a.plan_date.localeCompare(b.plan_date) || (a.plan_time || '').localeCompare(b.plan_time || '') || a.id - b.id) : rest;
  });
  const remove = (it) => setItems((l) => (l || []).filter((x) => x.id !== it.id));

  const createClient = async (body) => { const d = await API.cpCreateClient(body); await loadClients(); setClientId(String(d.client.id)); toast('Kunde angelegt', 'success'); };
  const updateClient = async (id, body) => { await API.cpUpdateClient(id, body); await loadClients(); toast('Gespeichert', 'success'); };
  const deleteClient = async (c) => {
    if (!await confirmDialog({ title: 'Kunde löschen?', message: `„${c.name}" wird mit allen Einträgen, Dateien und Freigabe-Links gelöscht.`, confirmLabel: 'Löschen', danger: true })) return;
    try { await API.cpDeleteClient(c.id); if (String(c.id) === String(clientId)) setClientId(''); await loadClients(); } catch (e) { toast(e.message, 'error'); }
  };

  const stats = useMemo(() => {
    const s = { total: 0, pending: 0, approved: 0, revision: 0, rejected: 0, ideas: 0 };
    for (const it of items || []) { s.total++; if (it.status === 'idea') s.ideas++; s[it.review_status] = (s[it.review_status] || 0) + 1; }
    return s;
  }, [items]);

  const Sidebar = (
    <div style={{ width: mobile ? '100%' : 240, flexShrink: 0, borderRight: mobile ? 'none' : '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '14px 14px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', flex: 1 }}>Kunden</span>
        <IconBtn size={28} title="Kunde anlegen" onClick={() => setClientModal({})}>{Ic.plus(14)}</IconBtn>
      </div>
      <div style={{ overflowY: 'auto', padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {clients === null ? <div style={{ color: 'var(--fg-3)', padding: 10 }}>{Ic.loader(16)}</div>
          : clients.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--fg-3)', padding: '6px 8px', lineHeight: 1.5 }}>Noch kein Kunde. Leg oben mit „+" den ersten an — jeder Kunde bekommt seinen eigenen Plan.</div>
          : clients.map((c) => {
            const on = String(c.id) === String(clientId);
            return (
              <div key={c.id} onClick={() => { setClientId(String(c.id)); setShowClients(false); }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 'var(--r-sm)', cursor: 'pointer', background: on ? 'color-mix(in oklab, var(--accent) 14%, transparent)' : 'transparent', color: on ? 'var(--accent)' : 'var(--fg)' }}>
                <div style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--accent-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{c.name.slice(0, 1).toUpperCase()}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 540, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-4)' }}>{c.item_count} {c.item_count === 1 ? 'Eintrag' : 'Einträge'}</div>
                </div>
                {on && (<>
                  <span onClick={(e) => { e.stopPropagation(); setClientModal(c); }} title="Bearbeiten" style={{ color: 'var(--fg-3)', display: 'inline-flex' }}>{Ic.fileGen(14)}</span>
                  <span onClick={(e) => { e.stopPropagation(); deleteClient(c); }} title="Löschen" style={{ color: 'var(--fg-4)', display: 'inline-flex' }}>{Ic.trash(14)}</span>
                </>)}
              </div>
            );
          })}
      </div>
    </div>
  );

  const siblings = (items || []).filter((x) => x.status !== undefined);

  return (
    <>
      <div className="nyza-topbar" style={{ height: 64, padding: '0 20px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--surface-2)', backdropFilter: 'blur(20px)' }}>
        <IconBtn size={34} title="Zurück" onClick={onBack} style={{ flexShrink: 0, border: '1px solid var(--border)', borderRadius: 999 }}>{Ic.chevronL(17)}</IconBtn>
        <div style={{ fontSize: 14, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--fg-3)', cursor: 'pointer' }} onClick={onBack}>Apps</span><span style={{ color: 'var(--fg-4)' }}>{Ic.chevronR(12)}</span>
          <span style={{ fontWeight: 600 }}>Content Plan</span>
          {mobile && client && <><span style={{ color: 'var(--fg-4)' }}>{Ic.chevronR(12)}</span><span onClick={() => setShowClients((v) => !v)} style={{ color: 'var(--accent)', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{client.name}</span></>}
        </div>
        <span style={{ flex: 1 }}/>
        {client && <Btn variant="primary" size="sm" icon={Ic.share(14)} onClick={() => setSharing(true)}>{mobile ? 'Teilen' : 'Monat teilen'}</Btn>}
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {(!mobile || showClients) && Sidebar}
        {(!mobile || !showClients) && (
          <div data-scroll style={{ flex: 1, overflow: 'auto', padding: mobile ? '14px 12px 80px' : '18px 24px 80px', minWidth: 0 }}>
            {!client ? (
              <div style={{ color: 'var(--fg-3)', padding: 30, textAlign: 'center' }}>
                {clients === null ? Ic.loader(22) : <>{Ic.calendar(30)}<div style={{ marginTop: 10, fontSize: 14 }}>Leg links einen Kunden an, um seinen Contentplan zu starten.</div></>}
              </div>
            ) : (<>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                <IconBtn size={32} onClick={() => shift(-1)} title="Vormonat">{Ic.chevronL(16)}</IconBtn>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, minWidth: 190, textAlign: 'center' }}>{MONTHS[month - 1]} {year}</div>
                <IconBtn size={32} onClick={() => shift(1)} title="Nächster Monat">{Ic.chevronR(16)}</IconBtn>
                <Btn variant="ghost" size="sm" onClick={goToday}>Heute</Btn>
                <span style={{ flex: 1 }}/>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Pill color="#94a3b8">{stats.total} gesamt</Pill>
                  {stats.approved > 0 && <Pill color={CP_REVIEW.approved.color}>{stats.approved} freigegeben</Pill>}
                  {stats.revision > 0 && <Pill color={CP_REVIEW.revision.color}>{stats.revision} überarbeiten</Pill>}
                  {stats.rejected > 0 && <Pill color={CP_REVIEW.rejected.color}>{stats.rejected} abgelehnt</Pill>}
                  {stats.pending > 0 && <Pill color={CP_REVIEW.pending.color}>{stats.pending} offen</Pill>}
                </div>
                <div style={{ display: 'flex', padding: 3, borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
                  <IconBtn active={view === 'calendar'} onClick={() => setView('calendar')} size={28} title="Kalender">{Ic.grid(14)}</IconBtn>
                  <IconBtn active={view === 'list'} onClick={() => setView('list')} size={28} title="Liste">{Ic.list(14)}</IconBtn>
                </div>
                <Btn variant="glass" size="sm" icon={Ic.plus(14)} onClick={() => setEditing({ date: (year === now.getFullYear() && month === now.getMonth() + 1) ? todayStr() : ymd(year, month, 1) })}>Eintrag</Btn>
              </div>

              {items === null ? <div style={{ color: 'var(--fg-3)', padding: 30, textAlign: 'center' }}>{Ic.loader(22)}</div> : (
                <MonthGrid year={year} month={month} items={items} mobile={mobile || view === 'list'} highlightGaps
                  onDay={(date) => setEditing({ date })}
                  onItem={(it) => setEditing({ item: it })}
                  renderChip={(it) => <ItemChip item={it} mediaUrl={(id) => API.cpMediaUrl(id)}/>}/>
              )}
              <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--fg-4)', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <span>Farbe = Kundenentscheidung</span>
                {Object.entries(CP_REVIEW).map(([k, v]) => <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: v.color }}/>{v.label}</span>)}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 12, height: 8, borderRadius: 2, border: '1.5px dashed #f59e0b' }}/>noch nichts geplant (Lücke)</span>
              </div>
            </>)}
          </div>
        )}
      </div>

      {editing && client && (
        <ItemEditor item={editing.item} date={editing.date} clientId={client.id} clientName={client.name} siblings={siblings}
          onClose={() => setEditing(null)} onSaved={(saved) => { upsert(saved); }} onDeleted={remove}/>
      )}
      {sharing && client && <ShareModal client={client} year={year} month={month} onClose={() => setSharing(false)}/>}
      {clientModal && <ClientModal client={clientModal.id ? clientModal : null} onClose={() => setClientModal(null)}
        onSave={(body) => clientModal.id ? updateClient(clientModal.id, body) : createClient(body)}/>}
    </>
  );
}

// ═════════════════════════ PUBLIC (customer) PAGE ═══════════════════════════

function PublicItemModal({ token, pw, item, clientName, onClose, onUpdated }) {
  const [it, setIt] = useState(item);
  const [decision, setDecision] = useState(null);
  const [comment, setComment] = useState('');
  const [name, setName] = useState(() => localStorage.getItem('nyza.cp.reviewer') || '');
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(null);
  const url = (id) => API.cpPublicMediaUrl(token, id, pw);
  const rv = CP_REVIEW[it.review_status] || CP_REVIEW.pending;
  const resultMedia = (it.media || []).filter((m) => m.kind === 'result');
  const ideaMedia = (it.media || []).filter((m) => m.kind === 'idea');

  const send = async (dec) => {
    if (dec !== 'approved' && !comment.trim()) { setDecision(dec); toast('Bitte kurz beschreiben, was geändert werden soll', 'error'); return; }
    setBusy(true);
    try {
      const d = await API.cpPublicReview(token, it.id, { decision: dec, comment: comment.trim() || null, name: name.trim() || null }, pw);
      setIt(d.item); onUpdated(d.item); setDecision(null); setComment('');
      if (name.trim()) localStorage.setItem('nyza.cp.reviewer', name.trim());
      toast(dec === 'approved' ? 'Freigegeben — danke!' : 'Rückmeldung gesendet', 'success');
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  const fm = (it.formats || []).map((f) => CP_FORMATS.find((x) => x.id === f)?.label).filter(Boolean).join(' + ');
  const pl = (it.platforms || []).map((p) => CP_PLATFORMS.find((x) => x.id === p)).filter(Boolean);

  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 980, borderRadius: 'var(--r-xl)', overflow: 'hidden', maxHeight: '94vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{fmtWeekday(it.plan_date)}, {fmtDate(it.plan_date)}{it.plan_time ? ' · ' + it.plan_time + ' Uhr' : ''}{fm ? ' · ' + fm : ''}</div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: '2px 0 0' }}>{it.title}</h2>
          </div>
          <Pill color={rv.color}>{rv.label}</Pill>
          <IconBtn size={32} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div className="nyza-cp-editor" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', overflowY: 'auto', flex: 1 }}>
          <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, borderRight: '1px solid var(--border)' }}>
            {pl.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{pl.map((p) => <Pill key={p.id} color={p.color === '#111111' ? 'var(--fg)' : p.color}>{p.label}</Pill>)}</div>}
            {resultMedia.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={lbl}>Ergebnis</span>
                <MediaStrip media={resultMedia} mediaUrl={url} onOpen={setViewing}/>
              </div>
            )}
            {it.caption && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={lbl}>Text</span>
                <div style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', padding: '10px 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>{it.caption}</div>
              </div>
            )}
            {it.idea && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={lbl}>Idee</span>
                <div style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', color: 'var(--fg-2)' }}>{it.idea}</div>
                {ideaMedia.length > 0 && <MediaStrip media={ideaMedia} mediaUrl={url} onOpen={setViewing} compact/>}
              </div>
            )}

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={lbl}>Deine Entscheidung</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Btn variant={it.review_status === 'approved' ? 'primary' : 'glass'} icon={Ic.check(14)} disabled={busy} onClick={() => send('approved')} style={{ borderColor: CP_REVIEW.approved.color }}>Freigeben</Btn>
                <Btn variant={decision === 'revision' ? 'primary' : 'glass'} icon={Ic.rotate(14)} disabled={busy} onClick={() => decision === 'revision' ? send('revision') : setDecision('revision')}>Überarbeiten</Btn>
                <Btn variant={decision === 'rejected' ? 'primary' : 'glass'} icon={Ic.close(14)} disabled={busy} onClick={() => decision === 'rejected' ? send('rejected') : setDecision('rejected')}>Ablehnen</Btn>
              </div>
              {(decision || comment) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <textarea value={comment} autoFocus onChange={(e) => setComment(e.target.value)} rows={3} placeholder={decision === 'rejected' ? 'Warum passt es nicht?' : 'Was soll geändert werden?'} style={area}/>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dein Name (optional)" style={{ ...fld, maxWidth: 220 }}/>
                    <span style={{ flex: 1 }}/>
                    <Btn variant="ghost" size="sm" onClick={() => { setDecision(null); setComment(''); }}>Abbrechen</Btn>
                    {decision && <Btn variant="primary" size="sm" disabled={busy} icon={busy ? Ic.loader(13) : Ic.check(13)} onClick={() => send(decision)}>{decision === 'rejected' ? 'Ablehnen' : 'Zur Überarbeitung senden'}</Btn>}
                  </div>
                </div>
              )}
              {!decision && !comment && <div style={{ fontSize: 11.5, color: 'var(--fg-4)' }}>Bei „Überarbeiten" und „Ablehnen" bitten wir um eine kurze Begründung.</div>}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={lbl}>Verlauf</span>
              <Thread comments={it.comments}/>
            </div>
          </div>
          <div style={{ padding: 18 }}>
            <ContentPreview item={it} clientName={clientName} mediaUrl={url}/>
          </div>
        </div>
      </Glass>
      {viewing && <Lightbox media={viewing} url={url(viewing.id)} onClose={() => setViewing(null)}/>}
    </div>
  );
}

export function PublicContentPlanPage({ token }) {
  const mobile = useIsMobile(760);
  const [state, setState] = useState({ status: 'loading' });
  const [pw, setPw] = useState('');
  const [pwInput, setPwInput] = useState('');
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState('all');

  const load = (p) => {
    setState({ status: 'loading' });
    API.cpPublic(token, p).then((d) => { setState({ status: 'ok', data: d }); setPw(p || ''); })
      .catch((e) => setState({ status: e.code === 'password' ? 'password' : e.code === 'notfound' ? 'notfound' : 'error', message: e.message }));
  };
  useEffect(() => { load(''); }, [token]);
  const unlock = () => { API.cpPublicUnlock(token, pwInput).then(() => load(pwInput)).catch((e) => toast(e.message, 'error')); };

  const data = state.data || {};
  const items = data.items || [];
  const updated = (it) => setState((s) => ({ ...s, data: { ...s.data, items: (s.data.items || []).map((x) => x.id === it.id ? it : x) } }));
  const stats = useMemo(() => { const s = { total: items.length, pending: 0, approved: 0, revision: 0, rejected: 0 }; for (const i of items) s[i.review_status] = (s[i.review_status] || 0) + 1; return s; }, [items]);
  const shown = filter === 'all' ? items : items.filter((i) => i.review_status === filter);

  if (state.status === 'loading') return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-3)' }}>{Ic.loader(26)}</div>;
  if (state.status === 'notfound' || state.status === 'error') {
    return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}><Glass style={{ padding: 32, borderRadius: 'var(--r-xl)', textAlign: 'center', maxWidth: 420 }}><div style={{ color: 'var(--fg-3)', marginBottom: 10 }}>{Ic.link(28)}</div><div style={{ fontSize: 16, fontWeight: 600 }}>{state.status === 'notfound' ? 'Dieser Link ist nicht (mehr) gültig.' : 'Konnte nicht geladen werden.'}</div><div style={{ fontSize: 12.5, color: 'var(--fg-3)', marginTop: 6 }}>{state.message}</div></Glass></div>;
  }
  if (state.status === 'password') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Glass style={{ padding: 28, borderRadius: 'var(--r-xl)', width: '100%', maxWidth: 380 }}>
          <div style={{ marginBottom: 14 }}><NyzaWordmark size={16}/></div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Contentplan geschützt</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-3)', marginBottom: 14 }}>Bitte das Passwort eingeben, das du erhalten hast.</div>
          <input type="password" value={pwInput} autoFocus onChange={(e) => setPwInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && unlock()} placeholder="Passwort" style={{ ...fld, marginBottom: 10 }}/>
          <Btn variant="primary" full onClick={unlock}>Öffnen</Btn>
        </Glass>
      </div>
    );
  }

  const done = stats.total ? Math.round(((stats.approved + stats.rejected + stats.revision) / stats.total) * 100) : 0;

  return (
    <div style={{ minHeight: '100vh', padding: mobile ? '18px 12px 60px' : '30px 28px 80px', maxWidth: 1240, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>Contentplan · {data.client}</div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: mobile ? 30 : 40, fontWeight: 600, letterSpacing: -1, margin: 0, lineHeight: 1.05 }}>{MONTHS[(data.month || 1) - 1]} {data.year}</h1>
          {data.intro && <p style={{ fontSize: 14, color: 'var(--fg-2)', marginTop: 10, maxWidth: 560, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{data.intro}</p>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>{stats.total} {stats.total === 1 ? 'Eintrag' : 'Einträge'} · {done}% beantwortet</div>
          <div style={{ width: mobile ? 180 : 240, height: 6, borderRadius: 999, background: 'var(--surface-hi)', overflow: 'hidden', display: 'flex' }}>
            {['approved', 'revision', 'rejected'].map((k) => stats[k] > 0 && <div key={k} style={{ width: (stats[k] / stats.total * 100) + '%', background: CP_REVIEW[k].color }}/>)}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {[['all', 'Alle', 'var(--fg-2)', stats.total], ['pending', 'Offen', CP_REVIEW.pending.color, stats.pending], ['approved', 'Freigegeben', CP_REVIEW.approved.color, stats.approved], ['revision', 'Überarbeiten', CP_REVIEW.revision.color, stats.revision], ['rejected', 'Abgelehnt', CP_REVIEW.rejected.color, stats.rejected]].map(([k, label, col, n]) => (
          <button key={k} onClick={() => setFilter(k)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: filter === k ? '#fff' : col, background: filter === k ? col : 'color-mix(in oklab, ' + col + ' 12%, transparent)', border: '1.5px solid ' + col }}>{label}<span style={{ opacity: 0.75, fontWeight: 500 }}>{n}</span></button>
        ))}
      </div>

      {items.length === 0 ? (
        <Glass style={{ padding: 30, borderRadius: 'var(--r-xl)', textAlign: 'center', color: 'var(--fg-3)' }}>{Ic.calendar(28)}<div style={{ marginTop: 8 }}>Für diesen Monat ist noch nichts eingeplant.</div></Glass>
      ) : (
        <MonthGrid year={data.year} month={data.month} items={shown} mobile={mobile}
          onItem={(it) => setOpen(it)}
          renderChip={(it) => <ItemChip item={it} mediaUrl={(id) => API.cpPublicMediaUrl(token, id, pw)}/>}/>
      )}

      <div style={{ marginTop: 22, display: 'grid', gridTemplateColumns: mobile ? 'minmax(0,1fr)' : 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {shown.map((it) => {
          const rv = CP_REVIEW[it.review_status] || CP_REVIEW.pending;
          const main = (it.media || []).find((m) => m.kind === 'result' && (m.is_image || m.is_video)) || (it.media || []).find((m) => m.is_image || m.is_video);
          const fm = (it.formats || []).map((f) => CP_FORMATS.find((x) => x.id === f)?.label).filter(Boolean).join(' + ');
          return (
            <div key={it.id} onClick={() => setOpen(it)} className="nyza-listrow" style={{ display: 'flex', gap: 12, padding: 12, borderRadius: 'var(--r-md)', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer', borderLeft: '4px solid ' + rv.color }}>
              <div style={{ width: 64, height: 64, borderRadius: 10, overflow: 'hidden', background: 'var(--surface-hi)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-4)' }}>
                {main ? (main.is_video ? <video src={API.cpPublicMediaUrl(token, main.id, pw)} muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/> : <img src={API.cpPublicMediaUrl(token, main.id, pw)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>) : Ic.images(20)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>{fmtWeekday(it.plan_date)}, {fmtDate(it.plan_date)}{fm ? ' · ' + fm : ''}</div>
                <div style={{ fontSize: 14, fontWeight: 560, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title}</div>
                <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}><Pill color={rv.color}>{rv.label}</Pill>{(it.comments || []).length > 0 && <span style={{ fontSize: 11, color: 'var(--fg-4)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>{Ic.comment(11)} {it.comments.length}</span>}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--fg-4)', fontSize: 11.5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><NyzaWordmark size={13}/> Contentplan</div>

      {open && <PublicItemModal token={token} pw={pw} item={open} clientName={data.client} onClose={() => setOpen(null)} onUpdated={(it) => { updated(it); setOpen(it); }}/>}
    </div>
  );
}
