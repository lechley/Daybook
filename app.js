'use strict';
const VERSION = '1.6.0';

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
  const links = [];
  let out = esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => { links.push(`<a href="${u}" target="_blank" rel="noopener">${t}</a>`); return `\u0000${links.length - 1}\u0000`; })
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => { links.push(`<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>`); return `${p}\u0000${links.length - 1}\u0000`; })
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => links[+i]);
}
function mdToHTML(src) {
  const lines = (src || '').replace(/\r/g, '').split('\n');
  const html = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { html.push(`<p>${para.map(mdInlineToHTML).join('<br>')}</p>`); para = []; } };
  const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); closeList();
      const lvl = Math.min(6, m[1].length + 2); // render page headings smaller than the app's own titles
      html.push(`<h${lvl}>${mdInlineToHTML(m[2])}</h${lvl}>`); continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushPara(); closeList(); html.push('<hr>'); continue; }
    if ((m = line.match(/^\s*[-*+•]\s+(?:\[( |x|X)\]\s+)?(.*)$/))) {
      flushPara(); if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
      const box = m[1] !== undefined ? `<span class="check${m[1].trim() ? ' on' : ''}"></span>` : '';
      html.push(`<li>${box}${mdInlineToHTML(m[2])}</li>`); continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara(); if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
      html.push(`<li>${mdInlineToHTML(m[1])}</li>`); continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeList(); html.push(`<blockquote>${mdInlineToHTML(m[1])}</blockquote>`); continue; }
    closeList(); para.push(line.trim());
  }
  flushPara(); closeList();
  return html.join('');
}
const mdBlockToHTML = mdToHTML;
function mdToPlain(s) {
  return (s || '').replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*+•]\s+(\[[ xX]\]\s+)?/gm, '').replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|__|~~|`/g, '').replace(/(^|\s)[*_]([^*_]+)[*_]/g, '$1$2').replace(/^>\s?/gm, '');
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
function toast(msg, action) {
  const t = $('#toast'); t.textContent = msg; t.classList.toggle('action', !!action);
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { t.classList.remove('show'); action.fn(); }; t.appendChild(b); }
  t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2200);
}
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
async function resizeImage(file, max = 1600, quality = 0.82) {
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
  return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
}

/* ---------- state ---------- */
const state = { date: todayISO(), day: null, view: 'day', calMonth: todayISO().slice(0, 7), urls: [], photos: [], urlById: {}, pending: [] };
let saveTimer;
function scheduleSave(field) {
  clearTimeout(saveTimer);
  const tag = document.querySelector(`.saved[data-for="${field}"]`);
  if (tag) tag.textContent = '…';
  saveTimer = setTimeout(async () => { await saveDay(); if (tag) { tag.textContent = 'Saved'; setTimeout(() => tag.textContent = '', 1500); } }, 500);
}
const dayKey = d => JSON.stringify([d.log, d.notes, d.conversations, d.media, d.endOfDay]);
async function saveDay() {
  if (dayKey(state.day) === state.savedKey) return;
  state.savedKey = dayKey(state.day);
  state.day.updatedAt = Date.now();
  if (isEmptyDay(state.day) && !(await DB.photosFor(state.day.date)).length) await DB.deleteDay(state.day.date);
  else await DB.putDay(state.day);
}

/* ---------- day view ---------- */
async function loadDay(date) {
  clearTimeout(saveTimer);
  if (state.day) await saveDay();
  const dir = state.day && date !== state.date ? (date > state.date ? 'next' : 'prev') : '';
  state.date = date;
  state.day = (await DB.getDay(date)) || blankDay(date);
  for (const k of ['media', 'conversations']) if (state.day[k] == null) state.day[k] = '';
  state.savedKey = dayKey(state.day);
  renderDay();
  const v = $('#view-day');
  v.classList.remove('slide-next', 'slide-prev');
  if (dir && state.view === 'day') { void v.offsetWidth; v.classList.add('slide-' + dir); window.scrollTo(0, 0); }
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
function deleteEntry(id) {
  const idx = state.day.log.findIndex(x => x.id === id); if (idx < 0) return;
  const [removed] = state.day.log.splice(idx, 1), date = state.date;
  renderLog(); saveDay();
  toast('Entry deleted', { label: 'Undo', fn: () => { if (state.date !== date) return; state.day.log.push(removed); renderLog(); saveDay(); } });
}
function renderLog() {
  const list = $('#logList'); list.innerHTML = '';
  const entries = [...state.day.log].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  for (const e of entries) {
    const li = document.createElement('li');
    li.dataset.id = e.id;
    li.innerHTML = `<span class="swipe-bg">Delete</span><div class="row"><label class="time"><span>${esc(e.time || 'Time')}</span><input type="time" value="${esc(e.time || '')}" aria-label="Change time"></label><div class="body"><span class="txt" contenteditable="true" spellcheck="true">${esc(e.text)}</span><div class="ephotos"></div></div><button class="del" aria-label="Delete entry">×</button></div>`;
    const txt = li.querySelector('.txt'), row = li.querySelector('.row');
    txt.addEventListener('blur', () => {
      const v = txt.textContent.trim();
      if (!v) { deleteEntry(e.id); return; }
      e.text = v; saveDay(); renderGlance();
    });
    txt.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); txt.blur(); } });
    li.querySelector('.del').addEventListener('click', () => deleteEntry(e.id));
    li.querySelector('input[type=time]').addEventListener('change', ev => { e.time = ev.target.value || ''; renderLog(); saveDay(); });
    // swipe left to delete
    let sx = 0, sy = 0, dx = 0, mode = null;
    li.addEventListener('touchstart', ev => { const t = ev.touches[0]; sx = t.clientX; sy = t.clientY; dx = 0; mode = null; row.style.transition = 'none'; }, { passive: true });
    li.addEventListener('touchmove', ev => {
      const t = ev.touches[0], ddx = t.clientX - sx, ddy = t.clientY - sy;
      if (mode === null) { if (Math.abs(ddx) > 10 && Math.abs(ddx) > Math.abs(ddy)) mode = 'h'; else if (Math.abs(ddy) > 10) mode = 'v'; }
      if (mode === 'h') { dx = Math.min(0, ddx); row.style.transform = `translateX(${dx}px)`; li.classList.toggle('armed', dx < -90); }
    }, { passive: true });
    li.addEventListener('touchend', () => {
      row.style.transition = '';
      if (mode === 'h' && dx < -90) { row.style.transform = 'translateX(-100%)'; setTimeout(() => deleteEntry(e.id), 160); }
      else { row.style.transform = ''; li.classList.remove('armed'); }
    });
    list.appendChild(li);
  }
  $('#logEmpty').hidden = entries.length > 0;
  $('#logCount').textContent = entries.length ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}` : '';
  fillEntryPhotos();
  renderGlance();
}
function fillEntryPhotos() {
  for (const li of document.querySelectorAll('#logList li')) {
    const box = li.querySelector('.ephotos'); box.innerHTML = '';
    for (const p of state.photos.filter(p => p.entryId === li.dataset.id)) {
      const url = state.urlById[p.id]; if (!url) continue;
      const b = document.createElement('button'); b.type = 'button';
      b.innerHTML = `<img src="${url}" alt="${esc(p.caption || 'Photo')}">`;
      b.addEventListener('click', () => openPhoto(p, url));
      box.appendChild(b);
    }
  }
}
async function renderPhotos() {
  const date = state.date;
  const photos = (await DB.photosFor(date)).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (date !== state.date) return;
  state.urls.forEach(u => URL.revokeObjectURL(u)); state.urls = []; state.urlById = {}; state.photos = photos;
  const grid = $('#photoGrid'); grid.innerHTML = '';
  for (const p of photos) {
    const url = URL.createObjectURL(p.blob); state.urls.push(url); state.urlById[p.id] = url;
    const b = document.createElement('button');
    b.innerHTML = `<img src="${url}" alt="${esc(p.caption || 'Photo')}">`;
    b.addEventListener('click', () => openPhoto(p, url));
    grid.appendChild(b);
  }
  grid.insertAdjacentHTML('beforeend', '<label class="add" for="photoInput" aria-label="Add photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></label>');
  fillEntryPhotos();
  renderGlance();
}
function renderDay() {
  renderHeader();
  renderLog();
  renderPhotos();
  for (const k of ['notes', 'endOfDay']) { const el = $('#' + k); el.value = state.day[k]; showRendered(k); }
  const conv = (state.day.conversations || '').trim();
  $('#convCard').hidden = !conv;
  $('#convView').innerHTML = conv ? mdBlockToHTML(conv) : '';
  $('#quickInput').placeholder = state.date === todayISO() ? 'What did you just do?' : `Add to ${shortDate(state.date)}…`;
}
function notesSections(src) {
  const lines = src.replace(/\r/g, '').split('\n');
  const pre = [], secs = [];
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) secs.push({ title: m[1].trim(), body: [] });
    else (secs.length ? secs[secs.length - 1].body : pre).push(line);
  }
  return { pre: pre.join('\n').trim(), secs };
}
function showRendered(k) {
  const el = $('#' + k), view = $('#' + k + 'View');
  const src = state.day[k] || '', has = !!src.trim();
  let html = has ? mdToHTML(src) : '', sectioned = false;
  if (k === 'notes' && has) {
    const { pre, secs } = notesSections(src);
    if (secs.length >= 2) {
      sectioned = true;
      const open = src.length < 700 ? ' open' : '';
      html = (pre ? mdToHTML(pre) : '') + secs.map(s => {
        const body = s.body.join('\n').trim();
        const items = (body.match(/^\s*([-*+•]|\d+[.)])\s+/gm) || []).length;
        const empty = !body || /^[-*+•]?\s*\(?none\)?\.?$/i.test(body);
        const meta = empty ? 'None' : items ? String(items) : '';
        return `<details class="sec"${empty ? '' : open}><summary><span>${mdInlineToHTML(s.title)}</span><em>${meta}</em></summary><div class="sec-body">${empty ? '<p class="muted">Nothing recorded.</p>' : mdToHTML(body)}</div></details>`;
      }).join('');
    }
    view.classList.toggle('sectioned', sectioned);
    $('#notesEdit').hidden = false;
  } else if (k === 'notes') $('#notesEdit').hidden = true;
  view.innerHTML = html;
  view.hidden = !has; el.hidden = has;
  if (!has) autosize(el);
}
function editField(k) {
  const el = $('#' + k), view = $('#' + k + 'View');
  view.hidden = true; el.hidden = false; autosize(el); el.focus();
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
  const entry = p.entryId && p.date === state.date ? state.day.log.find(e => e.id === p.entryId) : null;
  const isReceipt = !!entry && /^Receipt\b/.test(entry.text);
  $('#photoShare').textContent = isReceipt ? (/sent to Dext/.test(entry.text) ? 'Send to Dext again' : 'Send to Dext') : 'Share';
  $('#photoShare').onclick = async () => {
    if (isReceipt) { if (await sendReceipt(p.blob, p.date, p.time, receiptNoteOf(entry))) { markReceiptSent(entry); dlg.close(); } }
    else await shareFile(new File([p.blob], `daybook-${p.date}.jpg`, { type: p.blob.type || 'image/jpeg' }), p.caption || 'Photo').catch(() => {});
  };
}

/* ---------- receipts ---------- */
const DEXT_KEY = 'daybook.dext';
const dextAddr = () => { try { return (localStorage.getItem(DEXT_KEY) || '').trim(); } catch { return ''; } };
async function shareFile(file, title) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title }); return true; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return false;
}
const autoReceipts = () => typeof Sync !== 'undefined' && Sync.autoReceipts();
const receiptNoteOf = entry => entry.text.replace(/^Receipt:?\s*/, '').replace(/\s*· sent to Dext$/, '');
// Sends the receipt to Dext: by email from the journal's own sender when that is switched on, otherwise through
// the phone's share sheet with the Dext address ready to paste. Resolves true once sent or shared.
async function sendReceipt(blob, date, time, note) {
  const addr = dextAddr();
  if (!addr) { toast('Add your Dext address under More first'); return false; }
  const file = new File([blob], `receipt-${date}${time ? '-' + time.replace(':', '') : ''}.jpg`, { type: blob.type || 'image/jpeg' });
  if (autoReceipts()) {
    try { toast('Sending to Dext…'); await Sync.sendReceipt(blob, file.name, note); return true; }
    catch (err) { toast(/failed to fetch|load failed/i.test(err.message) ? 'No connection. Receipt saved, open its photo to send it later.' : 'Could not send to Dext: ' + err.message); return false; }
  }
  try { navigator.clipboard.writeText(addr).catch(() => {}); } catch {}
  try {
    const shared = await shareFile(file, 'Receipt');
    if (!shared) { location.href = 'mailto:' + addr + '?subject=Receipt'; toast('Receipt downloaded. Attach it to the email to Dext.'); }
    return true;
  } catch (err) { if (err.name !== 'AbortError') toast('Could not open sharing: ' + err.message); return false; }
}
function markReceiptSent(entry) {
  if (/sent to Dext/.test(entry.text)) return;
  entry.text += ' · sent to Dext'; renderLog(); saveDay(); toast(autoReceipts() ? 'Sent to Dext' : 'Marked as sent to Dext');
}
let receiptBlob = null;
$('#receiptInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  receiptBlob = await resizeImage(f, 2200, 0.88).catch(() => f);
  const url = URL.createObjectURL(receiptBlob);
  $('#receiptImg').src = url; $('#receiptNote').value = '';
  const addr = dextAddr();
  $('#receiptSend').hidden = !addr;
  $('#receiptHint').textContent = !addr ? 'To send receipts to Dext, add your Dext address under More, in Receipts.'
    : autoReceipts() ? 'Send to Dext emails this receipt straight to your Dext inbox.'
    : 'Send to Dext opens sharing. Choose Mail, paste the Dext address into To (it is copied for you) and send.';
  const dlg = $('#receiptDialog'); dlg.showModal();
  dlg.addEventListener('close', () => URL.revokeObjectURL(url), { once: true });
});
async function saveReceipt() {
  const note = $('#receiptNote').value.trim(), time = state.date === todayISO() ? nowHM() : '';
  const entry = { id: uid(), time, text: 'Receipt' + (note ? ': ' + note : '') };
  state.day.log.push(entry);
  await DB.putPhoto({ id: uid(), date: state.date, time, caption: entry.text, entryId: entry.id, blob: receiptBlob });
  renderLog(); await saveDay(); renderPhotos(); hideWelcome();
  return { entry, time };
}
$('#receiptCancel').addEventListener('click', () => $('#receiptDialog').close());
$('#receiptSave').addEventListener('click', async () => { await saveReceipt(); $('#receiptDialog').close(); toast('Receipt saved'); });
$('#receiptSend').addEventListener('click', async () => {
  // share first: iPhone only allows the share sheet straight from a tap
  const btn = $('#receiptSend'), auto = autoReceipts(); btn.disabled = true;
  const sent = await sendReceipt(receiptBlob, state.date, state.date === todayISO() ? nowHM() : '', $('#receiptNote').value.trim());
  const { entry } = await saveReceipt(); $('#receiptDialog').close(); btn.disabled = false;
  if (sent) markReceiptSent(entry); else if (!auto) toast('Receipt saved, not sent yet. Open its photo to send it.');
});
$('#dextEmail').addEventListener('change', e => {
  const v = e.target.value.trim();
  if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { toast('That does not look like an email address'); return; }
  try { v ? localStorage.setItem(DEXT_KEY, v) : localStorage.removeItem(DEXT_KEY); } catch {}
  toast(v ? 'Dext address saved' : 'Dext address removed');
  if (typeof Sync !== 'undefined') Sync.profileChanged();
});

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

  renderLookBack(dayBy);
  $('#weekHint').textContent = 'Summaries and totals, week by week';

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
    const hay = mdToPlain([day.log.map(e => e.text).join(' '), day.notes, day.endOfDay, day.conversations, ph.map(p => p.caption).join(' ')].join('\n'));
    if (q && !hay.toLowerCase().includes(q)) continue;
    if (++shown > 200) break;
    let snippet = day.endOfDay || day.log.map(e => e.text).join(' · ') || day.notes || day.conversations.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') || '';
    if (q) {
      const i = hay.toLowerCase().indexOf(q);
      snippet = (i > 30 ? '…' : '') + hay.slice(Math.max(0, i - 30), i + 90);
    }
    let html = esc(mdToPlain(snippet).replace(/\s+/g, ' ').slice(0, 220));
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
  Lock.refresh();
  if (typeof Sync !== 'undefined') Sync.render();
  $('#dextEmail').value = dextAddr();
  let msg = 'Saved in this browser on this device.';
  if (navigator.storage?.estimate) {
    const { usage } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    msg = `Using ${(usage / 1048576).toFixed(1)} MB on this device. ${persisted ? 'Storage is marked as permanent.' : 'Export a backup now and then, because the phone can clear website data if space runs very low.'}`;
  }
  $('#storageInfo').textContent = msg;
}

/* ---------- wire up ---------- */
$('#quickLog').addEventListener('submit', async e => {
  e.preventDefault();
  const v = $('#quickInput').value.trim(), pend = state.pending;
  if (!v && !pend.length) return;
  const time = state.date === todayISO() ? nowHM() : '';
  const entry = { id: uid(), time, text: v || (pend.length > 1 ? 'Photos' : 'Photo') };
  state.day.log.push(entry);
  $('#quickInput').value = '';
  state.pending = []; renderPending();
  for (const blob of pend) await DB.putPhoto({ id: uid(), date: state.date, time, caption: '', entryId: entry.id, blob });
  renderLog(); await saveDay();
  if (pend.length) renderPhotos();
  hideWelcome();
});
function renderPending() {
  const strip = $('#pendingStrip'); strip.innerHTML = ''; strip.hidden = !state.pending.length;
  $('#quickLog').classList.toggle('has-pending', !!state.pending.length);
  state.pending.forEach((blob, i) => {
    const u = URL.createObjectURL(blob);
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', 'Remove photo');
    b.innerHTML = `<img src="${u}" alt=""><span>×</span>`;
    b.onclick = () => { state.pending.splice(i, 1); renderPending(); };
    strip.appendChild(b);
  });
}
$('#attachInput').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = '';
  for (const f of files) state.pending.push(await resizeImage(f).catch(() => f));
  renderPending(); $('#quickInput').focus();
});
$('#notesEdit').addEventListener('click', () => editField('notes'));

/* ---------- swipe between days ---------- */
(() => {
  const v = $('#view-day'); let sx = 0, sy = 0, ok = false;
  v.addEventListener('touchstart', e => {
    ok = !e.target.closest('.log li, input, textarea, [contenteditable], .pending');
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY;
  }, { passive: true });
  v.addEventListener('touchend', e => {
    if (!ok) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
    if (dx > 0) loadDay(addDays(state.date, -1));
    else if (state.date < todayISO()) loadDay(addDays(state.date, 1));
  });
})();

/* ---------- welcome ---------- */
function hideWelcome() { $('#welcome').hidden = true; try { localStorage.setItem('daybook.welcomed', '1'); } catch {} }
async function maybeWelcome() {
  let seen = false; try { seen = !!localStorage.getItem('daybook.welcomed'); } catch {}
  if (seen) return;
  if ((await DB.allDays()).length) { hideWelcome(); return; }
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#a2hsTip').hidden = !!standalone;
  $('#welcome').hidden = false;
}
$('#welcomeOk').addEventListener('click', () => { hideWelcome(); $('#quickInput').focus(); });

/* ---------- looking back + weekly review ---------- */
function daySnippet(day) {
  return mdToPlain(day.endOfDay || day.log.map(e => e.text).join(' · ') || day.notes || '').replace(/\s+/g, ' ').trim();
}
function renderLookBack(dayBy) {
  const t = parseISO(todayISO()), picks = [];
  const shift = (label, fn) => { const d = new Date(t); fn(d); picks.push([label, isoDate(d)]); };
  shift('A week ago', d => d.setDate(d.getDate() - 7));
  shift('A month ago', d => d.setMonth(d.getMonth() - 1));
  shift('Three months ago', d => d.setMonth(d.getMonth() - 3));
  shift('Six months ago', d => d.setMonth(d.getMonth() - 6));
  for (let y = 1; y <= 10; y++) shift(y === 1 ? 'A year ago today' : `${y} years ago today`, d => d.setFullYear(d.getFullYear() - y));
  const box = $('#lookBack'); box.innerHTML = '';
  for (const [label, date] of picks) {
    const day = dayBy[date]; if (!day || isEmptyDay(day)) continue;
    const snip = daySnippet(day); if (!snip) continue;
    const b = document.createElement('button'); b.className = 'daycard';
    b.innerHTML = `<div class="d"><span>${esc(label)}</span><small>${esc(shortDate(date))}</small></div><p>${esc(snip.slice(0, 200))}</p>`;
    b.addEventListener('click', () => { switchView('day'); loadDay(date); });
    box.appendChild(b);
  }
  $('#lookBackWrap').hidden = !box.children.length;
}
const weekStart = iso => { const d = parseISO(iso); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoDate(d); };
const week = { start: weekStart(todayISO()), md: '' };
async function renderWeek() {
  const [days, photos] = await Promise.all([DB.allDays(), DB.allPhotos()]);
  const dayBy = Object.fromEntries(days.map(d => [d.date, d]));
  const s = parseISO(week.start), e = parseISO(addDays(week.start, 6));
  const title = s.getMonth() === e.getMonth() ? `${s.getDate()}–${e.getDate()} ${MON[e.getMonth()]}` : `${s.getDate()} ${MON[s.getMonth()].slice(0, 3)} – ${e.getDate()} ${MON[e.getMonth()].slice(0, 3)}`;
  $('#weekTitle').textContent = title + (e.getFullYear() !== new Date().getFullYear() ? ` ${e.getFullYear()}` : '');
  $('#weekNext').disabled = week.start >= weekStart(todayISO());
  let written = 0, entries = 0, pics = 0; const parts = [], md = [`# Week of ${longDate(week.start)}`, ''];
  for (let i = 0; i < 7; i++) {
    const date = addDays(week.start, i); if (date > todayISO()) break;
    const day = dayBy[date], n = photos.filter(p => p.date === date).length; pics += n;
    const has = day && !isEmptyDay(day);
    if (has) { written++; entries += day.log.length; }
    const d = parseISO(date), head = `${DOW[d.getDay()]} ${d.getDate()}`;
    let body = '<p class="muted">Nothing written.</p>', mdBody = '_Nothing written._';
    if (has) {
      if (day.endOfDay.trim()) { body = mdToHTML(day.endOfDay); mdBody = day.endOfDay.trim(); }
      else if (day.log.length) { const l = [...day.log].sort((a, b) => (a.time || '').localeCompare(b.time || '')).map(x => `- ${x.time ? x.time + ' ' : ''}${x.text}`).join('\n'); body = mdToHTML(l); mdBody = l; }
      else { const sn = daySnippet(day).slice(0, 300); body = `<p>${esc(sn)}</p>`; mdBody = sn; }
    }
    const meta = has ? [day.log.length ? `${day.log.length} logged` : '', n ? `${n} photo${n > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') : '';
    parts.push(`<section class="wk-day${has ? '' : ' off'}" data-date="${date}"><h4>${head}<small>${meta}</small></h4><div class="md">${body}</div></section>`);
    md.push(`## ${longDate(date)}`, mdBody, '');
  }
  week.md = md.join('\n');
  $('#weekBody').innerHTML = `<div class="stats"><div class="stat"><b>${written}</b><span>days written</span></div><div class="stat"><b>${entries}</b><span>log entries</span></div><div class="stat"><b>${pics}</b><span>photos</span></div></div>` + parts.join('');
  $('#weekBody').scrollTop = 0;
}
$('#openWeek').addEventListener('click', async () => { week.start = weekStart(todayISO()); await renderWeek(); $('#weekDialog').showModal(); });
$('#weekPrev').addEventListener('click', () => { week.start = addDays(week.start, -7); renderWeek(); });
$('#weekNext').addEventListener('click', () => { week.start = addDays(week.start, 7); renderWeek(); });
$('#weekClose').addEventListener('click', () => $('#weekDialog').close());
$('#weekShare').addEventListener('click', () => shareOrDownload(new Blob([week.md], { type: 'text/markdown' }), `week-${week.start}.md`, 'Weekly review'));
$('#weekBody').addEventListener('click', e => {
  if (e.target.closest('a')) return;
  const sec = e.target.closest('.wk-day'); if (!sec) return;
  $('#weekDialog').close(); switchView('day'); loadDay(sec.dataset.date);
});

/* ---------- privacy lock ---------- */
const Lock = (() => {
  const KEY = 'daybook.lock';
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const write = v => { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch {} };
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const hash = async (salt, code) => b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + code)));
  const bioOK = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
  let mode = null, code = '', first = '', done = null, hiddenAt = 0, tries = 0;
  const el = $('#lock');
  const show = (m, cb) => {
    mode = m; code = ''; done = cb || null;
    $('#lockTitle').textContent = { unlock: 'Enter passcode', verify: 'Enter current passcode', set1: 'Choose a 4-digit passcode', set2: 'Enter it again to confirm' }[m];
    $('#lockSub').innerHTML = '&nbsp;';
    $('#lockCancel').hidden = m === 'unlock';
    $('#lockForgot').hidden = m !== 'unlock';
    el.querySelector('[data-k=bio]').style.visibility = m === 'unlock' && read()?.cred && bioOK() ? 'visible' : 'hidden';
    dots(); el.hidden = false; document.body.classList.add('locked');
  };
  const hide = () => { el.hidden = true; mode = null; document.body.classList.remove('locked'); };
  const dots = () => [...$('#lockDots').children].forEach((d, i) => d.classList.toggle('on', i < code.length));
  const fail = msg => { $('#lockSub').textContent = msg; code = ''; dots(); $('#lockDots').classList.remove('shake'); void $('#lockDots').offsetWidth; $('#lockDots').classList.add('shake'); };
  async function submit() {
    const cfg = read();
    if (mode === 'unlock' || mode === 'verify') {
      if (await hash(cfg.salt, code) === cfg.hash) { tries = 0; const cb = done; hide(); cb && cb(); }
      else { tries++; fail(tries >= 3 ? 'Wrong passcode. Take your time.' : 'Wrong passcode'); }
    } else if (mode === 'set1') { first = code; show('set2', done); }
    else if (mode === 'set2') {
      if (code !== first) { show('set1', done); fail('Those did not match. Try again.'); return; }
      const salt = b64(crypto.getRandomValues(new Uint8Array(12)));
      write({ salt, hash: await hash(salt, code), cred: null });
      const cb = done; hide(); toast('Passcode is on'); cb && cb();
    }
  }
  function press(k) {
    if (k === 'bio') return bioUnlock();
    if (k === 'del') { code = code.slice(0, -1); dots(); return; }
    if (code.length >= 4) return;
    code += k; dots();
    if (code.length === 4) setTimeout(submit, 120);
  }
  async function bioUnlock() {
    const cfg = read(); if (!cfg?.cred) return;
    try {
      await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), allowCredentials: [{ type: 'public-key', id: unb64(cfg.cred), transports: ['internal'] }], userVerification: 'required', timeout: 60000 } });
      tries = 0; const cb = done; hide(); cb && cb();
    } catch { $('#lockSub').textContent = 'Could not verify. Use your passcode.'; }
  }
  async function bioEnroll() {
    const cfg = read(); if (!cfg) return;
    try {
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: 'Daybook' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'daybook', displayName: 'Daybook' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' }, timeout: 60000 } });
      write({ ...cfg, cred: b64(cred.rawId) }); toast('Face ID / Touch ID is on');
    } catch { toast('Could not turn that on for this device'); }
    refresh();
  }
  function refresh() {
    const cfg = read();
    $('#lockSet').textContent = cfg ? 'Change passcode' : 'Turn on passcode';
    $('#lockOff').hidden = !cfg;
    $('#lockBio').hidden = !cfg || !bioOK();
    $('#lockBio').textContent = cfg?.cred ? 'Turn off Face ID / Touch ID' : 'Use Face ID or Touch ID';
    $('#lockInfo').textContent = cfg ? 'Lock is on. Daybook asks for your passcode when it opens. Keep a note of it: it cannot be recovered.' : 'Ask for a passcode whenever Daybook opens.';
  }
  // keypad
  const pad = $('#keypad');
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'del']) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.k = k;
    b.innerHTML = k === 'bio' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 10v1M15 10v1M12 10v3h-1M9 15.500c1.800 1.300 4.200 1.300 6 0"/></svg>' : k === 'del' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-6-6 6-6zM12 10l4 4M16 10l-4 4"/></svg>' : k;
    b.setAttribute('aria-label', k === 'bio' ? 'Use Face ID or Touch ID' : k === 'del' ? 'Delete' : k);
    b.addEventListener('click', () => press(k));
    pad.appendChild(b);
  }
  document.addEventListener('keydown', e => { if (!mode) return; if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del'); });
  $('#lockCancel').addEventListener('click', hide);
  $('#lockForgot').addEventListener('click', async () => {
    if (!confirm('The passcode cannot be recovered. You can reset the lock, but that ERASES the journal stored on this device and signs it out of sync. Erase and reset?')) return;
    if (!confirm('Last check: delete every entry and photo on this device?')) return;
    await new Promise(r => { const q = indexedDB.deleteDatabase('daybook'); q.onsuccess = q.onerror = q.onblocked = r; });
    try { localStorage.removeItem('daybook.sync.session'); localStorage.removeItem('daybook.sync.state'); } catch {}
    write(null); location.reload();
  });
  $('#lockSet').addEventListener('click', () => { const go = () => show('set1', refresh); read() ? show('verify', go) : go(); });
  $('#lockOff').addEventListener('click', () => show('verify', () => { write(null); refresh(); toast('Lock is off'); }));
  $('#lockBio').addEventListener('click', () => { const cfg = read(); if (cfg?.cred) { write({ ...cfg, cred: null }); refresh(); toast('Face ID / Touch ID is off'); } else bioEnroll(); });
  document.addEventListener('visibilitychange', () => {
    if (!read()) return;
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); if (!mode) { show('unlock'); el.dataset.auto = '1'; } }
    else if (el.dataset.auto && mode === 'unlock' && Date.now() - hiddenAt < 30000) { delete el.dataset.auto; hide(); }
    else delete el.dataset.auto;
  });
  return { start: () => { if (read()) show('unlock'); }, refresh };
})();

for (const k of ['notes', 'endOfDay']) {
  const el = $('#' + k);
  el.addEventListener('input', () => { state.day[k] = el.value; autosize(el); scheduleSave(k); renderGlance(); });
  el.addEventListener('blur', () => showRendered(k));
  $('#' + k + 'View').addEventListener('click', e => { if (!e.target.closest('a') && !e.currentTarget.classList.contains('sectioned')) editField(k); });
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
  Lock.start();
  navigator.storage?.persist?.().catch(() => {});
  await loadDay(todayISO());
  maybeWelcome();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// exposed for tests
window.__daybook = { dayToMarkdown, markdownToDay, mergeDays, makeZip, readZip, DB };
