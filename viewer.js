// Mốc 3: trình xem PDF theo đoạn trang, cờ chế độ (ôn tập / làm đề), đánh dấu khoảng trang, lớp highlight vẽ đè.
// Trang PDF được vẽ ra ảnh (canvas) vì map và chart trong sách là ảnh bitmap. Không có nội dung Cambridge trong code.
// Cấu hình trang và nét vẽ lưu trong máy (localStorage) tới mốc 6 thì đồng bộ lên Drive.
'use strict';
(function () {
  const PCFG_KEY = 'ielts.pdfcfg';   // {[fileId]: {marks: {key: trang PDF}, offset: lệch số trang in, lastPage}}
  const INK_KEY = 'ielts.ink';       // {[fileId]: {[trang]: [{t: 'hl'|'ul', p: 'x,y x,y'}]}}
  const ZOOMS = [1, 1.25, 1.5, 2, 2.5, 3];
  const MAX_PX = 12e6;               // trần số điểm ảnh mỗi canvas (iPhone giới hạn khoảng 16,7 triệu)
  const INK_W = 1000;                // hệ tọa độ nét vẽ: bề ngang trang = 1000 đơn vị
  const S = Sections;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const st = {
    file: null, src: null, doc: null, num: 0, page: 1, zoom: 0, mode: 'review', segKey: null,
    segs: [], allowed: [], tool: 'view', seq: 0, task: null, pageObj: null, ink: null, H: 1414, drawing: null, detect: null,
  };

  // ---------- Lưu trong máy ----------
  function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (_) { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { log('Không lưu được vào máy: ' + e.message); return false; } }
  function pcfg(id) { const all = loadJSON(PCFG_KEY, {}); const c = all[id] || {}; c.marks = c.marks || {}; return c; }
  function setPcfg(id, c) { const all = loadJSON(PCFG_KEY, {}); all[id] = c; saveJSON(PCFG_KEY, all); }
  const printed = (p) => { const c = st.file && pcfg(st.file.id); return c && Number.isInteger(c.offset) ? p - c.offset : null; };

  // ---------- Khung giao diện ----------
  function buildDom() {
    if ($('viewer')) return;
    document.body.insertAdjacentHTML('beforeend', `
<div id="viewer" class="viewer" hidden>
  <div class="vbar">
    <button class="small secondary" data-v="close" aria-label="Đóng">✕ Đóng</button>
    <div class="vtitle"><b id="v-title"></b> <span id="v-sub" class="hint"></span></div>
    <span id="v-mode" class="badge"></span>
  </div>
  <div class="vbar">
    <button class="small" data-v="prev" aria-label="Trang trước">‹</button>
    <span class="vnav"><span class="lbl">Trang</span> <input id="v-goto" inputmode="numeric" size="3"> / <span id="v-num"></span> <span id="v-printed" class="hint"></span></span>
    <button class="small" data-v="next" aria-label="Trang sau">›</button>
    <button class="small secondary" data-v="zoomout" aria-label="Thu nhỏ">−</button><span id="v-zoom" class="hint"></span><button class="small secondary" data-v="zoomin" aria-label="Phóng to">+</button>
    <select id="v-jump" aria-label="Đi tới phần"></select>
  </div>
  <div class="vbar vtools">
    <button class="small tool on" data-tool="view">Xem</button>
    <button class="small tool" data-tool="hl">Highlight</button>
    <button class="small tool" data-tool="ul">Gạch chân</button>
    <button class="small tool" data-tool="erase">Tẩy</button>
    <button class="small secondary" data-v="undo">Hoàn tác</button>
    <button class="small secondary" data-v="marks" id="v-marks-btn">Đánh dấu trang</button>
  </div>
  <div id="v-banner"></div>
  <div id="v-marks" class="vpanel" hidden></div>
  <div id="v-scroll" class="vscroll"><div id="v-box" class="vbox"><svg id="v-ink" class="vink" preserveAspectRatio="none"></svg></div></div>
  <div id="v-status" class="vstatus"></div>
</div>`);
    const v = $('viewer');
    v.addEventListener('click', onClick);
    $('v-goto').addEventListener('change', () => go(parseInt($('v-goto').value, 10), 0));
    $('v-jump').addEventListener('change', () => { const s = st.segs.find((x) => x.key === $('v-jump').value); if (s) go(s.start, 0); $('v-jump').value = ''; });
    $('v-marks').addEventListener('click', onMarksClick);
    $('v-status').addEventListener('click', () => $('v-status').classList.toggle('full'));
    const ink = $('v-ink');
    ink.addEventListener('pointerdown', inkDown);
    ink.addEventListener('pointermove', inkMove);
    ink.addEventListener('pointerup', inkUp);
    ink.addEventListener('pointercancel', inkUp);
    window.addEventListener('keydown', (e) => {
      if ($('viewer').hidden || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { go(st.page, +1); e.preventDefault(); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { go(st.page, -1); e.preventDefault(); }
    });
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (st.doc && !$('viewer').hidden) render(); }, 250); });
  }

  function banner(html) { $('v-banner').innerHTML = html ? `<div class="vbanner">${html}</div>` : ''; }
  function status() {
    const s = st.src && st.src.stats;
    const parts = [];
    if (s) {
      parts.push(s.mode === 'range' ? 'Lấy từng đoạn (Range): có' : '<span class="warn">Lấy từng đoạn: không, đã tải cả file</span>');
      parts.push(`đã tải ${PdfSource.mb(s.net)} qua mạng${s.cache ? `, đọc ${PdfSource.mb(s.cache)} từ cache` : ''} / file ${PdfSource.mb(s.size)} (${s.requests} lần gọi)`);
      if (s.firstMs != null) parts.push(`đoạn đầu ${s.firstMs} ms`);
    }
    if (st.lastRender) parts.push(`vẽ trang ${st.lastRender.ms} ms, ${st.lastRender.w}×${st.lastRender.h} px`);
    if (st.inkKB != null) parts.push(`nét vẽ ${st.inkKB} KB`);
    $('v-status').innerHTML = parts.join(' · ');
  }

  // ---------- Mở / đóng ----------
  // opts: {file: {id, name, size, book}, mode: 'review'|'exam', segKey}
  async function open(opts) {
    const wait = window.ensureToken();   // gọi trước mọi await để cửa sổ gia hạn không bị chặn
    buildDom();
    await closeDoc();
    Object.assign(st, { file: opts.file, mode: opts.mode || 'review', segKey: opts.segKey || null, tool: 'view', zoom: 0, page: 1, lastRender: null, inkKB: null });
    $('viewer').hidden = false;
    document.body.classList.add('viewing');
    $('v-title').textContent = (opts.file.book ? `Cam ${opts.file.book} · ` : '') + (st.mode === 'exam' ? S.LABEL[st.segKey] : opts.file.name);
    $('v-sub').textContent = st.mode === 'exam' ? opts.file.name : '';
    $('v-mode').textContent = st.mode === 'exam' ? 'Làm đề' : 'Ôn tập';
    $('v-mode').className = 'badge ' + (st.mode === 'exam' ? 'c-low' : 'c-high');
    $('v-marks-btn').hidden = st.mode === 'exam';
    $('v-jump').hidden = st.mode === 'exam';
    $('v-marks').hidden = true;
    setTool('view');
    banner('Đang mở…');
    $('v-status').textContent = '';
    const t0 = performance.now();
    try {
      await wait;
      st.src = await PdfSource.openDocument(opts.file, {
        onStats: status,
        // Token hết hạn giữa chừng: dừng tải, chờ Minh bấm (trình duyệt chỉ cho mở cửa sổ gia hạn khi có thao tác bấm).
        onAuthNeeded: (retry) => {
          banner('Token đã hết hạn nên đang dừng tải trang. <button class="small" id="v-reauth">Gia hạn và tải tiếp</button>');
          $('v-reauth').onclick = () => window.ensureToken().then(() => { banner(''); log('Đã gia hạn token, tải tiếp PDF.'); retry(); }, (e) => banner(esc(e.message)));
        },
        onError: (msg, retry) => {
          banner(`${esc(msg)} <button class="small" id="v-retry">Thử lại</button>`);
          $('v-retry').onclick = () => { banner(''); retry(); };
        },
        confirmFull: async (size) => confirm(`Drive không cho lấy riêng từng đoạn của file này. Tải cả file ${PdfSource.mb(size)} về máy?` +
          (/iPhone|iPad/.test(navigator.userAgent) && size > 100e6 ? '\n\nFile lớn, iPhone có thể không mở nổi. Nên dùng bản PDF nhỏ hơn nếu có.' : '')),
      });
    } catch (e) {
      banner(`<span class="bad">Không mở được: ${esc(e.message)}</span>`);
      log(`Mở PDF lỗi (${opts.file.name}): ${e.message}`);
      return;
    }
    st.doc = st.src.doc;
    st.num = st.doc.numPages;
    $('v-num').textContent = st.num;
    loadSegs();
    if (st.mode === 'exam') {
      if (!st.allowed.length) { banner('<span class="bad">Phần này chưa có khoảng trang. Mở ôn tập rồi đánh dấu trang trước.</span>'); return; }
      st.page = st.allowed[0];
    } else st.page = Math.min(st.num, pcfg(opts.file.id).lastPage || 1);
    banner('');
    log(`Mở PDF ${opts.file.name}: ${st.num} trang, chế độ ${st.mode === 'exam' ? 'làm đề ' + st.segKey : 'ôn tập'}, ${st.src.stats.mode === 'range' ? 'lấy từng đoạn' : 'tải cả file'}, ${Math.round(performance.now() - t0)} ms.`);
    await render();
  }

  async function closeDoc() {
    st.seq++;
    try { if (st.task) st.task.cancel(); } catch (_) {}
    if (st.src) { try { await st.src.close(); } catch (_) {} }
    st.src = null; st.doc = null; st.pageObj = null; st.task = null;
    const c = $('v-box') && $('v-box').querySelector('canvas');
    if (c) { c.width = 0; c.height = 0; c.remove(); }
  }

  async function close() {
    if (st.mode === 'exam' && st.doc && !confirm('Thoát bài đang làm?')) return;
    if (st.detect) st.detect.cancel = true;
    if (st.src) log(`Đóng PDF ${st.file.name}: đã tải ${PdfSource.mb(st.src.stats.net)} qua mạng, ${PdfSource.mb(st.src.stats.cache)} từ cache, file ${PdfSource.mb(st.src.stats.size)}.`);
    await closeDoc();
    $('viewer').hidden = true;
    document.body.classList.remove('viewing');
    refreshPicker();
  }

  // ---------- Khoảng trang và chặn trang ----------
  function loadSegs() {
    st.segs = S.segments(pcfg(st.file.id).marks, st.num);
    st.allowed = st.mode === 'exam' ? S.allowedPages(st.segs, st.segKey) : [];
    const sel = $('v-jump');
    sel.innerHTML = `<option value="">Đi tới phần…</option>` + st.segs.map((s) => `<option value="${s.key}">${esc(S.LABEL[s.key])} (trang ${s.start}–${s.end})</option>`).join('');
  }

  // Đi tới trang n (dir = 0), hoặc trang kế trước/sau trang n (dir = -1/+1). Làm đề thì chỉ trong trang được phép.
  function go(n, dir) {
    if (!st.doc || !Number.isInteger(n)) { syncNav(); return; }
    let target;
    if (st.mode === 'exam') {
      const a = st.allowed;
      if (dir > 0) target = a.find((p) => p > n);
      else if (dir < 0) target = [...a].reverse().find((p) => p < n);
      else target = a.includes(n) ? n : null;
      if (target == null) { flash(dir ? 'Hết trang của phần đang làm.' : `Trang ${n} nằm ngoài phần đang làm (${S.LABEL[st.segKey]}).`); syncNav(); return; }
    } else {
      target = Math.min(st.num, Math.max(1, n + dir));
    }
    if (!S.canView(st.segs, st.mode, st.segKey, target, st.num)) { flash('Không xem được trang này ở chế độ làm đề.'); syncNav(); return; }
    if (target === st.page && dir) { syncNav(); return; }
    st.page = target;
    $('v-scroll').scrollTop = 0;
    render();
  }

  let flashT = null;
  function flash(msg) {
    banner(`<span class="warn">${esc(msg)}</span>`);
    clearTimeout(flashT);
    flashT = setTimeout(() => { if ($('v-banner').textContent === msg) banner(''); }, 2500);   // không xóa thông báo khác (vd token hết hạn)
  }

  function syncNav() {
    $('v-goto').value = st.page;
    const pr = printed(st.page);
    const kinds = S.kindsOf(st.segs, st.page).map((k) => S.LABEL[k]);
    let pos = '';
    if (st.mode === 'exam') pos = `· trang ${st.allowed.indexOf(st.page) + 1}/${st.allowed.length} của phần`;
    $('v-printed').textContent = `${pr != null ? `(in ${pr}) ` : ''}${kinds.length && st.mode !== 'exam' ? '· ' + kinds.join(', ') : ''} ${pos}`.trim();
    const first = st.mode === 'exam' ? st.page === st.allowed[0] : st.page <= 1;
    const last = st.mode === 'exam' ? st.page === st.allowed[st.allowed.length - 1] : st.page >= st.num;
    $('viewer').querySelector('[data-v="prev"]').disabled = first;
    $('viewer').querySelector('[data-v="next"]').disabled = last;
    $('v-zoom').textContent = Math.round(ZOOMS[st.zoom] * 100) + '%';
  }

  // ---------- Vẽ trang ra ảnh ----------
  async function render() {
    const my = ++st.seq;
    const n = st.page;
    syncNav();
    const t0 = performance.now();
    let page;
    try { page = await st.doc.getPage(n); } catch (e) { if (my === st.seq) banner(`<span class="bad">Lỗi đọc trang ${n}: ${esc(e.message)}</span>`); return; }
    if (my !== st.seq) return;
    const base = page.getViewport({ scale: 1 });
    const boxW = Math.max(200, $('v-scroll').clientWidth - 16);
    const cssW = Math.round(boxW * ZOOMS[st.zoom]);
    const cssH = Math.round(cssW * base.height / base.width);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let px = (cssW / base.width) * dpr;
    if (base.width * base.height * px * px > MAX_PX) px = Math.sqrt(MAX_PX / (base.width * base.height));
    const vp = page.getViewport({ scale: px });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    if (st.task) { try { st.task.cancel(); } catch (_) {} }
    st.task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp });
    try { await st.task.promise; } catch (e) { if (e && e.name === 'RenderingCancelledException') return; if (my === st.seq) banner(`<span class="bad">Lỗi vẽ trang ${n}: ${esc(e.message)}</span>`); return; }
    if (my !== st.seq) { canvas.width = 0; return; }
    const box = $('v-box');
    const old = box.querySelector('canvas');
    if (old) { old.width = 0; old.height = 0; old.remove(); }
    box.style.width = cssW + 'px'; box.style.height = cssH + 'px';
    box.insertBefore(canvas, $('v-ink'));
    if (st.pageObj && st.pageObj !== page) { try { st.pageObj.cleanup(); } catch (_) {} }
    st.pageObj = page;
    st.lastRender = { ms: Math.round(performance.now() - t0), w: canvas.width, h: canvas.height };
    st.H = Math.round(INK_W * base.height / base.width);
    $('v-ink').setAttribute('viewBox', `0 0 ${INK_W} ${st.H}`);
    drawInk();
    status();
    if (st.mode === 'review') { const c = pcfg(st.file.id); c.lastPage = n; setPcfg(st.file.id, c); }
    prefetch(n);
  }

  // Tải sẵn dữ liệu trang kế tiếp (chỉ trang được xem) để lật trang nhanh hơn.
  async function prefetch(n) {
    const next = st.mode === 'exam' ? st.allowed.find((p) => p > n) : (n < st.num ? n + 1 : null);
    if (!next) return;
    const doc = st.doc;
    try { const p = await doc.getPage(next); if (doc !== st.doc) return; await p.getOperatorList(); if (p !== st.pageObj) p.cleanup(); } catch (_) {}
  }

  // ---------- Lớp vẽ (highlight, gạch chân, tẩy) ----------
  function inkAll() { return loadJSON(INK_KEY, {}); }
  function inkPage() { const a = inkAll(); return ((a[st.file.id] || {})[st.page]) || []; }
  function saveInkPage(list) {
    const a = inkAll();
    a[st.file.id] = a[st.file.id] || {};
    if (list.length) a[st.file.id][st.page] = list; else delete a[st.file.id][st.page];
    if (!Object.keys(a[st.file.id]).length) delete a[st.file.id];
    saveJSON(INK_KEY, a);
    st.inkKB = Math.round((localStorage.getItem(INK_KEY) || '').length / 1024 * 10) / 10;
    status();
  }
  const ptsOf = (s) => s.p.split(' ').map((q) => q.split(',').map(Number));
  function drawInk() {
    const svg = $('v-ink');
    const list = inkPage();
    svg.innerHTML = list.map((s, i) => `<polyline class="ink-${s.t}" data-i="${i}" points="${s.p}"/>`).join('') + '<polyline id="v-live" points=""/>';
    if (st.inkKB == null) st.inkKB = Math.round((localStorage.getItem(INK_KEY) || '').length / 1024 * 10) / 10;
  }
  function setTool(t) {
    st.tool = t;
    $('viewer').querySelectorAll('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    $('v-ink').classList.toggle('active', t !== 'view');
  }
  function inkPt(e) {
    const r = $('v-ink').getBoundingClientRect();
    return [Math.round((e.clientX - r.left) / r.width * INK_W * 10) / 10, Math.round((e.clientY - r.top) / r.height * st.H * 10) / 10];
  }
  function inkDown(e) {
    if (st.tool === 'view' || !st.doc) return;
    e.preventDefault();
    $('v-ink').setPointerCapture(e.pointerId);
    st.drawing = { t: st.tool, pts: [inkPt(e)], id: e.pointerId };
    if (st.tool === 'erase') eraseAt(st.drawing.pts[0]);
    else { const live = $('v-live'); live.setAttribute('class', 'ink-' + st.tool); }
  }
  function inkMove(e) {
    const d = st.drawing;
    if (!d || e.pointerId !== d.id) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      const p = inkPt(ev);
      const last = d.pts[d.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 2) continue;
      d.pts.push(p);
      if (d.t === 'erase') eraseAt(p);
    }
    if (d.t !== 'erase') $('v-live').setAttribute('points', d.pts.map((q) => q.join(',')).join(' '));
  }
  function inkUp(e) {
    const d = st.drawing;
    if (!d || e.pointerId !== d.id) return;
    st.drawing = null;
    $('v-live').setAttribute('points', '');
    if (d.t === 'erase') return;
    let pts = d.pts;
    if (pts.length < 2) return;
    // Nét gần như nằm ngang thì kéo thẳng cho gọn (highlight và gạch chân thường theo dòng chữ).
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    if (w < 4) return;
    if (h < 14 && w > 3 * h) {
      const y = Math.round(ys.reduce((a, b) => a + b, 0) / ys.length * 10) / 10;
      pts = [[Math.min(...xs), y], [Math.max(...xs), y]];
    }
    const list = inkPage();
    list.push({ t: d.t, p: pts.map((q) => q.join(',')).join(' ') });
    saveInkPage(list);
    drawInk();
  }
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = dx * dx + dy * dy;
    let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  function eraseAt(p) {
    const list = inkPage();
    const keep = list.filter((s) => {
      const q = ptsOf(s);
      const tol = s.t === 'hl' ? 12 : 8;
      if (q.length === 1) return Math.hypot(p[0] - q[0][0], p[1] - q[0][1]) > tol;
      for (let i = 1; i < q.length; i++) if (segDist(p, q[i - 1], q[i]) <= tol) return false;
      return true;
    });
    if (keep.length !== list.length) { saveInkPage(keep); drawInk(); }
  }
  function undo() { const list = inkPage(); if (!list.length) { flash('Trang này chưa có nét nào.'); return; } list.pop(); saveInkPage(list); drawInk(); }

  // ---------- Đánh dấu khoảng trang (chỉ ở chế độ ôn tập) ----------
  function renderMarks() {
    const box = $('v-marks');
    const c = pcfg(st.file.id);
    const used = c.marks;
    const nextKey = S.KEYS.find((k) => used[k] == null) || 'OTHER';
    const pr = (p) => (Number.isInteger(c.offset) ? ` (in ${p - c.offset})` : '');
    const rows = st.segs.map((s) => `<tr><td>${esc(S.LABEL[s.key])}${S.BLOCKED.has(s.key) ? ' <span class="chip warn">chặn khi làm đề</span>' : ''}</td>
      <td>${s.start}–${s.end}${Number.isInteger(c.offset) ? `<span class="hint"> · in ${s.start - c.offset}–${s.end - c.offset}</span>` : ''}</td>
      <td><button class="small secondary" data-m="goto" data-p="${s.start}">Tới</button> <button class="small secondary" data-m="del" data-k="${s.key}">Xóa</button></td></tr>`).join('');
    const d = st.detect;
    box.innerHTML = `
      <div class="row"><span>Trang PDF <b>${st.page}</b>${pr(st.page)} là trang bắt đầu của:</span>
        <select id="m-key">${S.KEYS.map((k) => `<option value="${k}"${k === nextKey ? ' selected' : ''}>${esc(S.LABEL[k])}${used[k] != null ? ` (đang là trang ${used[k]})` : ''}</option>`).join('')}</select>
        <button class="small" data-m="set">Đánh dấu</button></div>
      <div class="row"><span>Số in trên trang này:</span> <input id="m-printed" inputmode="numeric" size="4" value="${printed(st.page) ?? ''}">
        <button class="small secondary" data-m="offset">Lưu độ lệch</button>
        <span class="hint">${Number.isInteger(c.offset) ? `Đang lệch ${c.offset} (trang PDF = số in + ${c.offset})` : 'Chưa có độ lệch'}</span></div>
      <div class="row"><button class="small secondary" data-m="detect"${d && d.running ? ' disabled' : ''}>Dò tự động theo tiêu đề</button>
        ${d && d.running ? '<button class="small secondary" data-m="stop">Dừng</button>' : ''}<span class="hint" id="m-dstat">${esc(d ? d.msg : 'Cần PDF có lớp chữ. Tải gần như cả file, nên làm trên máy tính dùng Wi-Fi.')}</span></div>
      ${d && d.result ? detectBox(d.result) : ''}
      ${st.segs.length ? `<table class="mtable"><tr><th>Phần</th><th>Trang PDF</th><th></th></tr>${rows}</table>` : '<p class="hint">Chưa đánh dấu phần nào.</p>'}
      <p class="hint">Mỗi phần kéo dài tới trước trang bắt đầu của phần kế tiếp. Đánh dấu cả Audioscripts, Đáp án, Bài mẫu để chế độ làm đề chặn được, và "Trang khác" cho trang không thuộc phần nào (giới thiệu, quảng cáo) nằm giữa hay cuối sách.</p>`;
  }
  function detectBox(r) {
    const keys = Object.keys(r.marks);
    return `<div class="vdetect"><b>Gợi ý (${keys.length} phần${r.offset ? `, lệch số trang ${r.offset.offset}` : ''}):</b>
      <ul class="plain">${r.notes.filter((n) => !n.startsWith('bỏ qua')).map((n) => `<li>${esc(n)}</li>`).join('')}${r.offset ? `<li>Độ lệch số trang: ${r.offset.offset} (khớp ${r.offset.votes}/${r.offset.pages} trang có số)</li>` : ''}</ul>
      <div class="row"><button class="small" data-m="apply">Dùng gợi ý</button><button class="small secondary" data-m="dismiss">Bỏ</button></div>
      <p class="hint">Dùng gợi ý sẽ ghi đè các phần trùng tên; phần đã đánh dấu tay mà gợi ý không có thì giữ nguyên. Kiểm lại từng phần bằng nút "Tới".</p></div>`;
  }
  function onMarksClick(e) {
    const b = e.target.closest('button[data-m]');
    if (!b) return;
    const c = pcfg(st.file.id);
    const m = b.dataset.m;
    if (m === 'set') { const k = $('m-key').value; c.marks[k] = st.page; setPcfg(st.file.id, c); log(`Đánh dấu ${S.LABEL[k]} bắt đầu trang PDF ${st.page}.`); }
    if (m === 'del') { delete c.marks[b.dataset.k]; setPcfg(st.file.id, c); }
    if (m === 'goto') { go(Number(b.dataset.p), 0); }
    if (m === 'offset') {
      const v = $('m-printed').value.trim();
      if (v === '') delete c.offset;
      else { const n = parseInt(v, 10); if (!Number.isInteger(n)) { flash('Nhập số trang in.'); return; } c.offset = st.page - n; log(`Độ lệch số trang: trang PDF ${st.page} in số ${n}, lệch ${c.offset}.`); }
      setPcfg(st.file.id, c);
    }
    if (m === 'detect') {
      // pdf.js đọc chữ của trang thì cũng tải luôn ảnh scan của trang đó, nên dò gần như tải cả file.
      const s = st.src.stats;
      const left = Math.max(0, s.size - s.net - s.cache);
      const phone = /iPhone|iPad|Android/.test(navigator.userAgent);
      if (!confirm(`Dò tự động đọc chữ của cả ${st.num} trang, nên sẽ tải gần như cả file: khoảng ${PdfSource.mb(left)} nữa ` +
        `(file ${PdfSource.mb(s.size)}, phần đã có trong cache không tải lại).` + (phone ? '\n\nNên làm trên máy tính dùng Wi-Fi.' : '') + '\n\nTiếp tục?')) return;
      runDetect(); return;
    }
    if (m === 'stop') { if (st.detect) st.detect.cancel = true; return; }
    if (m === 'apply' && st.detect && st.detect.result) {
      const r = st.detect.result;
      Object.assign(c.marks, r.marks);
      if (r.offset && !Number.isInteger(c.offset)) c.offset = r.offset.offset;
      setPcfg(st.file.id, c); st.detect = null;
      log(`Dùng gợi ý dò tự động: ${Object.keys(r.marks).length} phần.`);
    }
    if (m === 'dismiss') st.detect = null;
    loadSegs(); syncNav(); renderMarks();
  }

  async function runDetect() {
    const doc = st.doc;
    const d = st.detect = { running: true, cancel: false, msg: 'Đang dò…', result: null };
    renderMarks();
    const net0 = st.src.stats.net;
    const t0 = performance.now();
    const pages = [];
    for (let p = 1; p <= st.num; p++) {
      if (d.cancel || doc !== st.doc) break;
      try {
        const pg = await doc.getPage(p);
        const h = pg.getViewport({ scale: 1 }).height;
        const tc = await pg.getTextContent();
        const edges = tc.items.filter((it) => it.str && (it.transform[5] < h * 0.08 || it.transform[5] > h * 0.92)).map((it) => it.str);
        pages.push({ p, text: tc.items.map((it) => it.str).join(' '), edges });
        if (pg !== st.pageObj) pg.cleanup();
      } catch (e) { pages.push({ p, text: '' }); }
      d.msg = `Đang dò trang ${p}/${st.num} · tải thêm ${PdfSource.mb(st.src.stats.net - net0)}`;
      const el = $('m-dstat'); if (el) el.textContent = d.msg;
    }
    const withText = pages.filter((x) => x.text.trim().length > 20).length;
    d.running = false;
    d.result = S.detect(pages);
    d.msg = `${d.cancel ? 'Đã dừng. ' : ''}Đọc ${pages.length}/${st.num} trang, ${withText} trang có chữ, tải thêm ${PdfSource.mb(st.src.stats.net - net0)}, ${((performance.now() - t0) / 1000).toFixed(1)} giây.` +
      (withText < pages.length * 0.5 ? ' Ít trang có lớp chữ, nên đánh dấu tay.' : '');
    log(`Dò tự động ${st.file.name}: ${d.msg} Gợi ý ${Object.keys(d.result.marks).length} phần.`);
    if (doc === st.doc && !$('v-marks').hidden) renderMarks();
  }

  // ---------- Nút ----------
  function onClick(e) {
    const tb = e.target.closest('button[data-tool]');
    if (tb) { setTool(tb.dataset.tool); return; }
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    const v = b.dataset.v;
    if (v === 'close') close();
    if (v === 'prev') go(st.page, -1);
    if (v === 'next') go(st.page, +1);
    if (v === 'zoomin' && st.zoom < ZOOMS.length - 1) { st.zoom++; render(); }
    if (v === 'zoomout' && st.zoom > 0) { st.zoom--; render(); }
    if (v === 'undo') undo();
    if (v === 'marks' && st.mode !== 'exam') { const p = $('v-marks'); p.hidden = !p.hidden; if (!p.hidden) renderMarks(); }
  }

  // ---------- Thẻ "Đề" trên trang chính ----------
  function bookPdfs() {
    const res = (window.Library && window.Library._results()) || [];
    const m = new Map();
    for (const r of res) {
      if (r.kind !== 'pdf' || r.ignored || !r.book || r.conf === 'unassigned') continue;
      if (!m.has(r.book)) m.set(r.book, []);
      m.get(r.book).push(r);
    }
    for (const list of m.values()) list.sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) || (a.scope === 'key') - (b.scope === 'key'));
    return m;
  }
  function refreshPicker() {
    const sb = $('ex-book');
    if (!sb) return;
    const m = bookPdfs();
    const prev = sb.value;
    sb.innerHTML = m.size ? [...m.keys()].sort((a, b) => a - b).map((b) => `<option value="${b}">Cam ${b}</option>`).join('') : '<option value="">(chưa quét thư viện)</option>';
    if (prev && m.has(Number(prev))) sb.value = prev;
    pickBook();
  }
  function pickBook() {
    const m = bookPdfs();
    const list = m.get(Number($('ex-book').value)) || [];
    const sp = $('ex-pdf');
    const prev = sp.value;
    sp.innerHTML = list.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}${r.scope === 'key' ? ' (key)' : ''}${r.isMain ? ' (chính)' : ''}${r.size ? ` · ${(r.size / 1e6).toFixed(1)} MB` : ''}</option>`).join('');
    if (prev && list.some((r) => r.id === prev)) sp.value = prev;
    pickPdf();
  }
  function selFile() {
    const list = bookPdfs().get(Number($('ex-book').value)) || [];
    return list.find((r) => r.id === $('ex-pdf').value) || null;
  }
  function pickPdf() {
    const f = selFile();
    const ss = $('ex-seg');
    const signedIn = !!loadAuth();
    $('ex-review').disabled = !f || !signedIn;
    $('ex-probe').disabled = !f || !signedIn;
    if (!f) { ss.innerHTML = ''; $('ex-exam').disabled = true; $('ex-hint').textContent = ''; return; }
    const c = pcfg(f.id);
    const keys = S.KEYS.filter((k) => S.isTestKey(k) && c.marks[k] != null);
    ss.innerHTML = keys.map((k) => `<option value="${k}">${esc(S.LABEL[k])}</option>`).join('');
    $('ex-exam').disabled = !keys.length || !signedIn || f.scope === 'key';
    const blocked = ['AS', 'KEY', 'SAMPLE'].filter((k) => c.marks[k] != null).map((k) => S.LABEL[k]);
    $('ex-hint').textContent = f.scope === 'key' ? 'File key chỉ mở ở chế độ ôn tập.' :
      !keys.length ? 'Chưa đánh dấu trang cho PDF này. Bấm "Mở ôn tập" rồi "Đánh dấu trang".' :
      `Đã đánh dấu ${Object.keys(c.marks).length} phần. Chặn khi làm đề: ${blocked.join(', ') || 'chưa đánh dấu phần nào cần chặn (Audioscripts, Đáp án, Bài mẫu)'}.`;
  }
  async function probeClick() {
    const f = selFile(); if (!f) return;
    const wait = window.ensureToken();
    const out = $('ex-probe-out');
    out.textContent = 'Đang thử…';
    try { await wait; const lines = await PdfSource.probe(f); out.textContent = lines.join('\n'); }
    catch (e) { out.textContent = 'Lỗi: ' + e.message; }
  }
  async function cacheClick(clear) {
    if (clear) { if (!confirm('Xóa toàn bộ PDF đã lưu tạm trong máy này?')) return; await PdfSource.clearCache(); log('Đã xóa cache PDF.'); }
    const i = await PdfSource.cacheInfo();
    $('ex-cache').textContent = `Cache PDF: ${i.chunks} đoạn (khoảng ${i.chunkMB.toFixed(1)} MB), ${i.full} file tải nguyên.` +
      (i.usage != null ? ` Trình duyệt đang dùng ${(i.usage / 1e6).toFixed(1)} MB / hạn mức ${(i.quota / 1e6).toFixed(0)} MB.` : '');
  }

  function init() {
    buildDom();
    if (!$('ex-book')) return;
    $('ex-book').onchange = pickBook;
    $('ex-pdf').onchange = pickPdf;
    $('ex-review').onclick = () => { const f = selFile(); if (f) open({ file: f, mode: 'review' }); };
    $('ex-exam').onclick = () => { const f = selFile(); if (f) open({ file: f, mode: 'exam', segKey: $('ex-seg').value }); };
    $('ex-probe').onclick = probeClick;
    $('ex-cache-btn').onclick = () => cacheClick(false);
    $('ex-cache-clear').onclick = () => cacheClick(true);
    refreshPicker();
  }

  window.Viewer = { open, close, refreshPicker, _st: st };
  init();
})();
