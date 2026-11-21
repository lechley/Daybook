'use strict';
const VERSION = '1.1.0';

/* ---------- dates ---------- */
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayISO = () => isoDate(new Date());
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return isoDate(d); };
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = s => { const d = parseISO(s); return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; };
const shortDate = s => parseISO(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- storage (IndexedDB) ---------- */
const DB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('daybook', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('days', { keyPath: 'date' });
      const p = db.createObjectStore('photos', { keyPath: 'id' });
      p.createIndex('date', 'date');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then(v => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
    });
  };
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    getDay: date => tx('days', 'readonly', s => req(s.get(date))),
    putDay: day => tx('days', 'readwrite', s => req(s.put(day))),
    deleteDay: date => tx('days', 'readwrite', s => req(s.delete(date))),
    allDays: () => tx('days', 'readonly', s => req(s.getAll())),
    photosFor: date => tx('photos', 'readonly', s => req(s.index('date').getAll(date))),
    allPhotos: () => tx('photos', 'readonly', s => req(s.getAll())),
    putPhoto: p => tx('photos', 'readwrite', s => req(s.put(p))),
    deletePhoto: id => tx('photos', 'readwrite', s => req(s.delete(id))),
  };
})();

const blankDay = date => ({ date, log: [], notes: '', conversations: '', media: '', endOfDay: '', updatedAt: 0 });
const isEmptyDay = d => !d || (!d.log.length && !d.notes.trim() && !d.conversations.trim() && !d.media.trim() && !d.endOfDay.trim());

/* ---------- markdown (same layout as the project journal) ---------- */
function photoFileName(p, i) {
  const t = (p.time || '0000').replace(':', '');
  const slug = (p.caption || 'photo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'photo';
  return `${t}-${slug}-${i + 1}.jpg`;
}
function dayToMarkdown(day, photos = []) {
  const sec = (title, body) => `## ${title}\n${body ? body.trim() + '\n' : ''}`;
  const log = [...day.log].sort((a, b) => (a.time || '').localeCompare(b.time || ''))
    .map(e => e.time ? `- ${e.time} ${e.text}` : `- ${e.text}`).join('\n');
  const photoLines = photos.map((p, i) =>
    `- ${p.time || ''} [Photo${p.caption ? ': ' + p.caption : ''}](media/${day.date}/${photoFileName(p, i)})`.replace('-  [', '- ['));
  const media = [day.media.trim(), photoLines.join('\n')].filter(Boolean).join('\n');
  return [
    `# ${longDate(day.date)}\n`,
    sec('Log', log),
    sec('Notes', day.notes),
    sec('Conversations', day.conversations),
    sec('Media', media),
    sec('End of day', day.endOfDay),
  ].join('\n');
}
function markdownToDay(date, md) {
  const day = blankDay(date);
  const parts = {};
  let cur = null;
  for (const line of md.replace(/\r/g, '').split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1].toLowerCase(); parts[cur] = []; continue; }
    if (cur) parts[cur].push(line);
  }
  const text = k => (parts[k] || []).join('\n').trim();
  for (const line of text('log').split('\n')) {
    const m = line.match(/^[-*]\s+(\d{1,2}:\d{2})\s+(.*)$/);
    if (m) day.log.push({ id: uid(), time: m[1].padStart(5, '0'), text: m[2].trim() });
    else if (line.replace(/^[-*]\s*/, '').trim()) day.log.push({ id: uid(), time: '', text: line.replace(/^[-*]\s*/, '').trim() });
  }
  day.notes = text('notes');
  day.conversations = text('conversations');
  // drop lines that point at photos this app exported, so re-imports don't duplicate them
  day.media = text('media').split('\n').filter(l => !/\[Photo[^\]]*\]\(media\//.test(l)).join('\n').trim();
  day.endOfDay = text('end of day');
  return day;
}
function mergeText(a, b) {
  a = (a || '').trim(); b = (b || '').trim();
  if (!a) return b; if (!b || a.includes(b)) return a; if (b.includes(a)) return b;
  return a + '\n\n' + b;
}
function mergeDays(local, incoming) {
  const out = { ...local };
  const key = e => `${e.time}|${e.text}`;
  const seen = new Set(local.log.map(key));
  out.log = [...local.log, ...incoming.log.filter(e => !seen.has(key(e)))];
  for (const k of ['notes', 'conversations', 'media', 'endOfDay']) out[k] = mergeText(local[k], incoming[k]);
  out.updatedAt = Date.now();
  return out;
}
function mdInlineToHTML(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}
function mdBlockToHTML(s) {
  const lines = s.split('\n').filter(l => l.trim());
  if (lines.every(l => /^[-*]\s/.test(l))) return '<ul>' + lines.map(l => `<li>${mdInlineToHTML(l.replace(/^[-*]\s/, ''))}</li>`).join('') + '</ul>';
  return lines.map(l => `<p>${mdInlineToHTML(l)}</p>`).join('');
}

/* ---------- zip (store-only, no dependencies) ---------- */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
async function makeZip(files) { // files: [{name, data: Uint8Array}]
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    chunks.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, a) => n + a.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
async function readZip(blob) { // returns [{name, data}] for stored or deflated entries
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [], dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    let data = buf.subarray(start, start + csize);
    if (method === 8) {
      if (!('DecompressionStream' in window)) continue;
      data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    } else if (method !== 0) continue;
    out.push({ name, data });
  }
  return out;
}

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200); }
function autosize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function shareOrDownload(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, name);
}
async function resizeImage(file, max = 1600) {
  const bmp = await createImageBitmap(file).catch(() => null);
  let w, h, src;
  if (bmp) { w = bmp.width; h = bmp.height; src = bmp; }
  else {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
}

/* ---------- state ---------- */
const state = { date: todayISO(), day: null, view: 'day', calMonth: todayISO().slice(0, 7), urls: [] };
let saveTimer;
function scheduleSave(field) {
  clearTimeout(saveTimer);
  const tag = document.querySelector(`.saved[data-for="${field}"]`);
  if (tag) tag.textContent = '…';
  saveTimer = setTimeout(async () => { await saveDay(); if (tag) { tag.textContent = 'Saved'; setTimeout(() => tag.textContent = '', 1500); } }, 500);
}
async function saveDay() {
  state.day.updatedAt = Date.now();
  if (isEmptyDay(state.day) && !(await DB.photosFor(state.day.date)).length) await DB.deleteDay(state.day.date);
  else await DB.putDay(state.day);
}

/* ---------- day view ---------- */
async function loadDay(date) {
  clearTimeout(saveTimer);
  if (state.day) await saveDay();
  state.date = date;
  state.day = (await DB.getDay(date)) || blankDay(date);
  for (const k of ['media', 'conversations']) if (state.day[k] == null) state.day[k] = '';
  renderDay();
}
function renderHeader() {
  const t = todayISO();
  if (state.view === 'day') {
    const diff = Math.round((parseISO(state.date) - parseISO(t)) / 864e5);
    const dd = parseISO(state.date), wd = DOW[dd.getDay()];
    $('#eyebrow').textContent = diff === 0 ? `Today · ${wd}` : diff === -1 ? `Yesterday · ${wd}` : wd;
    $('#title').textContent = `${dd.getDate()} ${MON[dd.getMonth()]}` + (dd.getFullYear() !== new Date().getFullYear() ? ` ${dd.getFullYear()}` : '');
    $('#prevDay').style.visibility = 'visible';
    $('#nextDay').style.visibility = 'visible';
    $('#nextDay').disabled = state.date >= t;
  } else {
    $('#eyebrow').textContent = '';
    $('#title').textContent = state.view === 'journal' ? 'Journal' : 'More';
    $('#prevDay').style.visibility = 'hidden';
    $('#nextDay').style.visibility = 'hidden';
  }
}
async function renderGlance() {
  const photos = (await DB.photosFor(state.date)).length;
  const timed = state.day.log.map(e => e.time).filter(Boolean).sort();
  const words = [state.day.notes, state.day.endOfDay, ...state.day.log.map(e => e.text)].join(' ').trim().split(/\s+/).filter(Boolean).length;
  const item = (n, label) => `<div><b>${n}</b><span>${label}</span></div>`;
  $('#glance').innerHTML = [
    item(state.day.log.length, state.day.log.length === 1 ? 'entry' : 'entries'),
    item(photos, photos === 1 ? 'photo' : 'photos'),
    item(words, words === 1 ? 'word' : 'words'),
    item(timed.length ? timed[0] : '—', 'first entry'),
  ].join('');
}
function renderLog() {
  const list = $('#logList'); list.innerHTML = '';
  const entries = [...state.day.log].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  for (const e of entries) {
    const li = document.createElement('li');
    li.innerHTML = `<time>${esc(e.time || '·')}</time><span class="txt" contenteditable="true" spellcheck="true">${esc(e.text)}</span><button class="del" aria-label="Delete entry">×</button>`;
    const txt = li.querySelector('.txt');
    txt.addEventListener('blur', () => {
      const v = txt.textContent.trim();
      if (!v) { state.day.log = state.day.log.filter(x => x.id !== e.id); renderLog(); }
      else e.text = v;
      saveDay();
    });
    txt.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); txt.blur(); } });
    li.querySelector('.del').addEventListener('click', () => {
      state.day.log = state.day.log.filter(x => x.id !== e.id); renderLog(); saveDay(); toast('Entry deleted');
    });
    list.appendChild(li);
  }
  $('#logEmpty').hidden = entries.length > 0;
  $('#logCount').textContent = entries.length ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}` : '';
  renderGlance();
}
async function renderPhotos() {
  state.urls.forEach(u => URL.revokeObjectURL(u)); state.urls = [];
  const grid = $('#photoGrid'); grid.innerHTML = '';
  const photos = (await DB.photosFor(state.date)).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  for (const p of photos) {
    const url = URL.createObjectURL(p.blob); state.urls.push(url);
    const b = document.createElement('button');
    b.innerHTML = `<img src="${url}" alt="${esc(p.caption || 'Photo')}">`;
    b.addEventListener('click', () => openPhoto(p, url));
    grid.appendChild(b);
  }
  grid.insertAdjacentHTML('beforeend', '<label class="add" for="photoInput" aria-label="Add photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></label>');
  renderGlance();
}
function renderDay() {
  renderHeader();
  renderLog();
  renderPhotos();
  for (const k of ['notes', 'endOfDay']) { const el = $('#' + k); el.value = state.day[k]; autosize(el); }
  const conv = (state.day.conversations || '').trim();
  $('#convCard').hidden = !conv;
  $('#convView').innerHTML = conv ? mdBlockToHTML(conv) : '';
  $('#quickInput').placeholder = state.date === todayISO() ? 'What did you just do?' : `Add to ${shortDate(state.date)}…`;
}
function openPhoto(p, url) {
  const dlg = $('#photoDialog');
  $('#photoBig').src = url; $('#photoCaption').value = p.caption || '';
  dlg.showModal();
  const close = async () => { p.caption = $('#photoCaption').value.trim(); await DB.putPhoto(p); dlg.close(); };
  $('#photoClose').onclick = close;
  dlg.onclick = e => { if (e.target === dlg) close(); };
  $('#photoDelete').onclick = async () => {
    if (!confirm('Delete this photo?')) return;
    await DB.deletePhoto(p.id); dlg.close(); renderPhotos(); saveDay(); toast('Photo deleted');
  };
}

/* ---------- journal view ---------- */
async function renderJournal() {
  const [days, photos] = await Promise.all([DB.allDays(), DB.allPhotos()]);
  const photoBy = {}; for (const p of photos) (photoBy[p.date] ||= []).push(p);
  const dates = new Set([...days.filter(d => !isEmptyDay(d)).map(d => d.date), ...Object.keys(photoBy)]);
  const dayBy = Object.fromEntries(days.map(d => [d.date, d]));

  // stats
  let streak = 0, d = todayISO();
  if (!dates.has(d)) d = addDays(d, -1);
  while (dates.has(d)) { streak++; d = addDays(d, -1); }
  const entries = days.reduce((n, x) => n + x.log.length, 0);
  $('#stats').innerHTML = `
    <div class="stat"><b>${streak}</b><span>day streak</span></div>
    <div class="stat"><b>${dates.size}</b><span>days written</span></div>
    <div class="stat"><b>${entries}</b><span>log entries</span></div>`;

  // calendar
  const [y, m] = state.calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  $('#calTitle').textContent = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  $('#calNext').disabled = state.calMonth >= todayISO().slice(0, 7);
  const grid = $('#calGrid'); grid.innerHTML = '';
  for (const w of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) grid.insertAdjacentHTML('beforeend', `<div class="dow">${w}</div>`);
  const lead = (first.getDay() + 6) % 7;
  for (let i = 0; i < lead; i++) grid.insertAdjacentHTML('beforeend', '<div></div>');
  const daysInMonth = new Date(y, m, 0).getDate(), t = todayISO();
  for (let n = 1; n <= daysInMonth; n++) {
    const iso = `${y}-${pad(m)}-${pad(n)}`;
    const b = document.createElement('button');
    b.textContent = n;
    if (dates.has(iso)) b.classList.add('has');
    if (iso === t) b.classList.add('today');
    if (iso > t) { b.classList.add('future'); b.disabled = true; }
    b.addEventListener('click', () => { switchView('day'); loadDay(iso); });
    grid.appendChild(b);
  }

  // list
  const q = $('#search').value.trim().toLowerCase();
  const list = $('#dayList'); list.innerHTML = '';
  state.journalUrls?.forEach(u => URL.revokeObjectURL(u)); state.journalUrls = [];
  const sorted = [...dates].sort().reverse();
  let shown = 0;
  for (const date of sorted) {
    const day = dayBy[date] || blankDay(date);
    const ph = photoBy[date] || [];
    const hay = [day.log.map(e => e.text).join(' '), day.notes, day.endOfDay, day.conversations, ph.map(p => p.caption).join(' ')].join(' ');
    if (q && !hay.toLowerCase().includes(q)) continue;
    if (++shown > 200) break;
    let snippet = day.endOfDay || day.log.map(e => e.text).join(' · ') || day.notes || day.conversations.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') || '';
    if (q) {
      const i = hay.toLowerCase().indexOf(q);
      snippet = (i > 30 ? '…' : '') + hay.slice(Math.max(0, i - 30), i + 90);
    }
    let html = esc(snippet.replace(/\s+/g, ' ').slice(0, 220));
    if (q) html = html.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
    const meta = [day.log.length ? `${day.log.length} logged` : '', ph.length ? `${ph.length} photo${ph.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
    const card = document.createElement('button');
    card.className = 'daycard';
    card.innerHTML = `<div class="d"><span>${esc(shortDate(date))}</span><small>${meta}</small></div>${html ? `<p>${html}</p>` : ''}`;
    if (ph.length) {
      const th = document.createElement('div'); th.className = 'thumbs';
      for (const p of ph.slice(0, 5)) { const u = URL.createObjectURL(p.blob); state.journalUrls.push(u); th.insertAdjacentHTML('beforeend', `<img src="${u}" alt="">`); }
      card.appendChild(th);
    }
    card.addEventListener('click', () => { switchView('day'); loadDay(date); });
    list.appendChild(card);
  }
  if (!shown) list.innerHTML = `<p class="empty center">${q ? 'No matches.' : 'Your days will appear here once you start writing.'}</p>`;
}

/* ---------- export / import ---------- */
async function exportAll() {
  const [days, photos] = await Promise.all([DB.allDays(), DB.allPhotos()]);
  const photoBy = {}; for (const p of photos) (photoBy[p.date] ||= []).push(p);
  const dates = [...new Set([...days.map(d => d.date), ...Object.keys(photoBy)])].sort();
  if (!dates.length) return toast('Nothing to export yet');
  const enc = new TextEncoder(), files = [];
  const dayBy = Object.fromEntries(days.map(d => [d.date, d]));
  for (const date of dates) {
    const ph = (photoBy[date] || []).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    files.push({ name: `journal/${date}.md`, data: enc.encode(dayToMarkdown(dayBy[date] || blankDay(date), ph)) });
    for (const [i, p] of ph.entries()) files.push({ name: `journal/media/${date}/${photoFileName(p, i)}`, data: new Uint8Array(await p.blob.arrayBuffer()) });
  }
  const zip = await makeZip(files);
  await shareOrDownload(zip, `daybook-${todayISO()}.zip`, 'Daybook export');
}
async function exportDay() {
  await saveDay();
  const ph = (await DB.photosFor(state.date)).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const blob = new Blob([dayToMarkdown(state.day, ph)], { type: 'text/markdown' });
  await shareOrDownload(blob, `${state.date}.md`, longDate(state.date));
}
async function importFiles(fileList) {
  let days = 0, pics = 0;
  const dec = new TextDecoder();
  const handleMd = async (name, text) => {
    const m = name.match(/(\d{4}-\d{2}-\d{2})\.md$/i);
    if (!m) return;
    const incoming = markdownToDay(m[1], text);
    const local = (await DB.getDay(m[1])) || blankDay(m[1]);
    await DB.putDay(mergeDays(local, incoming)); days++;
  };
  for (const f of fileList) {
    if (/\.zip$/i.test(f.name)) {
      const entries = await readZip(f);
      for (const e of entries) {
        if (/\.md$/i.test(e.name)) await handleMd(e.name, dec.decode(e.data));
        const pm = e.name.match(/media\/(\d{4}-\d{2}-\d{2})\/(\d{2})(\d{2})[^/]*\.(jpe?g|png|heic|webp)$/i);
        if (pm) {
          const existing = await DB.photosFor(pm[1]);
          const time = `${pm[2]}:${pm[3]}`;
          if (existing.some(p => p.blob.size === e.data.length && p.time === time)) continue;
          const caption = e.name.split('/').pop().replace(/^\d{4}-?/, '').replace(/-\d+\.\w+$/, '').replace(/\.\w+$/, '').replace(/-/g, ' ').replace(/^photo$/, '');
          await DB.putPhoto({ id: uid(), date: pm[1], time, caption, blob: new Blob([e.data], { type: /png/i.test(pm[4]) ? 'image/png' : 'image/jpeg' }) });
          pics++;
        }
      }
    } else await handleMd(f.name, await f.text());
  }
  toast(`Imported ${days} day${days === 1 ? '' : 's'}${pics ? ` and ${pics} photo${pics === 1 ? '' : 's'}` : ''}`);
  state.day = null; await loadDay(state.date);
}

/* ---------- navigation ---------- */
function switchView(v) {
  state.view = v;
  for (const s of document.querySelectorAll('.view')) s.hidden = s.id !== 'view-' + v;
  for (const b of document.querySelectorAll('.tabbar button')) b.classList.toggle('active', b.dataset.view === v);
  renderHeader();
  if (v === 'journal') renderJournal();
  if (v === 'more') renderMore();
  window.scrollTo(0, 0);
}
async function renderMore() {
  $('#ver').textContent = VERSION;
  let msg = 'Saved in this browser on this device.';
  if (navigator.storage?.estimate) {
    const { usage } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    msg = `Using ${(usage / 1048576).toFixed(1)} MB on this device. ${persisted ? 'Storage is marked as permanent.' : 'Export a backup now and then, because the phone can clear website data if space runs very low.'}`;
  }
  $('#storageInfo').textContent = msg;
}

/* ---------- wire up ---------- */
$('#quickLog').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#quickInput').value.trim(); if (!v) return;
  const time = state.date === todayISO() ? nowHM() : '';
  state.day.log.push({ id: uid(), time, text: v });
  $('#quickInput').value = '';
  renderLog(); saveDay();
});
for (const k of ['notes', 'endOfDay']) {
  const el = $('#' + k);
  el.addEventListener('input', () => { state.day[k] = el.value; autosize(el); scheduleSave(k); renderGlance(); });
}
$('#photoInput').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  toast(files.length > 1 ? `Adding ${files.length} photos…` : 'Adding photo…');
  for (const f of files) {
    const blob = await resizeImage(f).catch(() => f);
    await DB.putPhoto({ id: uid(), date: state.date, time: state.date === todayISO() ? nowHM() : '', caption: '', blob });
  }
  await DB.putDay({ ...state.day, updatedAt: Date.now() });
  renderPhotos(); toast(files.length > 1 ? 'Photos added' : 'Photo added');
});
$('#prevDay').addEventListener('click', () => loadDay(addDays(state.date, -1)));
$('#nextDay').addEventListener('click', () => { if (state.date < todayISO()) loadDay(addDays(state.date, 1)); });
$('#calPrev').addEventListener('click', () => { const d = parseISO(state.calMonth + '-01'); d.setMonth(d.getMonth() - 1); state.calMonth = isoDate(d).slice(0, 7); renderJournal(); });
$('#calNext').addEventListener('click', () => { const d = parseISO(state.calMonth + '-01'); d.setMonth(d.getMonth() + 1); state.calMonth = isoDate(d).slice(0, 7); renderJournal(); });
$('#search').addEventListener('input', () => { clearTimeout(renderJournal.t); renderJournal.t = setTimeout(renderJournal, 150); });
for (const b of document.querySelectorAll('.tabbar button')) b.addEventListener('click', () => {
  if (b.dataset.view === 'day' && state.view === 'day' && state.date !== todayISO()) loadDay(todayISO());
  switchView(b.dataset.view);
});
$('#exportZip').addEventListener('click', () => exportAll().catch(err => toast('Export failed: ' + err.message)));
$('#exportDay').addEventListener('click', () => exportDay().catch(err => toast('Export failed: ' + err.message)));
$('#shareDay').addEventListener('click', () => exportDay().catch(err => toast('Share failed: ' + err.message)));
$('#importInput').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importFiles(f).catch(err => toast('Import failed: ' + err.message)); });

// Roll over to the new day when the app is reopened after midnight
let lastToday = todayISO();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { clearTimeout(saveTimer); if (state.day) saveDay(); return; }
  const t = todayISO();
  if (t !== lastToday) { if (state.date === lastToday) loadDay(t); lastToday = t; state.calMonth = t.slice(0, 7); }
  else renderHeader();
});

(async () => {
  navigator.storage?.persist?.().catch(() => {});
  await loadDay(todayISO());
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// exposed for tests
window.__daybook = { dayToMarkdown, markdownToDay, mergeDays, makeZip, readZip, DB };
