// nyza-system.jsx — Design tokens, primitives, icons, mock data for Nyza Cloud

// ─────────────────────────────────────────────────────────────
// THEME — applied via CSS custom properties on a wrapper element.
// Each "screen" is wrapped in <NyzaTheme mode tweaks>...</NyzaTheme>.
// All tokens are CSS vars so theme/density/radius/glass/accent are live-tweakable.
// ─────────────────────────────────────────────────────────────

const NYZA_DEFAULTS = {
  mode: 'dark',                    // 'light' | 'dark'
  accent: 'violet',                // violet | sunset | aurora | mono
  density: 'cozy',                 // cozy | compact
  blur: 40,                        // glass blur amount in px
  radius: 1.0,                     // radius scale multiplier
  fontPair: 'inter',               // inter | spaceGrotesk | dmSerif
};

const ACCENTS = {
  violet: { from: 'oklch(0.66 0.20 282)', to: 'oklch(0.66 0.18 248)', solid: 'oklch(0.62 0.20 282)', glow: 'oklch(0.66 0.20 282 / 0.45)' },
  sunset: { from: 'oklch(0.72 0.20 30)',  to: 'oklch(0.65 0.22 360)', solid: 'oklch(0.68 0.22 15)',  glow: 'oklch(0.72 0.20 30 / 0.45)' },
  aurora: { from: 'oklch(0.78 0.18 168)', to: 'oklch(0.72 0.18 220)', solid: 'oklch(0.74 0.18 190)', glow: 'oklch(0.78 0.18 168 / 0.45)' },
  mono:   { from: 'oklch(0.96 0 0)',      to: 'oklch(0.78 0 0)',      solid: 'oklch(0.92 0 0)',      glow: 'oklch(0.92 0 0 / 0.35)' },
};

const FONT_PAIRS = {
  inter:        { display: '"Inter Tight", "Inter", system-ui, sans-serif', body: '"Inter", system-ui, sans-serif', mono: '"JetBrains Mono", ui-monospace, monospace' },
  spaceGrotesk: { display: '"Space Grotesk", system-ui, sans-serif',         body: '"Space Grotesk", system-ui, sans-serif', mono: '"JetBrains Mono", ui-monospace, monospace' },
  dmSerif:      { display: '"Instrument Serif", Georgia, serif',             body: '"Inter", system-ui, sans-serif', mono: '"JetBrains Mono", ui-monospace, monospace' },
};

function NyzaTheme({ mode = 'dark', tweaks = {}, children, style = {}, frame = false }) {
  const t = { ...NYZA_DEFAULTS, mode, ...tweaks };
  const acc = ACCENTS[t.accent] || ACCENTS.violet;
  const font = FONT_PAIRS[t.fontPair] || FONT_PAIRS.inter;
  const rad = t.radius ?? 1;

  // Base palette
  const dark = t.mode === 'dark';
  const vars = {
    '--bg':          dark ? '#0B0B0F' : '#F6F5F2',
    '--bg-2':        dark ? '#101015' : '#EFEEEA',
    '--surface':     dark ? 'rgba(22,22,28,0.62)'  : 'rgba(255,255,255,0.72)',
    '--surface-2':   dark ? 'rgba(30,30,38,0.55)'  : 'rgba(255,255,255,0.55)',
    '--surface-hi':  dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
    '--border':      dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)',
    '--border-hi':   dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)',
    '--inner-hi':    dark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.85)',
    '--fg':          dark ? '#F4F4F6' : '#0E0E12',
    '--fg-2':        dark ? 'rgba(244,244,246,0.72)' : 'rgba(14,14,18,0.7)',
    '--fg-3':        dark ? 'rgba(244,244,246,0.45)' : 'rgba(14,14,18,0.5)',
    '--fg-4':        dark ? 'rgba(244,244,246,0.28)' : 'rgba(14,14,18,0.3)',
    '--accent':      acc.solid,
    '--accent-from': acc.from,
    '--accent-to':   acc.to,
    '--accent-grad': `linear-gradient(135deg, ${acc.from}, ${acc.to})`,
    '--accent-glow': acc.glow,
    '--success':     'oklch(0.74 0.16 155)',
    '--warning':     'oklch(0.78 0.15 80)',
    '--danger':      'oklch(0.66 0.22 25)',
    '--blur':        t.blur + 'px',
    '--r-xs':        (6 * rad)  + 'px',
    '--r-sm':        (10 * rad) + 'px',
    '--r-md':        (16 * rad) + 'px',
    '--r-lg':        (22 * rad) + 'px',
    '--r-xl':        (28 * rad) + 'px',
    '--r-2xl':       (36 * rad) + 'px',
    '--gap':         t.density === 'compact' ? '10px' : '14px',
    '--pad':         t.density === 'compact' ? '14px' : '20px',
    '--row-h':       t.density === 'compact' ? '44px' : '52px',
    '--font-display': font.display,
    '--font-body':    font.body,
    '--font-mono':    font.mono,
    background: 'var(--bg)',
    color: 'var(--fg)',
    fontFamily: 'var(--font-body)',
    WebkitFontSmoothing: 'antialiased',
    MozOsxFontSmoothing: 'grayscale',
    fontFeatureSettings: '"ss01", "cv11"',
  };

  return (
    <div data-nyza-theme={t.mode} style={{ ...vars, position: 'relative', width: '100%', height: '100%', overflow: 'hidden', ...style }}>
      {/* Ambient atmospheric glow — gives glass something to refract */}
      <NyzaAmbient />
      {children}
    </div>
  );
}

// Soft, slow-moving gradient blobs that sit BEHIND the glass to give it
// something to refract. Not animated to keep canvas snappy.
function NyzaAmbient() {
  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
      <div style={{
        position: 'absolute', top: '-30%', left: '-20%', width: '55%', height: '55%',
        background: 'radial-gradient(closest-side, var(--accent-from), transparent 70%)',
        opacity: 0.16, filter: 'blur(60px)',
      }}/>
      <div style={{
        position: 'absolute', bottom: '-35%', right: '-20%', width: '60%', height: '60%',
        background: 'radial-gradient(closest-side, var(--accent-to), transparent 70%)',
        opacity: 0.13, filter: 'blur(80px)',
      }}/>
      <div style={{
        position: 'absolute', top: '60%', right: '-10%', width: '28%', height: '38%',
        background: 'radial-gradient(closest-side, oklch(0.65 0.18 320), transparent 70%)',
        opacity: 0.08, filter: 'blur(70px)',
      }}/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// PRIMITIVES
// ─────────────────────────────────────────────────────────────

// Glass surface — the workhorse. Use for cards, sidebars, panels, modals.
function Glass({ children, style = {}, intensity = 1, hi = true, ...rest }) {
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

// Pill button with gradient, glow on hover. variant: primary | ghost | glass | danger
function Btn({ children, variant = 'glass', size = 'md', icon, iconRight, full, style = {}, onClick, type = 'button', disabled, ...rest }) {
  const sizes = {
    sm: { h: 32, px: 12, fs: 13, gap: 6 },
    md: { h: 40, px: 16, fs: 14, gap: 8 },
    lg: { h: 52, px: 24, fs: 16, gap: 10 },
    xl: { h: 64, px: 32, fs: 18, gap: 12 },
  }[size];

  const variantStyles = {
    primary: {
      background: 'var(--accent-grad)',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.14)',
      boxShadow: '0 1px 0 rgba(255,255,255,0.25) inset, 0 0 0 1px rgba(0,0,0,0.05), 0 8px 24px -8px var(--accent-glow), 0 18px 40px -16px var(--accent-glow)',
      textShadow: '0 1px 0 rgba(0,0,0,0.15)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--fg)',
      border: '1px solid transparent',
    },
    glass: {
      background: 'var(--surface-hi)',
      color: 'var(--fg)',
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
    onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}
    >
      {icon}{children}{iconRight}
    </button>
  );
}

// Square icon button (toolbar)
function IconBtn({ children, active, onClick, title, size = 36, style = {} }) {
  return (
    <button onClick={onClick} title={title} style={{
      width: size, height: size, borderRadius: 'var(--r-sm)',
      border: '1px solid ' + (active ? 'var(--border-hi)' : 'transparent'),
      background: active ? 'var(--surface-hi)' : 'transparent',
      color: active ? 'var(--fg)' : 'var(--fg-2)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', transition: 'all .18s',
      ...style,
    }}
    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hi)'; e.currentTarget.style.color = 'var(--fg)'; }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = active ? 'var(--surface-hi)' : 'transparent';
      e.currentTarget.style.color = active ? 'var(--fg)' : 'var(--fg-2)';
    }}>
      {children}
    </button>
  );
}

// Brand mark — gradient diamond with "n" inset
function NyzaMark({ size = 28 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.28,
      background: 'var(--accent-grad)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 6px 16px -4px var(--accent-glow)',
      position: 'relative', flexShrink: 0,
    }}>
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 16 16" fill="none">
        <path d="M3 13V3L13 13V3" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </div>
  );
}

function NyzaWordmark({ size = 18 }) {
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

// ─────────────────────────────────────────────────────────────
// ICONS — minimal lucide-style, 1.6px stroke
// ─────────────────────────────────────────────────────────────
const Ic = {
  folder:    (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>,
  folderG:   (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><circle cx="9" cy="13" r="1.2"/><path d="m6 17 3-3 3 3 4-4 3 3"/></svg>,
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
  chevronD:  (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>,
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
  arrow:     (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>,
  inbox:     (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6l2-8z"/></svg>,
  sparkles:  (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3zM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14zM5 16l.6 1.4L7 18l-1.4.6L5 20l-.6-1.4L3 18l1.4-.6L5 16z"/></svg>,
};

// ─────────────────────────────────────────────────────────────
// MOCK DATA
// ─────────────────────────────────────────────────────────────
const MOCK_FOLDERS = [
  { id: 'f1', name: 'Markenshooting · Q2', kind: 'gallery', items: 142, size: '4.2 GB', updated: 'vor 2 Std', tone: 'violet', cover: 'photo' },
  { id: 'f2', name: 'Kundenprojekt · Lichtwerk', kind: 'normal', items: 38, size: '820 MB', updated: 'gestern', tone: 'aurora', cover: 'docs' },
  { id: 'f3', name: 'Webseite Redesign', kind: 'normal', items: 56, size: '1.1 GB', updated: 'vor 3 Tagen', tone: 'sunset', cover: 'figma' },
  { id: 'f4', name: 'Vertrag & Verträge', kind: 'normal', items: 14, size: '24 MB', updated: 'vor 1 Woche', tone: 'mono', cover: 'docs' },
];

const MOCK_FILES = [
  { id: 'a', name: 'IMG_2842.heic',          type: 'image', size: '8.4 MB',  updated: 'vor 3 Min',   shared: true,  hue: 280 },
  { id: 'b', name: 'IMG_2841.heic',          type: 'image', size: '7.9 MB',  updated: 'vor 5 Min',   shared: false, hue: 200 },
  { id: 'c', name: 'Pitch_Deck_v4.pdf',      type: 'pdf',   size: '12.1 MB', updated: 'vor 1 Std',   shared: true,  hue: 14 },
  { id: 'd', name: 'Showreel_2026.mp4',      type: 'video', size: '482 MB',  updated: 'gestern',     shared: false, hue: 168 },
  { id: 'e', name: 'IMG_2840.heic',          type: 'image', size: '9.1 MB',  updated: 'vor 2 Std',   shared: false, hue: 320 },
  { id: 'f', name: 'Brand_Guidelines.pdf',   type: 'pdf',   size: '4.8 MB',  updated: 'vor 4 Std',   shared: false, hue: 240 },
  { id: 'g', name: 'IMG_2839.heic',          type: 'image', size: '6.7 MB',  updated: 'vor 6 Std',   shared: true,  hue: 45 },
  { id: 'h', name: 'Vertrag_Lichtwerk.pdf',  type: 'pdf',   size: '380 KB',  updated: 'gestern',     shared: false, hue: 120 },
];

// Helper: file-type icon + tinted background tile
function FileIcon({ type, size = 20, tint }) {
  const bg = tint != null
    ? `linear-gradient(135deg, oklch(0.7 0.16 ${tint}), oklch(0.55 0.2 ${tint + 30}))`
    : 'var(--surface-hi)';
  const ic = { image: Ic.fileImg, pdf: Ic.filePdf, video: Ic.fileVid, doc: Ic.fileGen }[type] || Ic.fileGen;
  return (
    <div style={{
      width: size * 1.9, height: size * 1.9, borderRadius: 'var(--r-sm)',
      background: bg, color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 1px 0 rgba(255,255,255,0.2) inset',
      flexShrink: 0,
    }}>{ic(size)}</div>
  );
}

// Striped placeholder image with monospace label — used when we'd need a real photo
function PhotoPlaceholder({ hue = 280, label, style = {} }) {
  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      background: `linear-gradient(135deg, oklch(0.6 0.18 ${hue}), oklch(0.4 0.16 ${(hue + 60) % 360}))`,
      ...style,
    }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.18, mixBlendMode: 'overlay' }}>
        <defs>
          <pattern id={`stripe-${hue}`} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
            <line x1="0" y1="0" x2="0" y2="14" stroke="white" strokeWidth="6"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#stripe-${hue})`}/>
      </svg>
      {label && <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.85)',
        letterSpacing: 0.5, textTransform: 'uppercase',
      }}>{label}</div>}
    </div>
  );
}

Object.assign(window, {
  NyzaTheme, NyzaAmbient, Glass, Btn, IconBtn, NyzaMark, NyzaWordmark,
  Ic, MOCK_FOLDERS, MOCK_FILES, FileIcon, PhotoPlaceholder,
  ACCENTS, FONT_PAIRS, NYZA_DEFAULTS,
});
