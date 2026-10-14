// Mốc 3: lấy PDF từ Drive của Minh theo từng đoạn byte (header Range), có cache đoạn trong máy.
// Không có nội dung Cambridge nào trong code. File chỉ đọc từ Drive của người đăng nhập.
'use strict';
(function () {
  const DRIVE = 'https://www.googleapis.com/drive/v3/';
  const PDFJS_DIR = 'vendor/pdfjs-4.10.38/';
  // Bảng mã chữ Trung/Nhật/Hàn (cmaps, 169 file) chỉ cần khi PDF dùng phông CJK không nhúng, hiếm gặp. Lấy từ CDN khi cần
  // để repo ít file (giao diện tải lên của GitHub giới hạn số file mỗi lần).
  const CMAP_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/';
  const CHUNK = 16 * 1024;   // cỡ đoạn: nhỏ để từ điển trang rải rác tốn ít byte; đoạn liền nhau (ảnh scan) vẫn gộp 1 lần gọi
  const CHUNK_CACHE = 'ielts-pdf-chunks-16k-v1';
  const FULL_CACHE = 'ielts-pdf-full-v1';

  class AuthNeeded extends Error {}
  class NoRange extends Error {}

  const mediaUrl = (id) => DRIVE + 'files/' + encodeURIComponent(id) + '?alt=media';
  const token = () => { const a = loadAuth(); return a && a.token; };
  const mb = (n) => (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + ' MB';

  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('./' + PDFJS_DIR + 'pdf.min.js').then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = new URL(PDFJS_DIR + 'pdf.worker.min.js', location.href).href;
        return lib;
      }).catch((e) => { pdfjsPromise = null; throw e; });
    }
    return pdfjsPromise;
  }

  // Xin byte [begin, end) của file. Drive trả 206 nếu hỗ trợ Range. Trả 200 thì dừng ngay để khỏi tải cả file.
  async function fetchRange(id, begin, end) {
    const t = token();
    if (!t) throw new AuthNeeded('Chưa đăng nhập');
    const ctl = new AbortController();
    const t0 = performance.now();
    const res = await fetch(mediaUrl(id), {
      headers: { Authorization: 'Bearer ' + t, Range: `bytes=${begin}-${end - 1}` },
      signal: ctl.signal, cache: 'no-store',
    });
    if (res.status === 401) { ctl.abort(); const a = loadAuth(); if (a) { a.expiresAt = 0; saveAuth(a); } throw new AuthNeeded('Token hết hạn (401)'); }
    if (res.status === 200) { ctl.abort(); throw new NoRange('Drive trả 200 (cả file) thay vì 206, không lấy riêng từng đoạn được'); }
    if (res.status !== 206) { ctl.abort(); throw new Error(`Drive trả ${res.status}`); }
    const buf = new Uint8Array(await res.arrayBuffer());
    return { buf, ms: Math.round(performance.now() - t0), headers: res.headers };
  }

  // ---------- Cache đoạn (Cache API) ----------
  const chunkKey = (id, i) => new Request(location.origin + '/__pdf/' + encodeURIComponent(id) + '/' + i);
  let cacheP = null;
  function chunkCache() {
    if (!cacheP) cacheP = (self.caches ? caches.open(CHUNK_CACHE) : Promise.reject(new Error('no cache'))).catch(() => null);
    return cacheP;
  }
  async function cacheGet(id, i) {
    const c = await chunkCache(); if (!c) return null;
    try { const r = await c.match(chunkKey(id, i)); return r ? new Uint8Array(await r.arrayBuffer()) : null; } catch (_) { return null; }
  }
  async function cachePut(id, i, buf) {
    const c = await chunkCache(); if (!c) return;
    try { await c.put(chunkKey(id, i), new Response(buf)); } catch (_) {}
  }

  // ---------- Tải trước từ điển trang ----------
  // Lúc mở file, pdf.js đi lần lượt qua từ điển của TỪNG trang (để kiểm tra trang cuối). Với PDF có cây trang phẳng,
  // từ điển trang nằm rải khắp file (cạnh ảnh scan của trang đó), nên mỗi trang thành 1 lần gọi mạng nối tiếp nhau:
  // sách 140 trang là 140 lần chờ. Ở đây tự đọc bảng xref (dạng bảng chữ thường) để biết vị trí từ điển mọi trang,
  // rồi tải trước các đoạn đó song song vào cache. pdf.js vẫn đi tuần tự nhưng lấy từ cache nên nhanh.
  // Bảng xref dạng nén (xref stream) thì bỏ qua: khi đó từ điển trang thường nằm gom trong object stream, ít lần gọi hơn.
  const latin1 = new TextDecoder('latin1');
  const txt = (u8) => latin1.decode(u8);
  async function prefetchPageDicts(bytes, size, getChunks) {
    const tail = txt(await bytes(Math.max(0, size - 4096), size));
    const sx = tail.lastIndexOf('startxref');
    if (sx < 0) return { note: 'không thấy startxref, không tải trước' };
    let pos = parseInt(tail.slice(sx + 9).trim(), 10);
    if (!Number.isInteger(pos) || pos < 0 || pos >= size) return { note: 'startxref lỗi, không tải trước' };
    const offsets = new Map();
    let root = null, hops = 0;
    while (pos != null && hops < 4) {
      hops++;
      const head = txt(await bytes(pos, pos + 32));
      if (!/^\s*xref/.test(head)) {
        if (hops === 1) return { note: 'bảng xref dạng nén (xref stream), không tải trước' };
        break;
      }
      let text = '', from = pos;
      while (!text.includes('trailer') && text.length < 4e6 && from < size) { text += txt(await bytes(from, from + 65536)); from += 65536; }
      const ti = text.indexOf('trailer');
      if (ti < 0) break;
      const t = text.slice(text.indexOf('xref') + 4, ti).trim().split(/\s+/);
      for (let i = 0; i + 1 < t.length;) {
        const start = parseInt(t[i], 10), count = parseInt(t[i + 1], 10);
        i += 2;
        if (!Number.isInteger(start) || !Number.isInteger(count)) break;
        for (let k = 0; k < count && i + 2 < t.length + 1; k++, i += 3) {
          if (t[i + 2] === 'n' && !offsets.has(start + k)) offsets.set(start + k, parseInt(t[i], 10));   // bảng mới hơn đọc trước, giữ bản mới
        }
      }
      const trailer = text.slice(ti, ti + 2000);
      const r = /\/Root\s+(\d+)\s+\d+\s+R/.exec(trailer);
      if (r && root == null) root = Number(r[1]);
      const prev = /\/Prev\s+(\d+)/.exec(trailer);
      pos = prev ? Number(prev[1]) : null;
    }
    if (root == null || !offsets.has(root)) return { note: 'không đọc được /Root, không tải trước' };
    const obj = async (num, len) => (offsets.has(num) ? txt(await bytes(offsets.get(num), offsets.get(num) + len)) : null);
    const pagesRef = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(await obj(root, 2048) || '');
    if (!pagesRef) return { note: 'không thấy /Pages, không tải trước' };
    let ptxt = await obj(Number(pagesRef[1]), 8192) || '';
    if (/\/Kids\s*\[[^\]]*$/.test(ptxt)) ptxt = await obj(Number(pagesRef[1]), 262144) || '';
    const km = /\/Kids\s*\[([^\]]*)\]/.exec(ptxt);
    if (!km) return { note: 'không đọc được /Kids, không tải trước' };
    const kids = [...km[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
    if (kids.length < 8) return { note: `cây trang có nhánh (${kids.length} nhánh ở gốc), pdf.js đi nhanh, không cần tải trước` };
    const idx = new Set();
    for (const k of kids) {
      const off = offsets.get(k);
      if (off == null) continue;
      idx.add(Math.floor(off / CHUNK)); idx.add(Math.floor(Math.min(size - 1, off + 600) / CHUNK));   // từ điển có thể vắt qua 2 đoạn
    }
    const list = [...idx].sort((a, b) => a - b);
    const runs = [];
    for (const i of list) { const last = runs[runs.length - 1]; if (last && last[1] === i - 1) last[1] = i; else runs.push([i, i]); }
    let k = 0;
    const worker = async () => { while (k < runs.length) { const [a, b] = runs[k++]; await getChunks(a, b); } };
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 6 }, worker));
    return { note: `tải trước từ điển ${kids.length} trang: ${list.length} đoạn ${CHUNK / 1024} KB, ${runs.length} lần gọi song song, ${Math.round(performance.now() - t0)} ms`, kids: kids.length, chunks: list.length };
  }

  // ---------- Mở tài liệu ----------
  // file: {id, name, size}. hooks: {onStats(stats), onAuthNeeded(retry), onError(msg, retry)}
  async function openDocument(file, hooks = {}) {
    const lib = await loadPdfjs();
    let size = Number(file.size) || 0;
    if (!size) {
      const meta = await driveGet('files/' + encodeURIComponent(file.id), { fields: 'size' });
      size = Number(meta.size);
    }
    const stats = { size, net: 0, cache: 0, requests: 0, mode: 'range', firstMs: null, chunks: Math.ceil(size / CHUNK) };
    const emit = () => hooks.onStats && hooks.onStats(stats);
    const nChunks = stats.chunks;

    // Lấy các đoạn [from, to] (chỉ số đoạn): cache trước, đoạn đang tải dở thì chờ chung, phần thiếu gộp thành dải liền
    // rồi xin mạng song song. Trả về Map chỉ số đoạn -> byte.
    const inflight = new Map();
    async function getChunks(from, to) {
      const idx = [];
      for (let i = from; i <= to; i++) idx.push(i);
      const cached = await Promise.all(idx.map((i) => (inflight.has(i) ? null : cacheGet(file.id, i))));
      const out = new Map();
      const missing = [];
      idx.forEach((i, k) => {
        if (cached[k]) { out.set(i, cached[k]); stats.cache += cached[k].length; }
        else if (!inflight.has(i)) missing.push(i);
      });
      const runs = [];
      for (const i of missing) {
        const last = runs[runs.length - 1];
        if (last && last[1] === i - 1) last[1] = i; else runs.push([i, i]);
      }
      for (const [a, b] of runs) {
        const begin = a * CHUNK, end = Math.min(size, (b + 1) * CHUNK);
        const p = fetchRange(file.id, begin, end).then((r) => {
          stats.requests++; stats.net += r.buf.length;
          if (r.buf.length !== end - begin) throw new Error(`Drive trả ${r.buf.length} byte, cần ${end - begin}`);
          const m = new Map();
          for (let i = a; i <= b; i++) {
            const piece = r.buf.slice((i - a) * CHUNK, Math.min(r.buf.length, (i - a + 1) * CHUNK));
            m.set(i, piece); cachePut(file.id, i, piece.slice());   // bản sao riêng: pdf.js có thể chuyển (transfer) mảng gốc sang worker
          }
          return m;
        });
        for (let i = a; i <= b; i++) {
          const d = p.then((m) => m.get(i));
          d.catch(() => {});   // tránh báo lỗi "promise không ai bắt"; ai chờ đoạn này vẫn nhận lỗi
          inflight.set(i, d);
        }
        p.catch(() => {}).finally(() => { for (let i = a; i <= b; i++) inflight.delete(i); });
      }
      for (const i of idx) if (!out.has(i)) out.set(i, await inflight.get(i));
      emit();
      return out;
    }
    async function bytes(begin, end) {   // byte [begin, end) bất kỳ, qua getChunks
      end = Math.min(end, size);
      const a = Math.floor(begin / CHUNK), b = Math.floor((end - 1) / CHUNK);
      const m = await getChunks(a, b);
      const all = new Uint8Array((b - a + 1) * CHUNK); let o = 0;
      for (let i = a; i <= b; i++) { all.set(m.get(i), o); o += m.get(i).length; }
      return all.subarray(begin - a * CHUNK, end - a * CHUNK);
    }

    // Đoạn đầu: vừa làm dữ liệu khởi đầu cho pdf.js, vừa là phép thử Range.
    const t0 = performance.now();
    let first;
    try {
      first = (await getChunks(0, 0)).get(0);
    } catch (e) {
      if (e instanceof NoRange) return openFull(lib, file, size, stats, hooks, e);
      throw e;
    }
    stats.firstMs = Math.round(performance.now() - t0);

    // Tải trước song song từ điển của mọi trang (xem prefetchPageDicts). Lỗi thì bỏ qua, pdf.js vẫn tự tải tuần tự.
    try {
      const pf = await prefetchPageDicts(bytes, size, getChunks);
      stats.prefetch = pf;
      log(`PDF ${file.name}: ${pf.note}`);
    } catch (e) { if (e instanceof AuthNeeded) throw e; stats.prefetch = { note: 'không tải trước được: ' + e.message }; }
    stats.openMs = Math.round(performance.now() - t0);

    const pending = [];   // dải chờ gửi lại sau khi gia hạn token
    class DriveRangeTransport extends lib.PDFDataRangeTransport {
      requestDataRange(begin, end) {
        const from = Math.floor(begin / CHUNK), to = Math.min(nChunks - 1, Math.ceil(end / CHUNK) - 1);
        // pdf.js ghép dữ liệu trả về với yêu cầu theo đúng `begin`, nên phải trả một khối liền cho cả yêu cầu.
        const run = (attempt) => getChunks(from, to).then((m) => {
          const parts = []; let len = 0;
          for (let i = from; i <= to; i++) { parts.push(m.get(i)); len += m.get(i).length; }
          const all = new Uint8Array(len); let o = 0;
          for (const q of parts) { all.set(q, o); o += q.length; }
          const off = from * CHUNK;
          this.onDataRange(begin, all.subarray(begin - off, Math.min(end, size) - off));
        }).catch((e) => {
          if (e instanceof AuthNeeded) {
            pending.push(() => run(0));
            if (pending.length === 1 && hooks.onAuthNeeded) hooks.onAuthNeeded(() => { const q = pending.splice(0); q.forEach((f) => f()); });
          } else if (attempt < 2) setTimeout(() => run(attempt + 1), 800 * (attempt + 1));
          else if (hooks.onError) hooks.onError('Không tải được đoạn PDF: ' + e.message, () => run(0));
        });
        run(0);
      }
    }
    const transport = new DriveRangeTransport(size, first);
    const task = lib.getDocument({
      range: transport, rangeChunkSize: CHUNK, disableAutoFetch: true, disableStream: true,
      cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: PDFJS_DIR + 'standard_fonts/',
      isEvalSupported: false,
    });
    const doc = await task.promise;
    emit();
    return { doc, stats, close: () => task.destroy() };
  }

  // Phương án dự phòng khi Drive không trả từng đoạn: tải cả file một lần, lưu cache trong máy.
  async function openFull(lib, file, size, stats, hooks, why) {
    stats.mode = 'full';
    log(`PDF ${file.name}: ${why.message}. Chuyển sang tải cả file (${mb(size)}).`);
    let buf = null;
    try { const c = await caches.open(FULL_CACHE); const r = await c.match(chunkKey(file.id, 'full')); if (r) { buf = new Uint8Array(await r.arrayBuffer()); stats.cache = buf.length; } } catch (_) {}
    if (!buf) {
      if (hooks.confirmFull && !(await hooks.confirmFull(size))) throw new Error('Đã hủy tải cả file');
      const t = token();
      const res = await fetch(mediaUrl(file.id), { headers: { Authorization: 'Bearer ' + t } });
      if (res.status === 401) throw new AuthNeeded('Token hết hạn (401)');
      if (!res.ok) throw new Error(`Drive trả ${res.status}`);
      const reader = res.body.getReader();
      buf = new Uint8Array(size || Number(res.headers.get('Content-Length')) || 0);
      let got = 0, parts = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (got + value.length > buf.length) { parts = parts || [buf.slice(0, got)]; parts.push(value); }
        else buf.set(value, got);
        got += value.length; stats.net = got; stats.requests = 1;
        hooks.onStats && hooks.onStats(stats);
      }
      if (parts) { buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; } }
      else buf = buf.slice(0, got);
      try { const c = await caches.open(FULL_CACHE); await c.put(chunkKey(file.id, 'full'), new Response(buf)); } catch (_) {}
    }
    const task = lib.getDocument({ data: buf, cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: PDFJS_DIR + 'standard_fonts/', isEvalSupported: false });
    const doc = await task.promise;
    hooks.onStats && hooks.onStats(stats);
    return { doc, stats, close: () => task.destroy() };
  }

  // ---------- Thử Range (bước 1 của mốc 3) ----------
  // Xin 64 KB đầu và 64 KB cuối, báo mã trả về, số byte, thời gian, header nào trình duyệt đọc được.
  async function probe(file) {
    const size = Number(file.size);
    const lines = [`Thử Range: ${file.name} (${mb(size)})`];
    const H = ['content-range', 'content-length', 'accept-ranges', 'content-type'];
    for (const [label, begin, end] of [['đầu', 0, 65536], ['cuối', Math.max(0, size - 65536), size]]) {
      const t0 = performance.now();
      const ctl = new AbortController();
      try {
        const res = await fetch(mediaUrl(file.id), {
          headers: { Authorization: 'Bearer ' + token(), Range: `bytes=${begin}-${end - 1}` }, signal: ctl.signal, cache: 'no-store',
        });
        const hdr = H.map((h) => `${h}: ${res.headers.get(h) ?? '(không đọc được)'}`).join('; ');
        if (res.status !== 206) {
          ctl.abort();
          lines.push(`Đoạn ${label}: mã ${res.status} sau ${Math.round(performance.now() - t0)} ms, đã dừng tải. ${hdr}`);
          continue;
        }
        const n = (await res.arrayBuffer()).byteLength;
        lines.push(`Đoạn ${label}: mã 206, nhận ${n} byte (xin ${end - begin}), ${Math.round(performance.now() - t0)} ms. ${hdr}`);
      } catch (e) {
        lines.push(`Đoạn ${label}: lỗi ${e.name}: ${e.message} sau ${Math.round(performance.now() - t0)} ms`);
      }
    }
    lines.forEach((l) => log(l));
    return lines;
  }

  async function cacheInfo() {
    let chunks = 0, full = 0, est = null;
    try { chunks = (await (await caches.open(CHUNK_CACHE)).keys()).length; } catch (_) {}
    try { full = (await (await caches.open(FULL_CACHE)).keys()).length; } catch (_) {}
    try { est = await navigator.storage.estimate(); } catch (_) {}
    return { chunks, chunkMB: chunks * CHUNK / 1e6, full, usage: est && est.usage, quota: est && est.quota };
  }
  async function clearCache() {
    try { await caches.delete(CHUNK_CACHE); } catch (_) {}
    try { await caches.delete(FULL_CACHE); } catch (_) {}
    cacheP = null;
  }

  window.PdfSource = { openDocument, probe, loadPdfjs, cacheInfo, clearCache, AuthNeeded, CHUNK, mb };
})();
