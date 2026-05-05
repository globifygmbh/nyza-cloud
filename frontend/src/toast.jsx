import React, { useState, useEffect } from 'react';
import { Ic } from './system.jsx';

const _listeners = new Set();

export function toast(msg, kind = 'info') {
  _listeners.forEach((l) => l({ msg, kind, id: Math.random() }));
}

export function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const fn = (t) => {
      setItems((x) => [...x, t]);
      setTimeout(() => setItems((x) => x.filter((y) => y.id !== t.id)), 3500);
    };
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  }, []);
  if (items.length === 0) return null;
  const top = items[items.length - 1];
  return (
    <div className={'nyza-toast ' + top.kind}>
      {top.kind === 'error' && Ic.close(14)}
      {top.kind === 'success' && Ic.check(14)}
      {top.msg}
    </div>
  );
}
