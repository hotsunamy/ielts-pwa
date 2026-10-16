// Mốc 5 (m5-1): tách text đáp án, soát lỗi kiểu OCR, chấm bài. Hàm thuần, chạy được cả trong trình duyệt lẫn Node (để test).
// KHÔNG chứa đáp án nào của Cambridge: đáp án do Minh dán hoặc gõ, lưu trong máy (mốc 6 lên vùng dữ liệu ẩn Drive).
//
// Quy ước đáp án (theo cách in trong sách, mục "Marking the practice tests"):
//   colour/color          đáp án thay thế (dấu gạch chéo, hoặc chữ OR viết hoa)
//   (the) library         phần trong ngoặc là tùy chọn
//   11-12 IN EITHER ORDER B, D   nhóm câu chọn nhiều đáp án, thứ tự bất kỳ (cũng nhận "11&12", "in any order", nhóm 3 câu)
// Chấm: không phân biệt hoa thường, bỏ khoảng trắng thừa, bỏ dấu câu ở đầu/cuối, "1,500" = "1500". Còn lại so khớp đúng từng chữ
// (viết thừa chữ hoặc sai chính tả là sai). App không kiểm giới hạn số từ vì không đọc đề; Minh có nút "Tính là đúng" từng câu.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Grade = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const N_DEFAULT = 40;

  // ---------- Chuẩn hóa ----------
  function clean(s) {
    return String(s ?? '').normalize('NFKC')
      .replace(/[“”„]/g, '"').replace(/[‘’`´]/g, "'")
      .replace(/[‐-―−]/g, '-').replace(/ /g, ' ');
  }
  // Chuẩn hóa một câu trả lời để so khớp.
  function norm(s) {
    let t = clean(s).toLowerCase().replace(/\s+/g, ' ').trim();
    t = t.replace(/^[\s.,;:!?"']+|[\s.,;:!?"']+$/g, '');   // dấu câu ở đầu/cuối
    t = t.replace(/\s*-\s*/g, '-').replace(/\s*\/\s*/g, '/');
    t = t.replace(/([£$€])\s+/g, '$1');
    while (/\b\d{1,3},\d{3}\b/.test(t)) t = t.replace(/\b(\d{1,3}),(\d{3})\b/, '$1$2');
    return t;
  }

  // Tách theo dấu phân cách ở tầng ngoài cùng (không nằm trong ngoặc).
  function splitTop(s, re) {
    const out = []; let depth = 0, cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      if (c === ')') depth = Math.max(0, depth - 1);
      if (depth === 0) { const m = re.exec(s.slice(i)); if (m && m.index === 0) { out.push(cur); cur = ''; i += m[0].length - 1; continue; } }
      cur += c;
    }
    out.push(cur);
    return out;
  }
  const ALT_RE = /^(?:\/|\s+OR\s+)/;   // "/" hoặc " OR " (viết hoa, như sách in)

  // Mở phần tùy chọn trong ngoặc: "(the) library" -> ["the library", "library"]; "(a/the) car" -> ["a car", "the car", "car"].
  function expandParens(s) {
    const m = /\(([^()]*)\)/.exec(s);
    if (!m) return [s];
    const before = s.slice(0, m.index), after = s.slice(m.index + m[0].length);
    const opts = ['', ...m[1].split('/').map((x) => x.trim())];
    const out = [];
    for (const o of opts) for (const rest of expandParens(after)) out.push(before + o + rest);
    return out.slice(0, 64);
  }

  // Mọi cách viết được chấp nhận của một đáp án (đã chuẩn hóa).
  function variants(raw) {
    const set = new Set();
    for (const alt of splitTop(clean(raw), ALT_RE)) {
      if (!alt.trim()) continue;
      for (const v of expandParens(alt)) { const n = norm(v); if (n) set.add(n); }
    }
    return set;
  }

  // ---------- Tách text đáp án ----------
  const HEAD_RE = /\b(?:test|part|section|passage|questions?)\s*\d{1,2}(?:\s*-\s*\d{1,2})?\b/gi;
  const HEAD_ONLY = /^(?:listening|reading|writing|answer|answers|keys?|and|academic|general|training|cambridge|ielts|page|[\s:.,|-])*$/i;
  const GROUP_RE = /(^|[^\d,.])(\d{1,2})\s*(?:&|-|and|,)\s*(\d{1,2})(?![\d,.])((?:\s*\(?\s*in\s+(?:either|any)\s+order\s*\)?)?\s*:?)/gi;
  const ORDER_RE = /\(?\s*\bin\s+(?:either|any)\s+order\b\s*\)?\s*:?/gi;

  // text -> {items: {n: raw}, groups: [[a..b]], dups: [n], leftover: string}
  function parseKey(text, n = N_DEFAULT) {
    let t = clean(text).replace(/\r/g, '');
    // Bỏ dòng hướng dẫn quy đổi điểm ("If you score ...", band) và dòng chỉ có tiêu đề.
    t = t.split('\n').filter((l) => !/\bscore|\bband\b/i.test(l)).map((l) => l.replace(HEAD_RE, ' ')).filter((l) => !HEAD_ONLY.test(l.trim()) || !l.trim()).join('\n');
    // Đánh dấu nhóm "11-12 IN EITHER ORDER": có cụm "in either/any order" ngay sau, hoặc dải số đứng đầu dòng.
    t = t.replace(GROUP_RE, (all, pre, a, b, tail, off, str) => {
      const A = +a, B = +b;
      const atStart = /(^|\n)[ \t]*$/.test(str.slice(0, off) + pre);
      const hasOrder = /order/i.test(tail);
      if (!(A >= 1 && B <= n && B > A && B - A <= 3) || !(hasOrder || atStart)) return all;
      return `${pre}\n§G${A}-${B}§ `;
    });
    t = t.replace(ORDER_RE, ' ');
    const entries = [];   // {n | group:[a..b], toks: []}
    const used = new Set(), dups = [];
    let cur = null, leftover = [];
    for (const line of t.split('\n')) {
      const toks = line.trim().split(/\s+/).filter(Boolean);
      if (toks.length === 1 && /^\d+$/.test(toks[0]) && +toks[0] > n) continue;   // số trang in đứng riêng một dòng
      toks.forEach((tok, i) => {
        const g = /^§G(\d+)-(\d+)§$/.exec(tok);
        if (g) {
          const mem = []; for (let k = +g[1]; k <= +g[2]; k++) mem.push(k);
          if (mem.some((k) => used.has(k))) { dups.push(...mem.filter((k) => used.has(k))); cur = { skip: true, toks: [] }; return; }
          mem.forEach((k) => used.add(k));
          cur = { group: mem, toks: [], members: {} }; entries.push(cur); return;
        }
        const m = /^(\d{1,2})[.):]?$/.exec(tok);
        const q = m ? +m[1] : 0;
        if (q >= 1 && q <= n) {
          // Số của một câu trong nhóm vừa mở ("21-22 IN EITHER ORDER" rồi "21 B 22 D"): gán vào nhóm.
          if (cur && cur.group && cur.group.includes(q) && cur.members[q] == null && (cur.toks.length === 0 || cur.cur != null)) {
            cur.cur = q; cur.members[q] = []; return;
          }
          const lineStart = i === 0;
          const emptyCur = cur && !cur.skip && (cur.group ? (cur.cur != null ? cur.members[cur.cur].length === 0 : cur.toks.length === 0) : cur.toks.length === 0);
          if (!used.has(q) && !emptyCur && (lineStart || /[.):]$/.test(tok) || cur)) {
            used.add(q); cur = { n: q, toks: [] }; entries.push(cur); return;
          }
          if (used.has(q) && lineStart && !emptyCur) { dups.push(q); cur = { skip: true, toks: [] }; return; }
        }
        if (!cur) { leftover.push(tok); return; }
        if (cur.group && cur.cur != null) cur.members[cur.cur].push(tok); else cur.toks.push(tok);
      });
    }
    const items = {}, groups = [], notes = [];
    for (const e of entries) {
      if (e.n) { items[e.n] = e.toks.join(' ').replace(/^[:.\-\s]+/, '').trim(); continue; }
      const size = e.group.length;
      groups.push(e.group);
      if (Object.keys(e.members).length) {
        e.group.forEach((k) => { items[k] = (e.members[k] || []).join(' ').trim(); });
        if (e.toks.length) leftover.push(...e.toks);
        continue;
      }
      const raw = e.toks.join(' ').replace(/^[:.\-\s]+/, '').trim();
      let parts = raw.split(/\s*(?:,|;|&|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean);
      if (parts.length !== size) { const ws = raw.split(/\s+/).filter(Boolean); if (ws.length === size) parts = ws; }
      if (parts.length !== size) { notes.push({ n: e.group[0], msg: `nhóm ${e.group[0]}–${e.group.at(-1)}: tách được ${parts.length} đáp án, cần ${size}` }); }
      e.group.forEach((k, j) => { items[k] = parts.length === size ? parts[j] : (j === 0 ? raw : ''); });
    }
    return { items, groups, dups: [...new Set(dups)], leftover: leftover.join(' ').trim(), notes };
  }

  // ---------- Soát: dòng đáng ngờ (tô đỏ) ----------
  const UNIT = /^\d+(?:st|nd|rd|th|am|pm|km|kg|cm|mm|m|g|ml|l|s|h|hrs?|mins?|ft|kph|mph|%)$/i;
  const ROMAN = /^(?:i{1,3}|iv|vi{0,3}|ix|x|xi{1,2})$/i;
  const TFNG = ['true', 'false', 'not given', 'yes', 'no'];
  function kind(raw) {
    const s = norm(raw);
    if (!s) return '';
    if (/^[a-l]$/.test(s) || ROMAN.test(s)) return 'L';
    if (TFNG.includes(s)) return 'T';
    return 'W';
  }
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  // Cụm câu để soát và để hiện phiếu: Listening theo Part (10 câu), Reading theo khoảng 13/13/14.
  function clusters(skill, n = N_DEFAULT) {
    if (n !== 40) return [[1, n]];
    return skill === 'R' ? [[1, 13], [14, 26], [27, 40]] : [[1, 10], [11, 20], [21, 30], [31, 40]];
  }
  function clusterOf(cl, q) { return cl.findIndex(([a, b]) => q >= a && q <= b); }

  // key: {items, groups}. Trả về {byQ: {n: [lý do]}, global: [lý do]}.
  function check(key, skill, n = N_DEFAULT, parsed) {
    const byQ = {}, global = [];
    const add = (q, msg) => { (byQ[q] = byQ[q] || []).push(msg); };
    const items = (key && key.items) || {};
    const cl = clusters(skill, n);
    for (let q = 1; q <= n; q++) {
      const raw = String(items[q] ?? '').trim();
      if (!raw) { add(q, 'trống'); continue; }
      if (/[^\p{L}\p{N}\s'".,/()&£$€%:;?!+-]/u.test(raw)) add(q, 'ký tự lạ');
      for (const tok of clean(raw).split(/[\s/()]+/).filter(Boolean)) {
        const w = tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (/\p{L}/u.test(w) && /\d/.test(w) && !UNIT.test(w)) { add(q, `chữ lẫn số "${w}"`); break; }
      }
      for (const tok of clean(raw).split(/[\s/()]+/)) {
        const w = tok.replace(/[^\p{L}]/gu, '');
        if (w.length >= 4 && w === w.toUpperCase() && /\p{Lu}/u.test(w) && !['TRUE', 'FALSE', 'GIVEN'].includes(w)) { add(q, `chữ hoa bất thường "${w}"`); break; }
      }
      if (/(^|\/)\s*\/|\/\s*$/.test(raw) || /\(\s*\)/.test(raw)) add(q, 'phương án thay thế trống');
      const s = norm(raw);
      if (kind(raw) === 'W' && s.length >= 2 && raw === raw.toUpperCase() && TFNG.some((x) => x !== s && lev(s, x) <= (x.length > 4 ? 2 : 1))) add(q, 'giống TRUE/FALSE/NOT GIVEN/YES/NO nhưng viết sai');
      // Khác dạng với hai câu bên cạnh cùng cụm (vd câu giữa dãy chữ cái lại ra một từ hoặc số "8").
      const c = clusterOf(cl, q);
      if (q > 1 && q < n && clusterOf(cl, q - 1) === c && clusterOf(cl, q + 1) === c) {
        const kp = kind(items[q - 1]), kn = kind(items[q + 1]), k = kind(raw);
        if (kp && kp === kn && kp !== 'W' && k !== kp) add(q, kp === 'L' ? 'khác dạng: hai câu bên cạnh là chữ cái' : 'khác dạng: hai câu bên cạnh là TRUE/FALSE/NOT GIVEN');
      }
    }
    for (const g of (key && key.groups) || []) {
      if (g.some((q) => !String(items[q] ?? '').trim())) add(g[0], `nhóm ${g[0]}–${g.at(-1)} thiếu đáp án`);
    }
    if (parsed) {
      for (const q of parsed.dups || []) add(q, 'số câu xuất hiện 2 lần trong text, đã giữ lần đầu');
      for (const x of parsed.notes || []) add(x.n, x.msg);
      if (parsed.leftover) global.push(`Đoạn chữ không gán được vào câu nào: "${parsed.leftover.slice(0, 120)}"`);
    }
    const miss = []; for (let q = 1; q <= n; q++) if (!String(items[q] ?? '').trim()) miss.push(q);
    if (miss.length) global.push(`Thiếu ${miss.length} câu: ${ranges(miss)}`);
    return { byQ, global };
  }
  function ranges(list) {
    const out = []; let a = null, b = null;
    for (const x of list) { if (a != null && x === b + 1) b = x; else { if (a != null) out.push(a === b ? `${a}` : `${a}–${b}`); a = b = x; } }
    if (a != null) out.push(a === b ? `${a}` : `${a}–${b}`);
    return out.join(', ');
  }

  // ---------- Chấm ----------
  function groupOf(key, q) { return ((key && key.groups) || []).find((g) => g.includes(q)) || null; }
  // Ghép cặp lớn nhất giữa câu trả lời và đáp án của nhóm (thứ tự bất kỳ). Trả về {q: true} cho câu được tính đúng.
  function matchGroup(g, items, answers) {
    const specs = g.map((q) => variants(items[q] || ''));
    const given = g.map((q) => norm(answers[q] || ''));
    const owner = new Array(specs.length).fill(-1);
    const tryAssign = (i, seen) => {
      for (let j = 0; j < specs.length; j++) {
        if (!given[i] || !specs[j].has(given[i]) || seen[j]) continue;
        seen[j] = true;
        if (owner[j] < 0 || tryAssign(owner[j], seen)) { owner[j] = i; return true; }
      }
      return false;
    };
    const ok = {};
    for (let i = 0; i < g.length; i++) if (tryAssign(i, [])) ok[g[i]] = true;
    return ok;
  }
  // Chấm một bài: key {items, groups}, answers {n: chuỗi}, overrides {n: true} (Minh bấm "Tính là đúng").
  function grade(key, answers, overrides = {}, n = N_DEFAULT) {
    const items = (key && key.items) || {};
    answers = answers || {};
    const per = [];
    const groupOk = {};
    for (const g of (key && key.groups) || []) Object.assign(groupOk, matchGroup(g, items, answers));
    let score = 0, nokey = 0, blank = 0;
    for (let q = 1; q <= n; q++) {
      const given = String(answers[q] ?? '').trim();
      const raw = String(items[q] ?? '').trim();
      const g = groupOf(key, q);
      let status;
      if (!raw) status = 'nokey';
      else if (!given) status = 'blank';
      else if (g) status = groupOk[q] ? 'ok' : 'wrong';
      else status = variants(raw).has(norm(given)) ? 'ok' : 'wrong';
      const ov = !!overrides[q] && status !== 'ok' && status !== 'nokey';
      if (status === 'nokey') nokey++;
      if (status === 'blank') blank++;
      if (status === 'ok' || ov) score++;
      per.push({ n: q, given, key: raw, group: g, status, override: ov });
    }
    return { per, score, total: n, nokey, blank, overridden: per.filter((x) => x.override).length };
  }

  // Hiện đáp án theo kiểu sách in (dùng ở màn kết quả).
  function display(key, q) {
    const items = (key && key.items) || {};
    const g = groupOf(key, q);
    if (!g) return String(items[q] ?? '');
    return `${g.map((k) => items[k] || '?').join(', ')} (câu ${g[0]}–${g.at(-1)}, thứ tự bất kỳ)`;
  }
  // Dạng text chuẩn (để chép ra, hoặc dán lại).
  function toText(key, n = N_DEFAULT) {
    const items = (key && key.items) || {};
    const lines = [];
    for (let q = 1; q <= n; q++) {
      const g = groupOf(key, q);
      if (g) { if (g[0] === q) lines.push(`${g[0]}-${g.at(-1)} IN EITHER ORDER ${g.map((k) => items[k] || '').join(', ')}`); continue; }
      lines.push(`${q} ${items[q] || ''}`.trim());
    }
    return lines.join('\n');
  }
  // Chuỗi nhóm "11-12, 21-23" <-> [[11,12],[21,22,23]] (ô sửa nhóm trên màn nhập đáp án).
  function groupsToText(groups) { return (groups || []).map((g) => `${g[0]}-${g.at(-1)}`).join(', '); }
  function textToGroups(s, n = N_DEFAULT) {
    const out = [], bad = [], used = new Set();
    for (const part of clean(s).split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
      const m = /^(\d{1,2})\s*(?:-|&|and)\s*(\d{1,2})$/i.exec(part);
      const A = m && +m[1], B = m && +m[2];
      if (!m || !(A >= 1 && B <= n && B > A && B - A <= 3)) { bad.push(part); continue; }
      const g = []; for (let k = A; k <= B; k++) g.push(k);
      if (g.some((k) => used.has(k))) { bad.push(part); continue; }
      g.forEach((k) => used.add(k)); out.push(g);
    }
    return { groups: out.sort((a, b) => a[0] - b[0]), bad };
  }

  return { N: N_DEFAULT, norm, variants, parseKey, check, clusters, grade, display, toText, groupsToText, textToGroups, ranges, kind };
});
