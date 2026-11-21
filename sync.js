/* Daybook backup and sync. Loaded after app.js; talks to the journal's private database. */
const Sync = (() => {
  const BASE = window.__DAYBOOK_SYNC_URL || 'https://iximbcxwyhnedeojjwsa.supabase.co';
  const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4aW1iY3h3eWhuZWRlb2pqd3NhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUyNjYxMzMsImV4cCI6MjExMDg0MjEzM30.KfzL7T2SfrjQ4te4tKFAu-ImplrHR56SFw8PknN0fWg';
  const LS_SES = 'daybook.sync.session', LS_ST = 'daybook.sync.state';
  const jget = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const jset = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const fresh = owner => ({ owner: owner || null, rev: { days: 0, photos: 0 }, dirty: { days: {}, photos: {} }, up: {}, last: 0 });

  let ses = jget(LS_SES);            // { access_token, refresh_token, expires_at, user: { id, email } }
  let st = jget(LS_ST) || fresh();   // per-device sync bookkeeping
  let status = '', timer = null, running = null, again = false, refreshing = null, signup = false;
  const saveSt = () => jset(LS_ST, st);

  /* ---- track local changes by wrapping the storage layer ---- */
  const raw = { putDay: DB.putDay, deleteDay: DB.deleteDay, putPhoto: DB.putPhoto, deletePhoto: DB.deletePhoto };
  const mark = (kind, key) => { if (!ses && !st.owner) return; st.dirty[kind][key] = Date.now(); saveSt(); schedule(2500); };
  DB.putDay = async d => { const r = await raw.putDay(d); mark('days', d.date); return r; };
  DB.deleteDay = async date => { const had = await DB.getDay(date); const r = await raw.deleteDay(date); if (had) mark('days', date); return r; };
  DB.putPhoto = async p => { p.updatedAt = Date.now(); const r = await raw.putPhoto(p); mark('photos', p.id); return r; };
  DB.deletePhoto = async id => { const r = await raw.deletePhoto(id); mark('photos', id); return r; };

  /* ---- session ---- */
  const setSes = j => { ses = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, user: { id: j.user.id, email: j.user.email } }; jset(LS_SES, ses); };
  const dropSes = () => { ses = null; jset(LS_SES, null); };
  const errText = async r => { let j = null; try { j = await r.json(); } catch {} return (j && (j.message || j.msg || j.error_description || j.error)) || ('Error ' + r.status); };
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const r = await fetch(BASE + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: ses.refresh_token }) });
      if (r.ok) { setSes(await r.json()); return true; }
      if (r.status === 400 || r.status === 401 || r.status === 403) { dropSes(); setStatus(''); render(); toast('Signed out of sync. Sign in again under More.'); return false; }
      throw new Error(await errText(r));
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function api(path, opt = {}, retry = true) {
    if (ses && Date.now() > ses.expires_at - 60000) await refresh();
    if (!ses) throw new Error('Not signed in');
    const r = await fetch(BASE + path, { ...opt, headers: { apikey: KEY, Authorization: 'Bearer ' + ses.access_token, ...(opt.headers || {}) } });
    if (r.status === 401 && retry && ses && await refresh()) return api(path, opt, false);
    return r;
  }
  const need = async r => { if (!r.ok) throw new Error(await errText(r)); return r; };

  async function signIn(email, password, code) {
    email = email.trim().toLowerCase();
    if (signup) {
      const r = await fetch(BASE + '/rest/v1/rpc/daybook_signup', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_email: email, p_password: password, p_code: code }) });
      if (!r.ok) throw new Error(await errText(r));
    }
    const r = await fetch(BASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (!r.ok) { const m = await errText(r); throw new Error(/invalid login/i.test(m) ? 'Wrong email or password' : m); }
    const j = await r.json();
    const [days, photos] = await Promise.all([DB.allDays(), DB.allPhotos()]);
    if (st.owner && st.owner !== j.user.id && (days.length || photos.length) &&
      !confirm('This device already holds a journal from a different account. Add it to this account?')) return false;
    setSes(j);
    if (st.owner !== j.user.id) {
      st = fresh(j.user.id);
      for (const d of days) st.dirty.days[d.date] = d.updatedAt || 1;
      for (const p of photos) st.dirty.photos[p.id] = p.updatedAt || 1;
      saveSt();
    }
    return true;
  }
  async function signOut() {
    const t = ses && ses.access_token;
    dropSes(); setStatus(''); render();
    if (t) fetch(BASE + '/auth/v1/logout', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t } }).catch(() => {});
  }

  /* ---- the sync itself: pull what changed elsewhere, then push what changed here ---- */
  const dayData = d => ({ log: d.log || [], notes: d.notes || '', conversations: d.conversations || '', media: d.media || '', endOfDay: d.endOfDay || '' });
  const unsaved = () => state.day && dayKey(state.day) !== state.savedKey;
  async function run() {
    const uid_ = ses.user.id, touched = new Set();
    // pull days
    for (;;) {
      const rows = await (await need(await api(`/rest/v1/days?select=date,data,updated_at,deleted,rev&rev=gt.${st.rev.days}&order=rev.asc&limit=500`))).json();
      for (const row of rows) {
        const local = await DB.getDay(row.date), d = st.dirty.days[row.date];
        const localTs = local ? (local.updatedAt || 0) : (d || 0);
        const keepLocal = (d && localTs >= row.updated_at) || (row.date === state.date && unsaved());
        const same = local && !row.deleted && local.updatedAt === row.updated_at;
        if (!keepLocal && !same) {
          if (row.deleted) { if (local) await raw.deleteDay(row.date); }
          else await raw.putDay({ ...blankDay(row.date), ...dayData(row.data || {}), updatedAt: row.updated_at });
          delete st.dirty.days[row.date]; touched.add(row.date);
        } else if (same) delete st.dirty.days[row.date];
        st.rev.days = row.rev;
      }
      saveSt();
      if (rows.length < 500) break;
    }
    // pull photos
    let map = new Map((await DB.allPhotos()).map(p => [p.id, p]));
    for (;;) {
      const rows = await (await need(await api(`/rest/v1/photos?select=id,date,time,caption,entry_id,mime,updated_at,deleted,rev&rev=gt.${st.rev.photos}&order=rev.asc&limit=200`))).json();
      for (const row of rows) {
        const local = map.get(row.id), d = st.dirty.photos[row.id];
        const localTs = local ? (local.updatedAt || 0) : (d || 0);
        if (!(d && localTs >= row.updated_at)) {
          if (row.deleted) { if (local) { await raw.deletePhoto(row.id); touched.add(local.date); } }
          else if (local) {
            if (local.updatedAt !== row.updated_at) { await raw.putPhoto({ ...local, date: row.date, time: row.time, caption: row.caption, entryId: row.entry_id || undefined, updatedAt: row.updated_at }); touched.add(row.date); touched.add(local.date); }
          } else {
            const r = await api(`/storage/v1/object/authenticated/photos/${uid_}/${encodeURIComponent(row.id)}`);
            if (r.ok) {
              const blob = new Blob([await r.arrayBuffer()], { type: row.mime || 'image/jpeg' });
              await raw.putPhoto({ id: row.id, date: row.date, time: row.time, caption: row.caption, entryId: row.entry_id || undefined, updatedAt: row.updated_at, blob });
              touched.add(row.date);
            } else if (r.status !== 400 && r.status !== 404) throw new Error(await errText(r));
          }
          st.up[row.id] = 1; delete st.dirty.photos[row.id];
        }
        st.rev.photos = row.rev;
      }
      saveSt();
      if (rows.length < 200) break;
    }
    // push days
    const dd = Object.entries(st.dirty.days);
    for (let i = 0; i < dd.length; i += 100) {
      const chunk = dd.slice(i, i + 100), body = [];
      for (const [date, ts] of chunk) {
        const local = await DB.getDay(date);
        body.push(local ? { user_id: uid_, date, data: dayData(local), updated_at: local.updatedAt || ts, deleted: false }
          : { user_id: uid_, date, data: {}, updated_at: ts, deleted: true });
      }
      await need(await api('/rest/v1/days?on_conflict=user_id,date', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(body) }));
      for (const [date, ts] of chunk) if (st.dirty.days[date] === ts) delete st.dirty.days[date];
      saveSt();
    }
    // push photos
    const pp = Object.entries(st.dirty.photos);
    if (pp.length) map = new Map((await DB.allPhotos()).map(p => [p.id, p]));
    let n = 0;
    for (const [id, ts] of pp) {
      const p = map.get(id), path = `/storage/v1/object/photos/${uid_}/${encodeURIComponent(id)}`;
      if (p) {
        if (!st.up[id]) {
          if (pp.length > 3) setStatus(`Uploading photos (${++n} of ${pp.length})…`);
          await need(await api(path, { method: 'POST', headers: { 'Content-Type': p.blob.type || 'image/jpeg', 'x-upsert': 'true' }, body: p.blob }));
          st.up[id] = 1;
        }
        await need(await api('/rest/v1/photos?on_conflict=user_id,id', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([{ user_id: uid_, id, date: p.date, time: p.time || '', caption: p.caption || '', entry_id: p.entryId || null, mime: p.blob.type || 'image/jpeg', updated_at: p.updatedAt || ts, deleted: false }]) }));
      } else {
        await need(await api(`/rest/v1/photos?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ deleted: true, updated_at: ts }) }));
        api(path, { method: 'DELETE' }).catch(() => {});
        delete st.up[id];
      }
      if (st.dirty.photos[id] === ts) delete st.dirty.photos[id];
      saveSt();
    }
    st.last = Date.now(); saveSt();
    // show what arrived
    if (touched.size) {
      if (touched.has(state.date) && !unsaved()) {
        state.day = (await DB.getDay(state.date)) || blankDay(state.date);
        for (const k of ['media', 'conversations']) if (state.day[k] == null) state.day[k] = '';
        state.savedKey = dayKey(state.day);
        renderDay();
      }
      if (state.view === 'journal') renderJournal();
      if (typeof hideWelcome === 'function' && !$('#welcome').hidden) hideWelcome();
    }
  }
  function sync(manual) {
    if (!ses) return Promise.resolve();
    if (running) { again = true; return running; }
    clearTimeout(timer);
    setStatus('Syncing…');
    running = run().then(() => { setStatus(''); if (manual) toast('Journal is up to date'); })
      .catch(e => {
        const off = !navigator.onLine || /failed to fetch|load failed|networkerror/i.test(e.message);
        setStatus(off ? 'Offline. Changes will sync when you are back online.' : 'Sync problem: ' + e.message);
        if (manual) toast(off ? 'You are offline' : 'Sync problem: ' + e.message);
      })
      .finally(() => { running = null; render(); if (again) { again = false; schedule(800); } });
    return running;
  }
  function schedule(ms) { if (!ses) return; clearTimeout(timer); timer = setTimeout(() => sync(), ms); }

  /* ---- More tab card ---- */
  function setStatus(s) { status = s; const el = $('#syncStatus'); if (el) el.textContent = s || lastText(); }
  const lastText = () => {
    const pend = Object.keys(st.dirty.days).length + Object.keys(st.dirty.photos).length;
    if (!st.last) return pend ? 'Waiting to sync.' : 'Not synced yet.';
    const d = new Date(st.last), today = d.toDateString() === new Date().toDateString();
    const when = (today ? 'today at ' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' at ') + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `Last synced ${when}.` + (pend ? ` ${pend} change${pend === 1 ? '' : 's'} waiting.` : '');
  };
  function render() {
    $('#syncOut').hidden = !!ses; $('#syncIn').hidden = !ses;
    if (ses) { $('#syncWho').textContent = 'Signed in as ' + ses.user.email + '. Your journal is backed up and kept in step on every device you sign in to.'; $('#syncStatus').textContent = status || lastText(); }
    $('#syncCode').hidden = !signup; $('#syncCode').required = signup;
    $('#syncPass').autocomplete = signup ? 'new-password' : 'current-password';
    $('#syncGo').textContent = signup ? 'Create account' : 'Sign in';
    $('#syncMode').textContent = signup ? 'Already have an account? Sign in' : 'New here? Create an account';
  }
  $('#syncMode').addEventListener('click', () => { signup = !signup; render(); });
  $('#syncForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#syncGo'); btn.disabled = true; btn.textContent = 'One moment…';
    try {
      if (await signIn($('#syncEmail').value, $('#syncPass').value, $('#syncCode').value)) { $('#syncPass').value = ''; $('#syncCode').value = ''; signup = false; render(); toast('Signed in. Syncing your journal…'); sync(); }
    } catch (err) { toast(/failed to fetch|load failed/i.test(err.message) ? 'No connection. Try again when you are online.' : err.message); }
    btn.disabled = false; render();
  });
  $('#syncNow').addEventListener('click', () => sync(true));
  $('#syncOutBtn').addEventListener('click', () => { if (confirm('Sign out of sync on this device? Your journal stays on this device.')) signOut(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(600); else if (ses && (Object.keys(st.dirty.days).length || Object.keys(st.dirty.photos).length)) sync(); });
  window.addEventListener('online', () => schedule(500));
  if (ses && !st.owner) { st = fresh(ses.user.id); saveSt(); }
  render(); schedule(1200);
  return { sync, render, signedIn: () => !!ses, state: () => st };
})();
