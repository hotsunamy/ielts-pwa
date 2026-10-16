// Mốc 5 (m5-1): nhập đáp án (key), phiếu trả lời khi làm đề, nộp bài, chấm, xem kết quả.
// Không có đáp án nào trong code: key do Minh dán/gõ, lưu trong máy (localStorage) tới mốc 6 thì đồng bộ lên Drive.
//   ielts.keys     {[quyển]: {[T1L..T4R]: {items: {n: chuỗi}, groups: [[a..b]], checked: [chỉ số cụm đã soát], src, at, edits}}}
//   ielts.attempts [{id, book, seg, fileId, fileName, startedAt, updatedAt, answers: {n: chuỗi}, submittedAt, overrides: {n: true}, score, total}]
// Khung bên phải trình xem PDF (máy tính) hoặc dải dưới đáy (điện thoại), 3 kiểu: phiếu trả lời (làm đề), nhập đáp án (ôn tập), kết quả.
'use strict';
(function () {
  const KEYS_KEY = 'ielts.keys', ATT_KEY = 'ielts.attempts', SIDE_KEY = 'ielts.sidecollapsed';
  const G = Grade, S = Sections;
  const N = G.N;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const L = (msg) => { if (typeof log === 'function') log(msg); };
  const INPUT_ATTR = 'autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"';
  const QSEGS = []; for (let t = 1; t <= 4; t++) QSEGS.push(`T${t}L`, `T${t}R`);
  const isQSeg = (k) => /^T[1-4][LR]$/.test(k || '');
  const skillOf = (seg) => seg[2];
  const hhmm = (t) => new Date(t).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

  // ---------- Lưu trong máy ----------
  function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (_) { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { L('Không lưu được vào máy: ' + e.message); return false; } }
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
  function openAttempt(book, seg) { return attempts().filter((a) => a.book === book && a.seg === seg && !a.submittedAt).sort((a, b) => b.startedAt - a.startedAt)[0] || null; }
  const segLabel = (book, seg) => `Cam ${book} · ${S.LABEL[seg]}`;
  function clusterName(seg, i) { const [a, b] = G.clusters(skillOf(seg), N)[i]; return skillOf(seg) === 'L' ? `Part ${i + 1} · câu ${a}–${b}` : `Câu ${a}–${b}`; }

  // ---------- Trạng thái khung bên ----------
  const st = { kind: null, book: null, seg: null, file: null, att: null, submitted: false, keySeg: null, pollT: null, curPart: null, saveT: null };

  function side() { return $('v-side'); }
  function collapsed() { return loadJSON(SIDE_KEY, false) === true; }
  function setCollapsed(v) { saveJSON(SIDE_KEY, !!v); const el = side(); if (el) el.classList.toggle('collapsed', !!v); }
  function showSide(html) {
    const el = side();
    el.hidden = false;
    el.classList.toggle('collapsed', collapsed());
    el.innerHTML = html;
  }
  function hideSide() { const el = side(); if (el) { el.hidden = true; el.innerHTML = ''; } stopPoll(); st.kind = null; }
  function head(title, extra = '') {
    return `<div class="vs-head"><button class="small secondary vs-tog" data-a="toggle" aria-label="Thu gọn / mở">${collapsed() ? '▴' : '▾'}</button><b class="vs-title">${title}</b>${extra}</div>`;
  }

  // ---------- Gọi từ trình xem PDF ----------
  // ctx: {file, mode, segKey, panel: {kind: 'key', seg}}
  function onOpen(ctx) {
    st.file = ctx.file; st.book = ctx.file.book;
    st.submitted = false; st.att = null;
    if (ctx.mode === 'exam' && isQSeg(ctx.segKey) && st.book) { openSheet(ctx.segKey); return; }
    if (ctx.mode !== 'exam' && ctx.panel && ctx.panel.kind === 'key' && st.book) { openKeys(ctx.panel.seg); return; }
    hideSide();
  }
  function onClose() { flush(); hideSide(); st.file = null; }
  function blocksClose() { return st.kind === 'sheet' && !st.submitted; }

  // ---------- Phiếu trả lời (làm đề) ----------
  function openSheet(seg) {
    st.kind = 'sheet'; st.seg = seg;
    st.att = openAttempt(st.book, seg);
    const resumed = !!st.att;
    L(`Bài làm ${segLabel(st.book, seg)}: ${resumed ? `làm tiếp bài bắt đầu ${hhmm(st.att.startedAt)} (${Object.values(st.att.answers).filter(Boolean).length} ô đã điền)` : 'bài mới'}.`);
    renderSheet(resumed);
    startPoll();
  }
  function filledCount() { return st.att ? Object.values(st.att.answers || {}).filter((v) => String(v).trim()).length : 0; }
  function renderSheet(resumed) {
    const seg = st.seg, cl = G.clusters(skillOf(seg), N);
    const ans = (st.att && st.att.answers) || {};
    const blocks = cl.map(([a, b], i) => {
      let rows = '';
      for (let q = a; q <= b; q++) rows += `<label class="qrow"><span class="qn">${q}</span><input class="qin" data-q="${q}" ${INPUT_ATTR} enterkeyhint="next" value="${esc(ans[q] || '')}"></label>`;
      return `<div class="qblock" data-c="${i}"><div class="qbh">${esc(clusterName(seg, i))}</div><div class="qgrid">${rows}</div></div>`;
    }).join('');
    showSide(`${head(`Phiếu trả lời <span class="hint" id="as-count">${filledCount()}/${N}</span>`)}
      <div class="vs-body">
        ${resumed ? `<p class="hint" id="as-resume">Làm tiếp bài bắt đầu ${esc(hhmm(st.att.startedAt))} (chưa nộp). <button class="small secondary" data-a="abandon">Bỏ bài này, làm lại</button></p>` : ''}
        ${blocks}
        <div class="row"><button data-a="submit" id="as-submit">Nộp bài</button></div>
        <p class="hint" id="as-saved">Mỗi ô tự lưu trong máy khi gõ. Đóng app giữa chừng, mở lại phần này sẽ làm tiếp.</p>
      </div>`);
    markCurPart(true);
  }
  function onSheetInput(inp) {
    const q = Number(inp.dataset.q);
    if (!st.att) {
      st.att = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), book: st.book, seg: st.seg, fileId: st.file.id, fileName: st.file.name,
        startedAt: Date.now(), updatedAt: Date.now(), answers: {}, submittedAt: null, overrides: {}, score: null, total: N };
      L(`Bài làm ${segLabel(st.book, st.seg)}: bắt đầu điền phiếu.`);
    }
    st.att.answers[q] = inp.value;
    st.att.updatedAt = Date.now();
    const c = $('as-count'); if (c) c.textContent = `${filledCount()}/${N}`;
    clearTimeout(st.saveT);
    st.saveT = setTimeout(flush, 300);
  }
  function flush() {
    clearTimeout(st.saveT);
    if (st.kind === 'sheet' && st.att && !st.submitted) {
      putAttempt(st.att);
      const el = $('as-saved'); if (el) el.textContent = `Đã lưu trong máy lúc ${new Date(st.att.updatedAt).toLocaleTimeString('vi-VN')}.`;
    }
  }
  function submit() {
    flush();
    const blank = N - filledCount();
    if (!confirm(`Nộp bài ${S.LABEL[st.seg]}?${blank ? ` Còn ${blank} ô trống.` : ''}`)) return;
    if (!st.att) st.att = { id: Date.now().toString(36), book: st.book, seg: st.seg, fileId: st.file.id, fileName: st.file.name, startedAt: Date.now(), updatedAt: Date.now(), answers: {}, overrides: {}, total: N };
    st.att.submittedAt = Date.now();
    const k = getKey(st.book, st.seg);
    if (k && keyFilled(k)) { const r = G.grade(k, st.att.answers, st.att.overrides, N); st.att.score = r.score; }
    putAttempt(st.att);
    st.submitted = true;
    stopPoll();
    const mins = Math.round((st.att.submittedAt - st.att.startedAt) / 60000);
    L(`Nộp bài ${segLabel(st.book, st.seg)}: ${k && keyFilled(k) ? `${st.att.score}/${N}` : 'chưa có đáp án để chấm'}, trống ${blank} ô` +
      (k ? `, key đã soát ${checkedCount(k, st.seg)}/${N}` : '') + `, từ lúc điền ô đầu tới lúc nộp ${mins} phút.`);
    st.kind = 'result';
    showSide(head(`Kết quả`) + `<div class="vs-body" id="as-result"></div>`);
    renderResult($('as-result'), st.att.id, { inViewer: true });
  }
  function abandon() {
    if (!st.att || !confirm('Bỏ bài đang làm dở (xóa các ô đã điền) và làm lại từ đầu?')) return;
    const list = attempts().filter((a) => a.id !== st.att.id);
    saveAttempts(list);
    L(`Bài làm ${segLabel(st.book, st.seg)}: bỏ bài bắt đầu ${hhmm(st.att.startedAt)}, làm lại.`);
    st.att = null;
    renderSheet(false);
  }
  // Listening: làm nổi cụm câu của Part đang phát (đọc trạng thái trình phát mỗi giây).
  function startPoll() { stopPoll(); if (skillOf(st.seg) === 'L') st.pollT = setInterval(() => markCurPart(false), 1000); }
  function stopPoll() { clearInterval(st.pollT); st.pollT = null; st.curPart = null; }
  function markCurPart(force) {
    if (st.kind !== 'sheet' || skillOf(st.seg) !== 'L' || !window.AudioPlayer) return;
    const a = AudioPlayer._st;
    const part = a && a.open && a.mode === 'exam' && a.list && a.list[a.idx] ? a.list[a.idx].part : null;
    if (part === st.curPart && !force) return;
    st.curPart = part;
    const el = side(); if (!el) return;
    el.querySelectorAll('.qblock').forEach((b) => b.classList.toggle('cur', Number(b.dataset.c) === (part || 0) - 1));
    const cur = el.querySelector('.qblock.cur');
    if (cur && !force && !el.contains(document.activeElement)) cur.scrollIntoView({ block: 'nearest' });
  }

  // ---------- Nhập đáp án (ôn tập) ----------
  function defaultKeySeg() {
    const all = (loadJSON(KEYS_KEY, {})[st.book]) || {};
    return QSEGS.find((s) => keyFilled(all[s]) < N) || 'T1L';
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
    box.closest('.qblock').classList.toggle('done', box.checked);
    L(`Đáp án ${segLabel(st.book, st.keySeg)}: ${box.checked ? 'đã soát' : 'bỏ dấu đã soát'} ${clusterName(st.keySeg, i)} (soát ${checkedCount(k, st.keySeg)}/${N}).`);
    updateStat(k);
  }

  // ---------- Kết quả (dùng chung: khung trong trình xem và hộp trên thẻ Đề) ----------
  function renderResult(box, attId, opt = {}) {
    const a = attempts().find((x) => x.id === attId);
    if (!a) { box.innerHTML = '<p class="hint">Không tìm thấy bài làm.</p>'; return; }
    const k = getKey(a.book, a.seg);
    const all = box.dataset.all === '1';
    let html = `<p><b>${esc(segLabel(a.book, a.seg))}</b> · nộp ${esc(hhmm(a.submittedAt))}</p>`;
    if (!k || !keyFilled(k)) {
      html += `<p class="warn">Chưa có đáp án cho phần này nên chưa chấm. Nhập đáp án xong, mở lại kết quả sẽ tự chấm.</p>`;
      html += `<div class="row"><button class="small" data-r="enterkey">Nhập đáp án ${esc(S.LABEL[a.seg])}</button></div>`;
      html += `<p class="hint">Bạn đã điền ${Object.values(a.answers || {}).filter((v) => String(v).trim()).length}/${N} ô.</p>`;
      box.innerHTML = html; box.dataset.att = attId; return;
    }
    const r = G.grade(k, a.answers, a.overrides || {}, N);
    if (a.score !== r.score) { a.score = r.score; putAttempt(a); }
    const wrong = r.per.filter((x) => x.status !== 'ok');
    const chips = [];
    if (r.overridden) chips.push(`<span class="chip warn">tính đúng tay ${r.overridden} câu</span>`);
    if (r.blank) chips.push(`<span class="chip">trống ${r.blank}</span>`);
    if (r.nokey) chips.push(`<span class="chip bad">thiếu key ${r.nokey} câu</span>`);
    const ck = checkedCount(k, a.seg);
    if (ck < N) chips.push(`<span class="chip warn">key mới soát ${ck}/${N}</span>`);
    html += `<p class="rscore"><b id="r-score">${r.score}/${r.total - r.nokey}</b> ${chips.join(' ')}</p>`;
    html += `<div class="row"><button class="small secondary" data-r="all">${all ? 'Chỉ hiện câu sai/trống' : `Hiện cả ${N} câu`}</button>${opt.inViewer ? '<button class="small secondary" data-r="openkey">Xem trang đáp án trong PDF</button>' : ''}</div>`;
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
      const before = G.grade(k, a.answers, a.overrides || {}, N).score;
      if (v) k.items[q] = v; else delete k.items[q];
      k.edits = (k.edits || 0) + 1; k.at = Date.now();
      setKey(a.book, a.seg, k);
      const after = G.grade(k, a.answers, a.overrides || {}, N).score;
      L(`Sửa key ${segLabel(a.book, a.seg)} câu ${q} từ màn kết quả: điểm ${before} → ${after}/${N}.`);
      renderResult(box, a.id, opt); return;
    }
    if (r === 'enterkey' || r === 'openkey') { openKeyFor(a.book, a.seg, a.fileId); return; }
  }
  // Mở trình xem ở chế độ ôn tập, tới trang Đáp án (nếu đã đánh dấu), mở khung nhập đáp án đúng phần.
  async function openKeyFor(book, seg, fileId) {
    closeModal();
    const file = findPdf(book, fileId);
    if (!file) { alert(`Chưa thấy PDF của Cam ${book} trong Thư viện.`); return; }
    const marks = (loadJSON('ielts.pdfcfg', {})[file.id] || {}).marks || {};
    if (!window.Viewer) return;
    if (Viewer.isOpen()) await Viewer.close(true);   // bài đã nộp: đóng trình xem làm đề (và thanh audio) rồi mở ôn tập
    Viewer.open({ file, mode: 'review', page: file.scope === 'key' ? null : marks.KEY || null, panel: { kind: 'key', seg } });
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

  // Thẻ Đề: tình trạng đáp án và bài đã nộp của quyển đang chọn.
  function refreshCard() {
    const box = $('ex-results');
    if (!box) return;
    const book = Number(($('ex-book') || {}).value);
    if (!book) { box.innerHTML = ''; return; }
    const keys = loadJSON(KEYS_KEY, {})[book] || {};
    const ks = QSEGS.filter((s) => keys[s] && keyFilled(keys[s])).map((s) => `${S.LABEL[s]} ${keyFilled(keys[s])}/${N}${checkedCount(keys[s], s) === N ? ' ✓ soát' : ` (soát ${checkedCount(keys[s], s)})`}`);
    const list = attempts().filter((a) => a.book === book).sort((a, b) => (b.submittedAt || b.updatedAt) - (a.submittedAt || a.updatedAt)).slice(0, 8);
    const rows = list.map((a) => a.submittedAt
      ? `<li>${esc(S.LABEL[a.seg])}: <b>${a.score != null ? `${a.score}/${a.total || N}` : 'chưa chấm'}</b> <span class="hint">nộp ${esc(hhmm(a.submittedAt))}</span> <button class="small secondary" data-res="${esc(a.id)}">Xem</button></li>`
      : `<li>${esc(S.LABEL[a.seg])}: <span class="warn">đang làm dở</span> <span class="hint">(${Object.values(a.answers || {}).filter((v) => String(v).trim()).length}/${N} ô, ${esc(hhmm(a.updatedAt))})</span></li>`).join('');
    box.innerHTML = `<p class="hint">Đáp án đã nhập: ${ks.length ? esc(ks.join(' · ')) : 'chưa có'}.</p>` + (rows ? `<ul class="plain">${rows}</ul>` : '');
  }

  // ---------- Sự kiện ----------
  function onSideClick(e) {
    const b = e.target.closest('[data-a]');
    if (st.kind === 'result') onResultClick(e, $('as-result'), { inViewer: true });
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'toggle') { setCollapsed(!collapsed()); b.textContent = collapsed() ? '▴' : '▾'; return; }
    if (a === 'submit') submit();
    if (a === 'abandon') abandon();
    if (a === 'parse') parseClick();
    if (a === 'pagetext') pageTextClick();
    if (a === 'totext') toTextClick();
    if (a === 'clearkey' && confirm(`Xóa toàn bộ đáp án ${S.LABEL[st.keySeg]} của Cam ${st.book}?`)) { setKey(st.book, st.keySeg, null); L(`Đáp án ${segLabel(st.book, st.keySeg)}: đã xóa.`); renderKeys(); }
  }
  function onSideInput(e) {
    const t = e.target;
    if (t.classList.contains('qin')) onSheetInput(t);
    if (t.classList.contains('kin')) saveKeyItem(Number(t.dataset.q), t.value);
  }
  function onSideChange(e) {
    const t = e.target;
    if (t.id === 'ak-seg') { st.keySeg = t.value; renderKeys(); }
    if (t.id === 'ak-groups') groupsChange(t);
    if (t.dataset && t.dataset.a === 'checked') checkedChange(t);
  }
  function onSideKey(e) {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (!t.classList || !(t.classList.contains('qin') || t.classList.contains('kin') || t.classList.contains('rkin'))) return;
    e.preventDefault();
    if (t.classList.contains('rkin')) { t.closest('tr').querySelector('[data-r="savekey"]').click(); return; }
    const list = [...side().querySelectorAll(t.classList.contains('qin') ? '.qin' : '.kin')];
    const nx = list[list.indexOf(t) + 1];
    if (nx) nx.focus(); else t.blur();
  }
  function bind() {
    const el = side();
    if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('click', onSideClick);
    el.addEventListener('input', onSideInput);
    el.addEventListener('change', onSideChange);
    el.addEventListener('keydown', onSideKey);
    el.addEventListener('focusout', () => flush());
  }
  function init() {
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    const rb = $('ex-results');
    if (rb) rb.addEventListener('click', (e) => { const b = e.target.closest('button[data-res]'); if (b) openModal(b.dataset.res); });
    const kb = $('ex-keys');
    if (kb) kb.onclick = () => { const book = Number($('ex-book').value); const f = window.Viewer && Viewer.selFile && Viewer.selFile(); if (book) openKeyFor(book, null, f && f.id); };
    refreshCard();
  }

  window.Answers = { onOpen, onClose, blocksClose, bind, refreshCard, openModal, openKeyFor, toggleKeys, flush, _st: st };
  init();
})();
