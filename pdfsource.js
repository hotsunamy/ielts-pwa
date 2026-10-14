// Mốc 3: lấy PDF từ Drive của Minh theo từng đoạn byte (header Range), có cache đoạn trong máy.
// Bản m3-2: ghi lại từng lần gọi Drive; tự đọc cấu trúc PDF (pdfindex.js, kể cả xref nén) để tải trước song song
// những gì pdf.js sẽ cần, thay vì để pdf.js tự hỏi từng chỗ một, mỗi chỗ một lần chờ mạng.
// Không có nội dung Cambridge nào trong code. File chỉ đọc từ Drive của người đăng nhập.
'use strict';
(function () {
  const DRIVE = 'https://www.googleapis.com/drive/v3/';
  const PDFJS_DIR = 'vendor/pdfjs-4.10.38/';
  // Bảng mã chữ Trung/Nhật/Hàn (cmaps, 169 file) chỉ cần khi PDF dùng phông CJK không nhúng, hiếm gặp. Lấy từ CDN khi cần
  // để repo ít file (giao diện tải lên của GitHub giới hạn số file mỗi lần).
  const CMAP_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/';
  const CHUNK = 16 * 1024;   // cỡ đoạn: nhỏ để object rải rác tốn ít byte; đoạn liền nhau (ảnh scan) vẫn gộp 1 lần gọi
  const CHUNK_CACHE = 'ielts-pdf-chunks-16k-v1';
  const FULL_CACHE = 'ielts-pdf-full-v1';
  const TAIL_CHUNKS = 4;          // 64 KB cuối file: startxref và (thường) cả bảng xref
  const EARLY_CAP = 4e6;          // đợt tải thứ 2 (object stream + object nhỏ) tối đa 4 MB
  // Số lần gọi song song khi tải trước. Drive chạy HTTP/2 (nhiều yêu cầu chung một kết nối). PDF xref dạng bảng có từ điển
  // trang rải khắp file (147 trang = khoảng 150 chỗ), 6 luồng thì thành 25 đợt chờ nối tiếp (đo giả lập: 70 s), gọi gần như cùng lúc thì còn 1–2 đợt (Chrome tự xếp hàng nếu Drive giới hạn số yêu cầu đồng thời, thường 100).
  const LANES = 128;
  const GAP = 2;                  // hai dải cách nhau tới 2 đoạn (32 KB) thì gộp chung một lần gọi
  const MEM_CAP = 48e6;           // giữ tối đa chừng này byte đoạn trong bộ nhớ (ngoài Cache API) để đọc lại nhanh

  class AuthNeeded extends Error {}
  class NoRange extends Error {}

  const mediaUrl = (id) => DRIVE + 'files/' + encodeURIComponent(id) + '?alt=media';
  const token = () => { const a = loadAuth(); return a && a.token; };
  const mb = (n) => (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + ' MB';
  const kb = (n) => (n / 1024).toFixed(n < 10240 ? 1 : 0);

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
  // rec (nếu có) nhận thời điểm có header và lúc xong, để ghi nhật ký từng lần gọi.
  async function fetchRange(id, begin, end, rec) {
    const t = token();
    if (!t) throw new AuthNeeded('Chưa đăng nhập');
    const ctl = new AbortController();
    const t0 = performance.now();
    const res = await fetch(mediaUrl(id), {
      headers: { Authorization: 'Bearer ' + t, Range: `bytes=${begin}-${end - 1}` },
      signal: ctl.signal, cache: 'no-store',
    });
    if (rec) { rec.hdr = performance.now(); rec.status = res.status; }
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

  // ---------- Nhật ký từng lần gọi Drive ----------
  // Mỗi lần gọi: lý do, offset, KB, bắt đầu / có header / xong (ms tính từ lúc bấm mở), song song với lần gọi nào không.
  // "Đợt" = nhóm các lần gọi chồng lên nhau về thời gian; số đợt là số lần phải chờ mạng nối tiếp.
  function callTable(calls, title) {
    if (!calls.length) return [`${title}: không gọi Drive lần nào (lấy hết từ cache).`];
    const sorted = [...calls].sort((a, b) => a.start - b.start);
    let wave = 0, waveEnd = -1;
    for (const c of sorted) {
      const end = c.end ?? c.start;
      if (c.start >= waveEnd) wave++;
      c.wave = wave; waveEnd = Math.max(waveEnd, end);
      c.par = sorted.filter((o) => o !== c && o.start < end && (o.end ?? o.start) > c.start).length;
    }
    const bytes = calls.reduce((s, c) => s + (c.len || 0), 0);
    const span = Math.max(...sorted.map((c) => c.end ?? c.start)) - sorted[0].start;
    const waits = sorted.filter((c) => c.hdr != null).map((c) => c.hdr - c.start);
    const avgWait = waits.length ? Math.round(waits.reduce((s, x) => s + x, 0) / waits.length) : 0;
    const lines = [`${title}: ${calls.length} lần gọi Drive, ${kb(bytes)} KB, ${wave} đợt nối tiếp, chờ header trung bình ${avgWait} ms.`,
      '  #  đợt  lý do                 offset      KB   bắt đầu  có header  xong     ms   song song'];
    const MAX = 40;
    for (const [k, c] of sorted.entries()) {
      if (k === MAX) { lines.push(`  … còn ${sorted.length - MAX} lần gọi nữa`); break; }
      const ms = c.end != null ? Math.round(c.end - c.start) : '-';
      lines.push(`  ${String(k + 1).padStart(2)} ${String(c.wave).padStart(3)}  ${c.why.padEnd(20).slice(0, 20)} ${String(c.off).padStart(10)} ${kb(c.len).padStart(6)} ${String(Math.round(c.start)).padStart(8)} ${c.hdr != null ? String(Math.round(c.hdr)).padStart(9) : '        -'} ${c.end != null ? String(Math.round(c.end)).padStart(6) : '     -'} ${String(ms).padStart(6)}   ${c.par ? 'có (' + c.par + ')' : 'nối tiếp'}${c.status && c.status !== 206 ? ' mã ' + c.status : ''}${c.err ? ' lỗi: ' + c.err : ''}`);
    }
    lines.push(`  (khoảng thời gian từ lần gọi đầu tới lần cuối xong: ${Math.round(span)} ms)`);
    return lines;
  }

  // ---------- Mở tài liệu ----------
  // file: {id, name, size}. hooks: {onStats(stats), onAuthNeeded(retry), onError(msg, retry), confirmFull(size), startPage}
  async function openDocument(file, hooks = {}) {
    const T0 = performance.now();
    const libP = loadPdfjs();   // tải thư viện song song với lần gọi mạng đầu
    libP.catch(() => {});
    let size = Number(file.size) || 0;
    if (!size) {
      const meta = await driveGet('files/' + encodeURIComponent(file.id), { fields: 'size' });
      size = Number(meta.size);
    }
    const stats = { size, net: 0, cache: 0, requests: 0, mode: 'range', firstMs: null, chunks: Math.ceil(size / CHUNK) };
    const emit = () => hooks.onStats && hooks.onStats(stats);
    const nChunks = stats.chunks;
    const calls = [];          // mọi lần gọi Drive của tài liệu này
    let reported = 0;          // số lần gọi đã ghi vào nhật ký
    let closed = false;
    const mem = new Map();     // đoạn đã có trong bộ nhớ
    let memBytes = 0;
    const remember = (i, piece) => {
      if (mem.has(i)) return;
      if (memBytes + piece.length > MEM_CAP) { mem.clear(); memBytes = 0; }
      mem.set(i, piece); memBytes += piece.length;
    };

    // Lấy các đoạn [from, to] (chỉ số đoạn): bộ nhớ, rồi cache, đoạn đang tải dở thì chờ chung, phần thiếu gộp thành
    // dải liền rồi xin mạng song song. Trả về Map chỉ số đoạn -> byte. why = lý do, để ghi nhật ký.
    const inflight = new Map();
    async function getChunks(from, to, why) {
      const idx = [];
      for (let i = from; i <= to; i++) idx.push(i);
      const out = new Map();
      const look = [];
      for (const i of idx) { if (mem.has(i)) { out.set(i, mem.get(i)); stats.cache += mem.get(i).length; } else if (!inflight.has(i)) look.push(i); }
      const cached = await Promise.all(look.map((i) => cacheGet(file.id, i)));
      const missing = [];
      look.forEach((i, k) => {
        if (cached[k]) { out.set(i, cached[k]); remember(i, cached[k]); stats.cache += cached[k].length; }
        else if (!inflight.has(i)) missing.push(i);
      });
      const runs = [];
      for (const i of missing) {
        const last = runs[runs.length - 1];
        if (last && last[1] === i - 1) last[1] = i; else runs.push([i, i]);
      }
      for (const [a, b] of runs) {
        const begin = a * CHUNK, end = Math.min(size, (b + 1) * CHUNK);
        const rec = { why: why || '?', off: begin, len: end - begin, start: performance.now() - T0 };
        calls.push(rec);
        const tm = {};
        const p = fetchRange(file.id, begin, end, tm).then((r) => {
          rec.end = performance.now() - T0;
          rec.hdr = tm.hdr - T0; rec.status = tm.status;
          stats.requests++; stats.net += r.buf.length;
          if (r.buf.length !== end - begin) throw new Error(`Drive trả ${r.buf.length} byte, cần ${end - begin}`);
          const m = new Map();
          for (let i = a; i <= b; i++) {
            const piece = r.buf.slice((i - a) * CHUNK, Math.min(r.buf.length, (i - a + 1) * CHUNK));
            m.set(i, piece); remember(i, piece);
            cachePut(file.id, i, piece.slice());   // bản sao riêng: Cache API giữ bản của nó
          }
          return m;
        }, (e) => { rec.end = performance.now() - T0; if (tm.hdr) { rec.hdr = tm.hdr - T0; rec.status = tm.status; } rec.err = e.constructor.name === 'AuthNeeded' ? '401' : e.message.slice(0, 40); throw e; });
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
    async function bytes(begin, end, why) {   // byte [begin, end) bất kỳ, qua getChunks
      end = Math.min(end, size);
      const a = Math.floor(begin / CHUNK), b = Math.floor((end - 1) / CHUNK);
      const m = await getChunks(a, b, why);
      const all = new Uint8Array((b - a + 1) * CHUNK); let o = 0;
      for (let i = a; i <= b; i++) { all.set(m.get(i), o); o += m.get(i).length; }
      return all.subarray(begin - a * CHUNK, end - a * CHUNK);
    }
    // Tải trước một loạt đoạn byte [begin, end): gộp theo đoạn 16 KB, bỏ đoạn đã có, chia dải liền cho LANES luồng song song.
    async function prefetchRanges(ranges, why) {
      const want = new Set();
      for (const [b0, e0] of ranges) {
        const e = Math.min(e0, size);
        if (e <= b0) continue;
        for (let i = Math.floor(b0 / CHUNK); i <= Math.floor((e - 1) / CHUNK); i++) if (!mem.has(i)) want.add(i);
      }
      if (!want.size) return;
      const list = [...want].sort((a, b) => a - b);
      const runs = [];
      for (const i of list) { const last = runs[runs.length - 1]; if (last && i - last[1] <= GAP + 1 && last[1] - last[0] < 255) last[1] = i; else runs.push([i, i]); }
      let k = 0;
      const lane = async () => { while (k < runs.length && !closed) { const [a, b] = runs[k++]; await getChunks(a, b, why); } };
      await Promise.all(Array.from({ length: Math.min(LANES, runs.length) }, lane));
    }

    // Đợt 1: đoạn đầu (dữ liệu khởi đầu cho pdf.js, cũng là phép thử Range) và đuôi file (startxref, bảng xref) cùng lúc.
    let first;
    try {
      const tailFrom = Math.max(1, nChunks - TAIL_CHUNKS);
      const [h] = await Promise.all([getChunks(0, 0, 'đầu file'), nChunks > 1 ? getChunks(tailFrom, nChunks - 1, 'đuôi file') : null]);
      first = h.get(0);
    } catch (e) {
      if (e instanceof NoRange) return openFull(libP, file, size, stats, hooks, e);
      throw e;
    }
    stats.firstMs = Math.round(performance.now() - T0);

    // Đọc cấu trúc, tải trước object stream / object nhỏ (đợt 2), đi cây trang, rồi tải trước trang đầu tiên sẽ xem (đợt 3,
    // chạy song song với lúc pdf.js mở tài liệu). Lỗi ở đây thì bỏ qua: pdf.js vẫn tự tải, chỉ chậm hơn (như m3-1).
    let index = null, warm = null;
    const pf = { notes: [] };
    stats.prefetch = pf;
    try {
      index = PdfIndex.create({ size, read: (a, b) => bytes(a, b, 'đọc cấu trúc'), prefetch: (rs, why) => prefetchRanges(rs, why || 'tải trước') });
      const info = await index.load();
      pf.notes.push(`xref ${info.kind}, ${info.sections} phần, ${info.objects} object, ${info.objStms} object stream`);
      const early = index.earlyRanges(EARLY_CAP, CHUNK);
      await prefetchRanges(early.ranges, 'object stream/nhỏ');
      pf.notes.push('đợt 2: ' + early.note);
      const pg = await index.pages('cây trang');
      pf.pages = pg.list.length;
      const start = Math.min(pg.list.length, Math.max(1, hooks.startPage || 1));
      warm = index.prefetchPages([start], 'trang ' + start, () => closed);
      warm.catch(() => {});
    } catch (e) {
      if (e instanceof AuthNeeded) throw e;
      index = null;
      pf.notes.push('không đọc được cấu trúc, để pdf.js tự tải: ' + e.message);
    }
    stats.openMs = Math.round(performance.now() - T0);
    log(`PDF ${file.name}: ${pf.notes.join('; ')}. Đọc cấu trúc xong sau ${stats.openMs} ms.`);

    const lib = await libP;
    const pending = [];   // dải chờ gửi lại sau khi gia hạn token
    class DriveRangeTransport extends lib.PDFDataRangeTransport {
      requestDataRange(begin, end) {
        const from = Math.floor(begin / CHUNK), to = Math.min(nChunks - 1, Math.ceil(end / CHUNK) - 1);
        // pdf.js ghép dữ liệu trả về với yêu cầu theo đúng `begin`, nên phải trả một khối liền cho cả yêu cầu.
        const run = (attempt) => getChunks(from, to, 'pdf.js').then((m) => {
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
    // Bản sao: pdf.js có thể chuyển (transfer) mảng dữ liệu khởi đầu sang worker, mảng trong bộ nhớ phải còn nguyên.
    const transport = new DriveRangeTransport(size, first.slice());
    const worker = new lib.PDFWorker();
    const task = lib.getDocument({
      worker, range: transport, rangeChunkSize: CHUNK, disableAutoFetch: true, disableStream: true,
      cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: PDFJS_DIR + 'standard_fonts/',
      isEvalSupported: false,
    });
    const doc = await task.promise;
    stats.docMs = Math.round(performance.now() - T0);
    emit();

    // Ghi bảng các lần gọi chưa ghi (gọi khi vừa thấy trang đầu, hoặc khi tải nền xong).
    function report(title) {
      const fresh = calls.slice(reported);
      reported = calls.length;
      callTable(fresh, `${title} (${file.name}; mốc thời gian tính bằng ms từ lúc bắt đầu mở)`).forEach((l) => log(l));
    }
    // Tải nền dữ liệu các trang `nums` (số trang PDF). Không chặn việc xem; dừng khi đóng tài liệu.
    async function prefetchPages(nums, why) {
      const t0 = performance.now(), n0 = stats.net, c0 = calls.length;
      let note;
      if (index) {
        const r = await index.prefetchPages(nums, why, () => closed);
        note = `${r.waves} đợt, ${r.objects} object`;
      } else {
        // Không đọc được cấu trúc: nhờ pdf.js tải lần lượt từng trang (chậm hơn nhưng vẫn chạy).
        for (const p of nums) { if (closed) break; try { const pg = await doc.getPage(p); await pg.getOperatorList(); pg.cleanup(); } catch (_) {} }
        note = 'qua pdf.js, lần lượt';
      }
      if (closed) return null;
      const res = { pages: nums.length, net: stats.net - n0, calls: calls.length - c0, ms: Math.round(performance.now() - t0), note };
      log(`PDF ${file.name}: ${why}: ${nums.length} trang, tải ${mb(res.net)} qua ${res.calls} lần gọi, ${res.ms} ms (${note}).`);
      return res;
    }
    return {
      doc, stats, report, prefetchPages, calls, warm,
      close: () => { closed = true; return shutdown(task, worker); },
    };
  }

  // Đóng tài liệu. pdf.js chờ worker làm xong việc dở (vd đang chờ dữ liệu trang kế tiếp) mới đóng, có lúc chờ mãi
  // (thấy khi giả lập Drive trễ 2,5 s: đóng trình xem ngay sau khi mở thì treo). Chờ tối đa 0,5 giây rồi tắt hẳn worker.
  async function shutdown(task, worker) {
    await Promise.race([task.destroy().catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
    try { worker.destroy(); } catch (_) {}
  }

  // Phương án dự phòng khi Drive không trả từng đoạn: tải cả file một lần, lưu cache trong máy.
  async function openFull(libP, file, size, stats, hooks, why) {
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
    const lib = await libP;
    const worker = new lib.PDFWorker();
    const task = lib.getDocument({ worker, data: buf, cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: PDFJS_DIR + 'standard_fonts/', isEvalSupported: false });
    const doc = await task.promise;
    hooks.onStats && hooks.onStats(stats);
    return {
      doc, stats, calls: [], report: () => {},
      prefetchPages: async () => null,   // cả file đã nằm trong máy
      close: () => shutdown(task, worker),
    };
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
        const tH = Math.round(performance.now() - t0);
        const hdr = H.map((h) => `${h}: ${res.headers.get(h) ?? '(không đọc được)'}`).join('; ');
        if (res.status !== 206) {
          ctl.abort();
          lines.push(`Đoạn ${label}: mã ${res.status} sau ${tH} ms, đã dừng tải. ${hdr}`);
          continue;
        }
        const n = (await res.arrayBuffer()).byteLength;
        lines.push(`Đoạn ${label}: mã 206, nhận ${n} byte (xin ${end - begin}), có header sau ${tH} ms, xong ${Math.round(performance.now() - t0)} ms. ${hdr}`);
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

  window.PdfSource = { openDocument, probe, loadPdfjs, cacheInfo, clearCache, AuthNeeded, CHUNK, mb, callTable };
})();
