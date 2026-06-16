// Nyza — design system primitives. Pure presentational components — no API,
// no state beyond local UI hover. Imported by app.jsx and pubpages.jsx.

import React from 'react';

export const Ic = {
  folder:    (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>,
  upload:    (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/></svg>,
  download:  (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v12M7 11l5 5 5-5M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/></svg>,
  search:    (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>,
  share:     (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>,
  trash:     (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6"/></svg>,
  star:      (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3 2.7 6.1 6.6.6-5 4.4 1.5 6.5L12 17.3 6.2 20.6l1.5-6.5-5-4.4 6.6-.6L12 3z"/></svg>,
  users:     (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5M16 14c2.5 0 5 1.5 5 4"/></svg>,
  clock:     (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>,
  link:      (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M10 14a4 4 0 0 1 0-5.6l3-3a4 4 0 0 1 5.6 5.6l-1.5 1.5"/><path d="M14 10a4 4 0 0 1 0 5.6l-3 3a4 4 0 0 1-5.6-5.6l1.5-1.5"/></svg>,
  plus:      (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>,
  more:      (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>,
  grid:      (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>,
  list:      (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>,
  sun:       (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>,
  moon:      (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>,
  chevronR:  (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6"/></svg>,
  chevronL:  (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 6-6 6 6 6"/></svg>,
  rotate:    (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5"/></svg>,
  close:     (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>,
  check:     (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7"/></svg>,
  lock:      (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>,
  eye:       (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>,
  copy:      (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>,
  camera:    (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z"/><circle cx="12" cy="13" r="3.5"/></svg>,
  home:      (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m3 11 9-7 9 7v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2v-9z"/></svg>,
  bolt:      (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>,
  fileImg:   (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 17 5-4 5 4 6-6"/></svg>,
  filePdf:   (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/><text x="9" y="17" fontSize="5" fontWeight="700" fill="currentColor" stroke="none">PDF</text></svg>,
  fileVid:   (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="14" height="12" rx="2"/><path d="m17 10 4-2v8l-4-2z"/></svg>,
  fileGen:   (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>,
  inbox:     (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6l2-8z"/></svg>,
  logout:    (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>,
  comment:   (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 9 9 0 0 1-3.9-.9L3 21l1.9-5.6A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>,
  cog:       (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  loader:    (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="nyza-spin"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>,
};

export function Glass({ children, style = {}, intensity = 1, hi = true, ...rest }) {
  return (
    <div {...rest} style={{
      position: 'relative',
      background: 'var(--surface)',
      backdropFilter: `blur(calc(var(--blur) * ${intensity})) saturate(180%)`,
      WebkitBackdropFilter: `blur(calc(var(--blur) * ${intensity})) saturate(180%)`,
      border: '1px solid var(--border)',
      boxShadow: hi
        ? '0 1px 0 var(--inner-hi) inset, 0 30px 60px -20px rgba(0,0,0,0.35), 0 8px 24px -12px rgba(0,0,0,0.25)'
        : 'none',
      ...style,
    }}>{children}</div>
  );
}

export function Btn({ children, variant = 'glass', size = 'md', icon, iconRight, full, style = {}, onClick, type = 'button', disabled, ...rest }) {
  const sizes = {
    sm: { h: 32, px: 12, fs: 13, gap: 6 },
    md: { h: 40, px: 16, fs: 14, gap: 8 },
    lg: { h: 52, px: 24, fs: 16, gap: 10 },
    xl: { h: 64, px: 32, fs: 18, gap: 12 },
  }[size];

  const variantStyles = {
    primary: {
      background: 'var(--accent-grad)', color: '#fff',
      border: '1px solid rgba(255,255,255,0.14)',
      boxShadow: '0 1px 0 rgba(255,255,255,0.25) inset, 0 0 0 1px rgba(0,0,0,0.05), 0 8px 24px -8px var(--accent-glow), 0 18px 40px -16px var(--accent-glow)',
      textShadow: '0 1px 0 rgba(0,0,0,0.15)',
    },
    ghost: { background: 'transparent', color: 'var(--fg)', border: '1px solid transparent' },
    glass: {
      background: 'var(--surface-hi)', color: 'var(--fg)',
      border: '1px solid var(--border)',
      backdropFilter: 'blur(20px) saturate(160%)',
      WebkitBackdropFilter: 'blur(20px) saturate(160%)',
      boxShadow: '0 1px 0 var(--inner-hi) inset',
    },
    danger: {
      background: 'color-mix(in oklab, var(--danger) 15%, transparent)',
      color: 'var(--danger)',
      border: '1px solid color-mix(in oklab, var(--danger) 30%, transparent)',
    },
  }[variant];

  return (
    <button type={type} onClick={onClick} disabled={disabled} {...rest} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      height: sizes.h, padding: `0 ${sizes.px}px`, gap: sizes.gap,
      borderRadius: 999, fontFamily: 'var(--font-body)', fontSize: sizes.fs, fontWeight: 540,
      letterSpacing: -0.1, cursor: disabled ? 'not-allowed' : 'pointer',
      width: full ? '100%' : undefined,
      transition: 'transform .2s cubic-bezier(.2,.8,.2,1), box-shadow .25s, background .25s, opacity .2s',
      whiteSpace: 'nowrap', opacity: disabled ? 0.5 : 1,
      ...variantStyles, ...style,
    }}
    onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.transform = 'translateY(-1px)'; }}
    onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}>
      {icon}{children}{iconRight}
    </button>
  );
}

export function IconBtn({ children, active, onClick, title, size = 36, style = {} }) {
  return (
    <button onClick={onClick} title={title} style={{
      width: size, height: size, borderRadius: 'var(--r-sm)',
      border: '1px solid ' + (active ? 'var(--border-hi)' : 'transparent'),
      background: active ? 'var(--surface-hi)' : 'transparent',
      color: active ? 'var(--fg)' : 'var(--fg-2)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', transition: 'all .18s', ...style,
    }}
    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hi)'; e.currentTarget.style.color = 'var(--fg)'; }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = active ? 'var(--surface-hi)' : 'transparent';
      e.currentTarget.style.color = active ? 'var(--fg)' : 'var(--fg-2)';
    }}>{children}</button>
  );
}

export function NyzaMark({ size = 28 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.28,
      background: 'var(--accent-grad)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 6px 16px -4px var(--accent-glow)',
      flexShrink: 0,
    }}>
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 16 16" fill="none">
        <path d="M3 13V3L13 13V3" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </div>
  );
}

export function NyzaWordmark({ size = 18 }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.45 }}>
      <NyzaMark size={size * 1.4}/>
      <span style={{
        fontFamily: 'var(--font-display)', fontSize: size, fontWeight: 600,
        letterSpacing: -0.4, color: 'var(--fg)',
      }}>nyza<span style={{ opacity: 0.5, fontWeight: 400 }}> · cloud</span></span>
    </div>
  );
}

export function FileIcon({ kind = 'doc', size = 20, tint }) {
  const bg = tint != null
    ? `linear-gradient(135deg, oklch(0.7 0.16 ${tint}), oklch(0.55 0.2 ${(tint + 30) % 360}))`
    : 'var(--surface-hi)';
  const ic = { image: Ic.fileImg, pdf: Ic.filePdf, video: Ic.fileVid, doc: Ic.fileGen }[kind] || Ic.fileGen;
  return (
    <div style={{
      width: size * 1.9, height: size * 1.9, borderRadius: 'var(--r-sm)',
      background: bg, color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 1px 0 rgba(255,255,255,0.2) inset', flexShrink: 0,
    }}>{ic(size)}</div>
  );
}

export function PhotoPlaceholder({ hue = 280, label, style = {} }) {
  const id = `stripe-${hue}`;
  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      background: `linear-gradient(135deg, oklch(0.6 0.18 ${hue}), oklch(0.4 0.16 ${(hue + 60) % 360}))`,
      ...style,
    }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.18, mixBlendMode: 'overlay' }}>
        <defs>
          <pattern id={id} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
            <line x1="0" y1="0" x2="0" y2="14" stroke="white" strokeWidth="6"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${id})`}/>
      </svg>
      {label && <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.85)',
        letterSpacing: 0.5, textTransform: 'uppercase',
      }}>{label}</div>}
    </div>
  );
}

export function Toggle({ on, onClick }) {
  return (
    <div onClick={onClick} style={{
      width: 38, height: 22, borderRadius: 11, padding: 2,
      background: on ? 'var(--accent-grad)' : 'var(--surface-hi)',
      border: '1px solid ' + (on ? 'transparent' : 'var(--border)'),
      transition: 'all .25s', cursor: 'pointer',
    }}>
      <div style={{
        width: 16, height: 16, borderRadius: '50%', background: '#fff',
        marginLeft: on ? 16 : 0, transition: 'margin .25s cubic-bezier(.2,.8,.2,1)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }}/>
    </div>
  );
}

export function CircularProgress({ pct, size = 80, thick = 8 }) {
  const r = (size - thick) / 2;
  const c = 2 * Math.PI * r;
  const id = 'pg-' + Math.round(pct * 100);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--surface-hi)" strokeWidth={thick}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={`url(#${id})`} strokeWidth={thick}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct/100)}
          transform={`rotate(-90 ${size/2} ${size/2})`}/>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--accent-from)"/>
            <stop offset="1" stopColor="var(--accent-to)"/>
          </linearGradient>
        </defs>
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: size * 0.28, fontWeight: 600, letterSpacing: -0.6, color: 'var(--fg)' }}>
          {Math.round(pct)}<span style={{ fontSize: size * 0.12, color: 'var(--fg-3)', marginLeft: 1 }}>%</span>
        </div>
      </div>
    </div>
  );
}

export function NyzaAmbient() {
  return (
    <div className="nyza-ambient" aria-hidden="true">
      <i className="b1"/><i className="b2"/><i className="b3"/>
    </div>
  );
}

// Accent presets — applied app-wide by overriding the CSS custom properties.
export const ACCENTS = {
  violet: { from: 'oklch(0.66 0.20 282)', to: 'oklch(0.66 0.18 248)', solid: 'oklch(0.62 0.20 282)', glow: 'oklch(0.66 0.20 282 / 0.45)' },
  blue:   { from: 'oklch(0.70 0.16 240)', to: 'oklch(0.66 0.16 220)', solid: 'oklch(0.62 0.17 240)', glow: 'oklch(0.70 0.16 240 / 0.45)' },
  aurora: { from: 'oklch(0.78 0.18 168)', to: 'oklch(0.72 0.18 220)', solid: 'oklch(0.70 0.17 190)', glow: 'oklch(0.78 0.18 168 / 0.45)' },
  sunset: { from: 'oklch(0.74 0.20 30)',  to: 'oklch(0.66 0.22 360)', solid: 'oklch(0.68 0.22 15)',  glow: 'oklch(0.74 0.20 30 / 0.45)' },
  rose:   { from: 'oklch(0.72 0.20 350)', to: 'oklch(0.66 0.20 320)', solid: 'oklch(0.66 0.21 345)', glow: 'oklch(0.72 0.20 350 / 0.45)' },
  emerald:{ from: 'oklch(0.74 0.17 155)', to: 'oklch(0.70 0.15 175)', solid: 'oklch(0.66 0.17 158)', glow: 'oklch(0.74 0.17 155 / 0.45)' },
  amber:  { from: 'oklch(0.80 0.16 75)',  to: 'oklch(0.72 0.18 45)',  solid: 'oklch(0.72 0.17 65)',  glow: 'oklch(0.80 0.16 75 / 0.45)' },
};
export function applyAccent(key) {
  const a = ACCENTS[key] || ACCENTS.violet;
  const r = document.documentElement.style;
  r.setProperty('--accent', a.solid);
  r.setProperty('--accent-from', a.from);
  r.setProperty('--accent-to', a.to);
  r.setProperty('--accent-grad', `linear-gradient(135deg, ${a.from}, ${a.to})`);
  r.setProperty('--accent-glow', a.glow);
}

export function humanSize(bytes) {
  if (bytes == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, b = Number(bytes);
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (b < 10 && i > 0 ? b.toFixed(1) : Math.round(b)) + ' ' + u[i];
}

export function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return 'gerade eben';
  if (sec < 3600) return 'vor ' + Math.floor(sec / 60) + ' Min';
  if (sec < 86400) return 'vor ' + Math.floor(sec / 3600) + ' Std';
  if (sec < 86400 * 7) return 'vor ' + Math.floor(sec / 86400) + ' Tagen';
  return d.toLocaleDateString('de-DE');
}
