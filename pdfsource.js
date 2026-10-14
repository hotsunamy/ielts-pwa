// Mốc 3: lấy PDF từ Drive của Minh theo từng đoạn byte (header Range), có cache đoạn trong máy.
// Bản m3-4: tự thử lại khi Drive lỗi tạm thời (5xx/429); dòng Mốc tách chờ Drive / vẽ, ghi chờ token; bỏ qua lần ẩn tab < 50 ms.
// Bản m3-3: đuôi file 256 KB, nhật ký tóm tắt theo đợt + thời gian vẽ trang đầu + tab bị ẩn, nút "Chuẩn bị quyển này".
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
  // 256 KB cuối file: startxref và các phần xref. m3-2 lấy 64 KB; Cam 15 thật có phần xref thứ hai (theo /Prev) nằm ngay
  // trước 64 KB cuối nên tốn thêm 1 lần chờ (khoảng 2 s). 256 KB lấy luôn phần đó trong đợt 1.
  const TAIL_CHUNKS = 16;
  const EARLY_CAP = 4e6;          // đợt tải thứ 2 (object stream + object nhỏ) tối đa 4 MB
  // Số lần gọi song song khi tải trước. Drive chạy HTTP/2 (nhiều yêu cầu chung một kết nối). PDF xref dạng bảng có từ điển
  // trang rải khắp file (147 trang = khoảng 150 chỗ), 6 luồng thì thành 25 đợt chờ nối tiếp (đo giả lập: 70 s), gọi gần như cùng lúc thì còn 1–2 đợt (Chrome tự xếp hàng nếu Drive giới hạn số yêu cầu đồng thời, thường 100).
  // m3-3: 256 (m3-2: 128). Cam 15 thật cần khoảng 146 lần gọi object nhỏ; với 128 luồng, 18 lần gọi còn lại phải chờ vòng sau,
  // thêm một lần chờ Drive (2–4 s; thấy trong nhật ký Edge 14/10: đợt 3 xong rải tới giây 14). Đợt 2 tối đa EARLY_CAP = 4 MB
  // = 244 đoạn 16 KB, nên 256 luồng luôn gửi hết trong một lượt; nếu Drive/trình duyệt giới hạn, trình duyệt tự xếp hàng.
  const LANES = 256;
  const GAP = 2;                  // hai dải cách nhau tới 2 đoạn (32 KB) thì gộp chung một lần gọi
  const MEM_CAP = 48e6;           // giữ tối đa chừng này byte đoạn trong bộ nhớ (ngoài Cache API) để đọc lại nhanh
  const HIDE_MIN = 50;            // m3-4: lần tab/app bị ẩn ngắn hơn chừng này ms thì không tính (hộp hỏi iOS)

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
  // m3-4: Drive lỗi tạm thời (500/502/503/504, 429 quá nhiều yêu cầu) thì tự thử lại tối đa 3 lần, chờ khoảng 0,5 / 1 / 2 s
  // (±20% để các lần gọi cùng lúc không thử lại dồn một lượt). Nhật ký iPhone 14/10: "Chuẩn bị 12.pdf lỗi: Drive trả 500" làm hỏng
  // cả lượt khoảng 145 lần gọi. 401 (token hết hạn) và 200 (Drive không cho lấy từng đoạn) vẫn xử lý như cũ, không thử lại.
  // rec.retries = số lần đã thử lại, rec.codes = các mã lỗi đã gặp (để ghi nhật ký).
  const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
  const RETRY_WAIT = [500, 1000, 2000];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function fetchRange(id, begin, end, rec) {
    const t0 = performance.now();
    for (let k = 0; ; k++) {
      const t = token();
      if (!t) throw new AuthNeeded('Chưa đăng nhập');
      const ctl = new AbortController();
      const res = await fetch(mediaUrl(id), {
        headers: { Authorization: 'Bearer ' + t, Range: `bytes=${begin}-${end - 1}` },
        signal: ctl.signal, cache: 'no-store',
      });
      if (rec) { rec.hdr = performance.now(); rec.status = res.status; }
      if (res.status === 401) { ctl.abort(); const a = loadAuth(); if (a) { a.expiresAt = 0; saveAuth(a); } throw new AuthNeeded('Token hết hạn (401)'); }
      if (res.status === 200) { ctl.abort(); throw new NoRange('Drive trả 200 (cả file) thay vì 206, không lấy riêng từng đoạn được'); }
      if (RETRY_STATUS.has(res.status) && k < RETRY_WAIT.length) {
        ctl.abort();
        if (rec) { rec.retries = k + 1; (rec.codes || (rec.codes = [])).push(res.status); }
        await sleep(RETRY_WAIT[k] * (0.8 + Math.random() * 0.4));
        continue;
      }
      if (res.status !== 206) { ctl.abort(); throw new Error(`Drive trả ${res.status}${k ? ` (đã thử lại ${k} lần)` : ''}`); }
      const buf = new Uint8Array(await res.arrayBuffer());
      return { buf, ms: Math.round(performance.now() - t0), headers: res.headers };
    }
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
  // m3-3: in bảng tóm tắt theo đợt trước, rồi bảng chi tiết chỉ 10 lần gọi đầu + 10 lần gọi chậm nhất.
  const SHOW_FIRST = 10, SHOW_SLOW = 10;
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
    const retried = calls.filter((c) => c.retries);
    const retryTxt = retried.length
      ? ` Drive lỗi tạm thời, đã tự thử lại: ${retried.length} lần gọi, tổng ${retried.reduce((s, c) => s + c.retries, 0)} lần thử lại (mã ${[...new Set(retried.flatMap((c) => c.codes || []))].join(', ')}).`
      : '';
    const lines = [`${title}: ${calls.length} lần gọi Drive, ${kb(bytes)} KB, ${wave} đợt nối tiếp, chờ header trung bình ${avgWait} ms.${retryTxt}`];
    // Tóm tắt theo đợt
    lines.push(' đợt  lần gọi      KB  bắt đầu    xong  chờ header nhỏ/tb/lớn (ms)  lý do');
    for (let w = 1; w <= wave; w++) {
      const g = sorted.filter((c) => c.wave === w);
      const ws = g.filter((c) => c.hdr != null).map((c) => Math.round(c.hdr - c.start));
      const why = new Map();
      for (const c of g) why.set(c.why, (why.get(c.why) || 0) + 1);
      const whyTxt = [...why].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
      const kbw = kb(g.reduce((s, c) => s + (c.len || 0), 0));
      const t0 = Math.round(Math.min(...g.map((c) => c.start)));
      const t1 = Math.round(Math.max(...g.map((c) => c.end ?? c.start)));
      const wt = ws.length ? `${Math.min(...ws)}/${Math.round(ws.reduce((s, x) => s + x, 0) / ws.length)}/${Math.max(...ws)}` : '-';
      const err = g.filter((c) => c.err || (c.status && c.status !== 206)).length;
      const rt = g.filter((c) => c.retries).length;
      lines.push(`${String(w).padStart(4)} ${String(g.length).padStart(8)} ${kbw.padStart(7)} ${String(t0).padStart(8)} ${String(t1).padStart(7)}  ${wt.padStart(26)}  ${whyTxt}${err ? ` (${err} lần lỗi)` : ''}${rt ? ` (${rt} lần phải thử lại)` : ''}`);
    }
    // Chi tiết: 10 lần gọi đầu + 10 lần gọi chậm nhất (theo thời gian từ bắt đầu tới xong)
    const dur = (c) => (c.end != null ? c.end - c.start : Infinity);
    const pick = new Set(sorted.slice(0, SHOW_FIRST));
    [...sorted].sort((a, b) => dur(b) - dur(a)).slice(0, SHOW_SLOW).forEach((c) => pick.add(c));
    sorted.filter((c) => c.retries || c.err).slice(0, SHOW_SLOW).forEach((c) => pick.add(c));   // m3-4: luôn hiện lần gọi phải thử lại hoặc lỗi
    lines.push(`  Chi tiết${sorted.length > pick.size ? ` (${SHOW_FIRST} lần gọi đầu + ${SHOW_SLOW} lần chậm nhất, bỏ ${sorted.length - pick.size} lần khác)` : ''}:`);
    lines.push('    #  đợt  lý do                 offset      KB   bắt đầu  có header  xong     ms   song song');
    let prev = -1;
    for (const [k, c] of sorted.entries()) {
      if (!pick.has(c)) continue;
      if (prev >= 0 && k !== prev + 1) lines.push('    …');
      prev = k;
      const ms = c.end != null ? Math.round(c.end - c.start) : '-';
      lines.push(`  ${String(k + 1).padStart(3)} ${String(c.wave).padStart(3)}  ${c.why.padEnd(20).slice(0, 20)} ${String(c.off).padStart(10)} ${kb(c.len).padStart(6)} ${String(Math.round(c.start)).padStart(8)} ${c.hdr != null ? String(Math.round(c.hdr)).padStart(9) : '        -'} ${c.end != null ? String(Math.round(c.end)).padStart(6) : '     -'} ${String(ms).padStart(6)}   ${c.par ? 'có (' + c.par + ')' : 'nối tiếp'}${c.status && c.status !== 206 ? ' mã ' + c.status : ''}${c.retries ? ` thử lại ${c.retries} (mã ${c.codes.join(',')})` : ''}${c.err ? ' lỗi: ' + c.err : ''}`);
    }
    lines.push(`  (khoảng thời gian từ lần gọi đầu tới lần cuối xong: ${Math.round(span)} ms)`);
    return lines;
  }

  // ---------- Tab / app bị ẩn (m3-3) ----------
  // Trình duyệt dừng hoặc làm chậm việc vẽ (requestAnimationFrame) khi tab bị ẩn hay app iPhone chuyển nền.
  // Ghi lại số lần và tổng thời gian bị ẩn trong lúc mở, để biết các khoảng chờ "không có lần gọi nào" là do đâu.
  function trackHidden(T0) {
    const t = { count: 0, ms: 0, periods: [], since: null };
    const now = () => performance.now() - T0;
    const isHidden = () => document.visibilityState === 'hidden';
    const on = () => {
      if (isHidden() && t.since == null) { t.since = now(); t.count++; }
      else if (!isHidden() && t.since != null) { const e = now(); t.periods.push([t.since, e]); t.ms += e - t.since; t.since = null; }
    };
    if (isHidden()) { t.since = 0; t.count = 1; }
    document.addEventListener('visibilitychange', on);
    t.stop = () => document.removeEventListener('visibilitychange', on);
    // m3-4: bỏ qua lần ẩn dưới HIDE_MIN ms (iPhone 14/10: hộp hỏi của iOS gây 1 lần "ẩn" 2 ms, không phải chuyển app thật).
    t.summary = (upTo) => {
      const all = t.periods.map((p) => p.slice()).concat(t.since != null ? [[t.since, upTo ?? now()]] : []);
      const ps = all.filter((p) => p[1] - p[0] >= HIDE_MIN);
      const skip = all.length - ps.length;
      const skipTxt = skip ? ` (bỏ qua ${skip} lần ẩn dưới ${HIDE_MIN} ms, thường do hộp hỏi)` : '';
      const total = ps.reduce((s, p) => s + p[1] - p[0], 0);
      if (!ps.length) return `Tab/app không bị ẩn trong lúc này.${skipTxt}`;
      return `Tab/app bị ẩn ${ps.length} lần, tổng ${Math.round(total)} ms (${ps.slice(0, 5).map((p) => `${Math.round(p[0])}–${Math.round(p[1])}`).join(', ')}${ps.length > 5 ? ', …' : ''} ms).${skipTxt}`;
    };
    return t;
  }

  // ---------- Khung tải đoạn dùng chung (mở tài liệu và nút "Chuẩn bị quyển này") ----------
  function makeLoader(file, size, T0) {
    const stats = { size, net: 0, cache: 0, requests: 0, mode: 'range', firstMs: null, chunks: Math.ceil(size / CHUNK) };
    const L = { stats, calls: [], closed: false, touched: new Set(), onStats: null };
    const nChunks = stats.chunks;
    const mem = new Map();     // đoạn đã có trong bộ nhớ
    let memBytes = 0;
    const remember = (i, piece) => {
      if (mem.has(i)) return;
      if (memBytes + piece.length > MEM_CAP) { mem.clear(); memBytes = 0; }
      mem.set(i, piece); memBytes += piece.length;
    };
    const emit = () => L.onStats && L.onStats(stats);

    // Lấy các đoạn [from, to] (chỉ số đoạn): bộ nhớ, rồi cache, đoạn đang tải dở thì chờ chung, phần thiếu gộp thành
    // dải liền rồi xin mạng song song. Trả về Map chỉ số đoạn -> byte. why = lý do, để ghi nhật ký.
    const inflight = new Map();
    async function getChunks(from, to, why) {
      const idx = [];
      for (let i = from; i <= to; i++) { idx.push(i); L.touched.add(i); }
      const out = new Map();
      const pend = new Map();   // chỉ số đoạn -> promise byte (đang tải, của lần gọi này hay lần gọi khác)
      const mine = new Map();   // đoạn do lần gọi này giữ chỗ: {res, rej}
      for (const i of idx) {
        if (mem.has(i)) { out.set(i, mem.get(i)); stats.cache += mem.get(i).length; continue; }
        if (!inflight.has(i)) {
          // Giữ chỗ NGAY (trước mọi await) để phần khác chạy cùng lúc (pdf.js, tìm trang đầu...) chờ chung, không xin trùng.
          let res, rej;
          const pr = new Promise((y, n) => { res = y; rej = n; });
          pr.catch(() => {});   // tránh báo lỗi "promise không ai bắt"; ai chờ đoạn này vẫn nhận lỗi
          inflight.set(i, pr); mine.set(i, { res, rej });
        }
        pend.set(i, inflight.get(i));
      }
      const look = [...mine.keys()];
      const cached = await Promise.all(look.map((i) => cacheGet(file.id, i)));
      const missing = [];
      look.forEach((i, k) => {
        if (cached[k]) { remember(i, cached[k]); stats.cache += cached[k].length; mine.get(i).res(cached[k]); inflight.delete(i); }
        else missing.push(i);
      });
      const runs = [];
      for (const i of missing) {
        const last = runs[runs.length - 1];
        if (last && last[1] === i - 1) last[1] = i; else runs.push([i, i]);
      }
      for (const [a, b] of runs) {
        const begin = a * CHUNK, end = Math.min(size, (b + 1) * CHUNK);
        const rec = { why: why || '?', off: begin, len: end - begin, start: performance.now() - T0 };
        L.calls.push(rec);
        const tm = {};
        fetchRange(file.id, begin, end, tm).then((r) => {
          rec.end = performance.now() - T0;
          rec.hdr = tm.hdr - T0; rec.status = tm.status;
          if (tm.retries) { rec.retries = tm.retries; rec.codes = tm.codes; }
          stats.requests++; stats.net += r.buf.length;
          if (r.buf.length !== end - begin) throw new Error(`Drive trả ${r.buf.length} byte, cần ${end - begin}`);
          for (let i = a; i <= b; i++) {
            const piece = r.buf.slice((i - a) * CHUNK, Math.min(r.buf.length, (i - a + 1) * CHUNK));
            remember(i, piece);
            cachePut(file.id, i, piece.slice());   // bản sao riêng: Cache API giữ bản của nó
            mine.get(i).res(piece);
          }
        }).catch((e) => {
          if (rec.end == null) { rec.end = performance.now() - T0; if (tm.hdr) { rec.hdr = tm.hdr - T0; rec.status = tm.status; } }
          if (tm.retries) { rec.retries = tm.retries; rec.codes = tm.codes; }
          rec.err = e.constructor.name === 'AuthNeeded' ? '401' : e.message.slice(0, 40);
          for (let i = a; i <= b; i++) mine.get(i).rej(e);
        }).finally(() => { for (let i = a; i <= b; i++) inflight.delete(i); });
      }
      for (const [i, pr] of pend) out.set(i, await pr);
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
    // Đoạn 16 KB cần cho một loạt dải byte [begin, end).
    function chunkSet(ranges) {
      const want = new Set();
      for (const [b0, e0] of ranges) {
        const e = Math.min(e0, size);
        if (e <= b0) continue;
        for (let i = Math.floor(b0 / CHUNK); i <= Math.floor((e - 1) / CHUNK); i++) want.add(i);
      }
      return want;
    }
    // Tải trước một loạt đoạn byte [begin, end): gộp theo đoạn 16 KB, bỏ đoạn đã có, chia dải liền cho LANES luồng song song.
    async function prefetchRanges(ranges, why) {
      const want = [...chunkSet(ranges)].filter((i) => !mem.has(i));
      if (!want.length) return;
      const list = want.sort((a, b) => a - b);
      const runs = [];
      for (const i of list) { const last = runs[runs.length - 1]; if (last && i - last[1] <= GAP + 1 && last[1] - last[0] < 255) last[1] = i; else runs.push([i, i]); }
      let k = 0;
      const lane = async () => { while (k < runs.length && !L.closed) { const [a, b] = runs[k++]; await getChunks(a, b, why); } };
      await Promise.all(Array.from({ length: Math.min(LANES, runs.length) }, lane));
    }
    // Đợt 1: đoạn đầu (dữ liệu khởi đầu cho pdf.js, cũng là phép thử Range) và đuôi file (startxref, các phần xref) cùng lúc.
    async function wave1() {
      const tailFrom = Math.max(1, nChunks - TAIL_CHUNKS);
      const [h] = await Promise.all([getChunks(0, 0, 'đầu file'), nChunks > 1 ? getChunks(tailFrom, nChunks - 1, 'đuôi file') : null]);
      stats.firstMs = Math.round(performance.now() - T0);
      return h.get(0);
    }
    Object.assign(L, { getChunks, bytes, prefetchRanges, chunkSet, wave1, mem, nChunks });
    return L;
  }
  const makeIndex = (L) => PdfIndex.create({ size: L.stats.size, read: (a, b) => L.bytes(a, b, 'đọc cấu trúc'), prefetch: (rs, why) => L.prefetchRanges(rs, why || 'tải trước') });

  // ---------- Ghi nhớ "đã chuẩn bị" (m3-3) ----------
  // Danh sách đoạn 16 KB của phần cấu trúc (đầu, đuôi, xref, object stream/object nhỏ, cây trang) theo từng file.
  // "Đã chuẩn bị" = mọi đoạn trong danh sách đang có trong cache máy này. Lưu dạng dải để gọn.
  const PREP_KEY = 'ielts.prep';
  const loadPrep = () => { try { return JSON.parse(localStorage.getItem(PREP_KEY)) || {}; } catch (_) { return {}; } };
  function savePrep(file, set, extra) {
    const list = [...set].sort((a, b) => a - b);
    const runs = [];
    for (const i of list) { const l = runs[runs.length - 1]; if (l && l[1] === i - 1) l[1] = i; else runs.push([i, i]); }
    const all = loadPrep();
    all[file.id] = Object.assign({ runs, chunks: list.length, size: Number(file.size) || 0, at: Date.now() }, extra || {});
    try { localStorage.setItem(PREP_KEY, JSON.stringify(all)); } catch (_) {}
  }
  async function prepStatus(file) {
    const r = loadPrep()[file.id];
    if (!r || !r.runs) return { state: 'none' };
    const c = await chunkCache();
    if (!c) return { state: 'none' };
    let have = 0;
    const idx = [];
    for (const [a, b] of r.runs) for (let i = a; i <= b; i++) idx.push(i);
    const hits = await Promise.all(idx.map((i) => c.match(chunkKey(file.id, i)).then((x) => !!x, () => false)));
    hits.forEach((h) => { if (h) have++; });
    return { state: have === idx.length ? 'ready' : have ? 'partial' : 'none', have, total: idx.length, mb: idx.length * CHUNK / 1e6, at: r.at, by: r.by };
  }

  // ---------- Nút "Chuẩn bị quyển này" (m3-3) ----------
  // Tải sẵn vào cache phần cấu trúc PDF mà pdf.js bắt buộc đọc trước khi mở: đợt 1 (đầu + đuôi file), đợt 2 (object stream,
  // object nhỏ) và cây trang. Đọc xref xong thì hỏi trước (hooks.confirm) với dung lượng còn phải tải.
  // Thêm (m3-3, để mở lần đầu dưới 2 s): dữ liệu các trang sẽ mở trước (hooks.pages(số trang) trả danh sách: trang đang xem dở
  // và trang đầu mỗi phần đã đánh dấu). Không có bước này thì lần mở đầu vẫn phải chờ Drive 1 lần (2–4 s) cho dữ liệu trang.
  // hooks: {confirm({readMB, needMB, chunks, pages, pageMB}) -> Promise<bool>, onProgress(text), pages(n) -> [số trang]}
  async function prepare(file, hooks = {}) {
    const T0 = performance.now();
    let size = Number(file.size) || 0;
    if (!size) { const meta = await driveGet('files/' + encodeURIComponent(file.id), { fields: 'size' }); size = Number(meta.size); }
    const L = makeLoader(file, size, T0);
    const vis = trackHidden(T0);
    const prog = (t) => hooks.onProgress && hooks.onProgress(t);
    L.onStats = (s) => prog(`Đang chuẩn bị: đã tải ${mb(s.net)} (${s.requests} lần gọi)…`);
    try {
      try { await L.wave1(); } catch (e) { if (e instanceof NoRange) throw new Error('Drive không cho lấy từng đoạn của file này, nên không chuẩn bị được (khi mở sẽ tải cả file).'); throw e; }
      const index = makeIndex(L);
      const info = await index.load();
      const early = index.earlyRanges(EARLY_CAP, CHUNK);
      const want = [...L.chunkSet(early.ranges)];
      const c = await chunkCache();
      const hit = c ? await Promise.all(want.map((i) => L.mem.has(i) || c.match(chunkKey(file.id, i)).then((x) => !!x, () => false))) : want.map(() => false);
      const need = want.filter((_, k) => !hit[k]).length;
      const readMB = L.stats.net / 1e6, needMB = need * CHUNK / 1e6;
      // Ước lượng dữ liệu trang: phần còn lại của file chia đều cho số trang (chưa biết số trang trước khi đọc cây trang,
      // lấy /Count của nút gốc nếu đọc được, không thì 150).
      let nPages = 150;
      try { const cat = await index.obj(index.trailer.Root.R); const root = cat && cat.Pages ? await index.obj(cat.Pages.R) : null; if (root && root.Count) nPages = root.Count; } catch (_) {}
      const pageList = hooks.pages ? [...new Set(hooks.pages(nPages))].filter((p) => p >= 1 && p <= nPages) : [];
      const pageMB = pageList.length * Math.max(0, size - want.length * CHUNK) / nPages / 1e6;
      log(`Chuẩn bị ${file.name}: xref ${info.kind}, ${info.sections} phần, ${info.objects} object, ${info.objStms} object stream. Đã đọc ${mb(L.stats.net)}, còn ${need} đoạn (${mb(need * CHUNK)}) cần tải (${early.note}).`);
      if (hooks.confirm && !(await hooks.confirm({ readMB, needMB, chunks: need, pages: pageList.length, pageMB }))) { log(`Chuẩn bị ${file.name}: đã hủy.`); return null; }
      await L.prefetchRanges(early.ranges, 'object stream/nhỏ');
      const pg = await index.pages('cây trang');
      savePrep(file, L.touched, { by: 'prepare' });
      let pr = null;
      if (pageList.length) pr = await index.prefetchPages(pageList.filter((p) => p <= pg.list.length), 'trang đầu các phần', () => false);
      const ms = Math.round(performance.now() - T0);
      callTable(L.calls, `Chuẩn bị xong ${file.name} sau ${ms} ms, ${pg.list.length} trang, cấu trúc ${L.touched.size} đoạn` +
        `${pr ? `, dữ liệu ${pageList.length} trang (${pageList.join(', ')})` : ''} (mốc thời gian tính bằng ms từ lúc bấm)`).forEach((l) => log(l));
      log('  ' + vis.summary());
      return { ms, net: L.stats.net, calls: L.calls.length, pages: pg.list.length, chunks: L.touched.size };
    } finally { vis.stop(); }
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
    const L = makeLoader(file, size, T0);
    const { stats, calls } = L;
    L.onStats = (s) => hooks.onStats && hooks.onStats(s);
    const emit = () => hooks.onStats && hooks.onStats(stats);
    const nChunks = L.nChunks;
    const vis = trackHidden(T0);
    let reported = 0;          // số lần gọi đã ghi vào nhật ký
    const prepBefore = loadPrep()[file.id];

    let first;
    try {
      first = await L.wave1();
    } catch (e) {
      vis.stop();
      if (e instanceof NoRange) return openFull(libP, file, size, stats, hooks, e);
      throw e;
    }

    // Đọc cấu trúc, tải trước object stream / object nhỏ (đợt 2), đi cây trang, rồi tải trước trang đầu tiên sẽ xem (đợt 3,
    // chạy song song với lúc pdf.js mở tài liệu). Lỗi ở đây thì bỏ qua: pdf.js vẫn tự tải, chỉ chậm hơn (như m3-1).
    let index = null, warm = null, structP = Promise.resolve();
    const pf = { notes: [] };
    stats.prefetch = pf;
    try {
      index = makeIndex(L);
      const info = await index.load();
      pf.notes.push(`xref ${info.kind}, ${info.sections} phần, ${info.objects} object, ${info.objStms} object stream`);
      const early = index.earlyRanges(EARLY_CAP, CHUNK);
      pf.notes.push('đợt 2: ' + early.note);
      const earlyP = L.prefetchRanges(early.ranges, 'object stream/nhỏ');   // mọi đoạn được giữ chỗ ngay khi gọi
      earlyP.catch(() => {});
      // Trang sẽ hiện đầu tiên: tìm nhanh theo /Count rồi tải dữ liệu trang ngay khi catalog, nút gốc, từ điển trang về,
      // không chờ lần gọi chậm nhất của đợt 2 (m3-3). Cây trang lạ thì chờ đọc hết cây như m3-2.
      const start = Math.max(1, hooks.startPage || 1);
      warm = (async () => {
        const q = await index.prefetchPageQuick(start, 'trang ' + start, () => L.closed).catch(() => null);
        if (q) return q;
        await earlyP;
        const pg = await index.pages('cây trang');
        return index.prefetchPages([Math.min(pg.list.length, start)], 'trang ' + start, () => L.closed);
      })();
      warm.catch(() => {});
      // pdf.js chỉ mở xong khi có đủ phần cấu trúc (nó đọc từ điển mọi trang trước). Ghi nhận "đã có cấu trúc" sau đó.
      structP = (async () => {
        await earlyP;
        const pg = await index.pages('cây trang');
        pf.pages = pg.list.length;
        stats.openMs = Math.round(performance.now() - T0);
        savePrep(file, L.touched, { by: prepBefore && prepBefore.by === 'prepare' ? 'prepare' : 'open' });   // lần sau mở coi như đã chuẩn bị
        log(`PDF ${file.name}: ${pf.notes.join('; ')}. Đọc cấu trúc xong sau ${stats.openMs} ms.`);
      })();
      structP.catch((e) => log(`PDF ${file.name}: đọc cây trang lỗi: ${e.message}`));
    } catch (e) {
      if (e instanceof AuthNeeded) { vis.stop(); throw e; }
      index = null;
      pf.notes.push('không đọc được cấu trúc, để pdf.js tự tải: ' + e.message);
      stats.openMs = Math.round(performance.now() - T0);
      log(`PDF ${file.name}: ${pf.notes.join('; ')}. Đọc cấu trúc xong sau ${stats.openMs} ms.`);
    }

    const lib = await libP;
    const pending = [];   // dải chờ gửi lại sau khi gia hạn token
    class DriveRangeTransport extends lib.PDFDataRangeTransport {
      requestDataRange(begin, end) {
        const from = Math.floor(begin / CHUNK), to = Math.min(nChunks - 1, Math.ceil(end / CHUNK) - 1);
        // pdf.js ghép dữ liệu trả về với yêu cầu theo đúng `begin`, nên phải trả một khối liền cho cả yêu cầu.
        const run = (attempt) => L.getChunks(from, to, 'pdf.js').then((m) => {
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
    let doc;
    try { doc = await task.promise; } catch (e) { vis.stop(); throw e; }
    stats.docMs = Math.round(performance.now() - T0);
    emit();

    // Ghi bảng các lần gọi chưa ghi (gọi khi vừa thấy trang đầu, hoặc khi tải nền xong).
    // opts.seen: vừa thấy trang đầu → ghi thêm mốc pdf.js mở xong, thời gian vẽ trang đầu, tab/app có bị ẩn không.
    function report(title, opts = {}) {
      const fresh = calls.slice(reported);
      reported = calls.length;
      const now = performance.now() - T0;
      const lines = callTable(fresh, `${title} (${file.name}; mốc thời gian tính bằng ms từ lúc bắt đầu mở)`);
      if (opts.seen) {
        stats.seenMs = Math.round(now);
        stats.drawMs = Math.round(now - stats.docMs);
        // m3-4: tách "chờ Drive" (lần gọi cuối xong trước khi thấy trang) khỏi "giải mã + vẽ". Edge 14/10 ghi "vẽ trang đầu 8356 ms"
        // nhưng gần hết là chờ đợt 2 tải xong, không phải vẽ chậm.
        const netEnd = Math.max(stats.docMs, ...calls.filter((c) => c.end != null && c.end <= now).map((c) => c.end));
        const waitNet = Math.round(netEnd - stats.docMs), paint = Math.round(now - netEnd);
        lines.splice(1, 0, `  Mốc: ${opts.tokenMs >= 50 ? `chờ gia hạn token ${opts.tokenMs} ms trước khi bắt đầu (không tính vào các mốc dưới), ` : ''}` +
          `đợt 1 xong ${stats.firstMs} ms, đọc cấu trúc xong ${stats.openMs ?? '?'} ms, tài liệu mở xong (pdf.js) ${stats.docMs} ms, ` +
          `thấy trang ${stats.seenMs} ms → vẽ trang đầu ${stats.drawMs} ms (từ lúc tài liệu mở xong: chờ Drive ${waitNet} ms, giải mã + vẽ ${paint} ms` +
          `${opts.renderMs != null ? `; lệnh vẽ tính cả chờ dữ liệu ${opts.renderMs} ms` : ''}).` +
          `${prepBefore ? ` Trước khi mở: đã ${prepBefore.by === 'prepare' ? 'bấm Chuẩn bị' : 'mở'} quyển này trên máy (lưu ${new Date(prepBefore.at).toLocaleString('vi-VN')}).` : ' Trước khi mở: chưa chuẩn bị.'}`,
          '  ' + vis.summary(now));
      }
      lines.forEach((l) => log(l));
    }
    // Tải nền dữ liệu các trang `nums` (số trang PDF). Không chặn việc xem; dừng khi đóng tài liệu.
    async function prefetchPages(nums, why) {
      const t0 = performance.now(), n0 = stats.net, c0 = calls.length;
      let note;
      if (index) {
        const r = await index.prefetchPages(nums, why, () => L.closed);
        note = `${r.waves} đợt, ${r.objects} object`;
      } else {
        // Không đọc được cấu trúc: nhờ pdf.js tải lần lượt từng trang (chậm hơn nhưng vẫn chạy).
        for (const p of nums) { if (L.closed) break; try { const pg = await doc.getPage(p); await pg.getOperatorList(); pg.cleanup(); } catch (_) {} }
        note = 'qua pdf.js, lần lượt';
      }
      if (L.closed) return null;
      const res = { pages: nums.length, net: stats.net - n0, calls: calls.length - c0, ms: Math.round(performance.now() - t0), note };
      log(`PDF ${file.name}: ${why}: ${nums.length} trang, tải ${mb(res.net)} qua ${res.calls} lần gọi, ${res.ms} ms (${note}).`);
      return res;
    }
    return {
      doc, stats, report, prefetchPages, calls, warm, hidden: vis,
      close: () => { L.closed = true; vis.stop(); return shutdown(task, worker); },
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
    try { localStorage.removeItem(PREP_KEY); } catch (_) {}
    cacheP = null;
  }

  window.PdfSource = { openDocument, prepare, prepStatus, probe, loadPdfjs, cacheInfo, clearCache, AuthNeeded, CHUNK, TAIL_CHUNKS, mb, callTable };
})();
