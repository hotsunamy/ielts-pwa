// Service worker: lưu vỏ app (HTML, CSS, JS, icon) để mở nhanh và cài được.
// Không đụng tới request gửi Google/Drive từ trang. Cache PDF (ielts-pdf-*) do pdfsource.js quản lý, không xóa ở đây.
// m4-1: thêm đường "ap/<id>" để phát audio từ Drive kiểu stream (cách 1b): thẻ <audio> trỏ vào địa chỉ trong app, service worker
// gắn token rồi chuyển tiếp header Range sang Drive, trả 206. Token lấy từ cache 'ielts-auth-v1' (app.js ghi mỗi khi token đổi).
// Trình duyệt không đọc được header content-range của Drive (CORS) nên tự dựng từ dung lượng file app gửi kèm (?size=).
// Không lưu audio vào cache: chỉ stream online (Minh chốt 14/10).
// m4-2: đọc trước 256 KB khi trình phát xin mẩu nhỏ (Safari dò file m4a bằng nhiều lần xin nhỏ nối tiếp), giữ trong bộ nhớ
// của service worker (tối đa 8 MB, mất khi service worker tắt), không ghi vào máy. Trang mở bằng Ctrl+F5 thì trang nhờ
// service worker nhận quyền điều khiển (clients.claim) để cách 1b vẫn dùng được.
const VERSION = 'm4-3';
const VENDOR = 'vendor-pdfjs-4.10.38';   // cache riêng, không bị xóa khi đổi VERSION
const AUTH_CACHE = 'ielts-auth-v1';
const DRIVE = 'https://www.googleapis.com/drive/v3/';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'config.js', 'recognize.js', 'library.js', 'sections.js', 'pdfindex.js', 'pdfsource.js', 'viewer.js', 'audio.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // Giữ vỏ app bản hiện tại, thư viện pdf.js và mọi cache 'ielts-*' (PDF, token cho audio).
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== VENDOR && !k.startsWith('ielts-')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith(AP_PATH)) { e.respondWith(proxyAudio(e, url)); return; }
  // Thư viện pdf.js đặt trong vendor/ có số phiên bản trong đường dẫn, không đổi nữa: lấy cache trước, khỏi tải lại 1,8 MB.
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.open(VENDOR).then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }))));
    return;
  }
  // Mạng trước, mất mạng thì dùng bản đã lưu.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// ---------- Audio stream (m4-1, cách 1b) ----------
const AP_PATH = new URL('ap/', self.registration.scope).pathname;
const AUTH_URL = new URL('__auth', self.registration.scope).href;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_WAIT = [500, 1000, 2000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readAuth() {
  try { const c = await caches.open(AUTH_CACHE); const r = await c.match(AUTH_URL); return r ? await r.json() : null; } catch (_) { return null; }
}

// Báo cho trang từng lần gọi Drive để ghi nhật ký (trang không thấy được các lần gọi của service worker).
async function tell(clientId, msg) {
  try {
    const list = clientId ? [await self.clients.get(clientId)] : await self.clients.matchAll({ type: 'window' });
    for (const c of list) if (c) c.postMessage(Object.assign({ type: 'ap-call' }, msg));
  } catch (_) {}
}

// Đọc trước trong bộ nhớ: khối 256 KB thẳng hàng, theo file. Chỉ dùng khi trình phát xin mẩu nhỏ (<= 256 KB).
const RA_BLOCK = 256 * 1024, RA_MAX = 8 * 1024 * 1024;
const raFiles = new Map();   // id -> {size, blocks: Map(chỉ số khối -> Uint8Array)}; thứ tự Map = dùng gần nhất ở cuối
let raBytes = 0;
function raCovered(id, size, a, b) {
  const f = raFiles.get(id);
  if (!f || f.size !== size) return null;
  const parts = [];
  for (let k = Math.floor(a / RA_BLOCK); k <= Math.floor(b / RA_BLOCK); k++) { const blk = f.blocks.get(k); if (!blk) return null; parts.push([k, blk]); }
  raFiles.delete(id); raFiles.set(id, f);
  const out = new Uint8Array(b - a + 1);
  for (const [k, blk] of parts) {
    const s = k * RA_BLOCK, from = Math.max(a, s), to = Math.min(b, s + blk.length - 1);
    out.set(blk.subarray(from - s, to - s + 1), from - a);
  }
  return out;
}
function raStore(id, size, start, buf) {
  let f = raFiles.get(id);
  if (!f || f.size !== size) { if (f) raBytes -= [...f.blocks.values()].reduce((x, v) => x + v.length, 0); f = { size, blocks: new Map() }; }
  raFiles.delete(id); raFiles.set(id, f);
  for (let off = 0; off < buf.length; off += RA_BLOCK) {
    const k = (start + off) / RA_BLOCK, blk = buf.slice(off, Math.min(buf.length, off + RA_BLOCK));
    if (f.blocks.has(k)) raBytes -= f.blocks.get(k).length;
    f.blocks.set(k, blk); raBytes += blk.length;
  }
  while (raBytes > RA_MAX && raFiles.size > 1) {   // bỏ file dùng lâu nhất
    const [oid, of] = raFiles.entries().next().value;
    if (oid === id) break;
    raBytes -= [...of.blocks.values()].reduce((x, v) => x + v.length, 0); raFiles.delete(oid);
  }
}

async function proxyAudio(e, url) {
  const id = decodeURIComponent(url.pathname.slice(AP_PATH.length));
  const size = Number(url.searchParams.get('size')) || 0;
  const mime = url.searchParams.get('mime') || 'audio/mpeg';
  const tag = url.searchParams.get('n') || '';
  const rec = { id, tag, rid: Math.random().toString(36).slice(2), start: Date.now(), range: e.request.headers.get('range') || '' };
  const auth = await readAuth();
  if (!auth || !auth.token) { rec.status = 401; rec.err = 'chưa có token trong service worker'; tell(e.clientId, rec); return new Response('', { status: 401 }); }
  // Dải byte trình duyệt xin. Không có Range thì trả cả file (200).
  const m = /bytes=(\d*)-(\d*)/.exec(rec.range);
  let a = 0, b = size - 1;
  if (m) {
    if (m[1] === '' && m[2] !== '') { a = Math.max(0, size - Number(m[2])); }   // "bytes=-N": N byte cuối
    else { a = Number(m[1] || 0); if (m[2] !== '') b = Math.min(size - 1, Number(m[2])); }
  }
  if (size && a >= size) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  rec.off = a; rec.want = size ? b - a + 1 : null;
  // Đã có trong bộ nhớ đọc trước: trả luôn, không gọi Drive.
  if (size) {
    const hit = raCovered(id, size, a, b);
    if (hit) {
      rec.mem = true; rec.status = 206; rec.hdr = rec.end = Date.now(); rec.len = hit.length; tell(e.clientId, rec);
      return new Response(hit, { status: 206, headers: { 'Content-Type': mime, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': String(hit.length), 'Accept-Ranges': 'bytes' } });
    }
  }
  // Mẩu nhỏ: xin Drive cả khối 256 KB thẳng hàng (tối đa 2 khối) để các lần xin nhỏ sau lấy từ bộ nhớ.
  let ra = null;
  if (size && m && b - a + 1 <= RA_BLOCK) {
    const s0 = Math.floor(a / RA_BLOCK) * RA_BLOCK, s1 = Math.min(size - 1, (Math.floor(b / RA_BLOCK) + 1) * RA_BLOCK - 1);
    ra = { s0, s1 }; rec.ra = s1 - s0 + 1;
  }
  let res;
  for (let k = 0; ; k++) {
    try {
      res = await fetch(DRIVE + 'files/' + encodeURIComponent(id) + '?alt=media', {
        headers: { Authorization: 'Bearer ' + auth.token, Range: ra ? `bytes=${ra.s0}-${ra.s1}` : size ? `bytes=${a}-${b}` : `bytes=${a}-` },
        signal: e.request.signal, cache: 'no-store',
      });
    } catch (err) {
      rec.err = err.name === 'AbortError' ? 'trình phát hủy' : (err.message || 'lỗi mạng'); rec.hdr = Date.now(); tell(e.clientId, rec);
      return Response.error();
    }
    rec.hdr = Date.now(); rec.status = res.status;
    if (RETRY_STATUS.has(res.status) && k < RETRY_WAIT.length) {
      rec.retries = k + 1; (rec.codes || (rec.codes = [])).push(res.status);
      try { res.body && res.body.cancel(); } catch (_) {}
      await sleep(RETRY_WAIT[k] * (0.8 + Math.random() * 0.4));
      continue;
    }
    break;
  }
  if (res.status !== 206 && res.status !== 200) {
    rec.err = `Drive trả ${res.status}${rec.retries ? ` (đã thử lại ${rec.retries} lần)` : ''}`;
    tell(e.clientId, rec);
    try { res.body && res.body.cancel(); } catch (_) {}
    return new Response('', { status: res.status === 401 ? 401 : 502 });
  }
  const ctype = /^audio\/|^video\/mp4/.test(res.headers.get('content-type') || '') ? res.headers.get('content-type') : mime;
  if (ra && res.status === 206) {
    let buf;
    try { buf = new Uint8Array(await res.arrayBuffer()); }
    catch (err) { rec.err = err.name === 'AbortError' ? 'trình phát hủy' : 'đứt giữa chừng: ' + (err.message || err.name); rec.end = Date.now(); tell(e.clientId, rec); return Response.error(); }
    rec.len = buf.length; rec.end = Date.now();
    if (buf.length !== ra.s1 - ra.s0 + 1) { rec.err = `Drive trả ${buf.length} byte thay vì ${ra.s1 - ra.s0 + 1}`; tell(e.clientId, rec); return new Response('', { status: 502 }); }
    raStore(id, size, ra.s0, buf);
    tell(e.clientId, rec);
    return new Response(buf.slice(a - ra.s0, b - ra.s0 + 1), { status: 206, headers: { 'Content-Type': ctype, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': String(b - a + 1), 'Accept-Ranges': 'bytes' } });
  }
  // Đếm byte đi qua để báo lúc xong (hoặc lúc trình phát hủy giữa chừng khi tua).
  let got = 0;
  const reader = res.body.getReader();
  const finish = (cancelled) => { rec.len = got; rec.end = Date.now(); if (cancelled) rec.cancelled = true; tell(e.clientId, rec); };
  const body = new ReadableStream({
    async pull(ctl) {
      let r;
      try { r = await reader.read(); } catch (err) { rec.err = 'đứt giữa chừng: ' + (err.message || err.name); finish(false); ctl.error(err); return; }
      if (r.done) { finish(false); ctl.close(); return; }
      got += r.value.byteLength; ctl.enqueue(r.value);
    },
    cancel(reason) { finish(true); reader.cancel(reason).catch(() => {}); },
  });
  tell(e.clientId, Object.assign({}, rec, { phase: 'hdr' }));
  if (res.status === 200 || !m || !size) {
    // Drive trả cả file, hoặc trình duyệt không xin Range: trả 200 cả file.
    const h = { 'Content-Type': ctype, 'Accept-Ranges': 'bytes' };
    if (size && (res.status === 200 || a === 0)) h['Content-Length'] = String(size);
    return new Response(body, { status: 200, headers: h });
  }
  return new Response(body, {
    status: 206,
    headers: { 'Content-Type': ctype, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': String(b - a + 1), 'Accept-Ranges': 'bytes' },
  });
}

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'ping') e.source && e.source.postMessage({ type: 'pong', version: VERSION });
  // Trang mở bằng Ctrl+F5 không qua service worker: trang nhờ nhận quyền điều khiển để stream audio (cách 1b).
  if (e.data && e.data.type === 'claim') e.waitUntil(self.clients.claim());
});
