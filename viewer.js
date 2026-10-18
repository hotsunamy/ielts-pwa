// Mốc 3: trình xem PDF theo đoạn trang, cờ chế độ (ôn tập / làm đề), đánh dấu khoảng trang, lớp highlight vẽ đè.
// Trang PDF được vẽ ra ảnh (canvas) vì map và chart trong sách là ảnh bitmap. Không có nội dung Cambridge trong code.
// Cấu hình trang và nét vẽ lưu trong máy (localStorage); m6-1: đồng bộ giữa các máy qua sync.js (vùng dữ liệu ẩn trên Drive).
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
    style: 'mock',     // m5-2: làm đề kiểu 'mock' (Thi thử: giờ, không dừng tay) hoặc 'practice' (Luyện: có phiếu và chấm, dừng/tua tự do)
    pen: false, pan: null,   // m5-2 mục 3.8: đã thấy bút (Apple Pencil) thì lớp vẽ chỉ nhận nét bút, ngón tay để cuộn
    peek: new Map(), peekSeq: 0, peekW: 0, flip: null, flipAnim: false, slideDir: 0,   // m6-1: lật trang bằng cách kéo
  };
  const PEN_KEY = 'ielts.pen';
  const STYLE = { mock: 'Thi thử', practice: 'Luyện' };

  // ---------- Lưu trong máy ----------
  function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (_) { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); if (window.Sync) Sync.touched(k); return true; } catch (e) { log('Không lưu được vào máy: ' + e.message); return false; } }
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
    <button class="small secondary" data-v="audio" id="v-audio-btn">Audio</button>
    <button class="small secondary" data-v="keys" id="v-keys-btn">Đáp án</button>
  </div>
  <div id="v-banner"></div>
  <div id="v-marks" class="vpanel" hidden></div>
  <div class="vmain">
    <div id="v-scroll" class="vscroll"><div id="v-box" class="vbox"><svg id="v-ink" class="vink" preserveAspectRatio="none"></svg></div></div>
    <div id="v-flip" class="vflip" hidden></div>
    <div id="v-side" class="vside" hidden></div>
    <div id="v-cover" class="vcover" hidden></div>
  </div>
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
    // m6-1: kéo ngang bằng ngón tay để lật trang (trang trượt theo tay). Kéo dọc vẫn cuộn.
    const sc = $('v-scroll');
    sc.addEventListener('pointerdown', flipDown);
    sc.addEventListener('pointermove', flipMove);
    sc.addEventListener('pointerup', flipUp);
    sc.addEventListener('pointercancel', flipCancelEv);
    window.addEventListener('keydown', (e) => {
      if ($('viewer').hidden || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { go(st.page, +1); e.preventDefault(); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { go(st.page, -1); e.preventDefault(); }
    });
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (st.doc && !$('viewer').hidden) render(); }, 250); });
    // m5-1: khung phiếu trả lời / đáp án mở, đóng, thu gọn làm khung trang PDF đổi bề ngang: vẽ lại cho vừa.
    if (window.ResizeObserver) {
      let ro = null;
      new ResizeObserver(() => { clearTimeout(ro); ro = setTimeout(() => {
        if (st.doc && !$('viewer').hidden && st.renderedW && Math.abs($('v-scroll').clientWidth - st.renderedW) > 4) render();
      }, 150); }).observe($('v-scroll'));
    }
    if (window.Answers) Answers.bind();
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
  // opts: {file: {id, name, size, book}, mode: 'review'|'exam', segKey, page (ôn tập: mở ở trang này), panel: {kind: 'key', seg} (m5-1)}
  async function open(opts) {
    const wait = window.ensureToken();   // gọi trước mọi await để cửa sổ gia hạn không bị chặn
    buildDom();
    await closeDoc();
    Object.assign(st, { file: opts.file, mode: opts.mode || 'review', segKey: opts.segKey || null, tool: 'view', zoom: 0, page: 1, lastRender: null, inkKB: null,
      style: opts.style === 'practice' ? 'practice' : 'mock' });
    $('viewer').hidden = false;
    document.body.classList.add('viewing');
    $('v-title').textContent = (opts.file.book ? `Cam ${opts.file.book} · ` : '') + (st.mode === 'exam' ? S.LABEL[st.segKey] : opts.file.name);
    $('v-sub').textContent = st.mode === 'exam' ? opts.file.name : '';
    $('v-mode').textContent = st.mode === 'exam' ? STYLE[st.style] : 'Ôn tập';
    $('v-mode').className = 'badge ' + (st.mode === 'exam' ? 'c-low' : 'c-high');
    $('v-marks-btn').hidden = st.mode === 'exam';
    $('v-jump').hidden = st.mode === 'exam';
    $('v-audio-btn').hidden = st.mode === 'exam';   // làm đề: thanh audio tự hiện ở phần Listening
    $('v-keys-btn').hidden = st.mode === 'exam';    // m5-1: làm đề thì khung bên là phiếu trả lời
    if (window.Answers) { Answers.bind(); Answers.onClose(); }
    $('v-marks').hidden = true;
    setTool('view');
    banner('Đang mở…');
    $('v-status').textContent = '';
    const t0 = performance.now();
    // Trang sẽ hiện đầu tiên (để tải trước đúng trang đó trong lúc pdf.js mở tài liệu).
    const c0 = pcfg(opts.file.id);
    const startPage = st.mode === 'exam' ? (c0.marks[st.segKey] || 1) : (opts.page || c0.lastPage || 1);
    let tokenMs = 0;
    try {
      await wait;
      tokenMs = Math.round(performance.now() - t0);   // m3-4: thời gian chờ gia hạn token, ghi riêng ở dòng Mốc
      st.src = await PdfSource.openDocument(opts.file, {
        startPage,
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
      // m4-1 (việc tồn 7): token hết hạn ngay lúc mở cũng có nút gia hạn như khi hết hạn giữa chừng.
      // open() gọi ensureToken() đầu tiên, nên bấm nút là mở được cửa sổ gia hạn.
      if (e instanceof PdfSource.AuthNeeded) {
        banner(`<span class="bad">Không mở được: ${esc(e.message)}.</span> <button class="small" id="v-reauth-open">Gia hạn và mở lại</button>`);
        $('v-reauth-open').onclick = () => { log('Gia hạn token rồi mở lại PDF.'); open(opts); };
      } else banner(`<span class="bad">Không mở được: ${esc(e.message)}</span>`);
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
    } else st.page = Math.min(st.num, opts.page || pcfg(opts.file.id).lastPage || 1);
    banner('');
    // m4-1: làm đề phần Listening thì hiện thanh audio của đúng Test. Thi thử: chỉ Phát, không tua, không tạm dừng tay, phát nối
    // Part 1 → 4. Luyện (m5-2): thanh ôn tập khóa vào Test đó (dừng, tua, tốc độ), hết Part tự sang Part sau.
    // Mở audio trước phiếu trả lời (m5-2): phiếu cần thanh audio để nghe tiếp đúng chỗ khi mở lại bài làm dở.
    const lm = st.mode === 'exam' && /^T(\d)L$/.exec(st.segKey || '');
    if (lm && window.AudioPlayer && opts.file.book) { if (st.style === 'practice') AudioPlayer.openPractice(opts.file.book, Number(lm[1])); else AudioPlayer.openExam(opts.file.book, Number(lm[1])); }
    // m5-1: phiếu trả lời / bài viết (làm đề) hoặc khung nhập đáp án (ôn tập, khi được yêu cầu).
    if (window.Answers) Answers.onOpen({ file: opts.file, mode: st.mode, style: st.style, segKey: st.segKey, panel: opts.panel || null });
    log(`Mở PDF ${opts.file.name}: ${st.num} trang, chế độ ${st.mode === 'exam' ? `${STYLE[st.style].toLowerCase()} ${st.segKey}` : 'ôn tập'}, ${st.src.stats.mode === 'range' ? 'lấy từng đoạn' : 'tải cả file'}, ${Math.round(performance.now() - t0)} ms.`);
    const src = st.src;
    await render();
    if (st.src !== src) return;
    src.report(`Mở xong, thấy trang ${st.page} sau ${Math.round(performance.now() - t0)} ms kể từ lúc bấm`, { seen: true, renderMs: st.lastRender ? st.lastRender.ms : null, tokenMs });
    backgroundPrefetch(src);
  }

  // Tải nền (m3-2 mục 3): làm đề thì tải mọi trang của phần ngay; ôn tập thì chờ 3 giây (để trang đang xem tải xong
  // trước) rồi tải trang đầu của mỗi phần đã đánh dấu.
  function backgroundPrefetch(src) {
    const run = (pages, why) => {
      if (st.src !== src || !pages.length) return;
      src.prefetchPages(pages, why).catch((e) => log(`PDF ${st.file ? st.file.name : ''}: ${why} dừng: ${e.message}`));
    };
    if (st.mode === 'exam') run(st.allowed.filter((p) => p !== st.page), `tải nền phần ${S.LABEL[st.segKey]}`);
    else {
      const firsts = [...new Set(st.segs.map((x) => x.start))].filter((p) => p !== st.page);
      clearTimeout(st.bgTimer);
      st.bgTimer = setTimeout(() => run(firsts, 'tải nền trang đầu mỗi phần'), 3000);
    }
  }

  async function closeDoc() {
    st.seq++;
    clearTimeout(st.bgTimer);
    try { if (st.task) st.task.cancel(); } catch (_) {}
    if (st.src) { try { await st.src.close(); } catch (_) {} }
    st.src = null; st.doc = null; st.pageObj = null; st.task = null;
    clearPeek(); flipReset();
    const c = $('v-box') && $('v-box').querySelector('canvas');
    if (c) { c.width = 0; c.height = 0; c.remove(); }
  }

  // force: đóng không hỏi (vd bài đã nộp, chuyển sang xem trang đáp án).
  async function close(force) {
    if (!force && st.mode === 'exam' && st.doc) {
      const qseg = /^T[1-4][LRW]$/.test(st.segKey || '') && window.Answers;
      if (!qseg && !confirm('Thoát bài đang làm?')) return;
      if (qseg && Answers.blocksClose() && !confirm('Thoát bài đang làm? Đồng hồ dừng lại, phần đã làm vẫn được giữ trong máy. Mở lại phần này sẽ hỏi làm tiếp hay bỏ.')) return;
    }
    if (window.Answers) Answers.onClose();
    if (st.detect) st.detect.cancel = true;
    if (st.src) log(`Đóng PDF ${st.file.name}: đã tải ${PdfSource.mb(st.src.stats.net)} qua mạng, ${PdfSource.mb(st.src.stats.cache)} từ cache, file ${PdfSource.mb(st.src.stats.size)}.`);
    await closeDoc();
    if (window.AudioPlayer) AudioPlayer.close();
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
    st.slideDir = dir && Math.abs(target - st.page) <= 3 ? Math.sign(target - st.page) : 0;   // nút ‹ › / phím mũi tên: trang mới trượt vào
    st.page = target;
    $('v-scroll').scrollTop = 0;
    return render();
  }

  let flashT = null;
  function flash(msg, ms = 2500) {
    banner(`<span class="warn">${esc(msg)}</span>`);
    clearTimeout(flashT);
    flashT = setTimeout(() => { if ($('v-banner').textContent === msg) banner(''); }, ms);   // không xóa thông báo khác (vd token hết hạn)
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
    st.renderedW = $('v-scroll').clientWidth;
    $('v-scroll').classList.toggle('vzoom', st.zoom > 0);
    box.insertBefore(canvas, $('v-ink'));
    // Trượt trang mới vào (0,2 s). Chỉ khi chưa phóng to; tạm ẩn thanh cuộn ngang để trang trượt không làm hiện thanh cuộn.
    if (st.slideDir && st.zoom === 0) {
      const sc = $('v-scroll');
      box.classList.remove('slide-l', 'slide-r'); void box.offsetWidth;
      sc.classList.add('sliding');
      box.classList.add(st.slideDir > 0 ? 'slide-l' : 'slide-r');
      clearTimeout(st.slideT); st.slideT = setTimeout(() => { sc.classList.remove('sliding'); box.classList.remove('slide-l', 'slide-r'); }, 260);
    }
    st.slideDir = 0;
    if (st.pageObj && st.pageObj !== page) { try { st.pageObj.cleanup(); } catch (_) {} }
    st.pageObj = page;
    st.lastRender = { ms: Math.round(performance.now() - t0), w: canvas.width, h: canvas.height };
    st.H = Math.round(INK_W * base.height / base.width);
    $('v-ink').setAttribute('viewBox', `0 0 ${INK_W} ${st.H}`);
    drawInk();
    status();
    if (st.mode === 'review') { const c = pcfg(st.file.id); c.lastPage = n; setPcfg(st.file.id, c); }
    if (st.mode === 'review' && window.Answers && Answers.onPage) Answers.onPage(n);   // m5-2: nhớ trang đáp án theo phần
    prefetch(n);
    schedulePeek();
  }

  // Tải sẵn dữ liệu trang kế tiếp (chỉ trang được xem) để lật trang nhanh hơn.
  async function prefetch(n) {
    const next = st.mode === 'exam' ? st.allowed.find((p) => p > n) : (n < st.num ? n + 1 : null);
    if (!next) return;
    const doc = st.doc;
    try { const p = await doc.getPage(next); if (doc !== st.doc) return; await p.getOperatorList(); if (p !== st.pageObj) p.cleanup(); } catch (_) {}
  }

  // ---------- Lật trang bằng cách kéo (m6-1) ----------
  // Điện thoại / iPad: kéo ngang thì trang trượt theo tay, trang kế lộ ra bên cạnh (đã vẽ sẵn); thả quá 1/4 bề ngang hoặc vuốt nhanh
  // thì sang trang, không thì bật về. Kéo dọc vẫn cuộn (khung đặt touch-action: pan-y, trình duyệt tự cuộn dọc). Đang bật Highlight /
  // Gạch chân (không có bút) thì ngón tay vẽ, không lật. Chế độ bút iPad: ngón tay cuộn và lật (app tự cuộn vì lớp vẽ chặn cử chỉ).
  // Đang phóng to: kéo ngang là di chuyển trong trang; chỉ lật khi lúc bắt đầu kéo đã ở mép trang. Làm đề: trang ngoài phần thì bật về.
  const touchy = () => (navigator.maxTouchPoints || 0) > 0 || (window.matchMedia && matchMedia('(pointer: coarse)').matches);
  const FLIP_LOCK = 10, FLIP_FLING = 0.5, FLIP_MS = 200;
  function neighbor(dir) {
    if (!st.doc) return null;
    if (st.mode === 'exam') {
      const a = st.allowed;
      const t = dir > 0 ? a.find((p) => p > st.page) : [...a].reverse().find((p) => p < st.page);
      return t == null ? null : t;
    }
    const t = st.page + dir;
    if (t < 1 || t > st.num) return null;
    return S.canView(st.segs, st.mode, st.segKey, t, st.num) ? t : null;
  }
  function clearPeek() { st.peekSeq++; for (const v of st.peek.values()) { if (v.canvas) v.canvas.width = 0; } st.peek.clear(); }
  let peekT = null;
  function schedulePeek() {
    if (!touchy()) return;
    clearTimeout(peekT);
    peekT = setTimeout(() => {
      const w = Math.max(200, $('v-scroll').clientWidth - 16);
      if (w !== st.peekW) { clearPeek(); st.peekW = w; }
      const want = [neighbor(-1), neighbor(+1)].filter((x) => x != null);
      for (const k of [...st.peek.keys()]) if (!want.includes(k)) { const v = st.peek.get(k); if (v.canvas) v.canvas.width = 0; st.peek.delete(k); }
      for (const n of want) if (!st.peek.has(n)) renderPeek(n);
    }, 250);
  }
  // Vẽ sẵn trang kế (vừa bề ngang, như mức phóng 100%) để lúc kéo không thấy khoảng trắng. Độ nét thấp hơn trang chính một chút.
  async function renderPeek(n) {
    const my = st.peekSeq, doc = st.doc;
    const entry = { n, canvas: null, ready: null };
    st.peek.set(n, entry);
    entry.ready = (async () => {
      try {
        const page = await doc.getPage(n);
        if (my !== st.peekSeq || doc !== st.doc) return null;
        const base = page.getViewport({ scale: 1 });
        const cssW = Math.max(200, $('v-scroll').clientWidth - 16);
        const cssH = Math.round(cssW * base.height / base.width);
        let px = (cssW / base.width) * Math.min(window.devicePixelRatio || 1, 1.5);
        if (base.width * base.height * px * px > 4e6) px = Math.sqrt(4e6 / (base.width * base.height));
        const vp = page.getViewport({ scale: px });
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
        if (my !== st.peekSeq || st.peek.get(n) !== entry) { c.width = 0; return null; }
        entry.canvas = c; entry.cssW = cssW; entry.cssH = cssH;
        if (st.flip && st.flip.target === n) drawFlipNb();
        return entry;
      } catch (_) { return null; }
    })();
  }
  function flipDown(e) {
    if (e.pointerType !== 'touch' || !st.doc || st.flipAnim || st.flip || $('viewer').hidden) return;
    if (st.tool !== 'view' && !st.pen) return;   // đang vẽ bằng ngón tay
    const sc = $('v-scroll');
    const maxL = Math.max(0, sc.scrollWidth - sc.clientWidth);
    // Tự cuộn (manual): chế độ bút trên lớp vẽ, hoặc đang phóng to (khung tắt cuộn của trình duyệt để kéo chéo vẫn đi cả 2 chiều).
    st.flip = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lock: null, manual: st.tool !== 'view' || e.target === $('v-ink') || sc.classList.contains('vzoom'),
      sl: sc.scrollLeft, st0: sc.scrollTop, maxL, atL: sc.scrollLeft <= 1, atR: sc.scrollLeft >= maxL - 1,
      off: 0, dir: 0, target: null, shown: false, lx: e.clientX, lt: performance.now(), v: 0 };
  }
  function flipMove(e) {
    const g = st.flip;
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    const t = performance.now();
    if (t > g.lt) { g.v = 0.6 * ((e.clientX - g.lx) / (t - g.lt)) + 0.4 * g.v; g.lx = e.clientX; g.lt = t; }
    if (!g.lock) {
      if (Math.hypot(dx, dy) < FLIP_LOCK) return;
      g.lock = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'h' : 'v';
    }
    const sc = $('v-scroll');
    if (g.lock === 'v') { if (g.manual) { e.preventDefault(); sc.scrollTop = g.st0 - dy; sc.scrollLeft = g.sl - dx; } return; }
    e.preventDefault();
    // Phóng to: trước hết di chuyển trong trang; tới mép thì phần kéo dư mới dùng để lật (chỉ khi lúc bắt đầu đã ở mép đó).
    const want = g.sl - dx;
    let off = 0;
    if (want < 0) { sc.scrollLeft = 0; off = g.atL ? -want : 0; }
    else if (want > g.maxL) { sc.scrollLeft = g.maxL; off = g.atR ? g.maxL - want : 0; }
    else sc.scrollLeft = want;
    const dir = off > 0 ? -1 : off < 0 ? 1 : 0;
    if (!dir) { if (g.shown) setFlipPos(0); g.off = 0; return; }
    if (dir !== g.dir) { g.dir = dir; g.target = neighbor(dir); if (!g.shown) showFlip(); drawFlipNb(); }
    g.off = off;
    setFlipPos(g.target != null ? off : off * 0.25);
  }
  function flipUp(e) {
    const g = st.flip;
    if (!g || e.pointerId !== g.id) return;
    if (g.lock !== 'h' || !g.shown) { flipReset(); return; }
    const w = $('v-scroll').clientWidth;
    const fling = Math.abs(g.v) > FLIP_FLING && Math.sign(g.v) === Math.sign(g.off) && Math.abs(g.off) > 30;
    if (g.target != null && (Math.abs(g.off) > w / 4 || fling)) commitFlip(g);
    else {
      if (g.target == null && Math.abs(g.off) > w / 6) flash(st.mode === 'exam' ? (g.dir > 0 ? 'Hết trang của phần đang làm.' : 'Đây là trang đầu của phần đang làm.') : (g.dir > 0 ? 'Đây là trang cuối.' : 'Đây là trang đầu.'));
      animFlip(0, () => flipReset());
    }
  }
  function flipCancelEv(e) {
    const g = st.flip;
    if (!g || e.pointerId !== g.id) return;
    if (g.shown) animFlip(0, () => flipReset()); else flipReset();
  }
  function showFlip() {
    const g = st.flip, sc = $('v-scroll'), fl = $('v-flip');
    const w = sc.clientWidth, h = sc.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
    Object.assign(fl.style, { left: sc.offsetLeft + 'px', top: sc.offsetTop + 'px', width: w + 'px', height: h + 'px' });
    const bg = getComputedStyle(sc).backgroundColor;
    const mk = () => { const c = document.createElement('canvas'); c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + 'px'; c.style.height = h + 'px'; return c; };
    const cur = mk(), nb = mk();
    cur.className = 'fcur'; nb.className = 'fnb';
    const x = cur.getContext('2d');
    x.fillStyle = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#888'; x.fillRect(0, 0, cur.width, cur.height);
    const src = $('v-box').querySelector('canvas');
    if (src && src.width) {
      const br = $('v-box').getBoundingClientRect(), sr = sc.getBoundingClientRect();
      x.drawImage(src, (br.left - sr.left) * dpr, (br.top - sr.top) * dpr, br.width * dpr, br.height * dpr);
    }
    fl.innerHTML = ''; fl.append(nb, cur);
    g.shown = true; g.w = w; g.h = h; g.dpr = dpr; g.bg = x.fillStyle;
    fl.hidden = false;
    $('v-box').style.visibility = 'hidden';
  }
  // Vẽ trang kế vào lớp lật: dùng bản đã vẽ sẵn; chưa có thì vẽ khung trắng + số trang và vẽ ngay (xong thì thay vào).
  function drawFlipNb() {
    const g = st.flip; if (!g || !g.shown) return;
    const nb = $('v-flip').querySelector('.fnb'); if (!nb) return;
    const x = nb.getContext('2d'), d = g.dpr;
    x.fillStyle = g.bg; x.fillRect(0, 0, nb.width, nb.height);
    g.nbReady = false;
    if (g.target == null) return;
    const p = st.peek.get(g.target);
    const left = Math.max(8, (g.w - (p && p.cssW || g.w - 16)) / 2);
    if (p && p.canvas) {
      x.drawImage(p.canvas, left * d, 8 * d, p.cssW * d, p.cssH * d);
      g.nbReady = true;
    } else {
      x.fillStyle = '#fff'; x.fillRect(left * d, 8 * d, (g.w - 2 * left) * d, (g.h - 8) * d);
      x.fillStyle = '#999'; x.font = `${16 * d}px sans-serif`; x.fillText(`Trang ${g.target}…`, (left + 16) * d, 40 * d);
      if (!p) renderPeek(g.target);
    }
  }
  function setFlipPos(off) {
    const g = st.flip; if (!g || !g.shown) return;
    g.pos = off;
    const fl = $('v-flip');
    const cur = fl.querySelector('.fcur'), nb = fl.querySelector('.fnb');
    if (cur) cur.style.transform = `translateX(${off}px)`;
    if (nb) nb.style.transform = `translateX(${off + (g.dir || 1) * g.w}px)`;
  }
  function animFlip(to, done) {
    const g = st.flip; if (!g) { done(); return; }
    st.flipAnim = true;
    const fl = $('v-flip');
    fl.classList.add('anim');
    setFlipPos(to);
    setTimeout(() => { fl.classList.remove('anim'); st.flipAnim = false; done(); }, FLIP_MS + 20);
  }
  function commitFlip(g) {
    const target = g.target, dir = g.dir;
    animFlip(-dir * g.w, async () => {
      st.flip = g;   // giữ lớp lật (đang hiện trang mới) tới khi trang mới vẽ xong
      st.page = target;
      const sc = $('v-scroll');
      sc.scrollTop = 0; sc.scrollLeft = 0;
      try { await render(); } catch (_) {}
      flipReset();
    });
  }
  function flipReset() {
    st.flip = null;
    const fl = $('v-flip');
    if (fl) { fl.hidden = true; fl.innerHTML = ''; fl.classList.remove('anim'); }
    const box = $('v-box'); if (box) box.style.visibility = '';
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
    // m5-2 mục 3.8 (iPad): lần đầu thấy nét bút thì bật chế độ bút; từ đó ngón tay (và lòng bàn tay) không vẽ, chỉ cuộn trang.
    if (e.pointerType === 'pen' && !st.pen) {
      st.pen = true; saveJSON(PEN_KEY, true);
      log('Lớp vẽ: phát hiện bút, từ giờ chỉ nhận nét bút; ngón tay dùng để cuộn trang.');
      flash('Đã thấy bút: chỉ bút vẽ được, ngón tay để cuộn.', 4000);
    }
    // m6-1: ngón tay ở chế độ bút do phần kéo-lật-trang xử lý (cuộn dọc, cuộn ngang khi phóng to, kéo ngang để lật trang).
    if (st.pen && e.pointerType === 'touch') { e.preventDefault(); return; }
    e.preventDefault();
    try { $('v-ink').setPointerCapture(e.pointerId); } catch (_) {}
    st.drawing = { t: st.tool, pts: [inkPt(e)], id: e.pointerId };
    if (st.tool === 'erase') eraseAt(st.drawing.pts[0]);
    else { const live = $('v-live'); live.setAttribute('class', 'ink-' + st.tool); }
  }
  function inkMove(e) {
    if (st.pan && e.pointerId === st.pan.id) {
      e.preventDefault();
      const sc = $('v-scroll');
      sc.scrollLeft = st.pan.l - (e.clientX - st.pan.x);
      sc.scrollTop = st.pan.t - (e.clientY - st.pan.y);
      return;
    }
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
    if (st.pan && e.pointerId === st.pan.id) { st.pan = null; return; }
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
        ${d && d.running ? '<button class="small secondary" data-m="stop">Dừng</button>' : ''}<span class="hint" id="m-dstat">${esc(d ? d.msg : 'Đọc thử 5 trang trước: PDF không có lớp chữ (bản scan) thì dừng ngay. Có chữ thì hỏi rồi dò hết (tải gần như cả file, nên dùng Wi-Fi).')}</span></div>
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
    if (m === 'del') { log(`Xóa mốc ${S.LABEL[b.dataset.k]} (trang PDF ${c.marks[b.dataset.k]}).`); delete c.marks[b.dataset.k]; setPcfg(st.file.id, c); }   // m4-1 (việc tồn 3)
    if (m === 'goto') { go(Number(b.dataset.p), 0); }
    if (m === 'offset') {
      const v = $('m-printed').value.trim();
      if (v === '') delete c.offset;
      else { const n = parseInt(v, 10); if (!Number.isInteger(n)) { flash('Nhập số trang in.'); return; } c.offset = st.page - n; log(`Độ lệch số trang: trang PDF ${st.page} in số ${n}, lệch ${c.offset}.`); }
      setPcfg(st.file.id, c);
    }
    if (m === 'detect') { runDetect(); return; }
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

  // m4-1 (việc tồn 1): đọc thử 5 trang rải đều trước. Không trang nào có chữ (bản scan như Cam 15) thì dừng ngay, báo "PDF không có
  // lớp chữ", không tải cả file (14/10: Cam 15 tải 24,8 MB, 253 s, gợi ý 0 phần). Có chữ thì mới hỏi rồi dò hết.
  async function runDetect() {
    const doc = st.doc;
    const d = st.detect = { running: true, cancel: false, msg: 'Đọc thử 5 trang xem PDF có lớp chữ không…', result: null };
    renderMarks();
    const net0 = st.src.stats.net;
    const t0 = performance.now();
    const setMsg = (t) => { d.msg = t; const el = $('m-dstat'); if (el) el.textContent = t; };
    async function readPage(p) {
      try {
        const pg = await doc.getPage(p);
        const h = pg.getViewport({ scale: 1 }).height;
        const tc = await pg.getTextContent();
        const edges = tc.items.filter((it) => it.str && (it.transform[5] < h * 0.08 || it.transform[5] > h * 0.92)).map((it) => it.str);
        if (pg !== st.pageObj) pg.cleanup();
        return { p, text: tc.items.map((it) => it.str).join(' '), edges };
      } catch (e) { return { p, text: '' }; }
    }
    const hasText = (x) => x.text.trim().length > 20;
    const sample = [...new Set([1, 2, 3, 4, 5].map((k) => Math.max(1, Math.min(st.num, Math.round(st.num * k / 6)))))];
    const got = new Map();
    for (const p of sample) {
      if (d.cancel || doc !== st.doc) break;
      got.set(p, await readPage(p));
      setMsg(`Đọc thử trang ${p} (${got.size}/${sample.length}) · tải thêm ${PdfSource.mb(st.src.stats.net - net0)}`);
    }
    const sampleText = [...got.values()].filter(hasText).length;
    if (!d.cancel && doc === st.doc && got.size && !sampleText) {
      d.running = false; d.result = null;
      d.msg = `PDF không có lớp chữ: đọc thử ${got.size} trang (${[...got.keys()].join(', ')}), không trang nào có chữ (tải thêm ${PdfSource.mb(st.src.stats.net - net0)}, ` +
        `${((performance.now() - t0) / 1000).toFixed(1)} giây). Dò tự động không dùng được cho file này, hãy đánh dấu tay.`;
      log(`Dò tự động ${st.file.name}: ${d.msg}`);
      if (!$('v-marks').hidden) renderMarks();
      return;
    }
    if (!d.cancel && doc === st.doc) {
      // pdf.js đọc chữ của trang thì cũng tải luôn ảnh scan của trang đó, nên dò hết gần như tải cả file.
      const s = st.src.stats;
      const left = Math.max(0, s.size - s.net - s.cache);
      const phone = /iPhone|iPad|Android/.test(navigator.userAgent);
      if (!confirm(`Đọc thử ${got.size} trang: ${sampleText} trang có chữ. Dò tiếp cả ${st.num} trang sẽ tải gần như cả file: khoảng ${PdfSource.mb(left)} nữa ` +
        `(file ${PdfSource.mb(s.size)}, phần đã có trong cache không tải lại).` + (phone ? '\n\nNên làm trên máy tính dùng Wi-Fi.' : '') + '\n\nTiếp tục?')) {
        d.running = false; d.msg = `Đã dừng sau khi đọc thử ${got.size} trang (${sampleText} trang có chữ).`;
        if (!$('v-marks').hidden) renderMarks();
        return;
      }
    }
    const pages = [];
    for (let p = 1; p <= st.num; p++) {
      if (d.cancel || doc !== st.doc) break;
      pages.push(got.get(p) || await readPage(p));
      setMsg(`Đang dò trang ${p}/${st.num} · tải thêm ${PdfSource.mb(st.src.stats.net - net0)}`);
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
    // m4-1 (việc tồn 2): mở khung thì cuộn về đầu, để dòng chọn phần và nút "Đánh dấu" luôn thấy ngay.
    if (v === 'marks' && st.mode !== 'exam') { const p = $('v-marks'); p.hidden = !p.hidden; if (!p.hidden) { renderMarks(); p.scrollTop = 0; } }
    if (v === 'keys' && window.Answers && st.mode !== 'exam') Answers.toggleKeys();
    if (v === 'audio' && window.AudioPlayer && st.file) {
      if (AudioPlayer.isOpen()) AudioPlayer.close();
      else {
        // Test của trang đang xem (theo khoảng trang đã đánh dấu), không có thì Test 1.
        const k = S.kindsOf(st.segs, st.page).map((x) => /^T(\d)/.exec(x)).find(Boolean);
        AudioPlayer.openBook(st.file.book, { test: k ? Number(k[1]) : 1, part: 1 });
      }
    }
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
    $('ex-prep').disabled = !f || !signedIn || prepBusy;
    if ($('ex-audio')) $('ex-audio').disabled = !$('ex-book').value || !signedIn;
    updatePrep(f);
    if ($('ex-keys')) $('ex-keys').disabled = !f || !signedIn;
    if (window.Answers) Answers.refreshCard();
    if (!f) { ss.innerHTML = ''; $('ex-exam').disabled = true; if ($('ex-practice')) $('ex-practice').disabled = true; $('ex-hint').textContent = ''; return; }
    const c = pcfg(f.id);
    const keys = S.KEYS.filter((k) => S.isTestKey(k) && c.marks[k] != null);
    ss.innerHTML = keys.map((k) => `<option value="${k}">${esc(S.LABEL[k])}</option>`).join('');
    $('ex-exam').disabled = !keys.length || !signedIn || f.scope === 'key';
    if ($('ex-practice')) $('ex-practice').disabled = $('ex-exam').disabled;
    $('ex-hint').innerHTML = f.scope === 'key' ? 'File key chỉ mở ở chế độ ôn tập.' : marksSummary(c.marks, !keys.length);
  }
  // m5-2 mục 3.6: "Đã đánh dấu 7/20 phần. Chưa có: Test 1 Reading; Test 3, Test 4 (cả 4 kỹ năng); Bài mẫu Writing; Phiếu trả lời mẫu."
  // 20 phần = 4 Test × 4 kỹ năng + Audioscripts + Đáp án + Bài mẫu + Phiếu. Bấm vào thì bung danh sách đầy đủ.
  function marksSummary(marks, none) {
    const ALL = S.KEYS.filter((k) => k !== 'OTHER');
    const have = ALL.filter((k) => marks[k] != null);
    const SK = { L: 'Listening', R: 'Reading', W: 'Writing', S: 'Speaking' };
    const part = [], whole = [];
    for (let t = 1; t <= 4; t++) {
      const miss = 'LRWS'.split('').filter((x) => marks[`T${t}${x}`] == null);
      if (miss.length === 4) whole.push(`Test ${t}`);
      else if (miss.length) part.push(`Test ${t} ${miss.map((x) => SK[x]).join(', ')}`);
    }
    const other = ['AS', 'KEY', 'SAMPLE', 'SHEET'].filter((k) => marks[k] == null).map((k) => S.LABEL[k]);
    const miss = [...part, ...(whole.length ? [`${whole.join(', ')} (cả 4 kỹ năng)`] : []), ...other];
    const blocked = ['AS', 'KEY', 'SAMPLE'].filter((k) => marks[k] != null).map((k) => S.LABEL[k]);
    const line = `Đã đánh dấu ${have.length}/${ALL.length} phần.${miss.length ? ` Chưa có: ${miss.join('; ')}.` : ' Đủ cả.'}`;
    const rows = ALL.map((k) => `<li>${esc(S.LABEL[k])}: ${marks[k] != null ? `trang ${marks[k]}` : '<span class="warn">chưa</span>'}</li>`).join('');
    return `<details class="mlist"><summary>${esc(line)}</summary><ul class="plain">${rows}</ul></details>` +
      (none ? 'Chưa đánh dấu phần nào của Test. Bấm "Mở ôn tập" rồi "Đánh dấu trang".' : `Chặn khi làm đề: ${esc(blocked.join(', ') || 'chưa đánh dấu phần nào cần chặn (Audioscripts, Đáp án, Bài mẫu)')}.`);
  }
  // ---------- Nút "Chuẩn bị quyển này" (m3-3) ----------
  // Tải sẵn vào cache phần cấu trúc PDF (đầu, đuôi, xref, object stream/object nhỏ, cây trang) để lần mở đầu chỉ còn
  // tải dữ liệu trang. Trạng thái "đã chuẩn bị" = mọi đoạn cấu trúc đang có trong cache máy này.
  let prepBusy = false, prepSeq = 0;
  async function updatePrep(f) {
    const el = $('ex-prep-st');
    if (!el) return;
    const my = ++prepSeq;
    if (!f) { el.textContent = ''; return; }
    let s;
    try { s = await PdfSource.prepStatus(f); } catch (_) { s = { state: 'none' }; }
    if (my !== prepSeq || prepBusy) return;
    el.className = 'hint' + (s.state === 'ready' ? ' ok' : '');
    el.textContent = s.state === 'ready' ? `Đã chuẩn bị: phần cấu trúc (${PdfSource.mb(s.total * PdfSource.CHUNK)}) có sẵn trong máy. Trang đã tải sẵn mở ngay, trang khác chỉ còn tải dữ liệu trang đó.`
      : s.state === 'partial' ? `Chuẩn bị dở: có ${s.have}/${s.total} đoạn cấu trúc trong máy. Bấm để tải nốt.`
      : `Chưa chuẩn bị. Bấm để tải sẵn phần cấu trúc PDF và trang đầu mỗi phần đã đánh dấu (Cam 15 khoảng 3 MB + 2 MB). App đọc xref trước, báo dung lượng rồi hỏi trước khi tải. Nên dùng Wi-Fi.`;
  }
  async function prepClick() {
    const f = selFile(); if (!f || prepBusy) return;
    const wait = window.ensureToken();   // gọi trước mọi await để cửa sổ gia hạn không bị chặn
    const el = $('ex-prep-st'), btn = $('ex-prep');
    prepBusy = true; btn.disabled = true; prepSeq++;
    el.className = 'hint'; el.textContent = 'Đang đọc cấu trúc PDF…';
    const phone = /iPhone|iPad|Android/.test(navigator.userAgent);
    try {
      await wait;
      const r = await PdfSource.prepare(f, {
        onProgress: (t) => { el.textContent = t; },
        // Trang sẽ mở trước: trang đang xem dở (ôn tập) và trang đầu mỗi phần đã đánh dấu (làm đề).
        pages: (n) => { const c = pcfg(f.id); return [c.lastPage || 1, ...S.segments(c.marks, n).map((x) => x.start)]; },
        confirm: async ({ readMB, needMB, chunks, pages, pageMB }) => confirm(`Chuẩn bị ${f.name}: đã đọc cấu trúc (${readMB.toFixed(2)} MB). ` +
          `Cần tải thêm khoảng ${(needMB + pageMB).toFixed(1)} MB vào bộ nhớ máy: phần cấu trúc còn lại ${needMB.toFixed(1)} MB (${chunks} đoạn 16 KB)` +
          (pages ? ` và dữ liệu ${pages} trang sẽ mở trước (trang đang xem dở, trang đầu mỗi phần đã đánh dấu), ước khoảng ${pageMB.toFixed(1)} MB.` : '.') +
          (phone ? '\n\nNên dùng Wi-Fi.' : '\n\nNên dùng Wi-Fi nếu đang dùng mạng di động.') + '\n\nTải tiếp?'),
      });
      prepBusy = false;
      await updatePrep(f);
      if (r) el.textContent = `Chuẩn bị xong sau ${(r.ms / 1000).toFixed(1)} giây: tải ${PdfSource.mb(r.net)} qua ${r.calls} lần gọi. ` + el.textContent;
      else el.textContent = 'Đã hủy chuẩn bị. ' + el.textContent;
    } catch (e) {
      prepBusy = false;
      el.className = 'hint bad';
      el.textContent = (e instanceof PdfSource.AuthNeeded ? 'Token hết hạn, bấm lại để gia hạn rồi chuẩn bị tiếp. ' : 'Chuẩn bị lỗi: ') + e.message;
      log(`Chuẩn bị ${f.name} lỗi: ${e.message}`);
    } finally {
      prepBusy = false;
      btn.disabled = !selFile() || !loadAuth();
    }
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
    // m5-2: Thi thử (giờ, không dừng tay) và Luyện (có phiếu và chấm, dừng/tua tự do).
    const start = (style) => {
      const f = selFile(); if (!f) return;
      const seg = $('ex-seg').value;
      if (window.Answers && Answers.preflight && !Answers.preflight(f.book, seg, style)) return;
      open({ file: f, mode: 'exam', segKey: seg, style });
    };
    $('ex-exam').onclick = () => start('mock');
    if ($('ex-practice')) $('ex-practice').onclick = () => start('practice');
    $('ex-probe').onclick = probeClick;
    $('ex-prep').onclick = prepClick;
    if ($('ex-audio')) $('ex-audio').onclick = () => { const b = Number($('ex-book').value); if (b && window.AudioPlayer) AudioPlayer.openBook(b, { test: 1, part: 1 }); };
    $('ex-cache-btn').onclick = () => cacheClick(false);
    $('ex-cache-clear').onclick = () => cacheClick(true);
    refreshPicker();
  }

  // m5-1: answers.js đọc tài liệu và trang đang xem (nút "Lấy chữ trang PDF này"), mở/đóng trình xem.
  const ctx = () => ({ doc: st.doc, page: st.page, file: st.file, mode: st.mode, style: st.style, segKey: st.segKey, segs: st.segs });
  const isOpen = () => !!$('viewer') && !$('viewer').hidden;
  const goPage = (n) => go(n, 0);
  st.pen = loadJSON(PEN_KEY, false) === true;
  // m6-1: mốc trang, nét vẽ, chế độ bút vừa đồng bộ về từ máy khác: trình xem đang mở thì vẽ lại theo dữ liệu mới.
  window.addEventListener('ielts-sync', (e) => {
    const keys = (e.detail && e.detail.keys) || [];
    if (keys.includes(PEN_KEY)) st.pen = loadJSON(PEN_KEY, false) === true;
    if (!isOpen() || !st.doc) return;
    if (keys.includes(PCFG_KEY)) {
      loadSegs(); syncNav();
      if (!$('v-marks').hidden) renderMarks();
    }
    if (keys.includes(INK_KEY) && !st.drawing) drawInk();
  });
  window.Viewer = { open, close, refreshPicker, ctx, isOpen, selFile, goPage, flash, _st: st };
  init();
})();
