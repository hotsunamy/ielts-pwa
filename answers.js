// Mốc 5: nhập đáp án (key), phiếu trả lời khi làm đề, nộp bài, chấm, xem kết quả (m5-1);
// đồng hồ, tạm dừng theo rời app, hỏi tiếp tục/bỏ, tự nộp khi hết giờ, kiểu Thi thử / Luyện, phiếu co khi bàn phím bật,
// ô gõ bài Writing + nút chấm bằng AI (m5-2).
// Không có đáp án nào trong code: key do Minh dán/gõ, lưu trong máy (localStorage); m6-1: đồng bộ giữa các máy qua sync.js (vùng ẩn Drive).
//   ielts.keys     {[quyển]: {[T1L..T4R]: {items: {n: chuỗi}, groups: [[a..b]], checked: [chỉ số cụm đã soát], src, at, edits}}}
//   ielts.attempts [{id, book, seg, style: 'mock'|'practice', fileId, fileName, startedAt, updatedAt, answers: {n: chuỗi} | {t1, t2, p1, p2} (Writing),
//                    submittedAt, overrides: {n: true}, score, total, clock (xem clock.js), phase, deadline, timeUsedMs, autoSubmitted,
//                    skipParts: [Part thiếu audio, thi thử], audioPos: {idx, t}}]
//   ielts.pdfcfg[fileId].keypage {[T1L..T4R]: trang PDF của đáp án phần đó} (m5-2 mục 3.5)
// Khung bên phải trình xem PDF (máy tính) hoặc dải dưới đáy (điện thoại): phiếu trả lời / bài viết (làm đề), nhập đáp án (ôn tập), kết quả.
'use strict';
(function () {
  const KEYS_KEY = 'ielts.keys', ATT_KEY = 'ielts.attempts', SIDE_KEY = 'ielts.sidecollapsed', PCFG_KEY = 'ielts.pdfcfg';
  const G = Grade, S = Sections, C = Clock;
  const N = G.N;
  const HIDE_MIN = 50;   // lần "ẩn" ngắn hơn (vd hộp hỏi của iOS) không tính là tạm dừng
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const L = (msg) => { if (typeof log === 'function') log(msg); };
  const INPUT_ATTR = 'autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"';
  const QSEGS = []; for (let t = 1; t <= 4; t++) QSEGS.push(`T${t}L`, `T${t}R`);
  const isQSeg = (k) => /^T[1-4][LR]$/.test(k || '');
  const isWSeg = (k) => /^T[1-4]W$/.test(k || '');
  const skillOf = (seg) => seg[2];
  const testOf = (seg) => Number(seg[1]);
  const STYLE = { mock: 'Thi thử', practice: 'Luyện' };
  const hhmm = (t) => new Date(t).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  const now = () => Date.now();
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const phone = () => window.matchMedia && matchMedia('(max-width: 760px)').matches;

  // ---------- Lưu trong máy ----------
  function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (_) { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); if (window.Sync) Sync.touched(k); return true; } catch (e) { L('Không lưu được vào máy: ' + e.message); return false; } }
  function getKey(book, seg) { const all = loadJSON(KEYS_KEY, {}); return (all[book] || {})[seg] || null; }
  function setKey(book, seg, k) {
    const all = loadJSON(KEYS_KEY, {});
    all[book] = all[book] || {};
    if (k) all[book][seg] = k; else delete all[book][seg];
    if (!Object.keys(all[book]).length) delete all[book];
    saveJSON(KEYS_KEY, all);
  }
  function emptyKey() { return { items: {}, groups: [], checked: [], src: '', at: Date.now(), edits: 0 }; }
  function keyFilled(k) { return k ? Object.values(k.items || {}).filter((v) => String(v).trim()).length : 0; }
  function checkedCount(k, seg) {
    if (!k) return 0;
    const cl = G.clusters(skillOf(seg), N);
    return (k.checked || []).reduce((s, i) => s + (cl[i] ? cl[i][1] - cl[i][0] + 1 : 0), 0);
  }
  function attempts() { return loadJSON(ATT_KEY, []); }
  function saveAttempts(list) { saveJSON(ATT_KEY, list.slice(-200)); }
  function putAttempt(a) { const list = attempts(); const i = list.findIndex((x) => x.id === a.id); if (i >= 0) list[i] = a; else list.push(a); saveAttempts(list); }
  const styleOf = (a) => a.style || 'mock';
  function openAttempt(book, seg, style) {
    return attempts().filter((a) => a.book === book && a.seg === seg && !a.submittedAt && styleOf(a) === style).sort((a, b) => b.startedAt - a.startedAt)[0] || null;
  }
  const segLabel = (book, seg) => `Cam ${book} · ${S.LABEL[seg]}`;
  function clusterName(seg, i) { const [a, b] = G.clusters(skillOf(seg), N)[i]; return skillOf(seg) === 'L' ? `Part ${i + 1} · câu ${a}–${b}` : `Câu ${a}–${b}`; }
  const filledOf = (a) => Object.entries((a && a.answers) || {}).filter(([k, v]) => /^\d+$/.test(k) && String(v).trim()).length;
  // Câu bị bỏ khi thi thử thiếu audio (Part thiếu → cả cụm câu của Part đó).
  function skipSet(a) {
    const s = new Set();
    for (const p of (a && a.skipParts) || []) { const c = G.clusters('L', N)[p - 1]; if (c) for (let q = c[0]; q <= c[1]; q++) s.add(q); }
    return s;
  }
  // Chấm, bỏ các câu thuộc Part thiếu audio (nếu có).
  function gradeAtt(k, a) {
    const r = G.grade(k, a.answers, a.overrides || {}, N);
    const skip = skipSet(a);
    if (!skip.size) return r;
    const per = r.per.filter((x) => !skip.has(x.n));
    return { per, score: per.filter((x) => x.status === 'ok' || x.override).length, total: per.length, nokey: per.filter((x) => x.status === 'nokey').length,
      blank: per.filter((x) => x.status === 'blank').length, overridden: per.filter((x) => x.override).length, skipped: skip.size };
  }
  const partsText = (ps) => (ps.length > 1 && ps.every((p, i) => i === 0 || p === ps[i - 1] + 1) ? `Part ${ps[0]}–${ps.at(-1)}` : ps.map((p) => `Part ${p}`).join(', '));
  // Part thiếu audio của Test (thi thử Listening). Quyển không có audio nào, hoặc Test không có file nào: không khóa ô (cả bài làm không audio).
  function missingParts(book, test) {
    if (!window.AudioPlayer) return { parts: [], none: false };
    const d = AudioPlayer.bookAudio(book);
    if (d.none) return { parts: [], none: true };
    if (d.byTest) return { parts: [], none: !d.get(test) };
    const parts = [1, 2, 3, 4].filter((p) => !d.get(test, p));
    return parts.length === 4 ? { parts: [], none: true } : { parts, none: false };
  }

  // ---------- Trạng thái khung bên ----------
  const st = { kind: null, book: null, seg: null, file: null, att: null, style: 'mock', submitted: false, keySeg: null, pollT: null, curPart: null, saveT: null,
    tickT: null, hidAt: null, cover: null, beatSaved: 0, skipNextPage: false, attBase: 0 };
  // m6-1: máy này (đồng bộ). Bài làm ghi kèm máy sửa lần cuối, để biết bài đã được làm tiếp ở máy khác.
  const myDev = () => (window.Sync ? Sync.dev() : 'local');
  const myName = () => (window.Sync ? Sync.name() : '');
  const fromOther = (a) => (a && a.dev && a.dev !== myDev() ? ` trên ${a.devName || 'máy khác'}` : '');

  function side() { return $('v-side'); }
  function collapsed() { return loadJSON(SIDE_KEY, false) === true; }
  function setCollapsed(v) { saveJSON(SIDE_KEY, !!v); const el = side(); if (el) el.classList.toggle('collapsed', !!v); }
  function showSide(html) {
    const el = side();
    el.hidden = false;
    el.classList.toggle('collapsed', collapsed());
    el.classList.remove('kb');
    el.innerHTML = html;
  }
  function hideSide() { const el = side(); if (el) { el.hidden = true; el.innerHTML = ''; el.classList.remove('kb'); } stopPoll(); stopTick(); hideCover(); st.kind = null; }
  function head(title, extra = '') {
    return `<div class="vs-head"><button class="small secondary vs-tog" data-a="toggle" aria-label="Thu gọn / mở">${collapsed() ? '▴' : '▾'}</button><b class="vs-title">${title}</b>${extra}</div>`;
  }
  const isWork = () => (st.kind === 'sheet' || st.kind === 'wsheet') && st.att && !st.submitted;

  // ---------- Gọi từ trình xem PDF ----------
  // ctx: {file, mode, style, segKey, panel: {kind: 'key', seg}}
  function onOpen(ctx) {
    st.file = ctx.file; st.book = ctx.file.book;
    st.submitted = false; st.att = null; st.style = ctx.style === 'practice' ? 'practice' : 'mock';
    if (ctx.mode === 'exam' && isQSeg(ctx.segKey) && st.book) { openSheet(ctx.segKey); return; }
    if (ctx.mode === 'exam' && isWSeg(ctx.segKey) && st.book) { openWriting(ctx.segKey); return; }
    if (ctx.mode !== 'exam' && ctx.panel && ctx.panel.kind === 'key' && st.book) { st.skipNextPage = true; openKeys(ctx.panel.seg); return; }
    hideSide();
  }
  // Đóng trình xem: bài đang làm thì tạm dừng đồng hồ (mở lại sẽ hỏi tiếp tục hay bỏ).
  function onClose() {
    if (isWork() && st.att.clock && C.running(st.att.clock)) { pauseClock('đóng bài'); }
    flush(); exitKb(); hideSide(); st.file = null; st.att = null;
  }
  function blocksClose() { return isWork(); }
  // Hỏi trước khi mở bài thi thử Listening thiếu audio (Viewer gọi trước khi mở PDF). Trả về false nếu Minh không muốn làm.
  function preflight(book, seg, style) {
    if (style !== 'mock' || !/^T[1-4]L$/.test(seg || '')) return true;
    const m = missingParts(book, testOf(seg));
    if (m.none) return confirm(`Cam ${book} Test ${testOf(seg)} chưa có audio. Thi thử Listening sẽ không có audio: đồng hồ đếm thời gian làm, bấm "Bắt đầu 10 phút chép" khi xong. Vẫn làm?`);
    if (!m.parts.length) return true;
    const skip = [...skipSet({ skipParts: m.parts })];
    return confirm(`Cam ${book} Test ${testOf(seg)} thiếu audio ${partsText(m.parts)}. Thi thử chỉ nghe phần có audio; ô câu ${partsQText(m.parts)} bị khóa, điểm tính trên ${N - skip.length} câu (tới khi có đủ audio). Vẫn làm?`);
  }
  function partsQText(ps) { return ps.map((p) => { const c = G.clusters('L', N)[p - 1]; return `${c[0]}–${c[1]}`; }).join(', '); }

  // ---------- Bài làm và đồng hồ ----------
  function newAttempt(seg) {
    const t = now();
    const sk = skillOf(seg);
    const a = { id: t.toString(36) + Math.random().toString(36).slice(2, 6), book: st.book, seg, style: st.style, fileId: st.file.id, fileName: st.file.name, dev: myDev(), devName: myName(),
      startedAt: t, updatedAt: t, answers: {}, submittedAt: null, overrides: {}, score: null, total: sk === 'W' ? null : N,
      clock: C.create(st.style, sk === 'L' ? 'listen' : sk === 'R' ? 'read' : 'write', t), skipParts: [] };
    if (sk === 'L' && st.style === 'mock') { const m = missingParts(st.book, testOf(seg)); a.skipParts = m.parts; a.noAudio = m.none; }
    syncFields(a);
    return a;
  }
  // Trường phẳng (mục 5D handover 16/10) lấy từ đồng hồ, để đọc nhanh: phase, deadline, pauses, timeUsedMs.
  function syncFields(a) {
    const c = a.clock; if (!c) return;
    const t = now();
    a.phase = c.phase; a.deadline = C.deadline(c, t); a.pauses = c.pauses; a.timeUsedMs = C.totalUsed(c, t); a.remainMs = C.remaining(c, t);
  }
  function save() {
    if (!st.att) return;
    if (checkMoved()) return;
    st.att.updatedAt = now(); st.att.dev = myDev(); st.att.devName = myName();
    if (st.att.clock) syncFields(st.att);
    putAttempt(st.att);
    st.attBase = st.att.updatedAt;
  }
  // m6-1 (Minh chốt 18/10, câu 1a): bài dở được làm tiếp ở máy khác thì bài chuyển sang máy đó. Máy này thấy bản trong máy
  // (vừa đồng bộ về) mới hơn lần lưu cuối của mình và do máy khác ghi → dừng bài, không ghi đè.
  function checkMoved() {
    const a = st.att;
    if (!a || st.submitted || !(st.kind === 'sheet' || st.kind === 'wsheet')) return false;
    const cur = attempts().find((x) => x.id === a.id);
    if (cur && (!cur.dev || cur.dev === myDev() || (cur.updatedAt || 0) <= (st.attBase || 0))) return false;
    if (!cur && !(window.Sync && Sync.on() && st.attBase)) return false;
    if (!cur) {   // máy khác đã bỏ bài này (Bỏ bài này, làm lại) và dấu xóa vừa đồng bộ về
      const any = (window.Sync && Sync._META['ielts.attempts'] || {})[a.id];
      if (!any || any[1] === myDev()) return false;
    }
    moved(cur);
    return true;
  }
  function moved(cur) {
    const a = st.att, seg = st.seg;
    stopTick(); stopPoll(); exitKb(); clearTimeout(st.saveT);
    const who = cur ? (cur.devName || 'máy khác') : 'máy khác';
    L(`Bài làm ${segLabel(a.book, seg)}: ${cur ? `đã được làm tiếp trên ${who} lúc ${hhmm(cur.updatedAt)}${cur.submittedAt ? ' và đã nộp' : ''}` : `đã bị bỏ trên ${who}`}; máy này dừng bài, không ghi đè.`);
    st.att = null; st.kind = 'moved';
    if (window.AudioPlayer && AudioPlayer.isOpen()) { try { $('ap-audio').pause(); } catch (_) {} }
    const el = $('v-cover'); if (!el) return;
    st.cover = 'moved';
    el.innerHTML = `<div class="vc-box"><p><b>${cur ? `Bài này đã được làm tiếp trên ${esc(who)}` : `Bài này đã bị bỏ trên ${esc(who)}`}</b>${cur ? ` lúc ${esc(hhmm(cur.updatedAt))}${isWSeg(seg) ? '' : ` (${filledOf(cur)}/${N} ô)`}${cur.submittedAt ? ', đã nộp' : ''}` : ''}.</p>
      <p class="hint">Máy này dừng ở đây để không ghi đè phần đã làm ở máy kia. Muốn làm tiếp trên máy này: đóng rồi mở lại phần này.</p>
      <div class="row"><button data-a="closeviewer">Đóng</button></div></div>`;
    el.hidden = false;
  }
  function clockText() {
    const a = st.att, c = a && a.clock;
    if (!a) return '';
    if (!c) return 'không tính giờ';
    const t = now();
    if (st.submitted) return `đã nộp · ${C.usedText(c, t)}`;
    if (c.limit != null) {
      const r = C.remaining(c, t);
      return `${c.phase === 'copy' ? '10 phút chép · ' : ''}còn ${C.fmt(r)}${C.running(c) ? '' : ' (đang dừng)'}`;
    }
    if (c.phase === 'listen' && st.style === 'mock') {
      const ap = window.AudioPlayer && AudioPlayer._st;
      const part = ap && ap.open && ap.mode === 'exam' && ap.list && ap.list[ap.idx] ? ap.list[ap.idx].part : null;
      return `Đang nghe${part ? ` · Part ${part}` : ''} · đã làm ${C.fmt(C.phaseUsed(c, t))}${C.running(c) ? '' : ' (đang dừng)'}`;   // m5-2b mục b: thời gian từ lúc mở đề, không phải vị trí audio
    }
    return `${STYLE.practice} · đã làm ${C.fmt(C.totalUsed(c, t))}${C.running(c) ? '' : ' (đang dừng)'}`;
  }
  function drawClock() {
    const txt = clockText();
    for (const id of ['as-clock', 'as-kbclock']) { const el = $(id); if (el) el.textContent = txt; }
    const c = st.att && st.att.clock;
    const r = c && c.limit != null && !st.submitted ? C.remaining(c, now()) : null;
    const el = $('as-clock'); if (el) el.classList.toggle('low', r != null && r <= 10 * C.MIN);
  }
  function startTick() {
    stopTick();
    drawClock();
    st.tickT = setInterval(tick, 1000);
  }
  function stopTick() { clearInterval(st.tickT); st.tickT = null; }
  function tick() {
    const a = st.att;
    if (!a || st.submitted || !isWork()) { drawClock(); return; }
    const c = a.clock;
    if (c && C.running(c)) {
      const t = now();
      c.beat = t;
      const ap = window.AudioPlayer && AudioPlayer.examPos && AudioPlayer.examPos();
      if (ap) a.audioPos = ap;
      const w = C.warnDue(c, t);
      if (w) warn(w);
      if (C.expired(c, t)) { drawClock(); autoSubmit(); return; }
      if (t - st.beatSaved > 5000) { st.beatSaved = t; save(); }
    }
    drawClock();
  }
  function warn(m) {
    const msg = `Còn ${m} phút${st.att.clock.phase === 'copy' ? ' chép đáp án' : ''}.`;
    L(`Bài làm ${segLabel(st.book, st.seg)}: cảnh báo ${msg}`);
    if (window.Viewer && Viewer.flash) Viewer.flash(msg, 6000);
    try { if (navigator.vibrate) navigator.vibrate(m === 1 ? [200, 100, 200] : 200); } catch (_) {}
    save();
  }
  function pauseClock(why) {
    const c = st.att && st.att.clock;
    if (!c || !C.running(c)) return false;
    const t = now();
    C.pause(c, t);
    const ap = window.AudioPlayer && AudioPlayer.examPos && AudioPlayer.examPos();
    if (ap) st.att.audioPos = ap;
    save();
    L(`Bài làm ${segLabel(st.book, st.seg)} (${STYLE[st.style]}): tạm dừng (${why}), ${clockText()}.`);
    drawClock();
    return true;
  }
  function resumeClock(why, minMs = 0) {
    const c = st.att && st.att.clock;
    if (!c || C.running(c) || st.submitted) return;
    const ms = C.resume(c, now(), minMs);
    save();
    if (ms >= minMs) L(`Bài làm ${segLabel(st.book, st.seg)} (${STYLE[st.style]}): tiếp tục (${why}) sau ${Math.round(ms / 1000)} s dừng, ${C.pauseText(c)}.`);
    drawClock();
  }

  // Lớp che đề (thi thử): khi quay lại app sau khi rời, hoặc mở lại bài làm dở. Che cả trang đề lẫn phiếu tới khi bấm Tiếp tục.
  function showCover(kind) {
    const el = $('v-cover'); if (!el || !st.att) return;
    st.cover = kind;
    const a = st.att, c = a.clock, t = now();
    const left = c && c.limit != null ? `còn ${C.fmt(C.remaining(c, t))}` : c ? `đã làm ${C.fmt(C.totalUsed(c, t))}` : '';
    let html;
    if (kind === 'resume') {
      html = `<p><b>${esc(segLabel(a.book, a.seg))}</b> (${STYLE[styleOf(a)]}) bắt đầu ${esc(hhmm(a.startedAt))}${esc(fromOther(a))}, chưa nộp.</p>
        <p>${c ? `Đã làm ${C.fmt(C.totalUsed(c, t))}${c.limit != null ? `, ${left}${c.phase === 'copy' ? ' của 10 phút chép' : ''}` : ''}. ${esc(cap(C.pauseText(c)))}.` : 'Bài này làm từ bản cũ, không tính giờ.'}
          ${isWSeg(a.seg) ? '' : `${filledOf(a)}/${N} ô đã điền.`}</p>
        <p class="vc-q">Tiếp tục hay bỏ bài này?</p>
        <div class="row"><button data-a="cont">Tiếp tục</button><button class="secondary" data-a="abandon">Bỏ bài này, làm lại</button></div>`;
    } else {
      const at = c ? C.fmt(C.totalUsed(c, t)) : '';
      html = `<p><b>Đã tạm dừng</b> ở ${at}${left && c.limit != null ? `, ${left}` : ''}.</p>
        <p class="hint">Rời app (khóa màn hình, chuyển app/tab) nên ${skillOf(a.seg) === 'L' ? 'audio và ' : ''}đồng hồ đã dừng. Đề được che tới khi bấm Tiếp tục.</p>
        <div class="row"><button data-a="cont">Tiếp tục</button></div>`;
    }
    el.innerHTML = `<div class="vc-box">${html}</div>`;
    el.hidden = false;
  }
  function hideCover() { const el = $('v-cover'); if (el) { el.hidden = true; el.innerHTML = ''; } st.cover = null; }
  function coverContinue() {
    if (checkMoved()) return;
    const was = st.cover;
    hideCover();
    resumeClock(was === 'resume' ? 'mở lại bài' : 'quay lại app');
    // Listening: nghe tiếp đúng chỗ (bấm Phát trong cùng thao tác bấm, để iPhone cho phát).
    if (st.seg && skillOf(st.seg) === 'L' && window.AudioPlayer && AudioPlayer.isOpen()) {
      const ap = AudioPlayer._st;
      const wasPlaying = ap.hidePaused != null || (was === 'resume' && st.att && st.att.audioPos && st.att.clock && st.att.clock.phase === 'listen');
      if (wasPlaying && !(ap.loaded && !$('ap-audio').paused)) $('ap-play').click();
    }
  }
  function onCoverClick(e) {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    if (b.dataset.a === 'cont') coverContinue();
    if (b.dataset.a === 'abandon') abandon();
    if (b.dataset.a === 'closeviewer' && window.Viewer) { hideCover(); Viewer.close(true); }
  }
  // Bấm Phát trên thanh audio khi đồng hồ đang dừng (thi thử Listening): chạy tiếp cùng audio.
  function onAudioPlay() {
    if (!isWork() || st.style !== 'mock') return;
    const c = st.att.clock;
    if (c && !C.running(c)) { hideCover(); resumeClock('bấm Phát'); }
  }
  // Phát hết audio của Test (thi thử): sang 10 phút chép.
  function onAudioDone() {
    if (!isWork() || st.style !== 'mock' || skillOf(st.seg) !== 'L') return;
    startCopy('phát hết audio');
  }
  function startCopy(why) {
    const c = st.att.clock;
    if (!c || c.phase !== 'listen') return;
    C.setPhase(c, 'copy', now());
    if (!C.running(c)) C.resume(c, now(), Infinity);
    save();
    L(`Bài làm ${segLabel(st.book, st.seg)}: ${why}, bắt đầu 10 phút chép (nghe ${C.fmt(c.used.listen)}).`);
    if (window.Viewer && Viewer.flash) Viewer.flash('Hết audio: 10 phút chép đáp án. Xong sớm thì bấm "Nộp luôn".', 6000);
    renderSheetFoot();
    drawClock();
  }

  // ---------- Rời app / quay lại ----------
  function onVis() {
    if (!isWork()) return;
    if (document.visibilityState === 'hidden') {
      flush();
      if (st.att.clock && C.running(st.att.clock)) { st.hidAt = now(); pauseClock('rời app'); }
      return;
    }
    if (st.hidAt == null) return;
    const ms = now() - st.hidAt;
    st.hidAt = null;
    if (ms < HIDE_MIN) { resumeClock('ẩn rất ngắn', HIDE_MIN); return; }
    if (st.style === 'mock') { L(`Bài làm ${segLabel(st.book, st.seg)}: quay lại app sau ${Math.round(ms / 1000)} s, che đề chờ bấm Tiếp tục.`); showCover('pause'); }
    // Luyện: chạy tiếp ngay, nhưng đang đồng bộ (vừa quay lại app) thì chờ xong (tối đa 3 s) để biết bài có được làm tiếp ở máy khác không.
    else if (window.Sync && Sync.on()) Sync.whenFresh(3000).then(() => { if (isWork() && !checkMoved()) resumeClock('quay lại app'); });
    else resumeClock('quay lại app');
  }

  // ---------- Phiếu trả lời (Listening, Reading) ----------
  function openSheet(seg) {
    st.kind = 'sheet'; st.seg = seg;
    let att = openAttempt(st.book, seg, st.style);
    const resumed = !!att;
    if (att && att.clock) {
      if (C.recover(att.clock, now())) L(`Bài làm ${segLabel(st.book, seg)}: app đã bị tắt khi đồng hồ đang chạy, tính là dừng từ ${new Date(att.clock.pausedAt).toLocaleTimeString('vi-VN')}.`);
    }
    if (!att) { att = newAttempt(seg); putAttempt(att); }
    st.att = att; st.attBase = att.updatedAt || 0;
    L(`Bài làm ${segLabel(st.book, seg)} (${STYLE[styleOf(att)]}): ${resumed ? `làm tiếp bài bắt đầu ${hhmm(att.startedAt)}${fromOther(att)} (${filledOf(att)} ô đã điền${att.clock ? `, ${clockText()}` : ', không tính giờ'})` : `bài mới${att.clock && att.clock.limit ? `, đồng hồ ${C.mins(att.clock.limit)} phút` : ''}`}` +
      `${(att.skipParts || []).length ? `, thiếu audio ${partsText(att.skipParts)} (khóa câu ${partsQText(att.skipParts)})` : ''}.`);
    renderSheet(resumed);
    if (skillOf(seg) === 'L' && att.audioPos && window.AudioPlayer && st.style === 'mock') AudioPlayer.examStartAt(att.audioPos);
    startPoll();
    startTick();
    if (resumed && att.clock) showCover('resume');
  }
  function renderSheet(resumed) {
    const seg = st.seg, cl = G.clusters(skillOf(seg), N);
    const a = st.att;
    const ans = (a && a.answers) || {};
    const skip = skipSet(a);
    const blocks = cl.map(([x, y], i) => {
      let rows = '';
      for (let q = x; q <= y; q++) {
        const off = skip.has(q);
        rows += `<label class="qrow${off ? ' off' : ''}"><span class="qn">${q}</span><input class="qin" data-q="${q}" ${INPUT_ATTR} enterkeyhint="next" value="${esc(ans[q] || '')}"${off ? ' disabled placeholder="thiếu audio"' : ''}></label>`;
      }
      return `<div class="qblock" data-c="${i}"><div class="qbh">${esc(clusterName(seg, i))}</div><div class="qgrid">${rows}</div></div>`;
    }).join('');
    const notes = [];
    if (resumed) notes.push(`<p class="hint" id="as-resume">Làm tiếp bài bắt đầu ${esc(hhmm(a.startedAt))} (chưa nộp${a.clock ? '' : ', bài từ bản cũ: không tính giờ'}). <button class="small secondary" data-a="abandon">Bỏ bài này, làm lại</button></p>`);
    if (skip.size) notes.push(`<p class="warn" id="as-skip">Thiếu audio ${esc(partsText(a.skipParts))}: ô câu ${esc(partsQText(a.skipParts))} khóa, điểm tính trên ${N - skip.size} câu.</p>`);
    showSide(`${head(`Phiếu trả lời <span class="hint" id="as-count">${filledOf(a)}/${N - skip.size}</span>`, ` <span id="as-clock" class="aclock"></span>`)}
      <div class="kbl"><button class="small secondary" data-a="qprev" aria-label="Ô trước">‹</button></div>
      <div class="vs-body">
        ${notes.join('')}
        ${blocks}
        <div id="as-foot"></div>
        <p class="hint" id="as-saved">Mỗi ô tự lưu trong máy khi gõ. Đóng app giữa chừng, mở lại phần này sẽ hỏi làm tiếp hay bỏ.</p>
      </div>
      <div class="kbr"><button class="small secondary" data-a="qnext" aria-label="Ô sau">›</button><span id="as-kbclock" class="aclock"></span></div>`);
    renderSheetFoot();
    markCurPart(true);
  }
  function renderSheetFoot() {
    const el = $('as-foot'); if (!el || !st.att) return;
    const c = st.att.clock;
    const copy = c && c.phase === 'copy';
    const noAudio = st.style === 'mock' && skillOf(st.seg) === 'L' && c && c.phase === 'listen' && st.att.noAudio;
    el.innerHTML = `<div class="row"><button data-a="submit" id="as-submit">${copy ? 'Nộp luôn' : 'Nộp bài'}</button>
      ${noAudio ? '<button class="secondary" data-a="startcopy" id="as-startcopy">Bắt đầu 10 phút chép</button>' : ''}</div>
      ${copy ? '<p class="hint">Đang trong 10 phút chép đáp án. Hết giờ app tự nộp; xong sớm thì bấm "Nộp luôn".</p>' : ''}`;
  }
  function onSheetInput(inp) {
    const q = Number(inp.dataset.q);
    if (!st.att || st.submitted) return;
    st.att.answers[q] = inp.value;
    st.att.updatedAt = now();
    const c = $('as-count'); if (c) c.textContent = `${filledOf(st.att)}/${N - skipSet(st.att).size}`;
    clearTimeout(st.saveT);
    st.saveT = setTimeout(flush, 300);
  }
  function flush() {
    clearTimeout(st.saveT);
    if (isWork()) {
      save();
      const el = $('as-saved'); if (el) el.textContent = `Đã lưu trong máy lúc ${new Date(st.att.updatedAt).toLocaleTimeString('vi-VN')}.`;
    }
  }
  function submit(auto) {
    if (!isWork()) return;
    flush();
    const a = st.att;
    const wr = isWSeg(st.seg);
    const skip = skipSet(a);
    const blank = wr ? 0 : N - skip.size - filledOf(a);
    if (!auto) {
      const q = wr ? `Nộp bài ${S.LABEL[st.seg]}? Task 1: ${C.words(a.answers.t1)} từ, Task 2: ${C.words(a.answers.t2)} từ.`
        : `Nộp bài ${S.LABEL[st.seg]}?${blank ? ` Còn ${blank} ô trống.` : ''}`;
      if (!confirm(q)) return;
    }
    const t = now();
    // Tự nộp: tính giờ tới đúng mốc hết giờ (đồng hồ chỉ kiểm mỗi giây, máy chậm có thể trễ vài giây).
    if (a.clock && C.running(a.clock)) { const dl = auto ? C.endAt(a.clock) : null; C.pause(a.clock, t, dl != null ? Math.min(t, dl) : t); }
    if (a.clock) a.clock.pausedAt = null;
    a.submittedAt = t;
    a.autoSubmitted = !!auto;
    if (a.clock) syncFields(a);
    exitKb();
    hideCover();
    const k = wr ? null : getKey(st.book, st.seg);
    if (k && keyFilled(k)) a.score = gradeAtt(k, a).score;
    a.total = wr ? null : N - skip.size;
    if (checkMoved()) return;
    a.dev = myDev(); a.devName = myName(); a.updatedAt = t;
    putAttempt(a);
    st.submitted = true;
    if (window.Sync) Sync.soon('nộp bài');
    stopPoll();
    const time = a.clock ? `thời gian ${C.usedText(a.clock, t)}, ${C.pauseText(a.clock)}` : `từ lúc bắt đầu tới lúc nộp ${Math.round((t - a.startedAt) / 60000)} phút (không tính giờ)`;
    if (wr) L(`Nộp bài ${segLabel(st.book, st.seg)} (${STYLE[styleOf(a)]}${auto ? ', tự nộp khi hết giờ' : ''}): Task 1 ${C.words(a.answers.t1)} từ, Task 2 ${C.words(a.answers.t2)} từ, ${time}.`);
    else L(`Nộp bài ${segLabel(st.book, st.seg)} (${STYLE[styleOf(a)]}${auto ? ', tự nộp khi hết giờ' : ''}): ${k && keyFilled(k) ? `${a.score}/${a.total}` : 'chưa có đáp án để chấm'}, trống ${blank} ô` +
      (skip.size ? `, bỏ ${skip.size} câu thiếu audio` : '') + (k ? `, key đã soát ${checkedCount(k, st.seg)}/${N}` : '') + `, ${time}.`);
    st.kind = 'result';
    showSide(head(`Kết quả`) + `<div class="vs-body" id="as-result"></div>`);
    renderResult($('as-result'), a.id, { inViewer: true });
    // Listening thi thử: thanh audio sang ôn tập (tua, tốc độ, A-B) để soát lại.
    if (skillOf(a.seg) === 'L' && window.AudioPlayer && AudioPlayer.isOpen()) AudioPlayer.toReview();
    stopTick();
  }
  function autoSubmit() {
    if (!isWork()) return;
    if (window.Viewer && Viewer.flash) Viewer.flash('Hết giờ: app đã khóa ô và tự nộp bài.', 8000);
    submit(true);
  }
  function abandon() {
    if (!st.att || !confirm('Bỏ bài đang làm dở (xóa các ô đã điền) và làm lại từ đầu?')) return;
    const list = attempts().filter((a) => a.id !== st.att.id);
    saveAttempts(list);
    L(`Bài làm ${segLabel(st.book, st.seg)}: bỏ bài bắt đầu ${hhmm(st.att.startedAt)}, làm lại.`);
    hideCover();
    const seg = st.seg;
    st.att = newAttempt(seg); putAttempt(st.att); st.attBase = st.att.updatedAt;
    L(`Bài làm ${segLabel(st.book, seg)} (${STYLE[st.style]}): bài mới${st.att.clock.limit ? `, đồng hồ ${C.mins(st.att.clock.limit)} phút` : ''}.`);
    if (isWSeg(seg)) renderWriting(false); else renderSheet(false);
    if (skillOf(seg) === 'L' && window.AudioPlayer && st.style === 'mock' && AudioPlayer.isOpen()) AudioPlayer.openExam(st.book, testOf(seg));
    startTick();
  }
  // Listening: làm nổi cụm câu của Part đang phát (đọc trạng thái trình phát mỗi giây).
  function startPoll() { stopPoll(); if (skillOf(st.seg) === 'L') st.pollT = setInterval(() => markCurPart(false), 1000); }
  function stopPoll() { clearInterval(st.pollT); st.pollT = null; st.curPart = null; }
  function markCurPart(force) {
    if (st.kind !== 'sheet' || skillOf(st.seg) !== 'L' || !window.AudioPlayer) return;
    const a = AudioPlayer._st;
    const part = a && a.open && a.list && a.list[a.idx] && a.mode === 'exam' ? a.list[a.idx].part : a && a.open && a.practice ? a.part : null;
    if (part === st.curPart && !force) return;
    st.curPart = part;
    const el = side(); if (!el) return;
    el.querySelectorAll('.qblock').forEach((b) => b.classList.toggle('cur', Number(b.dataset.c) === (part || 0) - 1));
    const cur = el.querySelector('.qblock.cur');
    if (cur && !force && !el.contains(document.activeElement)) cur.scrollIntoView({ block: 'nearest' });
  }

  // ---------- Điện thoại: bàn phím bật thì phiếu co còn 1 dòng (m5-2 mục 3.1) ----------
  // Một dòng gồm: nút ô trước, số câu + ô đang gõ, nút ô sau, đồng hồ. Bấm ra ngoài (ô mất focus) thì bung lại đủ 40 ô.
  function enterKb(inp) {
    if (!phone() || st.kind !== 'sheet') return;
    const el = side();
    el.querySelectorAll('.qrow.kbcur').forEach((r) => r.classList.remove('kbcur'));
    el.querySelectorAll('.qblock.kbblk').forEach((r) => r.classList.remove('kbblk'));
    inp.closest('.qrow').classList.add('kbcur');
    inp.closest('.qblock').classList.add('kbblk');
    if (!el.classList.contains('kb')) { el.classList.add('kb'); fitVV(); }
    drawClock();
  }
  function exitKb() {
    const el = side();
    if (!el || !(el.classList.contains('kb') || el.classList.contains('kbw'))) return;
    el.classList.remove('kb', 'kbw');
    const v = $('viewer'); if (v) { v.style.height = ''; v.style.top = ''; }
  }
  // iPhone: bàn phím che phần dưới màn hình mà khung trình xem (position: fixed) không tự co. Co khung theo vùng còn thấy (visualViewport).
  function fitVV() {
    const v = $('viewer'), vv = window.visualViewport, el = side();
    if (!v || !vv || !el || !(el.classList.contains('kb') || el.classList.contains('kbw'))) return;
    v.style.height = Math.round(vv.height) + 'px';
    v.style.top = Math.round(vv.offsetTop) + 'px';
  }
  function moveQ(dir) {
    const list = [...side().querySelectorAll('.qin:not([disabled])')];
    const i = list.indexOf(document.activeElement);
    focusQ(list[i + dir]);
  }
  // Ở dòng thu gọn các ô khác đang ẩn (display: none) nên không nhận focus: hiện ô đích trước rồi mới focus.
  function focusQ(nx) {
    if (!nx) return;
    if (side().classList.contains('kb')) { nx.closest('.qrow').classList.add('kbcur'); nx.closest('.qblock').classList.add('kbblk'); }
    nx.focus();
  }

  // ---------- Writing: ô gõ bài (m5-2) ----------
  function openWriting(seg) {
    st.kind = 'wsheet'; st.seg = seg;
    let att = openAttempt(st.book, seg, st.style);
    const resumed = !!att;
    if (att && att.clock && C.recover(att.clock, now())) L(`Bài làm ${segLabel(st.book, seg)}: app đã bị tắt khi đồng hồ đang chạy, tính là dừng từ ${new Date(att.clock.pausedAt).toLocaleTimeString('vi-VN')}.`);
    if (!att) { att = newAttempt(seg); putAttempt(att); }
    st.att = att; st.attBase = att.updatedAt || 0;
    L(`Bài làm ${segLabel(st.book, seg)} (${STYLE[styleOf(att)]}): ${resumed ? `làm tiếp bài bắt đầu ${hhmm(att.startedAt)}${fromOther(att)} (${clockText()})` : `bài mới${att.clock.limit ? `, đồng hồ ${C.mins(att.clock.limit)} phút` : ''}`}.`);
    renderWriting(resumed);
    startTick();
    if (resumed && att.clock) showCover('resume');
  }
  function renderWriting(resumed) {
    const a = st.att, ans = a.answers || {};
    const task = (n) => `<div class="wtask" data-t="${n}"><div class="qbh">Task ${n} <span class="hint" id="aw-wc${n}">${C.words(ans['t' + n])} từ / tối thiểu ${C.MIN_WORDS['t' + n]}</span></div>
      <details class="wprompt"${ans['p' + n] ? ' open' : ''}><summary>Gõ đề (tùy chọn, để gửi AI chấm)</summary><textarea class="wp" data-k="p${n}" rows="3" ${INPUT_ATTR}>${esc(ans['p' + n] || '')}</textarea></details>
      <textarea class="wt" data-k="t${n}" rows="${n === 1 ? 8 : 12}" ${INPUT_ATTR} placeholder="Gõ bài Task ${n} ở đây">${esc(ans['t' + n] || '')}</textarea></div>`;
    showSide(`${head(`Bài viết`, ` <span id="as-clock" class="aclock"></span>`)}
      <div class="vs-body">
        ${resumed ? `<p class="hint" id="as-resume">Làm tiếp bài bắt đầu ${esc(hhmm(a.startedAt))} (chưa nộp). <button class="small secondary" data-a="abandon">Bỏ bài này, làm lại</button></p>` : ''}
        ${task(1)}${task(2)}
        <div class="row"><button data-a="submit" id="as-submit">Nộp bài</button></div>
        <p class="hint" id="as-saved">Tự lưu trong máy khi gõ. Hết giờ app khóa ô và tự nộp. Nộp xong có nút chấm bằng AI.</p>
      </div>`);
  }
  function onWritingInput(t) {
    if (!st.att || st.submitted) return;
    st.att.answers[t.dataset.k] = t.value;
    st.att.updatedAt = now();
    const m = /^t([12])$/.exec(t.dataset.k);
    if (m) { const el = $('aw-wc' + m[1]); if (el) el.textContent = `${C.words(t.value)} từ / tối thiểu ${C.MIN_WORDS[t.dataset.k]}`; }
    clearTimeout(st.saveT);
    st.saveT = setTimeout(flush, 500);
  }

  // ---------- Chấm Writing bằng AI: chép sang app AI (m5-2, cách 1) ----------
  function aiText(a, withImages) {
    const t = a.answers || {};
    return C.aiPrompt({ book: a.book, test: testOf(a.seg), t1: t.t1, t2: t.t2, p1: t.p1, p2: t.p2, w1: C.words(t.t1), w2: C.words(t.t2),
      minutes: a.clock ? C.mins(C.totalUsed(a.clock, a.submittedAt || now())) : null, images: withImages });
  }
  function aiBox(a, inViewer) {
    const canShare = !!navigator.share;
    return `<div class="aibox"><p><b>Chấm bằng AI (tham khảo)</b></p>
      <p class="warn">Điểm AI chấm chỉ để tham khảo, không phải điểm thi thật. AI có thể chấm lệch, nhất là khi không thấy rõ đề.</p>
      <ul class="plain hint">
        <li>Dán cùng nội dung vào một app AI thứ hai để đối chiếu. Hai bên lệch quá 0,5 band thì đừng tin con số, hãy đọc phần nhận xét lỗi.</li>
        <li>Model gợi ý: Claude (Opus 5.5 hoặc Sonnet 5.5). App khác: chọn model mạnh nhất trong gói của bạn. Không cần bật chế độ suy nghĩ dài.</li>
        <li>Đề Task 1 có biểu đồ nên cần gửi kèm ảnh trang đề${inViewer ? '' : ' (mở lại phần này để lấy ảnh)'}. Muốn AI so với bài mẫu trong sách thì đính thêm ảnh trang bài mẫu (bài mẫu có thể kéo AI chấm theo nó).</li>
      </ul>
      <div class="row">
        ${canShare && inViewer ? '<button class="small" data-ai="share">Chia sẻ sang app AI (chữ + ảnh đề)</button>' : ''}
        <button class="small${canShare && inViewer ? ' secondary' : ''}" data-ai="copy">Chép chữ (prompt + bài làm)</button>
        ${inViewer ? '<button class="small secondary" data-ai="imgs">Lưu ảnh trang đề</button>' : ''}
      </div>
      <p class="hint" id="ai-msg"></p>
      <details><summary>Xem nội dung sẽ gửi</summary><pre class="aipre">${esc(aiText(a, inViewer))}</pre></details></div>`;
  }
  async function pageImages(a) {
    const ctx = window.Viewer && Viewer.ctx();
    if (!ctx || !ctx.doc) return [];
    const pages = S.allowedPages(ctx.segs, a.seg);
    const out = [];
    for (const p of pages) {
      const pg = await ctx.doc.getPage(p);
      const base = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: Math.min(3, 1400 / base.width) });
      const cv = document.createElement('canvas');
      cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
      await pg.render({ canvasContext: cv.getContext('2d', { alpha: false }), viewport: vp }).promise;
      const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.85));
      cv.width = 0;
      if (blob) out.push(new File([blob], `cam${a.book}-test${testOf(a.seg)}-writing-trang${p}.jpg`, { type: 'image/jpeg' }));
    }
    return out;
  }
  async function onAiClick(b, a) {
    const msg = $('ai-msg');
    const set = (t) => { if (msg) msg.textContent = t; };
    const what = b.dataset.ai;
    if (what === 'copy') {
      const t = aiText(a, false);
      try { await navigator.clipboard.writeText(t); set(`Đã chép ${t.length} ký tự. Dán vào app AI, rồi đính ảnh trang đề.`); L(`Writing ${segLabel(a.book, a.seg)}: chép prompt chấm AI (${t.length} ký tự).`); }
      catch (_) { set('Trình duyệt không cho chép tự động: mở "Xem nội dung sẽ gửi", chọn hết rồi chép tay.'); const d = b.closest('.aibox').querySelector('details'); if (d) d.open = true; }
      return;
    }
    b.disabled = true;
    try {
      set('Đang tạo ảnh trang đề…');
      const files = await pageImages(a);
      if (what === 'imgs') {
        for (const f of files) { const u = URL.createObjectURL(f); const x = document.createElement('a'); x.href = u; x.download = f.name; document.body.appendChild(x); x.click(); x.remove(); setTimeout(() => URL.revokeObjectURL(u), 30000); }
        set(files.length ? `Đã lưu ${files.length} ảnh (${files.map((f) => f.name).join(', ')}).` : 'Không tạo được ảnh (chưa mở PDF hoặc phần chưa đánh dấu trang).');
        L(`Writing ${segLabel(a.book, a.seg)}: lưu ${files.length} ảnh trang đề.`);
      } else {
        const text = aiText(a, files.length > 0);
        const data = { title: `IELTS Writing Cam ${a.book} Test ${testOf(a.seg)}`, text };
        if (files.length && navigator.canShare && navigator.canShare({ files })) data.files = files;
        try {
          await navigator.share(data);
          set(data.files ? `Đã mở bảng chia sẻ: chữ + ${files.length} ảnh. Nếu app AI chỉ nhận một thứ, dùng 2 nút "Chép chữ" và "Lưu ảnh trang đề".` : 'Máy không chia sẻ được ảnh kèm chữ: đã chia sẻ chữ, hãy bấm "Lưu ảnh trang đề" rồi đính ảnh.');
          L(`Writing ${segLabel(a.book, a.seg)}: chia sẻ sang app AI (${data.files ? `chữ + ${files.length} ảnh` : 'chỉ chữ'}).`);
        } catch (e) { set(e && e.name === 'AbortError' ? 'Đã hủy chia sẻ.' : 'Không chia sẻ được: ' + (e && e.message)); }
      }
    } catch (e) { set('Lỗi: ' + e.message); }
    finally { b.disabled = false; }
  }

  // ---------- Nhập đáp án (ôn tập) ----------
  function defaultKeySeg() {
    const all = (loadJSON(KEYS_KEY, {})[st.book]) || {};
    return QSEGS.find((s) => keyFilled(all[s]) < N) || 'T1L';
  }
  function keyPages(fileId) { return ((loadJSON(PCFG_KEY, {})[fileId] || {}).keypage) || {}; }
  // Trang đang xem có nằm trong vùng đáp án không: từ mốc Đáp án tới trước mốc kế tiếp (thường là Bài mẫu). File key riêng: cả file.
  function inKeyArea(page) {
    const ctx = window.Viewer && Viewer.ctx();
    if (!ctx || !ctx.file) return false;
    if (ctx.file.scope === 'key') return true;
    const k = (ctx.segs || []).find((s) => s.key === 'KEY');
    return !!k && page >= k.start && page <= k.end;
  }
  function recordKeyPage(page) {
    if (st.kind !== 'key' || !st.file || !isQSeg(st.keySeg)) return;
    const ctx = window.Viewer && Viewer.ctx();
    page = page || (ctx && ctx.page);
    if (!page || !inKeyArea(page)) return;
    const all = loadJSON(PCFG_KEY, {});
    const c = all[st.file.id] = all[st.file.id] || { marks: {} };
    c.keypage = c.keypage || {};
    if (c.keypage[st.keySeg] === page) return;
    c.keypage[st.keySeg] = page;
    saveJSON(PCFG_KEY, all);
    const el = $('ak-page'); if (el) el.textContent = keyPageText();
  }
  function keyPageText() {
    const p = st.file ? keyPages(st.file.id)[st.keySeg] : null;
    return p ? `Trang đáp án của phần này: ${p}. Lật trang khác trong vùng đáp án thì app nhớ trang mới.` : 'Chưa nhớ trang đáp án của phần này: lật tới đúng trang, app tự nhớ.';
  }
  // Trình xem vẽ xong một trang (ôn tập): đang mở khung Đáp án và trang nằm trong vùng đáp án thì nhớ trang cho phần đang chọn.
  function onPage(page) {
    if (st.skipNextPage) { st.skipNextPage = false; return; }
    recordKeyPage(page);
  }
  function openKeys(seg) {
    st.kind = 'key';
    st.keySeg = isQSeg(seg) ? seg : (st.keySeg && isQSeg(st.keySeg) ? st.keySeg : defaultKeySeg());
    renderKeys();
  }
  function renderKeys(parsed) {
    const seg = st.keySeg, k = getKey(st.book, seg) || emptyKey();
    const cl = G.clusters(skillOf(seg), N);
    const chk = G.check(k, skillOf(seg), N, parsed);
    const nflag = Object.keys(chk.byQ).length;
    const opts = QSEGS.map((s) => { const kk = getKey(st.book, s); return `<option value="${s}"${s === seg ? ' selected' : ''}>${esc(S.LABEL[s])}${kk ? ` (${keyFilled(kk)}/${N})` : ''}</option>`; }).join('');
    const blocks = cl.map(([a, b], i) => {
      let rows = '';
      for (let q = a; q <= b; q++) {
        const w = chk.byQ[q];
        rows += `<div class="krow${w ? ' flag' : ''}" data-q="${q}"><span class="qn">${q}</span><input class="kin" data-q="${q}" ${INPUT_ATTR} value="${esc((k.items || {})[q] || '')}">${w ? `<span class="kw">${esc(w.join('; '))}</span>` : ''}</div>`;
      }
      const done = (k.checked || []).includes(i);
      return `<div class="qblock${done ? ' done' : ''}" data-c="${i}"><div class="qbh">${esc(clusterName(seg, i))}
        <label class="kchk"><input type="checkbox" data-a="checked" data-c="${i}"${done ? ' checked' : ''}> Đã soát</label></div>${rows}</div>`;
    }).join('');
    showSide(`${head(`Đáp án Cam ${st.book}`, ` <select id="ak-seg" aria-label="Phần">${opts}</select>`)}
      <div class="vs-body">
        <p class="hint" id="ak-stat">${keyFilled(k)}/${N} câu · đã soát ${checkedCount(k, seg)}/${N}${nflag ? ` · <span class="bad">${nflag} dòng đỏ, xem trước</span>` : ''}</p>
        <p class="hint" id="ak-page">${esc(keyPageText())}</p>
        ${chk.global.length ? `<ul class="plain kglobal">${chk.global.map((g) => `<li class="warn">${esc(g)}</li>`).join('')}</ul>` : ''}
        <details class="kpaste"${keyFilled(k) ? '' : ' open'}><summary>Dán text đáp án</summary>
          <textarea id="ak-text" rows="6" ${INPUT_ATTR} placeholder="Ví dụ:&#10;1 colour/color&#10;2 (the) library&#10;11-12 IN EITHER ORDER B, D&#10;13 TRUE"></textarea>
          <div class="row"><button class="small" data-a="parse">Tách vào các ô</button>
            <button class="small secondary" data-a="pagetext">Lấy chữ trang PDF này</button>
            <button class="small secondary" data-a="totext">Chép dạng text</button></div>
          <p class="hint" id="ak-msg">Dán text (từ Claude chép ảnh, Google Lens, OCR…), bấm "Tách". App tìm theo số câu nên dòng bị đảo hay hai cột trộn vẫn tách được. Sau đó soát từng cụm với trang scan bên cạnh, dòng đỏ là chỗ đáng ngờ.</p>
        </details>
        <div class="row kgroups"><label>Nhóm thứ tự bất kỳ <input id="ak-groups" ${INPUT_ATTR} size="14" value="${esc(G.groupsToText(k.groups))}" placeholder="vd 11-12, 21-23"></label></div>
        ${blocks}
        <div class="row"><button class="small secondary" data-a="clearkey">Xóa đáp án phần này</button></div>
      </div>`);
  }
  function saveKeyItem(q, v) {
    const k = getKey(st.book, st.keySeg) || emptyKey();
    k.items = k.items || {};
    if (String(v).trim()) k.items[q] = v.trim(); else delete k.items[q];
    k.at = Date.now(); k.src = k.src || 'gõ tay';
    setKey(st.book, st.keySeg, k);
    recordKeyPage();
    // Cập nhật dòng đỏ của dòng này và hai dòng bên cạnh, không vẽ lại cả khung (để con trỏ không nhảy).
    const chk = G.check(k, skillOf(st.keySeg), N);
    for (const n of [q - 1, q, q + 1]) {
      const row = side().querySelector(`.krow[data-q="${n}"]`); if (!row) continue;
      const w = chk.byQ[n];
      row.classList.toggle('flag', !!w);
      let sp = row.querySelector('.kw');
      if (w) { if (!sp) { sp = document.createElement('span'); sp.className = 'kw'; row.appendChild(sp); } sp.textContent = w.join('; '); } else if (sp) sp.remove();
    }
    updateStat(k, chk);
  }
  function updateStat(k, chk) {
    chk = chk || G.check(k, skillOf(st.keySeg), N);
    const nflag = Object.keys(chk.byQ).length;
    const stat = $('ak-stat'); if (stat) stat.innerHTML = `${keyFilled(k)}/${N} câu · đã soát ${checkedCount(k, st.keySeg)}/${N}${nflag ? ` · <span class="bad">${nflag} dòng đỏ</span>` : ''}`;
  }
  function parseClick() {
    const text = $('ak-text').value;
    if (!text.trim()) { $('ak-msg').textContent = 'Ô dán đang trống.'; return; }
    const old = getKey(st.book, st.keySeg);
    if (keyFilled(old) && !confirm(`${S.LABEL[st.keySeg]} đã có ${keyFilled(old)} câu. Tách text mới sẽ ghi đè các câu có trong text. Tiếp tục?`)) return;
    const p = G.parseKey(text, N);
    const k = old || emptyKey();
    k.items = Object.assign({}, k.items, p.items);
    for (const q of Object.keys(k.items)) if (!String(k.items[q]).trim()) delete k.items[q];
    // Nhóm: bỏ nhóm cũ chồng lên câu có trong text mới, thêm nhóm mới.
    const touched = new Set(Object.keys(p.items).map(Number));
    k.groups = (k.groups || []).filter((g) => !g.some((q) => touched.has(q))).concat(p.groups).sort((a, b) => a[0] - b[0]);
    k.checked = []; k.at = Date.now(); k.src = 'dán text';
    setKey(st.book, st.keySeg, k);
    recordKeyPage();
    const chk = G.check(k, skillOf(st.keySeg), N, p);
    L(`Đáp án ${segLabel(st.book, st.keySeg)}: tách text được ${Object.keys(p.items).length} câu, ${p.groups.length} nhóm thứ tự bất kỳ, ${Object.keys(chk.byQ).length} dòng đỏ.`);
    renderKeys(p);
  }
  async function pageTextClick() {
    const ctx = window.Viewer && Viewer.ctx();
    const msg = $('ak-msg');
    if (!ctx || !ctx.doc) { msg.textContent = 'Chưa mở PDF.'; return; }
    msg.textContent = `Đang đọc chữ trang ${ctx.page}…`;
    try {
      const pg = await ctx.doc.getPage(ctx.page);
      const tc = await pg.getTextContent();
      const items = tc.items.filter((i) => i.str && i.str.trim()).map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5] }));
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = []; let y = null;
      for (const it of items) { if (y == null || Math.abs(it.y - y) > 3) { lines.push([]); y = it.y; } lines[lines.length - 1].push(it); }
      const text = lines.map((l) => l.sort((a, b) => a.x - b.x).map((i) => i.s).join(' ')).join('\n');
      if (text.replace(/\s/g, '').length < 20) { msg.innerHTML = `<span class="warn">Trang ${ctx.page} không có lớp chữ (bản scan). Hãy dán text từ ngoài hoặc gõ tay.</span>`; L(`Đáp án: trang PDF ${ctx.page} không có lớp chữ.`); return; }
      const ta = $('ak-text'); ta.value = (ta.value.trim() ? ta.value + '\n' : '') + text;
      msg.textContent = `Đã lấy ${text.length} ký tự từ trang ${ctx.page}. Kiểm rồi bấm "Tách vào các ô".`;
      L(`Đáp án: lấy chữ trang PDF ${ctx.page} (${text.length} ký tự).`);
    } catch (e) { msg.textContent = 'Không đọc được chữ: ' + e.message; }
  }
  function toTextClick() {
    const k = getKey(st.book, st.keySeg);
    const t = G.toText(k || emptyKey(), N);
    $('ak-text').value = t;
    const done = () => { $('ak-msg').textContent = 'Đã chép dạng text vào ô (và vào bộ nhớ tạm nếu trình duyệt cho).'; };
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(done, done); else done();
  }
  function groupsChange(inp) {
    const r = G.textToGroups(inp.value, N);
    const k = getKey(st.book, st.keySeg) || emptyKey();
    k.groups = r.groups; k.at = Date.now();
    setKey(st.book, st.keySeg, k);
    L(`Đáp án ${segLabel(st.book, st.keySeg)}: nhóm thứ tự bất kỳ = ${G.groupsToText(r.groups) || '(không có)'}${r.bad.length ? `, bỏ qua "${r.bad.join(', ')}"` : ''}.`);
    renderKeys();
    if (r.bad.length) $('ak-msg').innerHTML = `<span class="warn">Bỏ qua nhóm không hợp lệ: ${esc(r.bad.join(', '))} (mỗi nhóm 2–4 câu liền nhau, không chồng nhau).</span>`;
  }
  function checkedChange(box) {
    const k = getKey(st.book, st.keySeg) || emptyKey();
    const i = Number(box.dataset.c);
    const set = new Set(k.checked || []);
    if (box.checked) set.add(i); else set.delete(i);
    k.checked = [...set].sort();
    setKey(st.book, st.keySeg, k);
    recordKeyPage();
    box.closest('.qblock').classList.toggle('done', box.checked);
    L(`Đáp án ${segLabel(st.book, st.keySeg)}: ${box.checked ? 'đã soát' : 'bỏ dấu đã soát'} ${clusterName(st.keySeg, i)} (soát ${checkedCount(k, st.keySeg)}/${N}).`);
    updateStat(k);
  }
  // Đổi phần trong khung Đáp án: tự về trang đáp án đã nhớ của phần đó.
  function keySegChange(seg) {
    st.keySeg = seg;
    renderKeys();
    const p = st.file ? keyPages(st.file.id)[seg] : null;
    const ctx = window.Viewer && Viewer.ctx();
    if (p && ctx && ctx.page !== p && Viewer.goPage) { Viewer.goPage(p); L(`Đáp án: chọn ${S.LABEL[seg]}, về trang đáp án đã nhớ (trang PDF ${p}).`); }
  }

  // ---------- Kết quả (dùng chung: khung trong trình xem và hộp trên thẻ Đề) ----------
  function timeLine(a) {
    const bits = [`<b>${STYLE[styleOf(a)]}</b>`];
    if (a.clock) {
      bits.push(`thời gian làm ${esc(C.usedText(a.clock, a.submittedAt))}`);
      bits.push(esc(C.pauseText(a.clock)));
      if (a.autoSubmitted) bits.push('<span class="warn">tự nộp khi hết giờ</span>');
    } else bits.push(`không tính giờ (bài từ bản cũ), từ lúc bắt đầu tới lúc nộp ${Math.round((a.submittedAt - a.startedAt) / 60000)} phút`);
    return `<p class="hint" id="r-time">${bits.join(' · ')}</p>`;
  }
  function renderResult(box, attId, opt = {}) {
    const a = attempts().find((x) => x.id === attId);
    if (!a) { box.innerHTML = '<p class="hint">Không tìm thấy bài làm.</p>'; return; }
    let html = `<p><b>${esc(segLabel(a.book, a.seg))}</b> · nộp ${esc(hhmm(a.submittedAt))}</p>` + timeLine(a);
    if (isWSeg(a.seg)) {
      const t = a.answers || {};
      html += `<p>Task 1: <b>${C.words(t.t1)}</b> từ${C.words(t.t1) < 150 ? ' <span class="warn">(dưới 150)</span>' : ''} · Task 2: <b>${C.words(t.t2)}</b> từ${C.words(t.t2) < 250 ? ' <span class="warn">(dưới 250)</span>' : ''}</p>`;
      html += aiBox(a, !!opt.inViewer);
      html += `<details><summary>Xem lại bài viết</summary><pre class="aipre">${esc(`Task 1\n${t.t1 || '(không làm)'}\n\nTask 2\n${t.t2 || '(không làm)'}`)}</pre></details>`;
      box.innerHTML = html; box.dataset.att = attId; return;
    }
    const k = getKey(a.book, a.seg);
    const all = box.dataset.all === '1';
    if (!k || !keyFilled(k)) {
      html += `<p class="warn">Chưa có đáp án cho phần này nên chưa chấm. Nhập đáp án xong, mở lại kết quả sẽ tự chấm.</p>`;
      html += `<div class="row"><button class="small" data-r="enterkey">Nhập đáp án ${esc(S.LABEL[a.seg])}</button></div>`;
      html += `<p class="hint">Bạn đã điền ${filledOf(a)}/${N - skipSet(a).size} ô.</p>`;
      box.innerHTML = html; box.dataset.att = attId; return;
    }
    const r = gradeAtt(k, a);
    if (a.score !== r.score || a.total !== r.total) { a.score = r.score; a.total = r.total; putAttempt(a); }
    const wrong = r.per.filter((x) => x.status !== 'ok');
    const chips = [];
    if (r.overridden) chips.push(`<span class="chip warn">tính đúng tay ${r.overridden} câu</span>`);
    if (r.blank) chips.push(`<span class="chip">trống ${r.blank}</span>`);
    if (r.nokey) chips.push(`<span class="chip bad">thiếu key ${r.nokey} câu</span>`);
    if (r.skipped) chips.push(`<span class="chip warn">bỏ ${r.skipped} câu thiếu audio (${esc(partsText(a.skipParts))})</span>`);
    const ck = checkedCount(k, a.seg);
    if (ck < N) chips.push(`<span class="chip warn">key mới soát ${ck}/${N}</span>`);
    html += `<p class="rscore"><b id="r-score">${r.score}/${r.total - r.nokey}</b> ${chips.join(' ')}</p>`;
    if (ck === N) html += `<p class="hint" id="r-keyok">key đã soát đủ ${N}/${N}</p>`;
    html += `<div class="row"><button class="small secondary" data-r="all">${all ? 'Chỉ hiện câu sai/trống' : `Hiện cả ${r.per.length} câu`}</button>${opt.inViewer ? '<button class="small secondary" data-r="openkey">Xem trang đáp án trong PDF</button>' : ''}</div>`;
    const rows = (all ? r.per : wrong).map((x) => {
      const mark = x.status === 'ok' ? '<span class="ok">✓</span>' : x.override ? '<span class="warn">✓ tay</span>' : x.status === 'nokey' ? '<span class="hint">?</span>' : '<span class="bad">✗</span>';
      const btns = x.status === 'ok' || x.status === 'nokey' ? (x.status === 'nokey' ? `<button class="small secondary" data-r="editkey" data-q="${x.n}">Sửa key</button>` : '')
        : `<button class="small secondary" data-r="override" data-q="${x.n}">${x.override ? 'Bỏ tính đúng' : 'Tính là đúng'}</button> <button class="small secondary" data-r="editkey" data-q="${x.n}">Sửa key</button>`;
      return `<tr class="r-${x.status}${x.override ? ' r-ov' : ''}" data-q="${x.n}"><td class="qn">${x.n}</td><td>${mark}</td>
        <td><span class="hint">bạn:</span> ${x.given ? esc(x.given) : '<span class="hint">(trống)</span>'}<br><span class="hint">key:</span> ${esc(G.display(k, x.n)) || '<span class="hint">(chưa có)</span>'}
        <div class="redit" hidden><input class="rkin" data-q="${x.n}" ${INPUT_ATTR} value="${esc((k.items || {})[x.n] || '')}"> <button class="small" data-r="savekey" data-q="${x.n}">Lưu key</button></div></td>
        <td class="rbtn">${btns}</td></tr>`;
    }).join('');
    html += rows ? `<table class="rtable">${rows}</table>` : '<p class="ok">Đúng hết.</p>';
    html += `<p class="hint">Chấm theo đáp án đã nhập: không phân biệt hoa thường, bỏ khoảng trắng và dấu câu thừa ở đầu/cuối, nhận đáp án thay thế (/) và phần trong ngoặc. App không kiểm giới hạn số từ. Câu bạn cho là đúng (vd viết tắt, cách viết số khác) thì bấm "Tính là đúng"; key chép sai thì "Sửa key", điểm chấm lại ngay.</p>`;
    box.innerHTML = html;
    box.dataset.att = attId;
  }
  function onResultClick(e, box, opt) {
    const ai = e.target.closest('button[data-ai]');
    if (ai) { const a = attempts().find((x) => x.id === box.dataset.att); if (a) onAiClick(ai, a); return; }
    const b = e.target.closest('button[data-r]');
    if (!b) return;
    const a = attempts().find((x) => x.id === box.dataset.att);
    if (!a) return;
    const q = Number(b.dataset.q);
    const r = b.dataset.r;
    if (r === 'all') { box.dataset.all = box.dataset.all === '1' ? '' : '1'; renderResult(box, a.id, opt); return; }
    if (r === 'override') {
      a.overrides = a.overrides || {};
      if (a.overrides[q]) delete a.overrides[q]; else a.overrides[q] = true;
      putAttempt(a);
      L(`Kết quả ${segLabel(a.book, a.seg)}: câu ${q} ${a.overrides[q] ? 'tính là đúng (tay)' : 'bỏ tính đúng tay'}.`);
      renderResult(box, a.id, opt); return;
    }
    if (r === 'editkey') { const row = b.closest('tr'); const ed = row.querySelector('.redit'); ed.hidden = !ed.hidden; if (!ed.hidden) ed.querySelector('input').focus(); return; }
    if (r === 'savekey') {
      const v = b.closest('tr').querySelector('.rkin').value.trim();
      const k = getKey(a.book, a.seg) || emptyKey();
      const before = gradeAtt(k, a).score;
      if (v) k.items[q] = v; else delete k.items[q];
      k.edits = (k.edits || 0) + 1; k.at = Date.now();
      setKey(a.book, a.seg, k);
      const after = gradeAtt(k, a);
      L(`Sửa key ${segLabel(a.book, a.seg)} câu ${q} từ màn kết quả: điểm ${before} → ${after.score}/${after.total}.`);
      renderResult(box, a.id, opt); return;
    }
    if (r === 'enterkey' || r === 'openkey') { openKeyFor(a.book, a.seg, a.fileId); return; }
  }
  // Mở trình xem ở chế độ ôn tập, tới trang đáp án đã nhớ của phần (không có thì trang Đáp án đã đánh dấu), mở khung nhập đáp án đúng phần.
  async function openKeyFor(book, seg, fileId) {
    closeModal();
    const file = findPdf(book, fileId);
    if (!file) { alert(`Chưa thấy PDF của Cam ${book} trong Thư viện.`); return; }
    const c = loadJSON(PCFG_KEY, {})[file.id] || {};
    const marks = c.marks || {};
    const kp = (c.keypage || {})[seg] || null;
    if (!window.Viewer) return;
    if (Viewer.isOpen()) await Viewer.close(true);   // bài đã nộp: đóng trình xem làm đề (và thanh audio) rồi mở ôn tập
    Viewer.open({ file, mode: 'review', page: kp || (file.scope === 'key' ? null : marks.KEY || null), panel: { kind: 'key', seg } });
  }
  // Nút "Đáp án" trên thanh công cụ trình xem (ôn tập): mở/đóng khung nhập đáp án.
  function toggleKeys() {
    if (!st.file || !st.book) return;
    if (st.kind === 'key') { hideSide(); return; }
    openKeys(null);
  }
  function findPdf(book, fileId) {
    const res = (window.Library && Library._results()) || [];
    const pdfs = res.filter((r) => r.kind === 'pdf' && !r.ignored && r.book === book);
    return pdfs.find((r) => r.id === fileId) || pdfs.find((r) => r.isMain) || pdfs.find((r) => r.scope !== 'key') || pdfs[0] || null;
  }

  // ---------- Hộp kết quả trên trang chính ----------
  function openModal(attId) {
    let m = $('a-modal');
    if (!m) {
      document.body.insertAdjacentHTML('beforeend', `<div id="a-modal" class="amodal" hidden><div class="amodal-box"><div class="vs-head"><b class="vs-title">Kết quả</b><button class="small secondary" id="a-modal-close">✕ Đóng</button></div><div id="a-modal-body" class="vs-body"></div></div></div>`);
      m = $('a-modal');
      $('a-modal-close').onclick = closeModal;
      $('a-modal-body').addEventListener('click', (e) => onResultClick(e, $('a-modal-body'), {}));
    }
    m.hidden = false;
    document.body.classList.add('viewing');
    const body = $('a-modal-body'); body.dataset.all = '';
    renderResult(body, attId, {});
  }
  function closeModal() { const m = $('a-modal'); if (m && !m.hidden) { m.hidden = true; if ($('viewer') ? $('viewer').hidden : true) document.body.classList.remove('viewing'); refreshCard(); } }

  // Thẻ Đề: tình trạng đáp án (m5-2 mục 3.7: "2/8 phần, đã có …, chưa có …") và bài đã nộp của quyển đang chọn.
  function keysLine(book) {
    const keys = loadJSON(KEYS_KEY, {})[book] || {};
    const have = QSEGS.filter((s) => keys[s] && keyFilled(keys[s]));
    const short = (s) => `T${s[1]} ${s[2] === 'L' ? 'Listening' : 'Reading'}`;
    const desc = have.map((s) => {
      const n = keyFilled(keys[s]), ck = checkedCount(keys[s], s);
      return `${short(s)}${n < N ? ` ${n}/${N} câu` : ''}${ck === N ? ' (đã soát đủ)' : ` (soát ${ck}/${N})`}`;
    });
    const miss = [];
    for (let t = 1; t <= 4; t++) {
      const m = ['L', 'R'].filter((k) => !have.includes(`T${t}${k}`));
      if (m.length) miss.push({ t, m });
    }
    const both = miss.filter((x) => x.m.length === 2).map((x) => `T${x.t}`);
    const one = miss.filter((x) => x.m.length === 1).map((x) => `T${x.t} ${x.m[0] === 'L' ? 'Listening' : 'Reading'}`);
    const missTxt = [...one, ...(both.length ? [`${both.join(', ')} (Listening + Reading)`] : [])].join('; ');
    if (!have.length) return `Đáp án: 0/8 phần, chưa có phần nào. Bấm "Đáp án quyển này" để nhập.`;
    return `Đáp án: ${have.length}/8 phần. Đã có: ${desc.join(', ')}.${missTxt ? ` Chưa có: ${missTxt}.` : ''}`;
  }
  function refreshCard() {
    const box = $('ex-results');
    if (!box) return;
    const book = Number(($('ex-book') || {}).value);
    if (!book) { box.innerHTML = ''; return; }
    const list = attempts().filter((a) => a.book === book).sort((a, b) => (b.submittedAt || b.updatedAt) - (a.submittedAt || a.updatedAt)).slice(0, 8);
    const rows = list.map((a) => {
      const sty = `<span class="hint">${STYLE[styleOf(a)]}</span>`;
      if (a.submittedAt) {
        const res = isWSeg(a.seg) ? `đã nộp (Task 1 ${C.words((a.answers || {}).t1)} từ, Task 2 ${C.words((a.answers || {}).t2)} từ)` : a.score != null ? `${a.score}/${a.total || N}` : 'chưa chấm';
        return `<li>${esc(S.LABEL[a.seg])}: <b>${res}</b> ${sty} <span class="hint">nộp ${esc(hhmm(a.submittedAt))}</span> <button class="small secondary" data-res="${esc(a.id)}">Xem</button></li>`;
      }
      const left = a.clock && a.clock.limit != null ? `, còn ${C.fmt(C.remaining(a.clock, now()))}` : '';
      const fill = isWSeg(a.seg) ? `${C.words((a.answers || {}).t1) + C.words((a.answers || {}).t2)} từ` : `${filledOf(a)}/${N} ô`;
      return `<li>${esc(S.LABEL[a.seg])}: <span class="warn">đang làm dở</span> ${sty} <span class="hint">(${fill}${left}, ${esc(hhmm(a.updatedAt))})</span></li>`;
    }).join('');
    box.innerHTML = `<p class="hint" id="ex-keyline">${esc(keysLine(book))}</p>` + (rows ? `<ul class="plain">${rows}</ul>` : '');
  }

  // ---------- Sự kiện ----------
  function onSideClick(e) {
    const b = e.target.closest('[data-a]');
    if (st.kind === 'result') onResultClick(e, $('as-result'), { inViewer: true });
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'toggle') { setCollapsed(!collapsed()); b.textContent = collapsed() ? '▴' : '▾'; return; }
    if (a === 'submit') submit(false);
    if (a === 'abandon') abandon();
    if (a === 'startcopy') startCopy('bấm "Bắt đầu 10 phút chép" (không có audio)');
    if (a === 'qprev') moveQ(-1);
    if (a === 'qnext') moveQ(+1);
    if (a === 'parse') parseClick();
    if (a === 'pagetext') pageTextClick();
    if (a === 'totext') toTextClick();
    if (a === 'clearkey' && confirm(`Xóa toàn bộ đáp án ${S.LABEL[st.keySeg]} của Cam ${st.book}?`)) { setKey(st.book, st.keySeg, null); L(`Đáp án ${segLabel(st.book, st.keySeg)}: đã xóa.`); renderKeys(); }
  }
  function onSideInput(e) {
    const t = e.target;
    if (t.classList.contains('qin')) onSheetInput(t);
    if (t.classList.contains('wt') || t.classList.contains('wp')) onWritingInput(t);
    if (t.classList.contains('kin')) saveKeyItem(Number(t.dataset.q), t.value);
  }
  function onSideChange(e) {
    const t = e.target;
    if (t.id === 'ak-seg') keySegChange(t.value);
    if (t.id === 'ak-groups') groupsChange(t);
    if (t.dataset && t.dataset.a === 'checked') checkedChange(t);
  }
  function onSideKey(e) {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (!t.classList || !(t.classList.contains('qin') || t.classList.contains('kin') || t.classList.contains('rkin'))) return;
    e.preventDefault();
    if (t.classList.contains('rkin')) { t.closest('tr').querySelector('[data-r="savekey"]').click(); return; }
    const list = [...side().querySelectorAll(t.classList.contains('qin') ? '.qin:not([disabled])' : '.kin')];
    const nx = list[list.indexOf(t) + 1];
    if (nx) focusQ(nx); else t.blur();
  }
  function bind() {
    const el = side();
    if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('click', onSideClick);
    el.addEventListener('input', onSideInput);
    el.addEventListener('change', onSideChange);
    el.addEventListener('keydown', onSideKey);
    el.addEventListener('focusin', (e) => {
      const t = e.target;
      if (t.classList && t.classList.contains('qin')) enterKb(t);
      // Writing trên điện thoại: giữ nguyên bố cục, chỉ co khung trình xem theo vùng bàn phím chừa lại để ô gõ không bị che.
      if (t.classList && (t.classList.contains('wt') || t.classList.contains('wp')) && phone()) { el.classList.add('kbw'); fitVV(); }
    });
    el.addEventListener('focusout', () => {
      flush();
      // Bấm ra ngoài (không sang ô khác): bung lại phiếu.
      setTimeout(() => { const a = document.activeElement; if (!(a && a.classList && (a.classList.contains('qin') || a.classList.contains('wt') || a.classList.contains('wp')) && el.contains(a))) exitKb(); }, 0);
    });
    // Nút ‹ › trong dòng thu gọn: giữ focus ở ô đang gõ (để bàn phím không tắt rồi bật lại).
    el.addEventListener('pointerdown', (e) => { if (e.target.closest('[data-a="qprev"],[data-a="qnext"]')) e.preventDefault(); });
    const cv = $('v-cover'); if (cv && !cv.dataset.bound) { cv.dataset.bound = '1'; cv.addEventListener('click', onCoverClick); }
  }
  function init() {
    window.addEventListener('pagehide', () => { if (isWork() && st.att.clock && C.running(st.att.clock)) pauseClock('đóng trang'); flush(); });
    document.addEventListener('visibilitychange', onVis);
    if (window.visualViewport) { visualViewport.addEventListener('resize', fitVV); visualViewport.addEventListener('scroll', fitVV); }
    const rb = $('ex-results');
    if (rb) rb.addEventListener('click', (e) => { const b = e.target.closest('button[data-res]'); if (b) openModal(b.dataset.res); });
    const kb = $('ex-keys');
    if (kb) kb.onclick = () => { const book = Number($('ex-book').value); const f = window.Viewer && Viewer.selFile && Viewer.selFile(); if (book) openKeyFor(book, null, f && f.id); };
    refreshCard();
  }

  // m6-1: dữ liệu vừa đồng bộ về từ máy khác: cập nhật thẻ Đề; bài đang làm mà đã được làm tiếp ở máy khác thì dừng.
  function onSynced(e) {
    const keys = (e && e.detail && e.detail.keys) || [];
    if (keys.includes(ATT_KEY) && isWork()) checkMoved();
    if (keys.some((k) => k === ATT_KEY || k === KEYS_KEY || k === PCFG_KEY)) refreshCard();
  }
  window.addEventListener('ielts-sync', onSynced);
  window.Answers = { onOpen, onClose, blocksClose, preflight, bind, refreshCard, openModal, openKeyFor, toggleKeys, flush, onPage, onAudioPlay, onAudioDone,
    working: () => isWork(), _st: st };
  init();
})();
