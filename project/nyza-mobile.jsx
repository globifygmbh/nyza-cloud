// nyza-mobile.jsx — Mobile screens for Nyza Cloud (in iPhone frame)
// Each screen renders inside an IOSDevice. Width 402, height 874.

// ─────────────────────────────────────────────────────────────
// MOBILE: DASHBOARD
// ─────────────────────────────────────────────────────────────
function NyzaMobileDashboard({ theme = 'dark' }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
      {/* Top header (replaces nav) */}
      <div style={{ padding: '70px 22px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <NyzaMark size={26}/>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-3)', lineHeight: 1 }}>Hi, Jonas</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>Nyza Cloud</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <IconBtn size={36}>{Ic.search(16)}</IconBtn>
          <IconBtn size={36}>{Ic.bolt(16)}</IconBtn>
        </div>
      </div>

      {/* Hero title */}
      <div style={{ padding: '4px 22px 18px' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 600,
          letterSpacing: -1, margin: 0, lineHeight: 1.05,
        }}>Deine Dateien.</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--surface-hi)', overflow: 'hidden' }}>
            <div style={{ width: '31%', height: '100%', background: 'var(--accent-grad)' }}/>
          </div>
          <span style={{ fontSize: 11, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>62 / 200 GB</span>
        </div>
      </div>

      {/* Quick chips */}
      <div style={{ padding: '0 22px 14px', display: 'flex', gap: 8, overflowX: 'auto' }}>
        {[
          { label: 'Alle', n: 248, active: true },
          { label: 'Bilder', n: 156 },
          { label: 'PDF', n: 38 },
          { label: 'Video', n: 12 },
          { label: 'Geteilt', n: 7 },
        ].map((c, i) => (
          <div key={i} style={{
            padding: '7px 14px', borderRadius: 999, fontSize: 12.5, fontWeight: 540,
            background: c.active ? 'var(--accent-grad)' : 'var(--surface-hi)',
            color: c.active ? '#fff' : 'var(--fg-2)',
            border: '1px solid ' + (c.active ? 'transparent' : 'var(--border)'),
            display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
            boxShadow: c.active ? '0 4px 12px -4px var(--accent-glow)' : 'none',
          }}>{c.label}<span style={{ opacity: 0.65, fontSize: 11 }}>{c.n}</span></div>
        ))}
      </div>

      {/* Folders horizontal scroll */}
      <div style={{ padding: '4px 22px 8px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, letterSpacing: -0.2 }}>Ordner</h2>
        <span style={{ fontSize: 11, color: 'var(--accent)' }}>Alle →</span>
      </div>
      <div style={{ padding: '8px 22px 18px', display: 'flex', gap: 10, overflowX: 'auto' }}>
        {MOCK_FOLDERS.slice(0, 4).map((f) => <MobileFolderCard key={f.id} folder={f}/>)}
      </div>

      {/* Files grid */}
      <div style={{ padding: '4px 22px 8px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, letterSpacing: -0.2 }}>Letzte Dateien</h2>
        <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>Datum ↓</span>
      </div>
      <div style={{ flex: 1, padding: '8px 22px 100px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, overflowY: 'auto' }}>
        {MOCK_FILES.slice(0, 6).map((f) => <MobileFileTile key={f.id} file={f}/>)}
      </div>

      {/* Bottom nav (glass pill) */}
      <div style={{
        position: 'absolute', left: 16, right: 16, bottom: 32, height: 64,
        borderRadius: 32, padding: '0 6px',
        background: 'var(--surface)', border: '1px solid var(--border-hi)',
        backdropFilter: 'blur(30px) saturate(180%)',
        WebkitBackdropFilter: 'blur(30px) saturate(180%)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-around',
        boxShadow: '0 1px 0 var(--inner-hi) inset, 0 20px 40px -10px rgba(0,0,0,0.4)',
        zIndex: 5,
      }}>
        {[
          { icon: Ic.home, label: 'Files', active: true },
          { icon: Ic.users, label: 'Geteilt' },
          // big upload pill in middle
          { upload: true },
          { icon: Ic.link, label: 'Links' },
          { icon: Ic.clock, label: 'Aktivität' },
        ].map((it, i) => it.upload ? (
          <div key={i} style={{
            width: 52, height: 52, borderRadius: 26,
            background: 'var(--accent-grad)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 8px 24px -4px var(--accent-glow)',
          }}>{Ic.plus(22)}</div>
        ) : (
          <div key={i} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            color: it.active ? 'var(--fg)' : 'var(--fg-3)', fontSize: 9.5, fontWeight: 540,
          }}>
            <span style={{ color: it.active ? 'var(--accent)' : 'currentColor' }}>{it.icon(20)}</span>
            {it.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function MobileFolderCard({ folder }) {
  const tones = { violet: 280, aurora: 168, sunset: 30, mono: 260 }[folder.tone] || 280;
  return (
    <div style={{
      width: 156, flexShrink: 0, borderRadius: 'var(--r-md)', overflow: 'hidden',
      background: 'var(--surface)', border: '1px solid var(--border)',
    }}>
      <div style={{ height: 88, position: 'relative' }}>
        {folder.kind === 'gallery' ? (
          <PhotoPlaceholder hue={tones} style={{ width: '100%', height: '100%' }}/>
        ) : (
          <div style={{
            width: '100%', height: '100%',
            background: `linear-gradient(135deg, oklch(0.4 0.12 ${tones} / 0.6), oklch(0.3 0.08 ${tones + 30} / 0.8))`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: 'var(--r-sm)',
              background: `linear-gradient(135deg, oklch(0.7 0.18 ${tones}), oklch(0.55 0.2 ${tones + 30}))`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{Ic.folder(20)}</div>
          </div>
        )}
      </div>
      <div style={{ padding: '8px 10px 10px' }}>
        <div style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{folder.name}</div>
        <div style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 2 }}>{folder.items} · {folder.size}</div>
      </div>
    </div>
  );
}

function MobileFileTile({ file }) {
  const showPreview = file.type === 'image' || file.type === 'video';
  return (
    <div style={{
      borderRadius: 'var(--r-sm)', overflow: 'hidden',
      background: 'var(--surface)', border: '1px solid var(--border)',
    }}>
      <div style={{ aspectRatio: '1/1', position: 'relative' }}>
        {showPreview
          ? <PhotoPlaceholder hue={file.hue} style={{ width: '100%', height: '100%' }}/>
          : <div style={{ width: '100%', height: '100%', background: 'var(--surface-hi)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><FileIcon type={file.type} size={26} tint={file.hue}/></div>}
        {file.shared && <div style={{ position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: 11, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.share(11)}</div>}
      </div>
      <div style={{ padding: '7px 9px' }}>
        <div style={{ fontSize: 11.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</div>
        <div style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 1 }}>{file.size}</div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MOBILE: CLIENT UPLOAD PAGE
// ─────────────────────────────────────────────────────────────
function NyzaMobileUpload() {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1, padding: '60px 18px 32px' }}>
      {/* Branded header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 7,
            background: 'linear-gradient(135deg, oklch(0.72 0.16 60), oklch(0.55 0.2 25))',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 11,
          }}>JM</div>
          <span style={{ fontSize: 12, fontWeight: 540 }}>jm-studio.de</span>
        </div>
        <div style={{ fontSize: 10, padding: '4px 8px', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)', color: 'var(--fg-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 5, height: 5, borderRadius: 3, background: 'oklch(0.74 0.16 155)' }}/>Sicher
        </div>
      </div>

      {/* Title */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 8 }}>Upload für Jonas</div>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 600,
          letterSpacing: -1, margin: 0, lineHeight: 1.0,
        }}>Dateien für<br/><span style={{ background: 'var(--accent-grad)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Lichtwerk</span></h1>
        <p style={{ fontSize: 13, color: 'var(--fg-3)', marginTop: 10, lineHeight: 1.5 }}>
          Bitte alle Rohdaten und finale Exporte hier ablegen.
        </p>
      </div>

      {/* Big dropzone */}
      <div style={{
        flex: 1, padding: 3, borderRadius: 'var(--r-xl)',
        background: 'var(--accent-grad)',
        boxShadow: '0 30px 60px -20px var(--accent-glow)',
      }}>
        <div style={{
          height: '100%', borderRadius: 'calc(var(--r-xl) - 3px)',
          background: 'var(--bg)', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', padding: 18, gap: 14,
          position: 'relative', overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', inset: 10, borderRadius: 'var(--r-lg)',
            border: '2px dashed color-mix(in oklab, var(--accent) 50%, transparent)', pointerEvents: 'none',
          }}/>
          <div style={{
            width: 76, height: 76, borderRadius: 'var(--r-lg)',
            background: 'var(--accent-grad)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 12px 32px -6px var(--accent-glow)',
            position: 'relative', zIndex: 1,
          }}>{Ic.upload(34)}</div>
          <div style={{ textAlign: 'center', position: 'relative', zIndex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, letterSpacing: -0.3 }}>Tippe zum Auswählen</div>
            <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 3 }}>oder ziehe Dateien hier rein</div>
          </div>
        </div>
      </div>

      {/* Bottom action row */}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button style={{
          flex: 1, height: 56, borderRadius: 'var(--r-md)', border: '1px solid var(--border)',
          background: 'var(--surface)', color: 'var(--fg)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          fontSize: 13, fontWeight: 540, fontFamily: 'inherit', cursor: 'pointer',
        }}>{Ic.fileGen(16)} Dateien</button>
        <button style={{
          flex: 1, height: 56, borderRadius: 'var(--r-md)', border: '1px solid var(--border)',
          background: 'var(--accent-grad)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          fontSize: 13, fontWeight: 540, fontFamily: 'inherit', cursor: 'pointer',
          boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 8px 24px -8px var(--accent-glow)',
        }}>{Ic.camera(16)} Kamera</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 14, fontSize: 10, color: 'var(--fg-3)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{Ic.lock(11)} Verschlüsselt</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{Ic.bolt(11)} Resume</span>
      </div>
    </div>
  );
}

Object.assign(window, {
  NyzaMobileDashboard, MobileFolderCard, MobileFileTile,
  NyzaMobileUpload,
});
