// Vite entry. Mounts <Root/> into #root and switches between authenticated app
// and public pages (/s/:token, /u/:token) based on URL.

import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './nyza.css';

import { API, BASE, getToken, setToken } from './api.js';
import { NyzaAmbient, applyAccent } from './system.jsx';
import { AuthScreen, Dashboard } from './app.jsx';
import { PublicSharePage, PublicUploadPage, CenteredLoader } from './pubpages.jsx';
import { ToastHost } from './toast.jsx';

// Strip the deployment base path (injected by PHP as window.NYZA_BASE) before
// matching client-side routes. Without this the regex below wouldn't match
// when the app is mounted at /cloud/.
function getRoute() {
  let path = location.pathname;
  if (BASE && path.startsWith(BASE)) path = path.slice(BASE.length);
  if (!path.startsWith('/')) path = '/' + path;

  let m = path.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
  if (m) return { kind: 'public-share', token: m[1] };
  m = path.match(/^\/u\/([A-Za-z0-9_-]+)\/?$/);
  if (m) return { kind: 'public-upload', token: m[1] };
  return { kind: 'app' };
}

function Root() {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'dark');
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [route, setRoute] = useState(getRoute());

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('nyza.theme', theme);
  }, [theme]);

  useEffect(() => {
    const onPop = () => setRoute(getRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (route.kind !== 'app') { setAuthChecked(true); return; }
    if (!getToken()) { setAuthChecked(true); return; }
    API.me()
      .then((d) => { setUser(d.user); })
      .catch(() => { setToken(null); })
      .finally(() => setAuthChecked(true));
  }, [route.kind]);

  // Apply the owner's accent preset once we know the user.
  useEffect(() => { if (user?.accent) applyAccent(user.accent); }, [user?.accent]);

  const toggleTheme = useCallback(() => setTheme((t) => t === 'dark' ? 'light' : 'dark'), []);

  if (!authChecked) return <><NyzaAmbient/><CenteredLoader/></>;

  if (route.kind === 'public-share') {
    return <><NyzaAmbient/><PublicSharePage token={route.token}/><ToastHost/></>;
  }
  if (route.kind === 'public-upload') {
    return <><NyzaAmbient/><PublicUploadPage token={route.token}/><ToastHost/></>;
  }

  if (!user) {
    return <><NyzaAmbient/><AuthScreen onAuth={(u) => setUser(u)}/><ToastHost/></>;
  }

  return (
    <>
      <NyzaAmbient/>
      <Dashboard user={user} onUserChange={setUser} theme={theme} onTheme={toggleTheme} basePath={BASE}/>
      <ToastHost/>
    </>
  );
}

createRoot(document.getElementById('root')).render(<Root/>);

// PWA: register the service worker (served by PHP at <base>/sw.js with the
// right Service-Worker-Allowed scope so it controls the whole app).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const root = (BASE || '') + '/';
    navigator.serviceWorker.register((BASE || '') + '/sw.js', { scope: root }).catch(() => {});
  });
}
