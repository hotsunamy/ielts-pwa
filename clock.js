// Mốc 5 (m5-2): đồng hồ làm bài, đếm từ Writing, prompt chấm Writing bằng AI. Hàm thuần, chạy được cả trong trình duyệt lẫn Node (để test).
// Đồng hồ tính theo MỐC THỜI GIAN, không đếm từng giây: lưu thời gian đã dùng của từng giai đoạn + mốc bắt đầu đoạn đang chạy,
// nên đóng/mở app, khóa màn hình hay trình duyệt dừng setInterval cũng không lệch.
//   c = {v, style: 'mock'|'practice', phase: 'listen'|'copy'|'read'|'write', limit: ms|null, used: {[phase]: ms},
//        runFrom: ms|null (đang chạy từ lúc này; null = đang dừng), pausedAt, pauses: [{at, ms}], beat (lần cuối app còn sống), warned: []}
// Thi thử (mock): Reading 60 phút, Writing 60 phút, Listening = thời gian audio + 10 phút chép (giai đoạn 'listen' không giới hạn).
// Luyện (practice): không giới hạn, chỉ đếm thời gian đã làm (không tính lúc rời app).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Clock = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MIN = 60000;
  const LIMIT = { read: 60 * MIN, write: 60 * MIN, copy: 10 * MIN, listen: null };
  const PHASE_LABEL = { listen: 'Đang nghe', copy: '10 phút chép', read: 'Reading', write: 'Writing' };
  const WARN = [10, 1];   // cảnh báo khi còn 10 phút và còn 1 phút

  function create(style, phase, now) {
    return { v: 1, style, phase, limit: style === 'mock' ? LIMIT[phase] : null, used: {}, runFrom: now, pausedAt: null, pauses: [], beat: now, warned: [] };
  }
  const running = (c) => c.runFrom != null;
  function phaseUsed(c, now) { return (c.used[c.phase] || 0) + (running(c) ? Math.max(0, now - c.runFrom) : 0); }
  function totalUsed(c, now) {
    let s = 0;
    for (const k of Object.keys(c.used)) s += c.used[k] || 0;
    return s + (running(c) ? Math.max(0, now - c.runFrom) : 0);
  }
  function remaining(c, now) { return c.limit == null ? null : Math.max(0, c.limit - phaseUsed(c, now)); }
  function deadline(c, now) { return running(c) && c.limit != null ? now + remaining(c, now) : null; }
  // Mốc hết giờ thật của đoạn đang chạy (kể cả khi đã quá giờ): runFrom + phần còn lại lúc bắt đầu đoạn.
  function endAt(c) { return running(c) && c.limit != null ? c.runFrom + c.limit - (c.used[c.phase] || 0) : null; }
  function expired(c, now) { const r = remaining(c, now); return r != null && r <= 0; }

  // Dừng đồng hồ tại mốc `at` (mặc định bây giờ). Trả về true nếu vừa dừng.
  function pause(c, now, at) {
    if (!running(c)) return false;
    const t = at != null ? Math.max(c.runFrom, Math.min(at, now)) : now;
    c.used[c.phase] = (c.used[c.phase] || 0) + Math.max(0, t - c.runFrom);
    c.runFrom = null; c.pausedAt = t; c.beat = t;
    return true;
  }
  // Chạy tiếp. Lần dừng ngắn hơn minMs (vd hộp hỏi của iOS làm app "ẩn" 2 ms) không ghi là một lần dừng.
  // Trả về số ms đã dừng (null nếu đồng hồ đang chạy sẵn).
  function resume(c, now, minMs = 0) {
    if (running(c)) return null;
    const ms = c.pausedAt != null ? Math.max(0, now - c.pausedAt) : 0;
    if (c.pausedAt != null && ms >= minMs) c.pauses.push({ at: c.pausedAt, ms });
    c.runFrom = now; c.pausedAt = null; c.beat = now;
    return ms;
  }
  // App bị tắt hẳn (không kịp chạy sự kiện pagehide) lúc đồng hồ đang chạy: coi như dừng từ lần cuối app còn sống (beat).
  function recover(c, now) {
    if (!running(c)) return false;
    pause(c, now, c.beat || now);
    return true;
  }
  // Chuyển giai đoạn (Listening: 'listen' → 'copy'). Giữ nguyên trạng thái chạy/dừng.
  function setPhase(c, phase, now) {
    const was = running(c);
    if (was) { c.used[c.phase] = (c.used[c.phase] || 0) + Math.max(0, now - c.runFrom); c.runFrom = now; }
    c.phase = phase;
    c.limit = c.style === 'mock' ? LIMIT[phase] : null;
    c.used[phase] = c.used[phase] || 0;
  }
  // Mốc cảnh báo vừa qua (10 hoặc 1 phút) chưa báo lần nào; null nếu không có. Đã báo 1 phút thì không báo 10 phút nữa.
  function warnDue(c, now) {
    const r = remaining(c, now);
    if (r == null || r <= 0) return null;
    for (const m of [...WARN].sort((a, b) => a - b)) {
      const key = c.phase + ':' + m;
      if (r <= m * MIN && c.limit > m * MIN && !c.warned.includes(key)) {
        for (const m2 of WARN) if (m2 >= m && !c.warned.includes(c.phase + ':' + m2)) c.warned.push(c.phase + ':' + m2);
        return m;
      }
    }
    return null;
  }
  function pauseTotal(c) { return (c.pauses || []).reduce((s, p) => s + p.ms, 0); }
  function fmt(ms) {
    if (ms == null || !isFinite(ms)) return '–';
    const s = Math.max(0, Math.round(ms / 1000));
    // Dưới 100 phút ghi phút:giây (đồng hồ Reading/Writing bắt đầu "60:00"), dài hơn thì giờ:phút:giây.
    if (s < 6000) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
  }
  const mins = (ms) => Math.round((ms || 0) / MIN);
  // "đã dừng 2 lần, tổng 4 phút" (dưới 1 phút thì ghi giây).
  function pauseText(c) {
    const n = (c.pauses || []).length;
    if (!n) return 'không dừng lần nào';
    const t = pauseTotal(c);
    return `đã dừng ${n} lần, tổng ${t < MIN ? Math.round(t / 1000) + ' giây' : mins(t) + ' phút'}`;
  }
  // Thời gian làm bài: "52 phút (nghe 31 + chép 8)" cho Listening thi thử.
  function usedText(c, now) {
    const u = (k) => mins((c.used[k] || 0) + (running(c) && c.phase === k ? Math.max(0, now - c.runFrom) : 0));
    const tot = mins(totalUsed(c, now));
    if (c.used.listen != null || c.phase === 'listen') return `${tot} phút (nghe ${u('listen')}${c.used.copy != null || c.phase === 'copy' ? ` + chép ${u('copy')}` : ''})`;
    return `${tot} phút`;
  }

  // ---------- Writing ----------
  // Đếm từ như cách đếm thông thường: các cụm cách nhau bởi khoảng trắng, có ít nhất một chữ hoặc số.
  function words(text) { return String(text || '').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length; }
  const MIN_WORDS = { t1: 150, t2: 250 };

  // Prompt chấm Writing để dán sang app AI (Claude, …). Không chứa nội dung Cambridge: đề do Minh gõ hoặc đính ảnh trang của sách của Minh.
  function aiPrompt(o) {
    const L = [];
    L.push('Bạn là giám khảo IELTS Writing (Academic). Hãy chấm bài viết dưới đây theo band descriptors công khai của IELTS.');
    L.push('');
    const img = o.images ? 'Đề bài nằm trong ảnh trang sách đính kèm.' : 'Nếu tin nhắn có ảnh trang sách thì đề bài nằm trong ảnh đó.';
    L.push(`Nguồn đề: Cambridge IELTS ${o.book || '?'}, Test ${o.test || '?'}. ${img} Nếu không thấy đề (không có ảnh, không có đề gõ dưới đây) thì hỏi lại tôi, không tự đoán đề.`);
    L.push('');
    L.push('Yêu cầu:');
    L.push('1. Với từng Task, cho band (0–9, bước 0,5) theo 4 tiêu chí: Task 1 là Task Achievement, Task 2 là Task Response; cả hai có Coherence and Cohesion, Lexical Resource, Grammatical Range and Accuracy. Mỗi tiêu chí nêu 2–3 lý do, trích nguyên văn câu trong bài để minh họa.');
    L.push('2. Band của từng Task và band Writing ước lượng (Task 2 tính gấp đôi Task 1).');
    L.push(`3. Số từ app đếm: ${o.t1 ? `Task 1 ${o.w1} từ` : 'Task 1 không làm'}, ${o.t2 ? `Task 2 ${o.w2} từ` : 'Task 2 không làm'}. Thiếu số từ tối thiểu (Task 1: 150, Task 2: 250) thì nói rõ và tính vào điểm.`);
    L.push('4. Bảng lỗi quan trọng nhất (tối đa 15): câu gốc → câu sửa → lý do (ngữ pháp, từ vựng, mạch lạc).');
    L.push('5. Viết lại đoạn yếu nhất của mỗi Task ở mức cao hơn khoảng 1 band, giữ ý của tôi.');
    L.push('6. 3 việc nên ưu tiên sửa ở bài sau.');
    L.push('7. Chỗ nào không chắc (vd ảnh đề mờ, không rõ yêu cầu đề) thì nói thẳng. Đây là điểm tham khảo, không phải điểm thi.');
    L.push('Trả lời bằng tiếng Việt; giữ nguyên tiếng Anh khi trích câu và khi dùng thuật ngữ chấm.');
    if (o.minutes != null) L.push(`Thời gian tôi làm bài: ${o.minutes} phút.`);
    const task = (n, prompt, text, w) => {
      L.push('');
      L.push(`=== Task ${n}${text ? ` (${w} từ)` : ''} ===`);
      if (prompt && prompt.trim()) { L.push('Đề (tôi gõ lại):'); L.push(prompt.trim()); L.push(''); L.push('Bài làm:'); }
      L.push(text && text.trim() ? text.trim() : '(không làm)');
    };
    task(1, o.p1, o.t1, o.w1);
    task(2, o.p2, o.t2, o.w2);
    return L.join('\n');
  }

  return { MIN, LIMIT, PHASE_LABEL, create, running, phaseUsed, totalUsed, remaining, deadline, endAt, expired, pause, resume, recover, setPhase, warnDue,
    pauseTotal, pauseText, usedText, fmt, mins, words, MIN_WORDS, aiPrompt };
});
