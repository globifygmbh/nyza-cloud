// Nyza overlays — in-app confirm dialog + right-click context menu, both in the
// cloud's own glass design (no native confirm()/menus). Driven by a tiny
// emitter like toast.jsx; mount <ConfirmHost/> and <ContextMenuHost/> once.

import React, { useState, useEffect, useRef } from 'react';
import { Ic, Glass, Btn } from './system.jsx';

// ───── Confirm dialog ──────────────────────────────────────────────────────
const _confirmListeners = new Set();

/**
 * confirmDialog({ title, message, confirmLabel, cancelLabel, danger, icon })
 * → Promise<boolean>. Resolves true on confirm, false on cancel/backdrop/Esc.
 */
export function confirmDialog(opts = {}) {
  return new Promise((resolve) => {
    const payload = { ...opts, id: Math.random(), resolve };
    _confirmListeners.forEach((l) => l(payload));
  });
}

export function ConfirmHost() {
  const [dlg, setDlg] = useState(null);
  useEffect(() => {
    const fn = (d) => setDlg(d);
    _confirmListeners.add(fn);
    return () => _confirmListeners.delete(fn);
  }, []);
  useEffect(() => {
    if (!dlg) return;
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dlg]);
  if (!dlg) return null;
  const done = (val) => { dlg.resolve(val); setDlg(null); };
  const danger = !!dlg.danger;
  return (
    <div className="nyza-modal-backdrop" style={{ zIndex: 300 }} onClick={() => done(false)}>
      <Glass onClick={(e) => e.stopPropagation()} style={{
        width: '100%', maxWidth: 420, borderRadius: 'var(--r-xl)', padding: '26px 26px 22px',
        animation: 'slideUp .22s cubic-bezier(.2,.8,.2,1)',
      }}>
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{
            width: 46, height: 46, borderRadius: 'var(--r-md)', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: danger ? 'color-mix(in oklab, var(--danger) 16%, transparent)' : 'color-mix(in oklab, var(--accent) 16%, transparent)',
            color: danger ? 'var(--danger)' : 'var(--accent)',
          }}>{dlg.icon || (danger ? Ic.trash(22) : Ic.bolt(22))}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: '2px 0 6px', letterSpacing: -0.3 }}>
              {dlg.title || 'Bist du sicher?'}
            </h2>
            {dlg.message && <p style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--fg-2)', margin: 0 }}>{dlg.message}</p>}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
          <Btn variant="glass" size="md" onClick={() => done(false)}>{dlg.cancelLabel || 'Abbrechen'}</Btn>
          <Btn variant={danger ? 'danger' : 'primary'} size="md"
            icon={danger ? Ic.trash(15) : Ic.check(15)} onClick={() => done(true)}>
            {dlg.confirmLabel || 'Bestätigen'}
          </Btn>
        </div>
      </Glass>
    </div>
  );
}

// ───── Context menu ─────────────────────────────────────────────────────────
const _menuListeners = new Set();

/**
 * openContextMenu(x, y, items). Each item: { label, icon, onClick, danger } or
 * { separator:true } or { header:'…' }. Falsy items are ignored so callers can
 * inline conditionals.
 */
export function openContextMenu(x, y, items) {
  const clean = (items || []).filter(Boolean);
  if (!clean.length) return;
  _menuListeners.forEach((l) => l({ x, y, items: clean, id: Math.random() }));
}

export function ContextMenuHost() {
  const [menu, setMenu] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    const fn = (m) => setMenu(m);
    _menuListeners.add(fn);
    return () => _menuListeners.delete(fn);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    // A full-screen backdrop handles outside taps (and blocks click-through to
    // the content behind). Only need resize/scroll/Esc here.
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // Clamp to viewport once measured.
  useEffect(() => {
    if (!menu || !ref.current) return;
    const el = ref.current;
    const r = el.getBoundingClientRect();
    let { x, y } = menu;
    const pad = 8;
    if (x + r.width + pad > window.innerWidth) x = window.innerWidth - r.width - pad;
    if (y + r.height + pad > window.innerHeight) y = window.innerHeight - r.height - pad;
    el.style.left = Math.max(pad, x) + 'px';
    el.style.top = Math.max(pad, y) + 'px';
  }, [menu]);

  if (!menu) return null;
  return (
    <>
    <div onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); setMenu(null); }}
      onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
      style={{ position: 'fixed', inset: 0, zIndex: 315 }}/>
    <div ref={ref} className="nyza-ctxmenu" style={{
      position: 'fixed', left: menu.x, top: menu.y, zIndex: 320, minWidth: 200, maxWidth: 280,
      background: 'var(--surface)', backdropFilter: 'blur(30px) saturate(180%)',
      WebkitBackdropFilter: 'blur(30px) saturate(180%)',
      border: '1px solid var(--border-hi)', borderRadius: 'var(--r-md)',
      boxShadow: '0 1px 0 var(--inner-hi) inset, 0 20px 50px -12px rgba(0,0,0,0.5)', padding: 6,
      animation: 'ctxIn .12s cubic-bezier(.2,.8,.2,1)',
    }}
    onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((it, i) => {
        if (it.separator) return <div key={i} style={{ height: 1, background: 'var(--border)', margin: '5px 6px' }}/>;
        if (it.header) return <div key={i} style={{ padding: '6px 10px 4px', fontSize: 10.5, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--fg-3)' }}>{it.header}</div>;
        if (it.swatches) return (
          <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 7, padding: '6px 10px 8px' }}>
            {it.swatches.map((s) => {
              const active = s.key === it.current;
              return (
                <button key={s.key} title={s.label} onClick={() => { setMenu(null); it.onPick && it.onPick(s.key); }}
                  style={{
                    width: 22, height: 22, borderRadius: '50%', cursor: 'pointer', background: s.dot,
                    border: active ? '2px solid var(--fg)' : '2px solid transparent',
                    boxShadow: active ? '0 0 0 2px var(--surface)' : '0 1px 2px rgba(0,0,0,0.3)',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                  }}>
                  {active && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }}/>}
                </button>
              );
            })}
          </div>
        );
        return (
          <button key={i} disabled={it.disabled}
            onClick={() => { setMenu(null); it.onClick && it.onClick(); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '9px 10px',
              borderRadius: 'var(--r-sm)', border: 'none', cursor: it.disabled ? 'default' : 'pointer',
              fontFamily: 'inherit', fontSize: 13, textAlign: 'left', background: 'transparent',
              color: it.disabled ? 'var(--fg-4)' : it.danger ? 'var(--danger)' : 'var(--fg)',
              opacity: it.disabled ? 0.6 : 1,
            }}
            onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = it.danger ? 'color-mix(in oklab, var(--danger) 14%, transparent)' : 'var(--surface-hi)'; }}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
            <span style={{ color: it.danger ? 'var(--danger)' : 'var(--fg-3)', display: 'inline-flex', width: 16 }}>{it.icon}</span>
            <span style={{ flex: 1 }}>{it.label}</span>
            {it.hint && <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>{it.hint}</span>}
          </button>
        );
      })}
    </div>
    </>
  );
}
