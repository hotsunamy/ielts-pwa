// Mốc 6 (m6-1): đồng bộ dữ liệu giữa các máy qua vùng dữ liệu ẩn của app trên Drive (appDataFolder, quyền drive.appdata).
// Vùng này không hiện trong Drive, chỉ app này đọc/ghi được. Không có nội dung Cambridge trong code; key do Minh dán vẫn chỉ nằm
// trong máy và trong Drive của Minh.
//
// Cách làm (Minh duyệt 18/10):
// - localStorage vẫn là nơi app đọc/ghi. Mỗi lần một phần app ghi một khóa được đồng bộ, Sync.touched(khóa) so với bản trước,
//   ghi thời điểm sửa + máy sửa cho TỪNG MỤC đổi (một mốc trang, một phần key, một bài làm, một trang nét vẽ, một file sửa tay…),
//   mục bị xóa thì để lại dấu đã xóa. Bảng thời điểm ở localStorage 'ielts.syncmeta'.
// - Gộp theo từng mục: bản sửa sau thắng. Bằng nhau (dữ liệu cũ chưa có thời điểm) thì giữ bản đã có trên Drive.
// - 3 file trong vùng ẩn: config.json (mốc trang, key, sửa tay, mốc audio, bút iPad), attempts.json (bài làm), ink.json (nét vẽ).
// - Đẩy lên = tải bản trên Drive → gộp → ghi lại. Drive API v3 không cho ghi có điều kiện; máy nào có mục mới hơn bản trên Drive
//   thì lần sau tự đẩy lại, nên hai máy ghi trùng lúc không mất dữ liệu, chỉ chậm một lượt.
// - Kéo khi mở app và khi quay lại app (lần trước đã quá 30 s); đẩy sau mỗi thay đổi 5 s (đang làm đề: 30 s), ngay khi nộp bài
//   và khi rời app. Mất mạng / token hết hạn: app chạy bình thường, có mạng / token lại thì tự đồng bộ.
// - Lần bật đầu tiên trên mỗi máy: lưu bản sao dữ liệu máy đó lên vùng ẩn (backup-<tên máy>-<ngày giờ>.json) rồi mới gộp.
'use strict';
(function (root) {
  // =====================================================================================================================
  // Phần thuần (không đụng trình duyệt), test bằng Node: sync.test.js
  // =====================================================================================================================
  const SPECS = {
    'ielts.pdfcfg': { file: 'config', depth: (p) => (p[1] === 'marks' || p[1] === 'keypage' ? 3 : 2) },
    'ielts.keys': { file: 'config', depth: () => 2 },
    'ielts.libcfg': { file: 'config', depth: (p) => (['files', 'books', 'keywords'].includes(p[0]) ? 2 : 1) },
    'ielts.audiomarks': { file: 'config', depth: () => 2 },
    'ielts.pen': { file: 'config', depth: () => 0 },
    'ielts.attempts': { file: 'attempts', list: true },
    'ielts.ink': { file: 'ink', depth: () => 2 },
  };
  const FILES = { config: 'config.json', attempts: 'attempts.json', ink: 'ink.json' };
  const FILE_KEYS = {};
  for (const [k, s] of Object.entries(SPECS)) (FILE_KEYS[s.file] = FILE_KEYS[s.file] || []).push(k);
  const MAX_ATTEMPTS = 200;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const js = (v) => JSON.stringify(v === undefined ? null : v);

  // Tách giá trị của một khóa thành các mục {đường dẫn: giá trị}. Danh sách bài làm: theo id.
  function itemize(key, v) {
    const spec = SPECS[key], out = {};
    if (v == null) return out;
    if (spec.list) { if (Array.isArray(v)) for (const a of v) if (a && a.id != null) out[String(a.id)] = a; return out; }
    const walk = (val, p) => {
      if (p.length >= spec.depth(p) || !isObj(val)) { out[p.join('/')] = val; return; }
      for (const k of Object.keys(val)) walk(val[k], p.concat(k));
    };
    walk(v, []);
    return out;
  }
  // Ghép các mục lại thành giá trị của khóa. Không còn mục nào: null (xóa khóa).
  function build(key, items) {
    const spec = SPECS[key];
    const paths = Object.keys(items);
    if (spec.list) {
      if (!paths.length) return [];
      return Object.values(items).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || String(a.id).localeCompare(String(b.id))).slice(-MAX_ATTEMPTS);
    }
    if (!paths.length) return null;
    if (paths.includes('')) return items[''];
    const rootObj = {};
    for (const path of paths) {
      const p = path.split('/');
      let o = rootObj;
      for (let i = 0; i < p.length - 1; i++) o = (o[p[i]] = isObj(o[p[i]]) ? o[p[i]] : {});
      o[p[p.length - 1]] = items[path];
    }
    return rootObj;
  }
  // So 2 bộ mục (đã JSON hóa): mục đổi/thêm và mục bị xóa.
  function diff(oldStr, newStr) {
    const changed = [], removed = [];
    for (const [p, s] of Object.entries(newStr)) if (oldStr[p] !== s) changed.push(p);
    for (const p of Object.keys(oldStr)) if (!(p in newStr)) removed.push(p);
    return { changed, removed };
  }
  const strItems = (items) => { const o = {}; for (const [p, v] of Object.entries(items)) o[p] = js(v); return o; };

  // Mục phía máy này: {t, d, v} hoặc {t, d, x: 1} (đã xóa). Mục cũ chưa có thời điểm: t = 0.
  function localEntry(items, meta, path, dev) {
    const m = meta[path];
    if (path in items) return { t: m && !m[2] ? m[0] : 0, d: m ? m[1] : dev, v: items[path] };
    if (m) return { t: m[0], d: m[1], x: 1 };
    return null;
  }
  const sameVal = (a, b) => (a.x && b.x) || (!a.x && !b.x && js(a.v) === js(b.v));
  const sameFull = (a, b) => !!a && !!b && a.t === b.t && sameVal(a, b);
  // Thắng: thời điểm sửa sau. Bằng nhau mà khác giá trị (vd dữ liệu cũ của 2 máy, đều t = 0): giữ bản trên Drive.
  function pick(l, r) {
    if (!r) return 'local';
    if (!l) return 'remote';
    if (l.t > r.t) return 'local';
    if (l.t < r.t) return 'remote';
    return sameVal(l, r) ? 'same' : 'remote';
  }

  // Gộp dữ liệu máy này (local: {[khóa]: {items, meta}}) với một file trên Drive (remote: {keys: {[khóa]: {[đường dẫn]: mục}}}).
  // opt: {dev, lastSyncAt}. Trả về: doc (bản mới để ghi lên Drive), apply (mục trên Drive thắng, cần ghi vào máy),
  // meta (mục giữ nguyên giá trị nhưng nhận thời điểm của Drive), push (cần ghi lên Drive), conflicts (hai bên cùng sửa / dữ liệu cũ khác nhau).
  function mergeDoc(local, remote, opt = {}) {
    const dev = opt.dev || '?', since = opt.lastSyncAt || 0;
    const rkeys = (remote && remote.keys) || {};
    const out = { keys: {} }, apply = {}, metaOnly = {}, conflicts = [];
    let push = !remote, sent = 0, recv = 0;
    for (const [k, rv] of Object.entries(rkeys)) if (!local[k]) out.keys[k] = rv;   // khóa của bản app khác: giữ nguyên
    for (const [key, lv] of Object.entries(local)) {
      const items = lv.items || {}, meta = lv.meta || {};
      const rk = rkeys[key] || {};
      const res = {};
      const paths = new Set([...Object.keys(items), ...Object.keys(meta), ...Object.keys(rk)]);
      for (const path of paths) {
        const l = localEntry(items, meta, path, dev), r = rk[path] || null;
        const w = pick(l, r);
        if (w === 'local' || w === 'same') {
          if (!l) continue;
          res[path] = w === 'same' && r ? r : l;
          if (w === 'local' && !sameFull(l, r)) {
            push = true;
            if (!(r && sameVal(l, r))) sent++;
            if (r && !r.x && !l.x && !sameVal(l, r) && (!since || r.t > since)) conflicts.push({ key, path, kept: 'local', local: l, remote: r });
          }
          if (w === 'same' && r && (r.t !== l.t || r.d !== l.d)) (metaOnly[key] = metaOnly[key] || {})[path] = [r.t, r.d, r.x ? 1 : 0];
        } else {
          res[path] = r;
          if (!l || !sameVal(l, r)) {
            if (!(r.x && !l)) { (apply[key] = apply[key] || {})[path] = r; recv++; }
            if (l && !l.x && !r.x && (!since || l.t === r.t || l.t > since)) conflicts.push({ key, path, kept: 'remote', local: l, remote: r });
          } else (metaOnly[key] = metaOnly[key] || {})[path] = [r.t, r.d, r.x ? 1 : 0];
        }
      }
      if (SPECS[key] && SPECS[key].list) capList(res);
      out.keys[key] = res;
    }
    return { doc: out, apply, meta: metaOnly, push, conflicts, sent, recv };
  }
  // Danh sách bài làm trên Drive giữ tối đa 200 bài (như trong máy), bỏ bài cũ nhất. Dấu đã xóa giữ lại.
  function capList(res) {
    const live = Object.entries(res).filter(([, e]) => !e.x);
    if (live.length <= MAX_ATTEMPTS) return;
    live.sort((a, b) => ((a[1].v && a[1].v.startedAt) || 0) - ((b[1].v && b[1].v.startedAt) || 0));
    for (const [p] of live.slice(0, live.length - MAX_ATTEMPTS)) delete res[p];
  }
  // Gộp 2 bản trên Drive (khi 2 máy cùng tạo file lần đầu, có 2 file trùng tên): từng mục lấy bản sửa sau.
  function mergeRemote(a, b) {
    const out = { keys: {} };
    for (const doc of [a, b]) for (const [k, ents] of Object.entries((doc && doc.keys) || {})) {
      const o = (out.keys[k] = out.keys[k] || {});
      for (const [p, e] of Object.entries(ents)) if (!o[p] || e.t > o[p].t) o[p] = e;
    }
    return out;
  }

  const Pure = { SPECS, FILES, FILE_KEYS, itemize, build, diff, strItems, mergeDoc, mergeRemote, localEntry, pick, MAX_ATTEMPTS };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Pure; return; }

  // =====================================================================================================================
  // Phần chạy trong trình duyệt
  // =====================================================================================================================
  const STATE_KEY = 'ielts.sync', META_KEY = 'ielts.syncmeta';
  const DRIVE = 'https://www.googleapis.com/drive/v3/';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/';
  const DELAY = 5000, DELAY_WORK = 30000, PULL_GAP = 30000, RETRY_GAP = 60000, KEEPALIVE_MAX = 60000, INK_WARN = 1e6;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const L = (m) => { if (typeof log === 'function') log(m); };
  const hm = (t) => new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (_) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { L('Đồng bộ: không lưu được vào máy: ' + e.message); return false; } };

  const S = load(STATE_KEY, {}) || {};
  if (!S.dev) S.dev = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (!S.name) S.name = guessName();
  S.ids = S.ids || {}; S.dirty = S.dirty || {}; S.pend = S.pend || {};
  const saveState = () => store(STATE_KEY, S);
  saveState();
  const META = load(META_KEY, {}) || {};
  const saveMeta = () => store(META_KEY, META);
  const snap = {};    // {khóa: {đường dẫn: chuỗi JSON}} bản đã biết lần cuối, để biết mục nào vừa đổi
  for (const k of Object.keys(SPECS)) snap[k] = strItems(itemize(k, readKey(k)));

  const R = { busy: null, again: null, timer: null, due: 0, retryT: null, status: 'off', err: '', lastPull: 0, remote: {}, ver: {}, hidAt: null };

  function guessName() {
    const ua = navigator.userAgent || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Edg\//.test(ua)) return 'Edge';
    if (/Chrome\//.test(ua)) return 'Chrome';
    if (/Mac/.test(ua)) return 'Mac';
    return 'Máy tính';
  }
  function readKey(k) { try { const s = localStorage.getItem(k); return s == null ? null : JSON.parse(s); } catch (_) { return null; } }
  const tokenOk = () => { const a = typeof loadAuth === 'function' ? loadAuth() : null; return !!(a && a.token && a.expiresAt > Date.now() + 30_000); };
  const working = () => !!(window.Answers && Answers.working && Answers.working());
  const pendCount = () => Object.values(S.pend).reduce((a, b) => a + b, 0);

  // ---------- Ghi nhận thay đổi trong máy ----------
  // Các phần app gọi sau mỗi lần ghi một khóa được đồng bộ.
  function touched(k) {
    if (!SPECS[k]) return;
    const now = Date.now();
    const cur = strItems(itemize(k, readKey(k)));
    const { changed, removed } = diff(snap[k] || {}, cur);
    snap[k] = cur;
    if (!changed.length && !removed.length) return;
    const m = (META[k] = META[k] || {});
    for (const p of changed) m[p] = [now, S.dev, 0];
    for (const p of removed) m[p] = [now, S.dev, 1];
    saveMeta();
    const f = SPECS[k].file;
    // "Trang đang xem" đổi mỗi lần lật trang: không tự gọi một lượt đồng bộ riêng, đi kèm lượt sau hoặc khi rời app.
    const loud = changed.concat(removed).filter((p) => !(k === 'ielts.pdfcfg' && /\/lastPage$/.test(p)));
    S.dirty[f] = true; S.pend[f] = (S.pend[f] || 0) + loud.length;
    saveState();
    if (S.on && loud.length) schedule(working() ? DELAY_WORK : DELAY, 'thay đổi trong máy');
    render();
  }
  // Hẹn một lượt đẩy. Không dời lượt đã hẹn sớm hơn (đang làm đề, bài được lưu mỗi 5 s: vẫn đẩy sau 30 s chứ không dời mãi).
  function schedule(ms, why) {
    if (!S.on) return;
    const due = Date.now() + ms;
    if (R.timer && R.due <= due) return;
    clearTimeout(R.timer);
    R.due = due;
    R.timer = setTimeout(() => { R.timer = null; run(dirtyFiles(), why); }, ms);
  }
  const dirtyFiles = () => Object.keys(FILES).filter((f) => S.dirty[f]);
  const allFiles = () => Object.keys(FILES);

  // ---------- Gọi Drive ----------
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  class NeedToken extends Error {}
  async function api(method, url, opt = {}) {
    const a = typeof loadAuth === 'function' ? loadAuth() : null;
    if (!a || !a.token) throw new NeedToken('Chưa đăng nhập');
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, { method, headers: Object.assign({ Authorization: 'Bearer ' + a.token }, opt.headers || {}), body: opt.body, keepalive: !!opt.keepalive });
      } catch (e) { const er = new Error('Không có mạng hoặc Drive không trả lời'); er.offline = true; throw er; }
      if (res.status === 401) {
        if (typeof saveAuth === 'function') { const x = loadAuth(); if (x) { x.expiresAt = 0; saveAuth(x); } }
        throw new NeedToken('Token hết hạn (401)');
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
      if (!res.ok) { let d = ''; try { d = (await res.json()).error.message; } catch (_) {} throw new HttpError(res.status, `Drive trả ${res.status}${d ? ' ' + d : ''}`); }
      if (opt.raw) return res;
      const txt = await res.text();
      return txt ? JSON.parse(txt) : null;
    }
  }
  async function listApp() {
    const r = await api('GET', DRIVE + 'files?' + new URLSearchParams({ spaces: 'appDataFolder', fields: 'files(id,name,size,modifiedTime,createdTime)', pageSize: '200', orderBy: 'createdTime' }));
    return (r && r.files) || [];
  }
  async function getDoc(id) { return api('GET', DRIVE + 'files/' + encodeURIComponent(id) + '?alt=media'); }
  async function getVer(id) { const r = await api('GET', DRIVE + 'files/' + encodeURIComponent(id) + '?fields=version'); return r && r.version != null ? String(r.version) : null; }
  function multipart(meta, body) {
    const b = 'ielts' + Math.random().toString(36).slice(2);
    return { headers: { 'Content-Type': `multipart/related; boundary=${b}` },
      body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--` };
  }
  async function createFile(name, body) {
    const mp = multipart({ name, parents: ['appDataFolder'], mimeType: 'application/json' }, body);
    return api('POST', UPLOAD + 'files?uploadType=multipart&fields=id,name,size,modifiedTime,version', mp);
  }
  async function updateFile(id, body, keepalive) {
    return api('PATCH', UPLOAD + 'files/' + encodeURIComponent(id) + '?uploadType=media&fields=id,size,modifiedTime,version', { headers: { 'Content-Type': 'application/json' }, body, keepalive });
  }
  async function deleteFile(id) { return api('DELETE', DRIVE + 'files/' + encodeURIComponent(id), { raw: true }); }

  // ---------- Một lượt đồng bộ ----------
  function gather(f) {
    const out = {};
    for (const k of FILE_KEYS[f]) out[k] = { items: itemize(k, readKey(k)), meta: META[k] || {} };
    return out;
  }
  // Ghi các mục Drive thắng vào máy. Xét lại từng mục với dữ liệu trong máy lúc này (Minh có thể vừa sửa trong lúc chờ mạng).
  function applyLocal(apply, metaOnly) {
    const changedKeys = [];
    for (const k of new Set([...Object.keys(apply), ...Object.keys(metaOnly)])) {
      const items = itemize(k, readKey(k));
      const m = (META[k] = META[k] || {});
      let n = 0;
      for (const [p, r] of Object.entries(apply[k] || {})) {
        const l = localEntry(items, m, p, S.dev);
        if (pick(l, r) !== 'remote') continue;
        if (r.x) delete items[p]; else items[p] = r.v;
        m[p] = [r.t, r.d, r.x ? 1 : 0];
        n++;
      }
      for (const [p, mm] of Object.entries(metaOnly[k] || {})) { if (!m[p] || m[p][0] <= mm[0]) m[p] = mm; }
      if (n) {
        const v = build(k, items);
        try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { L('Đồng bộ: không ghi được vào máy: ' + e.message); continue; }
        snap[k] = strItems(itemize(k, readKey(k)));
        changedKeys.push(k);
      }
    }
    saveMeta();
    return changedKeys;
  }
  async function fileIds() {
    // Đã biết đủ 3 file thì khỏi liệt kê lại (10 phút). Thiếu file nào thì luôn liệt kê lại trước khi tạo, để không tạo trùng.
    if (S.idsAt && Date.now() - S.idsAt < 10 * 60_000 && Object.keys(FILES).every((f) => S.ids[f])) return { dups: {} };
    const list = await listApp();
    const dups = {};
    for (const [f, name] of Object.entries(FILES)) {
      const same = list.filter((x) => x.name === name);
      S.ids[f] = same.length ? same[0].id : null;
      if (same.length > 1) dups[f] = same.slice(1).map((x) => x.id);
    }
    S.idsAt = Date.now(); saveState();
    return { dups };
  }
  async function syncFile(f, dups, rep) {
    const wasPend = S.pend[f] || 0;
    S.dirty[f] = false; saveState();
    let id = S.ids[f], remote = null;
    // Đọc số version trước (yêu cầu nhỏ). Drive chưa đổi từ lần đọc/ghi trước trong phiên này (cùng version): dùng bản đã có,
    // khỏi tải lại cả file. Version đọc TRƯỚC nội dung, nên nội dung tải về không bao giờ cũ hơn version đã nhớ.
    let ver = null;
    if (id) { try { ver = await getVer(id); } catch (e) { if (e.status === 404) { S.ids[f] = null; S.idsAt = 0; id = null; } else throw e; } }
    if (id && ver && ver === R.ver[f] && R.remote[f] && !(dups[f] || []).length) { remote = R.remote[f]; rep.cached++; }
    else if (id) {
      try { remote = await getDoc(id); R.ver[f] = ver; }
      catch (e) {
        if (e.status === 404) { S.ids[f] = null; S.idsAt = 0; id = null; remote = null; }
        else if (e instanceof SyntaxError) { rep.notes.push(`${FILES[f]} trên Drive hỏng (không đọc được JSON), ghi lại từ dữ liệu máy này`); remote = null; }
        else throw e;
      }
    }
    for (const did of dups[f] || []) { try { remote = mergeRemote(remote, await getDoc(did)); } catch (_) {} }
    const m = mergeDoc(gather(f), remote, { dev: S.dev, lastSyncAt: S.lastSyncAt || 0 });
    const changed = applyLocal(m.apply, m.meta);
    const doc = Object.assign({ v: 1, app: 'ielts-pwa', file: f, at: Date.now(), by: S.name, dev: S.dev }, m.doc);
    const body = JSON.stringify(doc);
    if (!id) { const r = await createFile(FILES[f], body); S.ids[f] = r.id; id = r.id; R.ver[f] = r && r.version != null ? String(r.version) : null; }
    else if (m.push || (dups[f] || []).length) { const r = await updateFile(id, body); R.ver[f] = r && r.version != null ? String(r.version) : null; }
    for (const did of dups[f] || []) { try { await deleteFile(did); rep.notes.push(`xóa file trùng ${FILES[f]}`); } catch (_) {} }
    R.remote[f] = m.doc;
    S.pend[f] = Math.max(0, (S.pend[f] || 0) - wasPend);
    saveState();
    rep.files.push(`${FILES[f]} ${kb(body.length)}${m.recv ? ` ↓${m.recv}` : ''}${m.sent ? ` ↑${m.sent}` : ''}`);
    rep.recv += m.recv; rep.sent += m.sent; rep.changed.push(...changed); rep.conflicts.push(...m.conflicts);
    if (f === 'ink' && body.length > INK_WARN) rep.notes.push(`ink.json đã ${kb(body.length)} (quá 1 MB)`);
  }
  // Chạy đồng bộ các file (mặc định: cả 3). Đang chạy thì gộp lượt sau.
  function run(files, why) {
    files = files && files.length ? files : allFiles();
    if (!S.on) return Promise.resolve();
    if (R.busy) {
      R.again = R.again || { files: new Set(), why };
      files.forEach((f) => R.again.files.add(f));
      return R.busy;
    }
    clearTimeout(R.timer); R.timer = null; clearTimeout(R.retryT);
    if (!tokenOk()) { R.status = 'token'; render(); return Promise.resolve(); }
    if (navigator.onLine === false) { R.status = 'offline'; render(); return Promise.resolve(); }
    R.status = 'busy'; render();
    const t0 = performance.now();
    const rep = { files: [], recv: 0, sent: 0, changed: [], conflicts: [], notes: [], cached: 0 };
    R.busy = (async () => {
      try {
        const { dups } = await fileIds();
        for (const f of files) await syncFile(f, dups, rep);
        if (files.length === allFiles().length) R.lastPull = Date.now();
        S.lastSyncAt = Date.now(); S.lastOk = Date.now(); saveState();
        R.status = 'ok'; R.err = '';
        L(`Đồng bộ (${why}): ${rep.recv ? `nhận ${rep.recv} mục` : 'không có mục mới từ máy khác'}, ${rep.sent ? `gửi ${rep.sent} mục` : 'không có gì phải gửi'}; ${rep.files.join(', ')}; ${Math.round(performance.now() - t0)} ms` +
          `${rep.cached ? `; ${rep.cached} file Drive chưa đổi, không tải lại` : ''}${rep.conflicts.length ? `; ${rep.conflicts.length} chỗ hai máy khác nhau (xem dòng dưới)` : ''}${rep.notes.length ? '; ' + rep.notes.join('; ') : ''}.`);
        logConflicts(rep.conflicts);
        if (rep.changed.length) changedEvent([...new Set(rep.changed)], why);
      } catch (e) {
        if (e instanceof NeedToken) { R.status = 'token'; R.err = e.message; L(`Đồng bộ (${why}): ${e.message}, chờ gia hạn token.`); }
        else if (e.offline) { R.status = 'offline'; R.err = e.message; L(`Đồng bộ (${why}): ${e.message}. Có mạng lại sẽ tự đồng bộ.`); retryLater(); }
        else { R.status = 'error'; R.err = e.message; L(`Đồng bộ (${why}) lỗi: ${e.message}. Sẽ thử lại sau ${RETRY_GAP / 1000} giây.`); retryLater(); }
        for (const f of files) S.dirty[f] = S.dirty[f] || (S.pend[f] || 0) > 0;
        saveState();
      } finally {
        R.busy = null;
        render();
        if (R.again) { const a = R.again; R.again = null; run([...a.files], a.why); }
        else if (dirtyFiles().length && R.status === 'ok') schedule(working() ? DELAY_WORK : DELAY, 'thay đổi trong lúc đồng bộ');
      }
    })();
    return R.busy;
  }
  function retryLater() { clearTimeout(R.retryT); R.retryT = setTimeout(() => run(dirtyFiles().length ? dirtyFiles() : allFiles(), 'thử lại'), RETRY_GAP); }

  // Rời app: đẩy ngay phần chưa đồng bộ. Đã có bản Drive từ lượt trước trong phiên này thì gộp với bản đó và ghi thẳng (không tải
  // lại, để kịp trước khi iPhone tạm dừng app); file nhỏ dùng keepalive. Bản đó cũ hơn Drive thì máy kia có mục mới hơn sẽ tự đẩy lại.
  function pushOnHide(why) {
    if (!S.on || !tokenOk() || R.busy) return;
    const files = dirtyFiles();
    if (!files.length) return;
    clearTimeout(R.timer); R.timer = null;
    for (const f of files) {
      const id = S.ids[f], cached = R.remote[f];
      if (!id || !cached) { run([f], why); continue; }
      const m = mergeDoc(gather(f), cached, { dev: S.dev, lastSyncAt: S.lastSyncAt || 0 });
      if (!m.push) { S.dirty[f] = false; S.pend[f] = 0; continue; }
      const body = JSON.stringify(Object.assign({ v: 1, app: 'ielts-pwa', file: f, at: Date.now(), by: S.name, dev: S.dev }, m.doc));
      S.dirty[f] = false; const wasPend = S.pend[f] || 0;
      updateFile(id, body, body.length < KEEPALIVE_MAX).then((r) => {
        R.remote[f] = m.doc; R.ver[f] = r && r.version != null ? String(r.version) : null; S.pend[f] = Math.max(0, (S.pend[f] || 0) - wasPend); S.lastSyncAt = Date.now(); saveState();
        L(`Đồng bộ (${why}): gửi ${m.sent} mục, ${FILES[f]} ${kb(body.length)}${body.length < KEEPALIVE_MAX ? ' (keepalive)' : ''}.`); render();
      }, (e) => { S.dirty[f] = true; saveState(); L(`Đồng bộ (${why}) chưa gửi được ${FILES[f]}: ${e.message}. Lần mở app sau sẽ gửi.`); });
    }
    saveState();
  }

  // ---------- Nhãn dễ đọc cho nhật ký ----------
  function fileName(id) {
    const r = window.Library && Library._results && Library._results().find((x) => x.id === id);
    return r ? r.name : id;
  }
  const segLbl = (k) => (window.Sections && Sections.LABEL[k]) || k;
  function describe(key, path, e) {
    const p = path.split('/');
    if (key === 'ielts.pdfcfg') {
      if (p[1] === 'marks') return `mốc ${segLbl(p[2])} (${fileName(p[0])})`;
      if (p[1] === 'keypage') return `trang đáp án ${segLbl(p[2])} (${fileName(p[0])})`;
      if (p[1] === 'offset') return `độ lệch số trang (${fileName(p[0])})`;
      if (p[1] === 'lastPage') return `trang đang xem (${fileName(p[0])})`;
      return `${p[1]} (${fileName(p[0])})`;
    }
    if (key === 'ielts.keys') return `đáp án Cam ${p[0]} ${segLbl(p[1])}`;
    if (key === 'ielts.attempts') { const a = e && e.v; return a ? `bài làm Cam ${a.book} ${segLbl(a.seg)} bắt đầu ${new Date(a.startedAt).toLocaleString('vi-VN')}` : `bài làm ${path}`; }
    if (key === 'ielts.libcfg') return p[0] === 'files' ? `sửa tay file ${fileName(p[1])}` : p[0] === 'books' ? `cấu hình thư viện Cam ${p[1]}` : p[0] === 'keywords' ? `từ khóa thêm (${p[1]})` : `thư viện: ${path}`;
    if (key === 'ielts.audiomarks') return `mốc audio Part ${p[1]} (${fileName(p[0])})`;
    if (key === 'ielts.ink') return `nét vẽ trang ${p[1]} (${fileName(p[0])})`;
    if (key === 'ielts.pen') return 'chế độ bút iPad';
    return `${key} ${path}`;
  }
  function valText(key, e) {
    if (!e || e.x) return 'đã xóa';
    const v = e.v;
    if (key === 'ielts.keys' && v) return `${Object.values(v.items || {}).filter((x) => String(x).trim()).length} câu, soát ${(v.checked || []).length} cụm`;
    if (key === 'ielts.ink' && Array.isArray(v)) return `${v.length} nét`;
    if (key === 'ielts.attempts' && v) return v.submittedAt ? `đã nộp${v.score != null ? ` ${v.score}/${v.total}` : ''}` : 'chưa nộp';
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return String(v);
    return 'khác';
  }
  const who = (e) => (e && e.d === S.dev ? S.name : e && e.d ? (e.by || 'máy khác') : 'máy khác');
  function logConflicts(list) {
    for (const c of list.slice(0, 20)) {
      const keep = c.kept === 'remote' ? c.remote : c.local, drop = c.kept === 'remote' ? c.local : c.remote;
      const why = c.local.t === c.remote.t ? (c.local.t === 0 ? 'dữ liệu cũ, chưa rõ bản nào mới hơn: giữ bản trên Drive' : 'cùng thời điểm') : 'giữ bản sửa sau';
      L(`  Khác nhau: ${describe(c.key, c.path, keep)}: giữ ${valText(c.key, keep)} (${c.kept === 'remote' ? 'bản trên Drive' : `máy này, ${S.name}`}), bỏ ${valText(c.key, drop)} (${c.kept === 'remote' ? `máy này, ${S.name}` : 'bản trên Drive'}) · ${why}.`);
    }
    if (list.length > 20) L(`  …và ${list.length - 20} chỗ khác nữa. Bản sao lưu lúc bật đồng bộ vẫn còn trên Drive.`);
  }
  function changedEvent(keys, why) {
    try { window.dispatchEvent(new CustomEvent('ielts-sync', { detail: { keys, why } })); } catch (_) {}
    if (window.Library && Library.render) { try { Library.render(); } catch (_) {} }
  }

  // ---------- Bật / tắt ----------
  async function backup() {
    const data = {};
    for (const k of Object.keys(SPECS)) data[k] = readKey(k);
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    const name = `backup-${S.name.replace(/[^\w.-]+/g, '_')}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    const body = JSON.stringify({ v: 1, app: 'ielts-pwa', kind: 'backup', at: Date.now(), dev: S.dev, name: S.name, version: window.APP_VERSION, data, meta: META });
    await createFile(name, body);
    return { name, size: body.length };
  }
  function enableClick() {
    const wait = window.ensureToken();   // gọi trước mọi await để cửa sổ gia hạn không bị chặn
    const nm = ($('sync-name') && $('sync-name').value.trim()) || S.name;
    if (!confirm(`Bật đồng bộ trên máy này ("${nm}")?\n\nLần đầu: app lưu một bản sao dữ liệu của máy này lên vùng dữ liệu ẩn trên Drive, rồi gộp với dữ liệu đã có trên Drive. ` +
      'Chỗ hai máy khác nhau mà chưa rõ bản nào mới hơn (dữ liệu từ trước bản m6-1) thì giữ bản đã có trên Drive, tức của máy bật trước; nhật ký ghi lại từng chỗ.\n\nNên bật trên máy có nhiều mốc trang và đáp án nhất trước.')) { wait.catch(() => {}); return; }
    S.name = nm.slice(0, 30); saveState();
    const btn = $('sync-enable'); if (btn) btn.disabled = true;
    R.status = 'busy'; render();
    wait.then(async () => {
      const b = await backup();
      L(`Đồng bộ: đã lưu bản sao dữ liệu máy này lên vùng ẩn Drive (${b.name}, ${kb(b.size)}).`);
      S.on = true; S.since = Date.now(); S.backup = b.name; saveState();
      L(`Đồng bộ: bật trên máy này (${S.name}).`);
      await run(allFiles(), 'bật đồng bộ');
    }).catch((e) => { R.status = 'error'; R.err = e.message; L(`Bật đồng bộ lỗi: ${e.message}`); })
      .finally(() => { if (btn) btn.disabled = false; render(); });
  }
  function nowClick() {
    if (!S.on) return;
    const wait = window.ensureToken();
    wait.then(() => run(allFiles(), 'bấm Đồng bộ ngay'), (e) => { R.status = 'token'; R.err = e.message; render(); });
  }
  function offClick() {
    if (!S.on || !confirm('Tắt đồng bộ trên máy này? Dữ liệu trong máy và trên Drive vẫn giữ nguyên; bật lại thì gộp tiếp.')) return;
    S.on = false; saveState(); R.status = 'off'; L(`Đồng bộ: tắt trên máy này (${S.name}).`); render();
  }
  async function filesClick() {
    const out = $('sync-files-out'); if (!out) return;
    const wait = window.ensureToken();
    out.textContent = 'Đang đọc…';
    try {
      await wait;
      const list = await listApp();
      out.textContent = list.length ? list.map((f) => `${f.name}  ${kb(Number(f.size || 0))}  sửa ${new Date(f.modifiedTime).toLocaleString('vi-VN')}`).join('\n') : 'Vùng dữ liệu ẩn trống.';
    } catch (e) { out.textContent = 'Lỗi: ' + e.message; }
  }

  // ---------- Hiển thị ----------
  function statusText() {
    const pend = pendCount();
    if (!S.on) return { line: 'Chưa bật trên máy này: mốc trang, đáp án, bài làm chỉ nằm trong máy.', chip: '' };
    const p = pend ? ` ${pend} thay đổi chưa đồng bộ.` : '';
    switch (R.status) {
      case 'busy': return { line: `Đang đồng bộ…${p}`, chip: '⟳ đồng bộ' };
      case 'token': return { line: `Chờ gia hạn token để đồng bộ.${p} Bấm "Đồng bộ ngay".`, chip: pend ? `chờ đồng bộ ${pend}` : 'chờ token' };
      case 'offline': return { line: `Ngoại tuyến.${p} Có mạng lại sẽ tự đồng bộ.`, chip: pend ? `ngoại tuyến · ${pend}` : 'ngoại tuyến' };
      case 'error': return { line: `Lỗi đồng bộ: ${R.err}.${p} Sẽ tự thử lại.`, chip: pend ? `chờ đồng bộ ${pend}` : 'lỗi đồng bộ' };
      default: return { line: S.lastOk ? `Đã đồng bộ lúc ${hm(S.lastOk)} (máy này: ${S.name}).${p}` : `Bật trên máy này (${S.name}), chưa đồng bộ lần nào.${p}`, chip: pend ? `chờ đồng bộ ${pend}` : S.lastOk ? `✓ đồng bộ ${hm(S.lastOk)}` : '' };
    }
  }
  function render() {
    const s = statusText();
    const el = $('sync-status'); if (el) el.textContent = s.line;
    const ch = $('sync-chip'); if (ch) { ch.textContent = s.chip; ch.hidden = !s.chip; ch.className = 'tag' + (R.status === 'ok' && !pendCount() ? ' ok' : ''); }
    const signed = typeof loadAuth === 'function' && !!loadAuth();
    const en = $('sync-enable'); if (en) { en.hidden = !!S.on; en.disabled = !signed || R.status === 'busy'; }
    const nw = $('sync-now'); if (nw) { nw.hidden = !S.on; nw.disabled = !signed; }
    const off = $('sync-off'); if (off) off.hidden = !S.on;
    const nm = $('sync-name'); if (nm && document.activeElement !== nm) { nm.value = S.name; nm.disabled = !!S.on; }
  }

  // ---------- Kéo khi mở app / quay lại; đẩy khi rời app ----------
  function onVis() {
    if (document.visibilityState === 'hidden') { R.hidAt = Date.now(); setTimeout(() => pushOnHide('rời app'), 0); return; }
    if (!S.on) return;
    if (Date.now() - R.lastPull > PULL_GAP) run(allFiles(), 'quay lại app');
    else if (dirtyFiles().length) schedule(0, 'quay lại app');
  }
  // Chờ lượt đồng bộ đang chạy (vd vừa quay lại app) xong, tối đa ms. Không bật / không có lượt nào thì xong ngay.
  function whenFresh(ms = 3000) {
    if (!S.on || !R.busy) return Promise.resolve();
    return Promise.race([R.busy.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
  }
  function init() {
    if ($('sync-enable')) {
      $('sync-enable').onclick = enableClick;
      $('sync-now').onclick = nowClick;
      $('sync-off').onclick = offClick;
      if ($('sync-files')) $('sync-files').onclick = filesClick;
    }
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', () => pushOnHide('đóng trang'));
    window.addEventListener('online', () => { if (S.on) run(dirtyFiles().length ? dirtyFiles() : allFiles(), 'có mạng lại'); });
    window.addEventListener('ielts-token', () => { if (S.on && (R.status === 'token' || dirtyFiles().length || !R.lastPull)) run(allFiles(), 'có token mới'); });
    R.status = S.on ? 'ok' : 'off';
    render();
    if (S.on) {
      if (tokenOk()) run(allFiles(), 'mở app'); else { R.status = 'token'; render(); }
    }
  }

  root.Sync = Object.assign({}, Pure, {
    touched, run: (why) => run(allFiles(), why || 'gọi'), soon: (why) => schedule(500, why || 'ngay'), whenFresh,
    on: () => !!S.on, dev: () => S.dev, name: () => S.name, status: () => R.status, pending: pendCount, render, _S: S, _R: R, _META: META,
  });
  init();
})(typeof window !== 'undefined' ? window : globalThis);
