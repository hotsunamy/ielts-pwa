// Mốc 3: khoảng trang theo phần (Test N Listening/Reading/Writing/Speaking, Audioscripts, Đáp án, Bài mẫu...).
// Hàm thuần, chạy được cả trong trình duyệt lẫn Node (để test). Không chứa nội dung Cambridge, chỉ có quy tắc.
// Khoảng trang lưu theo CHỈ SỐ TRANG TRONG PDF (1 = trang đầu file), không theo số in trên sách.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sections = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SKILL = { L: 'Listening', R: 'Reading', W: 'Writing', S: 'Speaking' };
  const KEYS = [];
  for (let t = 1; t <= 4; t++) for (const s of 'LRWS') KEYS.push(`T${t}${s}`);
  KEYS.push('AS', 'KEY', 'SAMPLE', 'SHEET', 'OTHER');
  const LABEL = { AS: 'Audioscripts', KEY: 'Đáp án', SAMPLE: 'Bài mẫu Writing', SHEET: 'Phiếu trả lời mẫu', OTHER: 'Trang khác (giới thiệu, quảng cáo...)' };
  for (let t = 1; t <= 4; t++) for (const s of 'LRWS') LABEL[`T${t}${s}`] = `Test ${t} ${SKILL[s]}`;
  // Phần bị chặn ở chế độ làm đề (có thể lộ đáp án).
  const BLOCKED = new Set(['AS', 'KEY', 'SAMPLE']);
  const isTestKey = (k) => /^T[1-4][LRWS]$/.test(k);

  // marks: {key: trang bắt đầu}. Trả về các đoạn [{key, start, end}] theo thứ tự trang.
  // Đoạn kéo tới trước trang bắt đầu của mốc kế tiếp (mốc cùng trang thì dùng chung trang đó).
  function segments(marks, numPages) {
    const list = Object.entries(marks || {})
      .filter(([k, p]) => KEYS.includes(k) && Number.isInteger(p) && p >= 1 && p <= numPages)
      .map(([key, start]) => ({ key, start }))
      .sort((a, b) => a.start - b.start || KEYS.indexOf(a.key) - KEYS.indexOf(b.key));
    for (const s of list) {
      const next = list.find((o) => o.start > s.start);
      s.end = next ? next.start - 1 : numPages;
    }
    return list;
  }

  // Các phần chứa trang p.
  function kindsOf(segs, p) { return segs.filter((s) => p >= s.start && p <= s.end).map((s) => s.key); }

  // Trang được xem ở chế độ làm đề phần `key`: trong đoạn của phần đó, trừ trang nào cũng thuộc phần bị chặn.
  function allowedPages(segs, key) {
    const s = segs.find((x) => x.key === key);
    if (!s) return [];
    const out = [];
    for (let p = s.start; p <= s.end; p++) if (!kindsOf(segs, p).some((k) => BLOCKED.has(k) && k !== key)) out.push(p);
    return out;
  }

  // Có được xem trang p không. mode: 'review' (xem tự do) | 'exam' (chỉ trang của phần đang làm).
  function canView(segs, mode, key, p, numPages) {
    if (p < 1 || p > numPages) return false;
    if (mode !== 'exam') return true;
    return allowedPages(segs, key).includes(p);
  }

  // ---------- Dò tự động theo tiêu đề trong lớp chữ ----------
  // pages: [{p, text}] theo thứ tự. Trả về {marks, offset, notes}. Chỉ là gợi ý, Minh xác nhận trước khi dùng.
  const norm = (t) => String(t || '').normalize('NFKC').toUpperCase().replace(/\s+/g, ' ');
  const ONE = '[1IL|l]';
  const RE = {
    contents: /\bCONTENTS\b/,
    test: /\bTEST\s*([1-4])\b/,
    listen: /\bLISTENING\b/,
    part1: new RegExp(`\\b(PART|SECTION)\\s*${ONE}\\b`),
    q1: /QUESTIONS?\s*1\s*[-–—]\s*\d/,
    reading: new RegExp(`READING\\s*PASSAGE\\s*${ONE}\\b`),
    writing: new RegExp(`WRITING\\s*TASK\\s*${ONE}\\b`),
    speaking: /\bSPEAKING\b/,
    as: /\bAUDIO\s*SCRIPTS?\b|\bTAPESCRIPTS?\b|\bTRANSCRIPTS?\b/,
    key: /\bANSWER\s*KEYS?\b|LISTENING AND READING ANSWER/,
    sample: /\b(MODEL|SAMPLE)( AND SAMPLE)?( WRITING)? ANSWERS?\b/,
    sheet: /\bANSWER\s*SHEETS?\b/,
  };
  function detect(pages) {
    const marks = {}, notes = [];
    let cur = 0, after = false;   // after: đã qua phần đề (gặp Audioscripts/Đáp án)
    const set = (k, p, why) => { if (marks[k] == null) { marks[k] = p; notes.push(`${LABEL[k]}: trang PDF ${p} (${why})`); } };
    for (const { p, text } of pages) {
      const t = norm(text);
      if (!t.trim()) continue;
      const cats = ['listen', 'reading', 'writing', 'speaking', 'as', 'key', 'sample'].filter((c) => RE[c].test(t)).length;
      if (RE.contents.test(t) || cats >= 4) { notes.push(`bỏ qua trang ${p} (giống mục lục)`); continue; }
      if (!after) {
        const tm = RE.test.exec(t);
        if (RE.listen.test(t) && RE.part1.test(t) && (tm || RE.q1.test(t))) {
          const n = tm ? Number(tm[1]) : cur + 1;
          if (n === cur + 1) { cur = n; set(`T${n}L`, p, tm ? `Test ${n} + Listening + Part 1` : 'Listening + Part 1, theo thứ tự'); continue; }
        }
        if (cur && RE.reading.test(t)) { set(`T${cur}R`, p, 'Reading Passage 1'); continue; }
        if (cur && RE.writing.test(t)) { set(`T${cur}W`, p, 'Writing Task 1'); continue; }
        if (cur && RE.speaking.test(t) && RE.part1.test(t) && !RE.writing.test(t)) { set(`T${cur}S`, p, 'Speaking + Part 1'); continue; }
      }
      if (cur && RE.as.test(t) && marks.AS == null && marks.KEY == null) { after = true; set('AS', p, 'Audioscripts'); continue; }
      if (cur && RE.sheet.test(t) && (marks.SAMPLE != null || marks.KEY != null)) { after = true; set('SHEET', p, 'Answer sheet'); continue; }
      if (cur && RE.sample.test(t) && marks.SAMPLE == null && (marks.KEY != null || marks.AS != null)) { after = true; set('SAMPLE', p, 'Sample answers'); continue; }
      if (cur && RE.key.test(t) && marks.KEY == null) { after = true; set('KEY', p, 'Answer key'); continue; }
    }
    return { marks, offset: detectOffset(pages), notes };
  }

  // Độ lệch số trang: trang PDF p in số n thì lệch = p - n. Lấy giá trị lặp nhiều nhất từ các số đứng riêng ở đầu/cuối trang.
  function detectOffset(pages) {
    const votes = new Map();
    let counted = 0;
    for (const { p, text, edges } of pages) {
      const cands = new Set();
      for (const s of edges || []) { const m = /^\s*(\d{1,3})\s*$/.exec(s); if (m) cands.add(Number(m[1])); }
      if (!cands.size) continue;
      counted++;
      for (const n of cands) { const d = p - n; if (d >= -5 && d <= 40) votes.set(d, (votes.get(d) || 0) + 1); }
    }
    let best = null, bestN = 0;
    for (const [d, n] of votes) if (n > bestN) { best = d; bestN = n; }
    if (best == null || bestN < 3 || bestN < counted * 0.3) return null;
    return { offset: best, votes: bestN, pages: counted };
  }

  return { KEYS, LABEL, BLOCKED, isTestKey, segments, kindsOf, allowedPages, canView, detect, detectOffset };
});
