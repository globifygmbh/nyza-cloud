// nyza-desktop.jsx — Desktop app screens for Nyza Cloud
// Each screen takes the full ChromeWindow content area (1280x800).
// Composed of sub-components so single screens stay readable.

// ─────────────────────────────────────────────────────────────
// SIDEBAR
// ─────────────────────────────────────────────────────────────
function NyzaSidebar({ active = 'files' }) {
  const items = [
    { id: 'files',    label: 'Meine Dateien', icon: Ic.home,   count: 248 },
    { id: 'recent',   label: 'Zuletzt',       icon: Ic.clock,  count: 12 },
    { id: 'shared',   label: 'Geteilt',       icon: Ic.users,  count: 7 },
    { id: 'links',    label: 'Upload-Links',  icon: Ic.link,   count: 3, badge: 'NEU' },
    { id: 'starred',  label: 'Favoriten',     icon: Ic.star,   count: 18 },
    { id: 'trash',    label: 'Papierkorb',    icon: Ic.trash,  count: 2 },
  ];
  return (
    <Glass hi={false} style={{
      width: 248, height: '100%', borderRadius: 0,
      borderRight: '1px solid var(--border)', borderTop: 0, borderLeft: 0, borderBottom: 0,
      display: 'flex', flexDirection: 'column', flexShrink: 0,
      padding: '20px 14px',
    }}>
      <div style={{ padding: '4px 10px 22px' }}>
        <NyzaWordmark size={16}/>
      </div>

      <Btn variant="primary" size="md" icon={Ic.upload(16)} full>Hochladen</Btn>

      <div style={{ height: 1, background: 'var(--border)', margin: '18px 4px 12px' }}/>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map((it) => {
          const isActive = it.id === active;
          return (
            <div key={it.id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '9px 12px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
              background: isActive ? 'var(--surface-hi)' : 'transparent',
              color: isActive ? 'var(--fg)' : 'var(--fg-2)',
              fontSize: 14, fontWeight: isActive ? 540 : 460,
              transition: 'all .18s', position: 'relative',
            }}>
              {isActive && <div style={{
                position: 'absolute', left: -14, top: 8, bottom: 8, width: 3,
                borderRadius: 2, background: 'var(--accent-grad)',
              }}/>}
              <span style={{ color: isActive ? 'var(--accent)' : 'var(--fg-3)', display: 'inline-flex' }}>{it.icon(16)}</span>
              <span style={{ flex: 1 }}>{it.label}</span>
              {it.badge && <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: 0.6, padding: '2px 6px',
                borderRadius: 4, background: 'var(--accent-grad)', color: '#fff',
              }}>{it.badge}</span>}
              <span style={{ color: 'var(--fg-4)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{it.count}</span>
            </div>
          );
        })}
      </nav>

      <div style={{ marginTop: 'auto', padding: 8 }}>
        {/* Storage meter */}
        <div style={{ padding: '14px 12px', borderRadius: 'var(--r-md)', background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg)' }}>Speicher</span>
            <span style={{ fontSize: 11, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>62 / 200 GB</span>
          </div>
          <div style={{ height: 5, borderRadius: 3, background: 'var(--surface-hi)', overflow: 'hidden', border: '1px solid var(--border)' }}>
            <div style={{ width: '31%', height: '100%', background: 'var(--accent-grad)', borderRadius: 3 }}/>
          </div>
          <div style={{ marginTop: 12 }}>
            <Btn variant="glass" size="sm" full icon={Ic.bolt(13)}>Pro upgraden</Btn>
          </div>
        </div>
      </div>
    </Glass>
  );
}

// ─────────────────────────────────────────────────────────────
// TOPBAR — breadcrumbs, search, view toggle, theme, avatar
// ─────────────────────────────────────────────────────────────
function NyzaTopbar({ view, onView, onTheme, theme = 'dark', crumbs = ['Meine Dateien'] }) {
  return (
    <div style={{
      height: 64, padding: '0 28px', display: 'flex', alignItems: 'center', gap: 14,
      borderBottom: '1px solid var(--border)', flexShrink: 0,
      background: 'var(--surface-2)', backdropFilter: 'blur(20px)',
    }}>
      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span style={{ color: 'var(--fg-4)' }}>{Ic.chevronR(12)}</span>}
            <span style={{
              color: i === crumbs.length - 1 ? 'var(--fg)' : 'var(--fg-3)',
              fontWeight: i === crumbs.length - 1 ? 540 : 440,
              cursor: 'pointer',
            }}>{c}</span>
          </React.Fragment>
        ))}
      </div>

      <div style={{ flex: 1 }}/>

      {/* Search */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        height: 38, padding: '0 14px', borderRadius: 999,
        background: 'var(--surface-hi)', border: '1px solid var(--border)',
        width: 320, color: 'var(--fg-3)',
      }}>
        <span>{Ic.search(15)}</span>
        <input placeholder="Dateien & Ordner suchen…" style={{
          flex: 1, border: 0, outline: 0, background: 'transparent',
          color: 'var(--fg)', fontSize: 13.5, fontFamily: 'inherit',
        }}/>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 10, padding: '2px 6px',
          borderRadius: 4, background: 'var(--surface-hi)', color: 'var(--fg-3)',
          border: '1px solid var(--border)',
        }}>⌘K</span>
      </div>

      {/* View toggle */}
      <div style={{
        display: 'flex', padding: 3, borderRadius: 999,
        background: 'var(--surface-hi)', border: '1px solid var(--border)',
      }}>
        <IconBtn active={view === 'grid'} onClick={() => onView && onView('grid')} size={32} title="Raster">{Ic.grid(15)}</IconBtn>
        <IconBtn active={view === 'list'} onClick={() => onView && onView('list')} size={32} title="Liste">{Ic.list(15)}</IconBtn>
      </div>

      <IconBtn size={38} onClick={onTheme} title="Theme">{theme === 'dark' ? Ic.sun(16) : Ic.moon(16)}</IconBtn>

      {/* Avatar */}
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        background: 'linear-gradient(135deg, oklch(0.72 0.16 60), oklch(0.55 0.2 25))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', fontWeight: 600, fontSize: 13,
        boxShadow: '0 0 0 2px var(--bg), 0 0 0 3px var(--border-hi)',
      }}>JM</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// FOLDER CARD — gallery-style, with mini photo strip preview
// ─────────────────────────────────────────────────────────────
function FolderCard({ folder }) {
  const tones = {
    violet: [280, 250],
    aurora: [168, 200],
    sunset: [30, 360],
    mono:   [240, 260],
  }[folder.tone] || [280, 250];

  return (
    <div style={{
      borderRadius: 'var(--r-lg)',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      backdropFilter: 'blur(20px) saturate(160%)',
      WebkitBackdropFilter: 'blur(20px) saturate(160%)',
      overflow: 'hidden', cursor: 'pointer',
      transition: 'transform .25s cubic-bezier(.2,.8,.2,1), box-shadow .25s',
      boxShadow: '0 1px 0 var(--inner-hi) inset, 0 8px 24px -12px rgba(0,0,0,0.25)',
    }}
    onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 1px 0 var(--inner-hi) inset, 0 24px 48px -16px rgba(0,0,0,0.4), 0 0 0 1px var(--border-hi)'; }}
    onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 1px 0 var(--inner-hi) inset, 0 8px 24px -12px rgba(0,0,0,0.25)'; }}>
      {/* Cover preview */}
      <div style={{ height: 132, position: 'relative', overflow: 'hidden' }}>
        {folder.kind === 'gallery' ? (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: '2fr 1fr', gridTemplateRows: '1fr 1fr', gap: 2 }}>
            <PhotoPlaceholder hue={tones[0]} style={{ gridRow: '1 / 3' }}/>
            <PhotoPlaceholder hue={tones[0] + 30}/>
            <PhotoPlaceholder hue={tones[0] - 30}/>
          </div>
        ) : (
          <div style={{
            position: 'absolute', inset: 0,
            background: `linear-gradient(135deg, oklch(0.4 0.12 ${tones[0]} / 0.5), oklch(0.3 0.08 ${tones[1]} / 0.7))`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              width: 64, height: 64, borderRadius: 'var(--r-md)',
              background: `linear-gradient(135deg, oklch(0.7 0.18 ${tones[0]}), oklch(0.55 0.2 ${tones[1]}))`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 8px 24px -8px oklch(0.65 0.2 ' + tones[0] + ' / 0.6)',
              color: '#fff',
            }}>{Ic.folder(28)}</div>
          </div>
        )}
        {/* kind chip */}
        <div style={{
          position: 'absolute', top: 10, right: 10,
          padding: '4px 8px', borderRadius: 999, fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
          background: 'rgba(0,0,0,0.5)', color: '#fff', backdropFilter: 'blur(10px)',
          textTransform: 'uppercase',
        }}>{folder.kind === 'gallery' ? '◇ Galerie' : '◇ Dateien'}</div>
      </div>

      {/* Meta */}
      <div style={{ padding: '14px 16px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 540, color: 'var(--fg)', lineHeight: 1.3, letterSpacing: -0.1 }}>{folder.name}</div>
          <span style={{ color: 'var(--fg-3)', cursor: 'pointer' }}>{Ic.more(16)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5, color: 'var(--fg-3)' }}>
          <span>{folder.items} Dateien</span>
          <span style={{ width: 2, height: 2, borderRadius: 1, background: 'var(--fg-4)' }}/>
          <span>{folder.size}</span>
          <span style={{ width: 2, height: 2, borderRadius: 1, background: 'var(--fg-4)' }}/>
          <span>{folder.updated}</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// FILE TILE — for grid view
// ─────────────────────────────────────────────────────────────
function FileTile({ file, selected }) {
  const showPreview = file.type === 'image' || file.type === 'video';
  return (
    <div style={{
      borderRadius: 'var(--r-md)',
      background: 'var(--surface)',
      border: '1px solid ' + (selected ? 'var(--accent)' : 'var(--border)'),
      overflow: 'hidden', cursor: 'pointer', position: 'relative',
      boxShadow: selected ? '0 0 0 3px var(--accent-glow)' : '0 1px 0 var(--inner-hi) inset',
      transition: 'all .2s',
    }}>
      <div style={{ aspectRatio: '4/3', position: 'relative' }}>
        {showPreview
          ? <PhotoPlaceholder hue={file.hue} style={{ width: '100%', height: '100%' }} label={file.type === 'video' ? 'video' : null}/>
          : <div style={{
              width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--surface-hi)',
            }}>
              <FileIcon type={file.type} size={32} tint={file.hue}/>
            </div>}
        {file.type === 'video' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="white"><path d="M3 1l9 6-9 6z"/></svg>
            </div>
          </div>
        )}
        {file.shared && (
          <div style={{
            position: 'absolute', top: 8, right: 8, width: 24, height: 24, borderRadius: 999,
            background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{Ic.share(12)}</div>
        )}
        {selected && (
          <div style={{
            position: 'absolute', top: 8, left: 8, width: 22, height: 22, borderRadius: 999,
            background: 'var(--accent-grad)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 2px 8px var(--accent-glow)',
          }}>{Ic.check(13)}</div>
        )}
      </div>
      <div style={{ padding: '10px 12px' }}>
        <div style={{
          fontSize: 12.5, fontWeight: 500, color: 'var(--fg)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{file.name}</div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2, display: 'flex', justifyContent: 'space-between' }}>
          <span>{file.size}</span>
          <span>{file.updated}</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN: DASHBOARD GRID — sidebar + topbar + folders + files
// ─────────────────────────────────────────────────────────────
function NyzaDashboard({ view = 'grid', onView, onTheme, theme }) {
  return (
    <div style={{ display: 'flex', height: '100%', position: 'relative', zIndex: 1 }}>
      <NyzaSidebar active="files"/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <NyzaTopbar view={view} onView={onView} onTheme={onTheme} theme={theme} crumbs={['Meine Dateien']}/>
        <div style={{ flex: 1, overflow: 'auto', padding: '28px 32px 40px' }}>
          {/* Hero */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, marginBottom: 28 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: 'var(--fg-3)', marginBottom: 6, letterSpacing: 0.2 }}>Guten Morgen, Jonas</div>
              <h1 style={{
                fontFamily: 'var(--font-display)', fontSize: 38, fontWeight: 600,
                letterSpacing: -1.2, margin: 0, lineHeight: 1.05, color: 'var(--fg)',
              }}>Deine Dateien.<span style={{ color: 'var(--fg-3)' }}> Schön sortiert.</span></h1>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn variant="glass" size="md" icon={Ic.link(15)}>Upload-Link</Btn>
              <Btn variant="primary" size="md" icon={Ic.upload(15)}>Hochladen</Btn>
            </div>
          </div>

          {/* Quick stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 32 }}>
            {[
              { label: 'Gespeichert', v: '62.4 GB', sub: 'von 200 GB', accent: true },
              { label: 'Dateien gesamt', v: '1 248', sub: 'in 38 Ordnern' },
              { label: 'Aktive Links', v: '7', sub: '3 mit Upload' },
              { label: 'Letzte 7 Tage', v: '+128', sub: 'Hochgeladen' },
            ].map((s, i) => (
              <div key={i} style={{
                padding: '14px 18px', borderRadius: 'var(--r-md)',
                background: 'var(--surface)', border: '1px solid var(--border)',
                position: 'relative', overflow: 'hidden',
              }}>
                {s.accent && <div style={{
                  position: 'absolute', inset: 0, background: 'var(--accent-grad)', opacity: 0.08, pointerEvents: 'none',
                }}/>}
                <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4, position: 'relative' }}>{s.label}</div>
                <div style={{ fontSize: 22, fontFamily: 'var(--font-display)', fontWeight: 600, letterSpacing: -0.6, color: 'var(--fg)', position: 'relative' }}>{s.v}</div>
                <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2, position: 'relative' }}>{s.sub}</div>
              </div>
            ))}
          </div>

          {/* Folders section */}
          <SectionHeader title="Ordner" count={4} action="Alle anzeigen"/>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 36 }}>
            {MOCK_FOLDERS.map((f) => <FolderCard key={f.id} folder={f}/>)}
          </div>

          {/* Files section */}
          <SectionHeader title="Letzte Dateien" count={MOCK_FILES.length} action="Sortieren · Datum"/>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14 }}>
            {MOCK_FILES.slice(0, 5).map((f, i) => <FileTile key={f.id} file={f} selected={i === 0}/>)}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title, count, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, letterSpacing: -0.4, margin: 0, color: 'var(--fg)' }}>{title}</h2>
        <span style={{ fontSize: 12, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
      </div>
      {action && <span style={{ fontSize: 12, color: 'var(--fg-3)', cursor: 'pointer' }}>{action} →</span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN: LIST VIEW
// ─────────────────────────────────────────────────────────────
function NyzaListView({ onView, onTheme, theme }) {
  const rows = [
    ...MOCK_FILES,
    { id: 'i', name: 'Logo_Final.svg',     type: 'doc',   size: '24 KB',  updated: 'gestern', shared: false, hue: 200 },
    { id: 'j', name: 'Notizen_Meeting.md', type: 'doc',   size: '12 KB',  updated: 'gestern', shared: true,  hue: 80 },
  ];
  return (
    <div style={{ display: 'flex', height: '100%', position: 'relative', zIndex: 1 }}>
      <NyzaSidebar active="files"/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <NyzaTopbar view="list" onView={onView} onTheme={onTheme} theme={theme} crumbs={['Meine Dateien', 'Markenshooting · Q2']}/>
        <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px 40px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
            <div>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 600, letterSpacing: -0.8, margin: 0 }}>Markenshooting · Q2</h1>
              <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 4 }}>142 Dateien · 4.2 GB · Aktualisiert vor 2 Std</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn variant="glass" size="md" icon={Ic.download(15)}>ZIP Download</Btn>
              <Btn variant="primary" size="md" icon={Ic.share(15)}>Teilen</Btn>
            </div>
          </div>

          {/* List */}
          <div style={{
            borderRadius: 'var(--r-md)', overflow: 'hidden',
            background: 'var(--surface)', border: '1px solid var(--border)',
            backdropFilter: 'blur(20px) saturate(160%)',
          }}>
            {/* Header */}
            <div style={{
              display: 'grid', gridTemplateColumns: '32px 2fr 110px 120px 120px 80px 40px',
              alignItems: 'center', gap: 16, padding: '10px 16px',
              fontSize: 11, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: 0.5,
              borderBottom: '1px solid var(--border)', background: 'var(--surface-hi)',
            }}>
              <span/>
              <span>Name ↑</span>
              <span>Typ</span>
              <span>Größe</span>
              <span>Geändert</span>
              <span>Geteilt</span>
              <span/>
            </div>
            {rows.map((r, i) => (
              <div key={r.id} style={{
                display: 'grid', gridTemplateColumns: '32px 2fr 110px 120px 120px 80px 40px',
                alignItems: 'center', gap: 16, padding: '10px 16px',
                borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none',
                fontSize: 13, color: 'var(--fg)',
                cursor: 'pointer', transition: 'background .15s',
                background: i === 1 ? 'color-mix(in oklab, var(--accent) 10%, transparent)' : 'transparent',
              }}>
                <input type="checkbox" defaultChecked={i === 1} style={{ accentColor: 'var(--accent)' }}/>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  <FileIcon type={r.type} size={16} tint={r.hue}/>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                </div>
                <span style={{ fontSize: 11.5, color: 'var(--fg-3)', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>{r.type}</span>
                <span style={{ fontSize: 12.5, color: 'var(--fg-2)', fontVariantNumeric: 'tabular-nums' }}>{r.size}</span>
                <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{r.updated}</span>
                <span style={{ color: r.shared ? 'var(--accent)' : 'var(--fg-4)' }}>{r.shared ? Ic.share(14) : '—'}</span>
                <span style={{ color: 'var(--fg-3)', justifySelf: 'end' }}>{Ic.more(16)}</span>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 12, color: 'var(--fg-3)' }}>
            <span>1 ausgewählt</span>
            <div style={{ flex: 1 }}/>
            <Btn variant="glass" size="sm" icon={Ic.download(13)}>Download</Btn>
            <Btn variant="glass" size="sm" icon={Ic.share(13)}>Teilen</Btn>
            <Btn variant="glass" size="sm" icon={Ic.trash(13)}>Löschen</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN: GALLERY — image-heavy folder
// ─────────────────────────────────────────────────────────────
function NyzaGallery({ onTheme, theme }) {
  const photos = Array.from({ length: 24 }, (_, i) => ({
    id: i, hue: (i * 37) % 360, h: 160 + (i % 3) * 60,
  }));
  return (
    <div style={{ display: 'flex', height: '100%', position: 'relative', zIndex: 1 }}>
      <NyzaSidebar active="files"/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <NyzaTopbar view="grid" onTheme={onTheme} theme={theme} crumbs={['Meine Dateien', 'Markenshooting · Q2']}/>
        <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px 40px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 22 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>◇ Galerie · 142 Bilder</div>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 600, letterSpacing: -0.8, margin: 0 }}>Markenshooting · Q2</h1>
            </div>
            <Btn variant="glass" size="md" icon={Ic.download(15)}>Alle herunterladen</Btn>
            <Btn variant="primary" size="md" icon={Ic.share(15)}>Teilen</Btn>
          </div>
          {/* Mosaic */}
          <div style={{ columnCount: 4, columnGap: 12 }}>
            {photos.map((p) => (
              <div key={p.id} style={{
                breakInside: 'avoid', marginBottom: 12, borderRadius: 'var(--r-md)', overflow: 'hidden',
                cursor: 'pointer', transition: 'transform .25s', position: 'relative',
                boxShadow: '0 8px 24px -12px rgba(0,0,0,0.3)',
              }}>
                <PhotoPlaceholder hue={p.hue} style={{ width: '100%', height: p.h }}/>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN: FULLSCREEN IMAGE VIEWER (overlay-style)
// ─────────────────────────────────────────────────────────────
function NyzaImageViewer() {
  const thumbs = Array.from({ length: 8 }, (_, i) => ({ hue: (280 + i * 25) % 360 }));
  return (
    <div style={{ position: 'relative', zIndex: 1, height: '100%', background: '#000', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{ height: 60, padding: '0 24px', display: 'flex', alignItems: 'center', gap: 16, color: '#fff' }}>
        <div style={{ width: 36, height: 36, borderRadius: 'var(--r-sm)', background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Ic.close(18)}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 540 }}>IMG_2842.heic</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>3 / 142 · 8.4 MB · 4032 × 3024</div>
        </div>
        <Btn variant="glass" size="sm" icon={Ic.share(14)}>Teilen</Btn>
        <Btn variant="glass" size="sm" icon={Ic.download(14)}>Download</Btn>
        <IconBtn size={36} style={{ color: '#fff' }}>{Ic.more(18)}</IconBtn>
      </div>
      {/* Stage */}
      <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        {/* Prev / Next */}
        <button style={navArrowStyle('left')}>{Ic.chevronL(20)}</button>
        <button style={navArrowStyle('right')}>{Ic.chevronR(20)}</button>
        <div style={{ width: '78%', height: '100%', maxWidth: 840, borderRadius: 'var(--r-lg)', overflow: 'hidden', boxShadow: '0 30px 80px rgba(0,0,0,0.6)' }}>
          <PhotoPlaceholder hue={310} style={{ width: '100%', height: '100%' }} label="IMG_2842"/>
        </div>
      </div>
      {/* Filmstrip */}
      <div style={{ height: 88, padding: '0 24px 16px', display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
        {thumbs.map((t, i) => (
          <div key={i} style={{
            width: 64, height: 64, flexShrink: 0, borderRadius: 'var(--r-sm)', overflow: 'hidden',
            border: '2px solid ' + (i === 2 ? 'var(--accent)' : 'transparent'),
            opacity: i === 2 ? 1 : 0.65, cursor: 'pointer',
          }}>
            <PhotoPlaceholder hue={t.hue} style={{ width: '100%', height: '100%' }}/>
          </div>
        ))}
        <div style={{ flex: 1 }}/>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>03 / 142</span>
      </div>
    </div>
  );
}
function navArrowStyle(dir) {
  return {
    position: 'absolute', top: '50%', [dir]: 28, transform: 'translateY(-50%)',
    width: 44, height: 44, borderRadius: 22, border: 'none',
    background: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(20px)',
    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', zIndex: 2,
  };
}

// ─────────────────────────────────────────────────────────────
// SCREEN: SHARE MODAL — over a dimmed dashboard
// ─────────────────────────────────────────────────────────────
function NyzaShareModal({ onTheme, theme }) {
  return (
    <div style={{ position: 'relative', zIndex: 1, height: '100%', display: 'flex' }}>
      {/* Dimmed dashboard backdrop */}
      <div style={{ position: 'absolute', inset: 0, filter: 'blur(8px) brightness(0.55)', pointerEvents: 'none' }}>
        <NyzaDashboard view="grid" theme={theme}/>
      </div>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(12px)' }}/>
      {/* Modal */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Glass style={{
          width: 540, borderRadius: 'var(--r-xl)', padding: 0, overflow: 'hidden',
        }}>
          <div style={{ padding: '24px 28px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 'var(--r-sm)',
                background: 'var(--accent-grad)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                boxShadow: '0 4px 16px var(--accent-glow)',
              }}>{Ic.share(18)}</div>
              <div style={{ flex: 1 }}>
                <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0, letterSpacing: -0.3 }}>Markenshooting · Q2 teilen</h2>
                <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 2 }}>142 Dateien · 4.2 GB</div>
              </div>
              <IconBtn size={32}>{Ic.close(16)}</IconBtn>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--surface-hi)', borderRadius: 999, border: '1px solid var(--border)', marginBottom: 18 }}>
              {[{ id: 'link', label: 'Link', icon: Ic.link, active: true }, { id: 'people', label: 'Personen', icon: Ic.users }, { id: 'upload', label: 'Upload-Link', icon: Ic.inbox }].map((t) => (
                <div key={t.id} style={{
                  flex: 1, height: 32, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  fontSize: 12.5, fontWeight: 540, cursor: 'pointer',
                  background: t.active ? 'var(--surface)' : 'transparent',
                  color: t.active ? 'var(--fg)' : 'var(--fg-3)',
                  boxShadow: t.active ? '0 1px 0 var(--inner-hi) inset, 0 1px 4px rgba(0,0,0,0.1)' : 'none',
                }}>
                  <span>{t.icon(13)}</span>{t.label}
                </div>
              ))}
            </div>

            {/* Link row */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px 8px 16px',
              borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)', marginBottom: 16,
            }}>
              <span style={{ color: 'var(--fg-3)' }}>{Ic.link(14)}</span>
              <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>nyza.cloud/s/q2-marken-2yk7d3</span>
              <Btn variant="primary" size="sm" icon={Ic.copy(13)}>Kopieren</Btn>
            </div>

            {/* Options */}
            <ShareToggleRow icon={Ic.eye} title="Öffentlich sichtbar" desc="Jeder mit dem Link kann ansehen" on/>
            <ShareToggleRow icon={Ic.download} title="Download erlauben" desc="ZIP & Einzeldownload" on/>
            <ShareToggleRow icon={Ic.lock} title="Mit Passwort schützen" desc="••••••••" on/>
            <ShareToggleRow icon={Ic.clock} title="Ablaufdatum" desc="14. Mai 2026" on/>
          </div>

          {/* Preview chip + footer */}
          <div style={{
            margin: '20px 0 0', padding: '14px 28px',
            background: 'var(--surface-hi)', borderTop: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{ display: 'flex', gap: -6 }}>
              {[280, 200, 30].map((h, i) => (
                <div key={i} style={{
                  width: 28, height: 28, borderRadius: 6, marginLeft: i ? -8 : 0,
                  border: '2px solid var(--bg)', overflow: 'hidden',
                }}>
                  <PhotoPlaceholder hue={h} style={{ width: '100%', height: '100%' }}/>
                </div>
              ))}
            </div>
            <div style={{ flex: 1, fontSize: 12, color: 'var(--fg-3)' }}>
              Empfänger sehen eine schöne Vorschauseite mit Download-Button.
            </div>
            <Btn variant="glass" size="sm">Vorschau</Btn>
          </div>
        </Glass>
      </div>
    </div>
  );
}

function ShareToggleRow({ icon, title, desc, on }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{
        width: 32, height: 32, borderRadius: 'var(--r-sm)',
        background: on ? 'color-mix(in oklab, var(--accent) 18%, transparent)' : 'var(--surface-hi)',
        color: on ? 'var(--accent)' : 'var(--fg-3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{icon(15)}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--fg)' }}>{title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 1 }}>{desc}</div>
      </div>
      <Toggle on={on}/>
    </div>
  );
}

function Toggle({ on }) {
  return (
    <div style={{
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

// ─────────────────────────────────────────────────────────────
// SCREEN: UPLOAD-LINK CREATE MODAL
// ─────────────────────────────────────────────────────────────
function NyzaUploadLinkModal({ onTheme, theme }) {
  return (
    <div style={{ position: 'relative', zIndex: 1, height: '100%', display: 'flex' }}>
      <div style={{ position: 'absolute', inset: 0, filter: 'blur(8px) brightness(0.55)', pointerEvents: 'none' }}>
        <NyzaDashboard view="grid" theme={theme}/>
      </div>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(12px)' }}/>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Glass style={{ width: 600, borderRadius: 'var(--r-xl)', overflow: 'hidden' }}>
          <div style={{ padding: '22px 28px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 'var(--r-sm)',
              background: 'var(--accent-grad)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 16px var(--accent-glow)',
            }}>{Ic.inbox(18)}</div>
            <div style={{ flex: 1 }}>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0, letterSpacing: -0.3 }}>Upload-Link erstellen</h2>
              <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>Externe können Dateien hochladen — ohne Anmeldung</div>
            </div>
            <IconBtn>{Ic.close(16)}</IconBtn>
          </div>

          <div style={{ padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Field label="Titel" hint="Wird auf der Upload-Seite groß angezeigt">
              <Input value="Dateien für Projekt Lichtwerk" />
            </Field>
            <Field label="Beschreibung (optional)">
              <Textarea value="Hi! Bitte alle Rohdaten und finale Exporte hier ablegen. Wir benötigen sie bis Freitag."/>
            </Field>

            <Field label="Zielordner">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
                <FileIcon type="doc" size={14} tint={200}/>
                <span style={{ fontSize: 13, fontWeight: 500 }}>Kundenprojekt · Lichtwerk</span>
                <span style={{ flex: 1 }}/>
                <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Ändern</span>
              </div>
            </Field>

            {/* Constraint grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ConstraintBox icon={Ic.lock} title="Passwort" value="•••••••• ✓" enabled/>
              <ConstraintBox icon={Ic.clock} title="Ablauf" value="14 Tage"  enabled/>
              <ConstraintBox icon={Ic.fileGen} title="Max. pro Datei" value="2 GB" enabled/>
              <ConstraintBox icon={Ic.bolt} title="Max. Anzahl" value="20 Dateien"/>
            </div>
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '16px 28px', borderTop: '1px solid var(--border)',
            background: 'var(--surface-hi)',
          }}>
            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Sicherer Upload · 256-bit Verschlüsselung</span>
            <span style={{ flex: 1 }}/>
            <Btn variant="ghost" size="md">Abbrechen</Btn>
            <Btn variant="primary" size="md" icon={Ic.link(15)}>Link erstellen</Btn>
          </div>
        </Glass>
      </div>
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
function Input({ value }) {
  return <div style={{
    height: 40, display: 'flex', alignItems: 'center', padding: '0 14px',
    borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)',
    fontSize: 14, color: 'var(--fg)',
  }}>{value}<span style={{ width: 1.5, height: 16, background: 'var(--accent)', marginLeft: 1, animation: 'blink 1s infinite' }}/></div>;
}
function Textarea({ value }) {
  return <div style={{
    minHeight: 64, padding: '12px 14px',
    borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)',
    fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5,
  }}>{value}</div>;
}
function ConstraintBox({ icon, title, value, enabled }) {
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 'var(--r-sm)',
      background: enabled ? 'color-mix(in oklab, var(--accent) 8%, var(--surface-hi))' : 'var(--surface-hi)',
      border: '1px solid ' + (enabled ? 'color-mix(in oklab, var(--accent) 30%, transparent)' : 'var(--border)'),
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <div style={{
        width: 30, height: 30, borderRadius: 'var(--r-xs)',
        background: enabled ? 'var(--accent-grad)' : 'var(--surface-hi)',
        color: enabled ? '#fff' : 'var(--fg-3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{icon(14)}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>{title}</div>
        <div style={{ fontSize: 13, fontWeight: 540, color: 'var(--fg)', marginTop: 1 }}>{value}</div>
      </div>
      <Toggle on={enabled}/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN: EMPTY / ONBOARDING
// ─────────────────────────────────────────────────────────────
function NyzaEmpty({ onTheme, theme }) {
  return (
    <div style={{ display: 'flex', height: '100%', position: 'relative', zIndex: 1 }}>
      <NyzaSidebar active="files"/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <NyzaTopbar view="grid" onTheme={onTheme} theme={theme} crumbs={['Meine Dateien']}/>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <div style={{ maxWidth: 480, textAlign: 'center' }}>
            {/* Hero icon */}
            <div style={{ position: 'relative', width: 140, height: 140, margin: '0 auto 32px' }}>
              <div style={{
                position: 'absolute', inset: 0, borderRadius: 'var(--r-2xl)',
                background: 'var(--accent-grad)', opacity: 0.3, filter: 'blur(30px)',
              }}/>
              <div style={{
                position: 'absolute', inset: 14, borderRadius: 'var(--r-xl)',
                background: 'var(--surface)', border: '1px solid var(--border-hi)',
                backdropFilter: 'blur(20px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 1px 0 var(--inner-hi) inset, 0 20px 60px -20px var(--accent-glow)',
              }}>
                <div style={{ color: 'var(--accent)' }}>{Ic.upload(56)}</div>
              </div>
            </div>
            <h1 style={{
              fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 600,
              letterSpacing: -1, margin: 0, lineHeight: 1.1,
            }}>Willkommen bei Nyza Cloud.</h1>
            <p style={{ fontSize: 15, color: 'var(--fg-3)', marginTop: 12, lineHeight: 1.55 }}>
              Datei reinziehen — oder Upload-Link erzeugen.<br/>
              <span style={{ color: 'var(--fg-4)' }}>So einfach war Cloud-Speicher noch nie.</span>
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 28 }}>
              <Btn variant="primary" size="lg" icon={Ic.upload(16)}>Erste Datei hochladen</Btn>
              <Btn variant="glass" size="lg" icon={Ic.link(16)}>Upload-Link erstellen</Btn>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, marginTop: 32, fontSize: 11.5, color: 'var(--fg-4)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{Ic.lock(12)} Ende-zu-Ende verschlüsselt</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{Ic.bolt(12)} Chunk-Upload bis 50 GB</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{Ic.users(12)} 0 Setup</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN: CLIENT SHARE PAGE (download — WeTransfer-like, premium)
// ─────────────────────────────────────────────────────────────
function NyzaSharePage() {
  return (
    <div style={{ position: 'relative', zIndex: 1, height: '100%', overflow: 'auto' }}>
      {/* Branded header */}
      <div style={{ padding: '28px 40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'linear-gradient(135deg, oklch(0.72 0.16 60), oklch(0.55 0.2 25))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 700, fontSize: 13,
          }}>JM</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 540 }}>Jonas Müller</div>
            <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>jm-studio.de</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--fg-3)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{Ic.lock(11)} Sicher · 256-bit</span>
          <span>·</span>
          <span>via</span>
          <NyzaWordmark size={11}/>
        </div>
      </div>

      {/* Hero */}
      <div style={{ padding: '40px 40px 60px', display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 60, alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 24, height: 1, background: 'var(--accent)' }}/>
            Geteilte Dateien für Sie
          </div>
          <h1 style={{
            fontFamily: 'var(--font-display)', fontSize: 56, fontWeight: 600,
            letterSpacing: -2, margin: 0, lineHeight: 1.0, color: 'var(--fg)',
          }}>Markenshooting<br/><span style={{ color: 'var(--fg-3)' }}>· Q2 2026</span></h1>
          <p style={{ fontSize: 16, color: 'var(--fg-2)', marginTop: 18, lineHeight: 1.55, maxWidth: 480 }}>
            Hi Anna — hier sind alle finalen Bilder vom Shoot am Donnerstag. Ich freue mich auf dein Feedback. ✨
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 32 }}>
            <Btn variant="primary" size="xl" icon={Ic.download(20)}>Alles herunterladen</Btn>
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, letterSpacing: -0.3 }}>4.2 GB · ZIP</div>
              <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>142 Dateien · läuft ab am 14. Mai</div>
            </div>
          </div>
        </div>

        {/* Stack of preview cards */}
        <div style={{ position: 'relative', aspectRatio: '1/1', maxWidth: 440, marginLeft: 'auto' }}>
          {[
            { hue: 280, rot: -8, x: -20, y: 30, z: 1 },
            { hue: 320, rot: 4,  x: 30,  y: 0,  z: 2 },
            { hue: 200, rot: -2, x: 0,   y: -20, z: 3 },
          ].map((c, i) => (
            <div key={i} style={{
              position: 'absolute', inset: 0, transform: `translate(${c.x}px, ${c.y}px) rotate(${c.rot}deg)`,
              borderRadius: 'var(--r-lg)', overflow: 'hidden', zIndex: c.z,
              boxShadow: '0 30px 80px -20px rgba(0,0,0,0.4), 0 0 0 1px var(--border)',
            }}>
              <PhotoPlaceholder hue={c.hue} style={{ width: '100%', height: '100%' }} label={`#${i + 1}`}/>
            </div>
          ))}
        </div>
      </div>

      {/* File list */}
      <div style={{ padding: '0 40px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0, letterSpacing: -0.3 }}>Inhalt</h2>
          <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>142 Dateien</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} style={{ aspectRatio: '1/1', borderRadius: 'var(--r-sm)', overflow: 'hidden', border: '1px solid var(--border)' }}>
              <PhotoPlaceholder hue={(280 + i * 25) % 360} style={{ width: '100%', height: '100%' }}/>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN: CLIENT UPLOAD PAGE (no-login dropzone)
// ─────────────────────────────────────────────────────────────
function NyzaClientUploadPage() {
  return (
    <div style={{ position: 'relative', zIndex: 1, height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '24px 40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8,
            background: 'linear-gradient(135deg, oklch(0.72 0.16 60), oklch(0.55 0.2 25))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 700, fontSize: 12,
          }}>JM</div>
          <span style={{ fontSize: 13, fontWeight: 540 }}>jm-studio.de</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-3)', padding: '6px 10px', borderRadius: 999, background: 'var(--surface-hi)', border: '1px solid var(--border)' }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: 'oklch(0.74 0.16 155)' }}/>
          Sicherer Upload · keine Anmeldung
        </div>
      </div>

      <div style={{ flex: 1, padding: '20px 40px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 720, textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 14 }}>Upload für Jonas Müller</div>
          <h1 style={{
            fontFamily: 'var(--font-display)', fontSize: 48, fontWeight: 600,
            letterSpacing: -1.6, margin: 0, lineHeight: 1.05,
          }}>Dateien für<br/><span style={{ background: 'var(--accent-grad)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>Projekt Lichtwerk</span></h1>
          <p style={{ fontSize: 15, color: 'var(--fg-3)', marginTop: 14, lineHeight: 1.55 }}>
            Bitte alle Rohdaten und finale Exporte hier ablegen.<br/>Wir benötigen sie bis Freitag, 8. Mai.
          </p>
        </div>

        {/* Dropzone — large, glassy, with animated dashed border */}
        <div style={{
          width: '100%', maxWidth: 720,
          padding: 4, borderRadius: 'var(--r-xl)',
          background: 'var(--accent-grad)', position: 'relative',
          boxShadow: '0 30px 80px -30px var(--accent-glow), 0 8px 32px -8px rgba(0,0,0,0.3)',
        }}>
          <div style={{
            background: 'var(--bg)', borderRadius: 'calc(var(--r-xl) - 4px)',
            padding: '52px 32px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
            position: 'relative', overflow: 'hidden',
          }}>
            {/* dashed inner border */}
            <div style={{
              position: 'absolute', inset: 12,
              borderRadius: 'var(--r-lg)',
              border: '2px dashed color-mix(in oklab, var(--accent) 50%, transparent)',
              pointerEvents: 'none',
            }}/>
            <div style={{
              width: 88, height: 88, borderRadius: 'var(--r-xl)',
              background: 'var(--accent-grad)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 12px 32px -8px var(--accent-glow)',
              position: 'relative', zIndex: 1,
            }}>{Ic.upload(40)}</div>
            <div style={{ textAlign: 'center', position: 'relative', zIndex: 1 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, letterSpacing: -0.4 }}>Zieh deine Dateien hier rein</div>
              <div style={{ fontSize: 13, color: 'var(--fg-3)', marginTop: 4 }}>oder klicke zum Auswählen · max. 2 GB pro Datei</div>
            </div>
            <div style={{ display: 'flex', gap: 10, position: 'relative', zIndex: 1 }}>
              <Btn variant="primary" size="md" icon={Ic.fileGen(15)}>Dateien wählen</Btn>
              <Btn variant="glass" size="md" icon={Ic.camera(15)}>Foto aufnehmen</Btn>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginTop: 28, fontSize: 12, color: 'var(--fg-3)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{Ic.lock(13)} Verschlüsselte Übertragung</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{Ic.bolt(13)} Resume bei Abbruch</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{Ic.check(13)} 20 Slots frei</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SCREEN: UPLOAD PROGRESS / SUCCESS
// ─────────────────────────────────────────────────────────────
function NyzaUploadProgress() {
  const files = [
    { name: 'IMG_2842.heic',         size: '8.4 MB',  pct: 100, status: 'done' },
    { name: 'IMG_2843.heic',         size: '7.9 MB',  pct: 100, status: 'done' },
    { name: 'Showreel_2026.mp4',     size: '482 MB',  pct: 64,  status: 'uploading' },
    { name: 'Pitch_Deck_v4.pdf',     size: '12.1 MB', pct: 0,   status: 'queued' },
    { name: 'Brand_Guidelines.pdf',  size: '4.8 MB',  pct: 0,   status: 'queued' },
  ];
  return (
    <div style={{ position: 'relative', zIndex: 1, height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '24px 40px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: 'linear-gradient(135deg, oklch(0.72 0.16 60), oklch(0.55 0.2 25))',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 12,
        }}>JM</div>
        <span style={{ fontSize: 13, fontWeight: 540 }}>jm-studio.de</span>
      </div>

      <div style={{ flex: 1, padding: '20px 40px 40px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Glass style={{ width: '100%', maxWidth: 640, borderRadius: 'var(--r-xl)', padding: 28 }}>
          {/* Big circular progress */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginBottom: 24 }}>
            <CircularProgress pct={73} size={104}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 4 }}>Wird hochgeladen…</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600, letterSpacing: -0.6, lineHeight: 1.1 }}>2 von 5 Dateien fertig</div>
              <div style={{ fontSize: 13, color: 'var(--fg-3)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                382 / 515 MB · ~ 24 Sek. übrig · 14 MB/s
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {files.map((f, i) => (
              <UploadRow key={i} file={f}/>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
            <span style={{ fontSize: 12, color: 'var(--fg-3)', flex: 1 }}>Verbindung unterbrochen? Upload setzt automatisch fort.</span>
            <Btn variant="ghost" size="sm">Abbrechen</Btn>
          </div>
        </Glass>
      </div>
    </div>
  );
}

function UploadRow({ file }) {
  const isDone = file.status === 'done';
  const isUp = file.status === 'uploading';
  const isQ = file.status === 'queued';
  const ext = file.name.split('.').pop();
  const tint = ext === 'heic' ? 280 : ext === 'mp4' ? 168 : 14;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
      borderRadius: 'var(--r-sm)', background: isUp ? 'color-mix(in oklab, var(--accent) 6%, transparent)' : 'var(--surface-hi)',
      border: '1px solid ' + (isUp ? 'color-mix(in oklab, var(--accent) 25%, transparent)' : 'var(--border)'),
      position: 'relative', overflow: 'hidden',
    }}>
      {/* progress fill */}
      {isUp && <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: file.pct + '%',
        background: 'color-mix(in oklab, var(--accent) 14%, transparent)', pointerEvents: 'none',
      }}/>}
      <FileIcon type={ext === 'heic' ? 'image' : ext === 'mp4' ? 'video' : 'pdf'} size={14} tint={tint}/>
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>{file.size}</div>
      </div>
      <div style={{ position: 'relative' }}>
        {isDone && <div style={{
          width: 22, height: 22, borderRadius: 11, background: 'oklch(0.74 0.16 155)',
          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{Ic.check(13)}</div>}
        {isUp && <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--accent)', fontWeight: 600 }}>{file.pct}%</div>}
        {isQ && <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>wartet</span>}
      </div>
    </div>
  );
}

function CircularProgress({ pct, size = 80, thick = 8 }) {
  const r = (size - thick) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--surface-hi)" strokeWidth={thick}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="url(#prog-grad)" strokeWidth={thick}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct/100)}
          transform={`rotate(-90 ${size/2} ${size/2})`}/>
        <defs>
          <linearGradient id="prog-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--accent-from)"/>
            <stop offset="1" stopColor="var(--accent-to)"/>
          </linearGradient>
        </defs>
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column',
      }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: size * 0.28, fontWeight: 600, letterSpacing: -0.6, color: 'var(--fg)' }}>{pct}<span style={{ fontSize: size * 0.12, color: 'var(--fg-3)', marginLeft: 1 }}>%</span></div>
      </div>
    </div>
  );
}

function NyzaUploadSuccess() {
  return (
    <div style={{ position: 'relative', zIndex: 1, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, overflow: 'auto' }}>
      <div style={{ maxWidth: 480, textAlign: 'center' }}>
        <div style={{ position: 'relative', width: 120, height: 120, margin: '0 auto 28px' }}>
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'oklch(0.74 0.16 155)', opacity: 0.3, filter: 'blur(30px)' }}/>
          <div style={{
            position: 'absolute', inset: 12, borderRadius: '50%',
            background: 'linear-gradient(135deg, oklch(0.78 0.16 155), oklch(0.62 0.18 155))',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
            boxShadow: '0 1px 0 rgba(255,255,255,0.3) inset, 0 20px 60px -10px oklch(0.74 0.16 155 / 0.6)',
          }}>{Ic.check(48)}</div>
        </div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 38, fontWeight: 600, letterSpacing: -1.2, margin: 0, lineHeight: 1.05 }}>Upload erfolgreich.</h1>
        <p style={{ fontSize: 15, color: 'var(--fg-2)', marginTop: 14, lineHeight: 1.55 }}>
          5 Dateien · 515 MB wurden sicher übertragen.<br/>
          <span style={{ color: 'var(--fg-3)' }}>Jonas wird per E-Mail benachrichtigt.</span>
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 28 }}>
          <Btn variant="primary" size="lg" icon={Ic.upload(15)}>Weitere hochladen</Btn>
          <Btn variant="glass" size="lg">Fertig</Btn>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          marginTop: 32, padding: '10px 16px', borderRadius: 999,
          background: 'var(--surface-hi)', border: '1px solid var(--border)',
          fontSize: 11.5, color: 'var(--fg-3)', width: 'fit-content', margin: '32px auto 0',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: 'oklch(0.74 0.16 155)' }}/>
          Bestätigung in deinem Postfach · vor 2 Sek.
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  NyzaSidebar, NyzaTopbar, FolderCard, FileTile, SectionHeader,
  NyzaDashboard, NyzaListView, NyzaGallery, NyzaImageViewer,
  NyzaShareModal, NyzaUploadLinkModal, NyzaEmpty,
  NyzaSharePage, NyzaClientUploadPage,
  NyzaUploadProgress, NyzaUploadSuccess, UploadRow, CircularProgress,
});
