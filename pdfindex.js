// Bản m3-2: tự đọc cấu trúc PDF (bảng xref thường và xref nén, object stream, cây trang) để biết TRƯỚC những đoạn byte
// pdf.js sẽ cần, rồi tải các đoạn đó song song. pdf.js tự đi lần lượt từng object, mỗi object thiếu là 1 lần gọi Drive
// nối tiếp (1,4–4 s mỗi lần trên máy Minh), nên tải trước song song là chỗ rút thời gian mở.
// Hàm thuần, không gọi mạng trực tiếp: nhận read(begin, end) và prefetch(ranges) từ pdfsource.js. Chạy được trong Node để test.
// Không có nội dung Cambridge nào trong code.
'use strict';
(function (root) {
  const latin1 = new TextDecoder('latin1');
  const txt = (u8) => latin1.decode(u8);

  // ---------- Đọc cú pháp PDF (đủ dùng cho từ điển, mảng, số, tên, tham chiếu) ----------
  class Truncated extends Error {}   // hết chuỗi giữa chừng: cần đọc thêm byte
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = '()<>[]{}/%';
  const isRef = (v) => v && typeof v === 'object' && 'R' in v && !Array.isArray(v);
  const isDict = (v) => v && typeof v === 'object' && !Array.isArray(v) && !('R' in v) && !('S' in v);

  function skipWs(s, i) {
    for (;;) {
      if (i >= s.length) return i;
      const c = s.charCodeAt(i);
      if (WS.has(c)) { i++; continue; }
      if (c === 37) { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }   // % chú thích
      return i;
    }
  }
  const REF = /(\d+)\s+(\d+)\s+R(?=[\s()<>[\]{}\/%]|$)/y;
  function parse(s, i) {
    i = skipWs(s, i);
    if (i >= s.length) throw new Truncated();
    const c = s[i];
    if (c === '<' && s[i + 1] === '<') {
      const d = Object.create(null);
      i += 2;
      for (;;) {
        i = skipWs(s, i);
        if (i >= s.length) throw new Truncated();
        if (s[i] === '>' && s[i + 1] === '>') return [d, i + 2];
        if (s[i] !== '/') throw new Error('từ điển lỗi tại ' + i);
        const [k, j] = parse(s, i);
        const [v, j2] = parse(s, j);
        d[k.slice(1)] = v; i = j2;
      }
    }
    if (c === '[') {
      const a = []; i++;
      for (;;) {
        i = skipWs(s, i);
        if (i >= s.length) throw new Truncated();
        if (s[i] === ']') return [a, i + 1];
        const [v, j] = parse(s, i); a.push(v); i = j;
      }
    }
    if (c === '/') {
      let j = i + 1;
      while (j < s.length && !WS.has(s.charCodeAt(j)) && !DELIM.includes(s[j])) j++;
      if (j >= s.length) throw new Truncated();
      return ['/' + s.slice(i + 1, j), j];
    }
    if (c === '(') {
      let depth = 1, j = i + 1;
      while (j < s.length && depth) { if (s[j] === '\\') j++; else if (s[j] === '(') depth++; else if (s[j] === ')') depth--; j++; }
      if (depth) throw new Truncated();
      return [{ S: s.slice(i + 1, j - 1) }, j];
    }
    if (c === '<') {
      const j = s.indexOf('>', i);
      if (j < 0) throw new Truncated();
      return [{ S: s.slice(i + 1, j) }, j + 1];
    }
    REF.lastIndex = i;
    const m = REF.exec(s);
    if (m) return [{ R: Number(m[1]), G: Number(m[2]) }, REF.lastIndex];
    let j = i;
    while (j < s.length && !WS.has(s.charCodeAt(j)) && !DELIM.includes(s[j])) j++;
    if (j >= s.length) throw new Truncated();   // số ở cuối chuỗi có thể còn tiếp, hoặc là "N G R" bị cắt
    const w = s.slice(i, j);
    if (w === 'true') return [true, j];
    if (w === 'false') return [false, j];
    if (w === 'null') return [null, j];
    // Số nguyên đứng trước một số nguyên khác: có thể là "N G R" bị cắt ở cuối chuỗi.
    if (/^\d+$/.test(w) && /^\s+(\d+\s*)?$/.test(s.slice(j))) throw new Truncated();
    const n = Number(w);
    if (!Number.isFinite(n)) return [{ K: w }, j];   // từ khóa khác (obj, stream...)
    return [n, j];
  }

  // ---------- Giải nén ----------
  async function inflate(u8) {
    if (typeof DecompressionStream !== 'function') throw new Error('trình duyệt không có DecompressionStream');
    const ds = new DecompressionStream('deflate');
    const w = ds.writable.getWriter();
    w.write(u8).catch(() => {}); w.close().catch(() => {});
    const r = ds.readable.getReader();
    const parts = []; let n = 0;
    try {
      for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); n += value.length; }
    } catch (e) { if (!n) throw e; }   // rác sau cuối dòng nén: giữ phần đã giải được (pdf.js cũng làm vậy)
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  // Bộ lọc dự đoán PNG (Predictor >= 10), dùng cho xref nén.
  function unpredict(data, parms) {
    const pred = (parms && parms.Predictor) || 1;
    if (pred < 10) { if (pred === 1) return data; throw new Error('Predictor ' + pred + ' chưa hỗ trợ'); }
    const colors = parms.Colors || 1, bpc = parms.BitsPerComponent || 8, cols = parms.Columns || 1;
    const bpp = Math.max(1, Math.ceil(colors * bpc / 8));
    const rowLen = Math.ceil(colors * bpc * cols / 8);
    const rows = Math.floor(data.length / (rowLen + 1));
    const out = new Uint8Array(rows * rowLen);
    let prev = new Uint8Array(rowLen);
    for (let r = 0; r < rows; r++) {
      const f = data[r * (rowLen + 1)];
      const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
      const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
      for (let i = 0; i < rowLen; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let x = src[i];
        if (f === 1) x += a;
        else if (f === 2) x += b;
        else if (f === 3) x += (a + b) >> 1;
        else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); x += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        else if (f !== 0) throw new Error('bộ lọc PNG ' + f + ' lỗi');
        cur[i] = x & 255;
      }
      prev = cur;
    }
    return out;
  }
  async function decodeStream(dict, raw) {
    let filters = dict.Filter == null ? [] : Array.isArray(dict.Filter) ? dict.Filter : [dict.Filter];
    let parms = dict.DecodeParms == null ? [] : Array.isArray(dict.DecodeParms) ? dict.DecodeParms : [dict.DecodeParms];
    let data = raw;
    filters.forEach((f) => { if (f !== '/FlateDecode' && f !== '/Fl') throw new Error('bộ lọc ' + f + ' chưa hỗ trợ'); });
    for (let k = 0; k < filters.length; k++) { data = await inflate(data); if (isDict(parms[k])) data = unpredict(data, parms[k]); }
    return data;
  }

  // ---------- Chỉ mục ----------
  // io: {size, read(begin, end) -> Promise<Uint8Array>, prefetch(ranges [[begin,end)], label) -> Promise}
  function create(io) {
    const size = io.size;
    const entries = new Map();     // số object -> {t:1, off} | {t:2, stm, idx}
    const xrefPos = [];            // vị trí các bảng xref (cũng là biên của object đứng trước)
    let trailer = null;
    let sorted = null;             // offset tăng dần, dùng tính biên object
    const objCache = new Map();    // số object -> Promise<{value, streamStart?, streamLen?}>
    const stmCache = new Map();    // số object stream -> Promise<{dict, text, map}>
    const info = { kind: null, sections: 0, objects: 0, objStms: 0, notes: [] };
    const kinds = new Set();

    // Biên trên của object bắt đầu tại off: offset kế tiếp trong bảng xref (hoặc vị trí bảng xref, hoặc cuối file).
    function bound(off) {
      if (!sorted) return size;
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= off) lo = mid + 1; else hi = mid; }
      return lo < sorted.length ? sorted[lo] : size;
    }
    // Đoạn byte nên tải cho object type 1: tới object kế tiếp, cộng 512 byte để lấy luôn object /Length nhỏ đứng sau (nếu có).
    function range1(off, cap) { return [off, Math.min(size, bound(off) + 512, cap ? off + cap : Infinity)]; }

    // Đọc object tại offset: phần đầu "N G obj", giá trị, và vị trí dòng dữ liệu nếu là stream.
    async function readAt(off, hint) {
      const lim = sorted ? bound(off) + 512 : size;
      let len = Math.min(lim - off, hint || 4096);
      for (;;) {
        const s = txt(await io.read(off, off + len));
        try {
          const h = /^\s*(\d+)\s+(\d+)\s+obj/.exec(s);
          if (!h) throw new Error('không thấy "obj" tại ' + off);
          const [value, i] = parse(s, h[0].length);
          const st = /^\s*stream(\r\n|\n|\r)?/.exec(s.slice(i, i + 40));
          if (isDict(value) && st) return { num: Number(h[1]), value, streamStart: off + i + st[0].length };
          // Từ điển nằm sát cuối đoạn đã đọc: chưa biết có "stream" theo sau không, đọc thêm nếu còn được.
          if (isDict(value) && /^\s*s?t?r?e?a?m?$/.test(s.slice(i)) && off + len < Math.min(lim, size)) throw new Truncated();
          return { num: Number(h[1]), value };
        } catch (e) {
          if (e instanceof Truncated && off + len < Math.min(lim, size)) { len = Math.min(Math.min(lim, size) - off, len * 4); continue; }
          throw e;
        }
      }
    }
    async function streamData(o) {
      let n = o.value.Length;
      if (isRef(n)) n = (await obj(n.R));
      if (!Number.isInteger(n) || n < 0) throw new Error('/Length lỗi');
      return io.read(o.streamStart, Math.min(size, o.streamStart + n));
    }

    // Đọc một phần xref tại pos (bảng hoặc stream). Phần mới hơn đọc trước nên không ghi đè mục đã có.
    function put(num, e) { if (!entries.has(num)) entries.set(num, e); }
    async function section(pos) {
      xrefPos.push(pos);
      info.sections++;
      const head = txt(await io.read(pos, Math.min(size, pos + 32)));
      if (/^\s*xref/.test(head)) {
        kinds.add('bảng');
        let s = '', from = pos;
        while (!/trailer\s*<</.test(s) && from < size && s.length < 8e6) { s += txt(await io.read(from, Math.min(size, from + 65536))); from += 65536; }
        const ti = s.search(/trailer\s*<</);
        if (ti < 0) throw new Error('không thấy trailer');
        const t = s.slice(s.indexOf('xref') + 4, ti).trim().split(/\s+/);
        for (let i = 0; i + 1 < t.length;) {
          const start = parseInt(t[i], 10), count = parseInt(t[i + 1], 10);
          i += 2;
          if (!Number.isInteger(start) || !Number.isInteger(count)) break;
          for (let k = 0; k < count && i + 2 < t.length + 1; k++, i += 3) {
            if (t[i + 2] === 'n') put(start + k, { t: 1, off: parseInt(t[i], 10) });
            else if (t[i + 2] === 'f') put(start + k, { t: 0 });
          }
        }
        let tr, rest = s.slice(ti + 7);
        for (;;) {
          try { tr = parse(rest, 0)[0]; break; }
          catch (e) { if (!(e instanceof Truncated) || from >= size) throw e; const more = txt(await io.read(from, Math.min(size, from + 65536))); rest += more; from += 65536; }
        }
        if (Number.isInteger(tr.XRefStm)) { try { await section(tr.XRefStm); } catch (e) { info.notes.push('XRefStm lỗi: ' + e.message); } }
        return tr;
      }
      // xref nén: "N 0 obj << /Type /XRef /W [...] ... >> stream"
      kinds.add('nén');
      const o = await readAt(pos, 2048);
      const d = o.value;
      if (!isDict(d) || d.Type !== '/XRef' || o.streamStart == null) throw new Error('vị trí startxref không phải bảng xref');
      const data = await decodeStream(d, await streamData(o));
      const W = d.W;
      if (!Array.isArray(W) || W.length < 3) throw new Error('/W lỗi');
      const idx = Array.isArray(d.Index) ? d.Index : [0, d.Size];
      const rl = W[0] + W[1] + W[2];
      let p = 0;
      const field = (w) => { let v = 0; for (let k = 0; k < w; k++) v = v * 256 + data[p++]; return v; };
      for (let s = 0; s + 1 < idx.length; s += 2) {
        for (let k = 0; k < idx[s + 1]; k++) {
          if (p + rl > data.length) throw new Error('dữ liệu xref nén ngắn hơn khai báo');
          const type = W[0] ? field(W[0]) : 1, f2 = field(W[1]), f3 = field(W[2]);
          const num = idx[s] + k;
          if (type === 1) put(num, { t: 1, off: f2 });
          else if (type === 2) put(num, { t: 2, stm: f2, idx: f3 });
          else put(num, { t: 0 });
        }
      }
      return d;
    }

    async function load() {
      const tail = txt(await io.read(Math.max(0, size - 1024), size));
      const sx = tail.lastIndexOf('startxref');
      if (sx < 0) throw new Error('không thấy startxref');
      let pos = parseInt(tail.slice(sx + 9).trim(), 10);
      const seen = new Set();
      while (Number.isInteger(pos) && pos >= 0 && pos < size && !seen.has(pos) && seen.size < 32) {
        seen.add(pos);
        const tr = await section(pos);
        if (!trailer) trailer = tr;
        else if (!trailer.Root && tr.Root) trailer.Root = tr.Root;
        pos = Number.isInteger(tr.Prev) ? tr.Prev : null;
      }
      if (!trailer || !isRef(trailer.Root)) throw new Error('không đọc được /Root');
      const offs = [...xrefPos];
      for (const e of entries.values()) if (e.t === 1) offs.push(e.off);
      sorted = [...new Set(offs)].sort((a, b) => a - b);
      info.kind = [...kinds].join(' + ');
      info.objects = [...entries.values()].filter((e) => e.t).length;
      info.objStms = new Set([...entries.values()].filter((e) => e.t === 2).map((e) => e.stm)).size;
      return info;
    }

    // Đoạn byte của mọi object stream (nơi xref nén gom từ điển trang, phông...). Thường nhỏ, tải hết một lần.
    function objStmRanges() {
      const out = [];
      for (const n of new Set([...entries.values()].filter((e) => e.t === 2).map((e) => e.stm))) {
        const e = entries.get(n);
        if (e && e.t === 1) out.push(range1(e.off));
      }
      return out;
    }
    // Đợt tải thứ 2 (ngay sau khi đọc xref): mọi object stream + mọi object nhỏ (dưới 4 KB, thường là catalog, nút cây trang,
    // từ điển trang, phông) nếu tổng không quá `cap` byte tính theo đoạn `chunk`. Nhờ vậy đi cây trang không phải chờ mạng.
    function earlyRanges(cap, chunk) {
      const stm = objStmRanges();
      const small = [];
      // Catalog nằm trong object stream thì cây trang cũng vậy: object nhỏ ngoài object stream lúc đó chủ yếu là
      // stream nội dung từng trang, chưa cần, bỏ qua cho đỡ tốn dữ liệu.
      const rootE = trailer && entries.get(trailer.Root.R);
      if (!rootE || rootE.t !== 2) for (const e of entries.values()) if (e.t === 1 && bound(e.off) - e.off <= 4096) small.push(range1(e.off));
      const chunks = (rs) => { const s = new Set(); for (const [a, b] of rs) for (let i = Math.floor(a / chunk); i <= Math.floor((b - 1) / chunk); i++) s.add(i); return s.size; };
      const all = stm.concat(small);
      const n = chunks(all);
      if (n * chunk <= cap) return { ranges: all, note: `${stm.length} object stream + ${small.length} object nhỏ, ${n} đoạn` };
      return { ranges: stm, note: `${stm.length} object stream (bỏ ${small.length} object nhỏ vì quá ${Math.round(cap / 1e6)} MB)` };
    }

    function objStm(n) {
      if (!stmCache.has(n)) {
        const p = (async () => {
          const e = entries.get(n);
          if (!e || e.t !== 1) throw new Error('object stream ' + n + ' không có trong xref');
          const o = await readAt(e.off, 1024);
          const data = await decodeStream(o.value, await streamData(o));
          const text = txt(data);
          const first = o.value.First, cnt = o.value.N;
          const nums = text.slice(0, first).trim().split(/\s+/).map(Number);
          const map = new Map();
          for (let k = 0; k < cnt; k++) map.set(nums[2 * k], [first + nums[2 * k + 1], k + 1 < cnt ? first + nums[2 * k + 3] : text.length]);
          return { text, map };
        })();
        p.catch(() => {});
        stmCache.set(n, p);
      }
      return stmCache.get(n);
    }

    function obj(n) {
      if (!objCache.has(n)) {
        const p = (async () => {
          const e = entries.get(n);
          if (!e || !e.t) return null;
          if (e.t === 1) { const o = await readAt(e.off); return o.value; }
          const s = await objStm(e.stm);
          const r = s.map.get(n);
          if (!r) return null;
          return parse(s.text.slice(r[0], r[1]) + ' endobj', 0)[0];   // đuôi giả để số đứng cuối không bị coi là bị cắt
        })();
        p.catch(() => {});
        objCache.set(n, p);
      }
      return objCache.get(n);
    }
    const get = async (v) => (isRef(v) ? obj(v.R) : v);

    // Đoạn byte cần cho một loạt object (để tải trước cùng lúc). small = object không phải stream, giới hạn 64 KB.
    function rangesFor(nums, small) {
      const out = [];
      for (const n of nums) {
        const e = entries.get(n);
        if (!e || !e.t) continue;
        if (e.t === 1) out.push(range1(e.off, small ? 65536 : 0));
        else { const c = entries.get(e.stm); if (c && c.t === 1) out.push(range1(c.off)); }
      }
      return out;
    }

    // Cây trang: đi theo từng tầng, mỗi tầng tải trước song song mọi node rồi mới đọc. Trả danh sách trang theo thứ tự.
    let pagesP = null;
    function pages(label) {
      if (!pagesP) {
        pagesP = (async () => {
          const cat = await get(trailer.Root);
          if (!isDict(cat) || !isRef(cat.Pages)) throw new Error('không thấy /Pages');
          const nodes = new Map();   // số object -> từ điển
          let frontier = [cat.Pages.R], depth = 0;
          const queued = new Set(frontier);
          while (frontier.length && depth++ < 32) {
            await io.prefetch(rangesFor(frontier, true), label);
            const vals = await Promise.all(frontier.map(obj));
            const next = [];
            for (let k = 0; k < frontier.length; k++) {
              const v = vals[k];
              nodes.set(frontier[k], v);
              let kids = isDict(v) && v.Type !== '/Page' ? v.Kids : null;
              if (isRef(kids)) kids = await get(kids);
              if (Array.isArray(kids)) for (const r of kids) if (isRef(r) && !queued.has(r.R)) { queued.add(r.R); next.push(r.R); }
            }
            frontier = next;
          }
          const list = [];
          const parent = new Map();
          const visit = (n, from, guard) => {
            if (guard > 64) return;
            const v = nodes.get(n);
            if (!isDict(v)) return;
            parent.set(n, from);
            const kids = v.Type !== '/Page' && Array.isArray(v.Kids) ? v.Kids : null;
            if (kids) kids.forEach((r) => isRef(r) && visit(r.R, n, guard + 1));
            else list.push(n);
          };
          visit(cat.Pages.R, null, 0);
          return { list, nodes, parent };
        })();
        pagesP.catch(() => {});
      }
      return pagesP;
    }

    // Tải trước mọi thứ pdf.js cần để vẽ các trang `nums` (số trang từ 1): nội dung, ảnh, phông, chú thích...
    // Đi theo từng đợt: mỗi đợt gom mọi tham chiếu mới, tải song song, rồi đọc để tìm tham chiếu đợt sau.
    // Không theo /Parent, /P, /Dest... để khỏi lan sang trang khác.
    const SKIP = new Set(['Parent', 'P', 'Dest', 'Dests', 'A', 'Next', 'Prev', 'First', 'Last', 'Thumb', 'B', 'StructParents', 'Metadata', 'PieceInfo']);
    async function prefetchPages(nums, label, isCancelled) {
      const pg = await pages(label);
      const seen = new Set();
      let frontier = [];
      for (const p of nums) {
        const n = pg.list[p - 1];
        if (n == null) continue;
        const d = pg.nodes.get(n);
        if (!isDict(d)) continue;
        seen.add(n);
        // Tài nguyên kế thừa từ node cha nếu trang không tự khai báo.
        let res = d.Resources, up = pg.parent.get(n);
        while (res == null && up != null) { res = (pg.nodes.get(up) || {}).Resources; up = pg.parent.get(up); }
        frontier.push(...refsIn({ Contents: d.Contents, Resources: res, Annots: d.Annots }));
      }
      let waves = 0, bytes = 0;
      while (frontier.length && waves < 8) {
        if (isCancelled && isCancelled()) break;
        frontier = frontier.filter((n) => !seen.has(n));
        frontier.forEach((n) => seen.add(n));
        if (!frontier.length) break;
        waves++;
        const rs = rangesFor(frontier, false);
        rs.forEach((r) => { bytes += r[1] - r[0]; });
        await io.prefetch(rs, label);
        const vals = await Promise.all(frontier.map((n) => obj(n).catch(() => null)));
        frontier = [];
        for (const v of vals) frontier.push(...refsIn(v));
      }
      return { waves, bytes, objects: seen.size };
    }
    function refsIn(v, out = [], depth = 0) {
      if (depth > 12 || v == null || typeof v !== 'object') return out;
      if (isRef(v)) { out.push(v.R); return out; }
      if (Array.isArray(v)) { for (const x of v) refsIn(x, out, depth + 1); return out; }
      if ('S' in v || 'K' in v) return out;
      for (const k in v) if (!SKIP.has(k)) refsIn(v[k], out, depth + 1);
      return out;
    }

    return { load, objStmRanges, earlyRanges, pages, prefetchPages, obj, info, entries, bound, get trailer() { return trailer; } };
  }

  const api = { create, parse, unpredict, inflate, Truncated };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PdfIndex = api;
})(typeof self !== 'undefined' ? self : this);
