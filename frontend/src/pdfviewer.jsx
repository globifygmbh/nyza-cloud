// In-page PDF viewer (pdf.js). Used instead of an <iframe> because mobile
// browsers don't render embedded PDFs reliably: Android Chrome shows nothing
// and iOS Safari only the first page. Pages are drawn to canvases sized to
// the container width, and only rendered once they scroll near the viewport,
// so long documents stay light on phones. Loaded lazily (default export) so
// pdf.js stays out of the main bundle.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Ic, IconBtn } from './system.jsx';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const PAD = 12; // gutter around pages, px

function PdfPage({ doc, num, width, scrollRoot, onVisible }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState(null); // { w, h } of the page at scale 1
  const [near, setNear] = useState(false);

  useEffect(() => {
    let off = false;
    doc.getPage(num).then((p) => {
      if (off) return;
      const v = p.getViewport({ scale: 1 });
      setSize({ w: v.width, h: v.height });
    });
    return () => { off = true; };
  }, [doc, num]);

  // Render when within ~1.5 screens; report the page that's in the middle.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setNear(true); },
      { root: scrollRoot.current, rootMargin: '150% 0px' });
    const mid = new IntersectionObserver(([e]) => { if (e.isIntersecting) onVisible(num); },
      { root: scrollRoot.current, rootMargin: '-50% 0px -50% 0px' });
    io.observe(el); mid.observe(el);
    return () => { io.disconnect(); mid.disconnect(); };
  }, [num, scrollRoot, onVisible]);

  useEffect(() => {
    if (!near || !size || !width) return;
    let task = null;
    let off = false;
    doc.getPage(num).then((p) => {
      if (off) return;
      const scale = width / size.w;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const v = p.getViewport({ scale: scale * dpr });
      const c = canvasRef.current;
      if (!c) return;
      c.width = Math.floor(v.width);
      c.height = Math.floor(v.height);
      task = p.render({ canvasContext: c.getContext('2d'), viewport: v });
      task.promise.catch(() => {}); // cancelled on re-render / unmount
    });
    return () => { off = true; if (task) task.cancel(); };
  }, [doc, num, near, size, width]);

  const h = size ? Math.round(width * size.h / size.w) : Math.round(width * 1.414);
  return (
    <div ref={wrapRef} data-page={num} style={{
      width, height: h, margin: '0 auto', background: '#fff', borderRadius: 4,
      boxShadow: '0 6px 24px -8px rgba(0,0,0,0.45)', flexShrink: 0, overflow: 'hidden',
    }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }}/>
    </div>
  );
}

export default function PdfViewer({ src, name, downloadHref, style }) {
  const scrollRef = useRef(null);
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const [boxW, setBoxW] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);

  useEffect(() => {
    let off = false;
    setDoc(null); setError(null); setPage(1);
    const task = pdfjs.getDocument({ url: src });
    task.promise.then((d) => { if (!off) setDoc(d); })
      .catch((e) => { if (!off) setError(e?.message || 'PDF konnte nicht geladen werden'); });
    return () => { off = true; task.destroy(); };
  }, [src]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Fit-to-width (capped so desktop pages don't get absurdly wide) × zoom.
  const fitW = Math.max(0, Math.min(boxW - PAD * 2, 900));
  const pageW = Math.round(fitW * zoom);
  const onVisible = useCallback((n) => setPage(n), []);

  const zoomTo = (z) => {
    const el = scrollRef.current;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
    if (!el || next === zoom) { setZoom(next); return; }
    // Keep the point in the middle of the screen where it was.
    const ratio = next / zoom;
    const cx = el.scrollLeft + el.clientWidth / 2;
    const cy = el.scrollTop + el.clientHeight / 2;
    setZoom(next);
    requestAnimationFrame(() => {
      el.scrollLeft = cx * ratio - el.clientWidth / 2;
      el.scrollTop = cy * ratio - el.clientHeight / 2;
    });
  };

  // Pinch-to-zoom on touch screens (the page itself has browser zoom off).
  const pinch = useRef(null);
  const onTouchStart = (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      pinch.current = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: zoom };
    }
  };
  const onTouchMove = (e) => {
    if (e.touches.length === 2 && pinch.current) {
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinch.current.z * d / pinch.current.d));
      if (Math.abs(next - zoom) > 0.04) setZoom(Math.round(next * 100) / 100);
    }
  };
  const onTouchEnd = (e) => { if (e.touches.length < 2) pinch.current = null; };

  // Ctrl/⌘ + wheel (and trackpad pinch, which arrives as ctrl+wheel).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const h = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * Math.exp(-e.deltaY * 0.01) * 100) / 100)));
    };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, []);

  const pages = doc ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : [];

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, ...style }}>
      <div ref={scrollRef} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', WebkitOverflowScrolling: 'touch', touchAction: 'pan-x pan-y' }}>
        {error ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--fg-3)', fontSize: 14 }}>
            <div style={{ marginBottom: 12 }}>Vorschau nicht möglich: {error}</div>
            {downloadHref && <a href={downloadHref} style={{ color: 'var(--accent)' }}>PDF herunterladen</a>}
          </div>
        ) : !doc || !pageW ? (
          <div style={{ height: '100%', minHeight: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-3)' }}>{Ic.loader(24)}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: PAD, padding: `${PAD}px ${PAD}px 88px`, width: 'max-content', minWidth: '100%', boxSizing: 'border-box' }}>
            {pages.map((n) => <PdfPage key={n} doc={doc} num={n} width={pageW} scrollRoot={scrollRef} onVisible={onVisible}/>)}
          </div>
        )}
      </div>

      {doc && (
        <div style={{
          position: 'absolute', left: '50%', bottom: 'calc(16px + env(safe-area-inset-bottom))', transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', borderRadius: 999,
          background: 'rgba(20,20,24,0.82)', color: '#fff', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
          boxShadow: '0 10px 30px -8px rgba(0,0,0,0.5)', fontSize: 12.5, whiteSpace: 'nowrap',
        }} aria-label={name ? 'Steuerung für ' + name : undefined}>
          <span style={{ padding: '0 10px', fontVariantNumeric: 'tabular-nums' }}>{page} / {doc.numPages}</span>
          <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.2)' }}/>
          <IconBtn size={36} title="Verkleinern" onClick={() => zoomTo(zoom / 1.25)} style={{ color: '#fff' }}>{Ic.minus ? Ic.minus(18) : '−'}</IconBtn>
          <span onClick={() => zoomTo(1)} title="An Breite anpassen" style={{ minWidth: 44, textAlign: 'center', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>{Math.round(zoom * 100)}%</span>
          <IconBtn size={36} title="Vergrößern" onClick={() => zoomTo(zoom * 1.25)} style={{ color: '#fff' }}>{Ic.plus(18)}</IconBtn>
          {downloadHref && <>
            <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.2)' }}/>
            <IconBtn size={36} title="Herunterladen" onClick={() => { location.href = downloadHref; }} style={{ color: '#fff' }}>{Ic.download(17)}</IconBtn>
          </>}
        </div>
      )}
    </div>
  );
}
