// Listen — shared checklists for the team. Several lists, notes per entry,
// tick things off; the whole Kontogruppe sees and edits the same lists.

import React, { useState, useEffect, useRef } from 'react';
import { API } from './api.js';
import { Ic, Glass, Btn, IconBtn } from './system.jsx';
import { toast } from './toast.jsx';
import { confirmDialog } from './overlays.jsx';

const fld = { height: 40, padding: '0 12px', borderRadius: 'var(--r-sm)', background: 'var(--surface-hi)', border: '1px solid var(--border)', outline: 'none', fontSize: 14, color: 'var(--fg)', fontFamily: 'inherit', width: '100%' };

function useIsMobile(bp = 860) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.innerWidth < bp);
  useEffect(() => {
    const on = () => setM(window.innerWidth < bp);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [bp]);
  return m;
}

const fmtWhen = (s) => {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T'));
  if (isNaN(d)) return '';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
};

/** One row: checkbox, inline-editable text, optional note, delete. */
function Row({ item, onToggle, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  useEffect(() => { setText(item.text); }, [item.text]);

  const commit = () => {
    setEditing(false);
    const t = text.trim();
    if (t && t !== item.text) onEdit(item, { text: t }); else setText(item.text);
  };

  return (
    <div className="nyza-listrow" style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 12px',
      borderRadius: 'var(--r-sm)', background: 'var(--surface)', border: '1px solid var(--border)',
    }}>
      <button type="button" onClick={() => onToggle(item)} title={item.done ? 'Wieder offen' : 'Abhaken'}
        style={{
          width: 20, height: 20, marginTop: 1, flexShrink: 0, borderRadius: 6, cursor: 'pointer', padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: item.done ? 'var(--accent)' : 'transparent',
          border: '1.5px solid ' + (item.done ? 'var(--accent)' : 'var(--border-hi)'),
          color: '#fff',
        }}>{item.done && Ic.check(13)}</button>

      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input value={text} autoFocus onChange={(e) => setText(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setText(item.text); setEditing(false); } }}
            style={{ ...fld, height: 30, fontSize: 13.5, padding: '0 8px' }}/>
        ) : (
          <div onClick={() => setEditing(true)} title="Zum Bearbeiten klicken" style={{
            fontSize: 13.5, lineHeight: 1.45, cursor: 'text', wordBreak: 'break-word',
            textDecoration: item.done ? 'line-through' : 'none',
            color: item.done ? 'var(--fg-4)' : 'var(--fg)',
          }}>{item.text}</div>
        )}
        {item.note && <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2, whiteSpace: 'pre-wrap' }}>{item.note}</div>}
        {item.done && item.done_by_name && (
          <div style={{ fontSize: 10.5, color: 'var(--fg-4)', marginTop: 2 }}>abgehakt von {item.done_by_name} · {fmtWhen(item.done_at)}</div>
        )}
      </div>

      <span className="task-kebab" onClick={() => onDelete(item)} title="Löschen"
        style={{ color: 'var(--fg-4)', cursor: 'pointer', display: 'inline-flex', flexShrink: 0, marginTop: 2 }}>{Ic.trash(14)}</span>
    </div>
  );
}

function ListModal({ list, onSave, onClose }) {
  const [name, setName] = useState(list?.name || '');
  const [note, setNote] = useState(list?.note || '');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) { toast('Name erforderlich', 'error'); return; }
    setBusy(true);
    try { await onSave({ name: name.trim(), note: note.trim() || null }); onClose(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="nyza-modal-backdrop" onClick={onClose}>
      <Glass style={{ width: '100%', maxWidth: 420, borderRadius: 'var(--r-xl)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, margin: 0 }}>{list?.id ? 'Liste bearbeiten' : 'Neue Liste'}</h2>
          <IconBtn size={30} onClick={onClose}>{Ic.close(16)}</IconBtn>
        </div>
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Name</span>
            <input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="z. B. Einkauf Büro" onKeyDown={(e) => e.key === 'Enter' && submit()} style={fld}/>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ fontSize: 12, fontWeight: 540, color: 'var(--fg-2)' }}>Notiz (optional)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Wofür ist die Liste?" style={{ ...fld, height: 'auto', padding: '9px 12px', resize: 'vertical' }}/>
          </label>
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Abbrechen</Btn>
          <Btn variant="primary" disabled={busy} icon={busy ? Ic.loader(15) : Ic.check(15)} onClick={submit}>Speichern</Btn>
        </div>
      </Glass>
    </div>
  );
}

export function ListsApp({ onBack }) {
  const mobile = useIsMobile();
  const [lists, setLists] = useState(null);
  const [activeId, setActiveId] = useState(() => localStorage.getItem('nyza.lists.active') || '');
  const [items, setItems] = useState(null);
  const [draft, setDraft] = useState('');
  const [hideDone, setHideDone] = useState(false);
  const [modal, setModal] = useState(null);       // null | {} | list
  const [showLists, setShowLists] = useState(false);
  const addRef = useRef(null);

  const loadLists = () => API.lists().then((d) => {
    const l = d.lists || [];
    setLists(l);
    setActiveId((cur) => (l.find((x) => String(x.id) === String(cur)) ? cur : (l[0] ? String(l[0].id) : '')));
  }).catch((e) => { toast(e.message, 'error'); setLists([]); });
  useEffect(() => { loadLists(); }, []);
  useEffect(() => { if (activeId) localStorage.setItem('nyza.lists.active', activeId); }, [activeId]);

  const active = (lists || []).find((l) => String(l.id) === String(activeId)) || null;

  useEffect(() => {
    if (!active) { setItems([]); return; }
    setItems(null);
    API.list(active.id).then((d) => setItems(d.list.items || [])).catch((e) => { toast(e.message, 'error'); setItems([]); });
  }, [active?.id]);

  // Counts live on the list rows in the sidebar; keep them in step locally
  // instead of refetching the whole collection after every tick.
  const syncCounts = (list) => setLists((ls) => (ls || []).map((l) => l.id === (active?.id) ? {
    ...l, total: list.length, done_count: list.filter((i) => i.done).length,
  } : l));
  const apply = (d) => { setItems(d.items); syncCounts(d.items); };

  const add = async () => {
    const t = draft.trim();
    if (!t || !active) return;
    setDraft('');
    try { apply(await API.addListItem(active.id, t)); addRef.current?.focus(); }
    catch (e) { toast(e.message, 'error'); setDraft(t); }
  };
  const toggle = async (it) => {
    setItems((l) => (l || []).map((x) => x.id === it.id ? { ...x, done: !x.done } : x));   // optimistic
    try { apply(await API.updateListItem(it.id, { done: !it.done })); }
    catch (e) { toast(e.message, 'error'); if (active) API.list(active.id).then((d) => setItems(d.list.items || [])); }
  };
  const edit = async (it, body) => { try { apply(await API.updateListItem(it.id, body)); } catch (e) { toast(e.message, 'error'); } };
  const del = async (it) => { try { apply(await API.deleteListItem(it.id)); } catch (e) { toast(e.message, 'error'); } };

  const createList = async (body) => { const d = await API.createList(body); await loadLists(); setActiveId(String(d.list.id)); toast('Liste angelegt', 'success'); };
  const updateList = async (id, body) => { await API.updateList(id, body); await loadLists(); toast('Gespeichert', 'success'); };
  const deleteList = async (l) => {
    if (!await confirmDialog({ title: 'Liste löschen?', message: `„${l.name}" wird mit allen Einträgen gelöscht.`, confirmLabel: 'Löschen', danger: true })) return;
    try { await API.deleteList(l.id); setActiveId(''); await loadLists(); } catch (e) { toast(e.message, 'error'); }
  };
  const clearDone = async () => {
    if (!active) return;
    if (!await confirmDialog({ title: 'Erledigte entfernen?', message: 'Alle abgehakten Einträge dieser Liste werden gelöscht.', confirmLabel: 'Entfernen', danger: true })) return;
    try { apply(await API.clearListDone(active.id)); } catch (e) { toast(e.message, 'error'); }
  };

  const shown = (items || []).filter((i) => !hideDone || !i.done);
  const doneCount = (items || []).filter((i) => i.done).length;

  const Sidebar = (
    <div style={{ width: mobile ? '100%' : 250, flexShrink: 0, borderRight: mobile ? 'none' : '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '14px 14px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', flex: 1 }}>Listen</span>
        <IconBtn size={28} title="Liste anlegen" onClick={() => setModal({})}>{Ic.plus(14)}</IconBtn>
      </div>
      <div style={{ overflowY: 'auto', padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {lists === null ? <div style={{ color: 'var(--fg-3)', padding: 10 }}>{Ic.loader(16)}</div>
          : lists.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--fg-3)', padding: '6px 8px', lineHeight: 1.5 }}>Noch keine Liste. Leg oben mit „+" die erste an — alle im Team sehen sie.</div>
          : lists.map((l) => {
            const on = String(l.id) === String(activeId);
            const pct = l.total ? Math.round((l.done_count / l.total) * 100) : 0;
            return (
              <div key={l.id} onClick={() => { setActiveId(String(l.id)); setShowLists(false); }} style={{
                display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
                background: on ? 'color-mix(in oklab, var(--accent) 14%, transparent)' : 'transparent', color: on ? 'var(--accent)' : 'var(--fg)',
              }}>
                <span style={{ flexShrink: 0, color: on ? 'var(--accent)' : 'var(--fg-3)' }}>{Ic.checkSquare(15)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 540, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                    <div style={{ flex: 1, height: 3, borderRadius: 999, background: 'var(--surface-hi)', overflow: 'hidden' }}>
                      <div style={{ width: pct + '%', height: '100%', background: pct === 100 ? '#22c55e' : 'var(--accent)' }}/>
                    </div>
                    <span style={{ fontSize: 10, color: 'var(--fg-4)', flexShrink: 0 }}>{l.done_count}/{l.total}</span>
                  </div>
                </div>
                {on && (<>
                  <span onClick={(e) => { e.stopPropagation(); setModal(l); }} title="Bearbeiten" style={{ color: 'var(--fg-3)', display: 'inline-flex' }}>{Ic.fileGen(14)}</span>
                  <span onClick={(e) => { e.stopPropagation(); deleteList(l); }} title="Löschen" style={{ color: 'var(--fg-4)', display: 'inline-flex' }}>{Ic.trash(14)}</span>
                </>)}
              </div>
            );
          })}
      </div>
    </div>
  );

  return (
    <>
      <div className="nyza-topbar" style={{ height: 64, padding: '0 20px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--surface-2)', backdropFilter: 'blur(20px)' }}>
        <IconBtn size={34} title="Zurück" onClick={onBack} style={{ flexShrink: 0, border: '1px solid var(--border)', borderRadius: 999 }}>{Ic.chevronL(17)}</IconBtn>
        <div style={{ fontSize: 14, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--fg-3)', cursor: 'pointer' }} onClick={onBack}>Apps</span>
          <span style={{ color: 'var(--fg-4)' }}>{Ic.chevronR(12)}</span>
          <span style={{ fontWeight: 600 }}>Listen</span>
          {mobile && active && (<>
            <span style={{ color: 'var(--fg-4)' }}>{Ic.chevronR(12)}</span>
            <span onClick={() => setShowLists((v) => !v)} style={{ color: 'var(--accent)', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{active.name}</span>
          </>)}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {(!mobile || showLists) && Sidebar}
        {(!mobile || !showLists) && (
          <div data-scroll style={{ flex: 1, overflow: 'auto', padding: mobile ? '14px 12px 80px' : '18px 24px 80px', minWidth: 0 }}>
            {!active ? (
              <div style={{ color: 'var(--fg-3)', padding: 30, textAlign: 'center' }}>
                {lists === null ? Ic.loader(22) : <>{Ic.checkSquare(30)}<div style={{ marginTop: 10, fontSize: 14 }}>Leg links eine Liste an, um loszulegen.</div></>}
              </div>
            ) : (
              <div style={{ maxWidth: 720 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, margin: 0, letterSpacing: -0.3 }}>{active.name}</h1>
                    {active.note && <div style={{ fontSize: 12.5, color: 'var(--fg-3)', marginTop: 4, whiteSpace: 'pre-wrap' }}>{active.note}</div>}
                    <div style={{ fontSize: 11.5, color: 'var(--fg-4)', marginTop: 4 }}>
                      {(items || []).length} {(items || []).length === 1 ? 'Eintrag' : 'Einträge'} · {doneCount} erledigt
                      {active.created_by_name ? ' · angelegt von ' + active.created_by_name : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Btn variant="ghost" size="sm" icon={hideDone ? Ic.eye(13) : Ic.checkSquare(13)} onClick={() => setHideDone((v) => !v)}>
                      {hideDone ? 'Alle zeigen' : 'Erledigte ausblenden'}
                    </Btn>
                    {doneCount > 0 && <Btn variant="ghost" size="sm" icon={Ic.trash(13)} onClick={clearDone}>Erledigte entfernen</Btn>}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                  <input ref={addRef} value={draft} onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
                    placeholder="Eintrag hinzufügen — Enter zum Speichern" style={fld}/>
                  <Btn variant="primary" size="md" icon={Ic.plus(14)} disabled={!draft.trim()} onClick={add}>Hinzu</Btn>
                </div>

                {items === null ? <div style={{ color: 'var(--fg-3)', padding: 20 }}>{Ic.loader(20)}</div>
                  : shown.length === 0 ? (
                    <div style={{ fontSize: 13, color: 'var(--fg-3)', padding: '18px 4px' }}>
                      {(items || []).length === 0 ? 'Noch nichts drin — schreib oben den ersten Eintrag rein.' : 'Alles erledigt. 🎉'}
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6 }}>
                      {shown.map((it) => <Row key={it.id} item={it} onToggle={toggle} onEdit={edit} onDelete={del}/>)}
                    </div>
                  )}
              </div>
            )}
          </div>
        )}
      </div>

      {modal && <ListModal list={modal.id ? modal : null} onClose={() => setModal(null)}
        onSave={(body) => modal.id ? updateList(modal.id, body) : createList(body)}/>}
    </>
  );
}
