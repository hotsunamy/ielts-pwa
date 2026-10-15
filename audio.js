// Mốc 4 (m4-1, m4-2): phát audio Listening từ Drive của Minh. Không có nội dung Cambridge trong code, không lưu audio vào máy.
// App tự thử theo thứ tự 1b → 2, ghi lại cách đã chạy cho từng định dạng (mp3, m4a) trên máy này (chỉ để xem, không khóa cứng:
// lần sau vẫn thử 1b trước nếu service worker đang điều khiển trang). m4-2 bỏ cách 1a (link Drive kèm ?access_token=): chạy thật
// 15/10 trên Edge và iPhone Drive đều từ chối, mỗi lần thử mất 10–15 s.
//   1b. stream qua service worker (sw.js, đường "ap/<id>"): service worker gắn token và chuyển tiếp Range, tua tới đâu tải tới đó;
//   2.  tải cả file về bộ nhớ rồi phát (dự phòng, chỉ giữ trong phiên này, không lưu vào máy);
//   3.  link mở trình phát của Drive (dự phòng cuối, không lặp đoạn, không đổi tốc độ).
// Chế độ ôn tập: tua, lùi/tiến 5 giây, lặp đoạn A-B, đổi tốc độ, chọn Test/Part. Chế độ làm đề: chỉ Phát/Tạm dừng, không tua,
// quyển chia theo Part thì phát nối Part 1 → 4 (Minh chốt 14/10). Ô thiếu audio hiện rõ, không báo lỗi.
'use strict';
(function () {
  const DRIVE = 'https://www.googleapis.com/drive/v3/';
  const METHOD_KEY = 'ielts.audiomethod';   // {[định dạng]: {use: '1b'|'2', failed: {[cách]: lý do}}} ('1a' còn trong dữ liệu cũ thì bỏ qua)
  const MARK_KEY = 'ielts.audiomarks';      // {[fileId]: {[part]: giây}} cho audio theo cả Test (Part 1 = 0)
  const ORDER = ['1b', '2'];
  const NAME = { '1a': 'cách 1a (link Drive kèm token)', '1b': 'cách 1b (stream qua service worker)', '2': 'cách 2 (tải cả file rồi phát)' };
  const SPEEDS = [0.75, 0.85, 1, 1.1, 1.25, 1.5];
  const START_TIMEOUT = 15000;   // quá chừng này chưa có dữ liệu thì coi cách đó không chạy, thử cách sau
  const BLOB_KEEP = 3;           // cách 2: giữ tối đa 3 file trong bộ nhớ của phiên này
  const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', wma: 'audio/x-ms-wma' };
  const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
  const RETRY_WAIT = [500, 1000, 2000];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1]?.toLowerCase() || '';
  const mimeOf = (f) => MIME[extOf(f.name)] || (String(f.mimeType || '').startsWith('audio/') ? f.mimeType : 'audio/mpeg');
  const fmt = (s) => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const mb = (n) => (n / 1e6).toFixed(1) + ' MB';
  function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (_) { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { log('Không lưu được vào máy: ' + e.message); } }

  const st = {
    open: false, mode: 'review', book: null, data: null, test: 1, part: 1,
    list: [], idx: 0,                  // làm đề: danh sách file phát nối
    cur: null,                         // {file, test, part, label}
    loaded: false, method: null, gen: 0, tag: '', calls: [], tClick: null, tokenMs: 0,
    seekT: null, seekTo: null, seeks: [], prog: false, lastTime: 0, played: 0, loop: { a: null, b: null },
    pending: null, unlocked: false, wasPlaying: false,
    src: null, srcT: 0,                // m4-3: ai vừa bấm Phát/Tạm dừng ('app' | 'màn hình khóa'), để ghi nhật ký
    hidePaused: null,                  // m4-4: vị trí (giây) app tự tạm dừng do rời app; null = không
  };
  const isHidden = () => document.visibilityState === 'hidden';
  const blobs = new Map();   // fileId -> {url, size}

  // ---------- Dữ liệu audio của quyển (từ kết quả nhận diện ở Thư viện) ----------
  function bookAudio(book) {
    const res = (window.Library && Library._results()) || [];
    const cells = Recognize.audioCells(res).get(book);
    if (!cells) return { book, none: true, byTest: false, get: () => null, missing: [], track: false, lowConf: false };
    const byTest = cells.scopes.size === 1 && cells.scopes.has('test');
    const all = [...cells.cells.values()].flat();
    return {
      book, none: false, byTest,
      get: (t, p) => { const l = cells.cells.get(byTest ? `T${t}` : `T${t}P${p}`); return l ? l[0] : null; },
      missing: cells.missing, dups: cells.dups,
      track: all.some((r) => r.auto && r.auto.scope === 'track'),
      lowConf: all.some((r) => r.conf === 'low'),
    };
  }
  const marksOf = (id) => loadJSON(MARK_KEY, {})[id] || {};

  // ---------- Khung giao diện (thanh dưới đáy, dùng chung cho trình xem, Thư viện và thẻ Đề) ----------
  function buildDom() {
    if ($('ap')) return;
    document.body.insertAdjacentHTML('beforeend', `
<div id="ap" class="ap" hidden>
  <div class="ap-row">
    <b id="ap-title" class="ap-title"></b><span id="ap-badge" class="badge"></span>
    <button class="small secondary" data-a="close" id="ap-close" aria-label="Đóng audio">✕</button>
  </div>
  <div class="ap-row">
    <button class="small secondary ap-rv" data-a="prevpart" aria-label="Part trước">⏮</button>
    <button class="small secondary ap-rv" data-a="back">−5s</button>
    <button class="small" data-a="play" id="ap-play">▶ Phát</button>
    <button class="small secondary ap-rv" data-a="fwd">+5s</button>
    <button class="small secondary ap-rv" data-a="nextpart" aria-label="Part sau">⏭</button>
    <span id="ap-time" class="ap-time">0:00 / 0:00</span>
  </div>
  <input id="ap-seek" class="ap-seek" type="range" min="0" max="1000" step="1" value="0" aria-label="Vị trí">
  <div class="ap-row ap-rv" id="ap-review">
    <label>Test <select id="ap-test"></select></label>
    <label>Part <select id="ap-part"></select></label>
    <label>Tốc độ <select id="ap-rate">${SPEEDS.map((s) => `<option value="${s}"${s === 1 ? ' selected' : ''}>${s}×</option>`).join('')}</select></label>
    <button class="small secondary" data-a="A" id="ap-A">A</button><button class="small secondary" data-a="B" id="ap-B">B</button>
    <button class="small secondary" data-a="noloop" id="ap-noloop" hidden>Bỏ lặp</button>
    <button class="small secondary" data-a="mark" id="ap-mark" hidden></button>
    <a id="ap-drive" class="hint" target="_blank" rel="noopener">Trình phát Drive</a>
  </div>
  <div id="ap-st" class="ap-msg"></div>
  <div id="ap-msg" class="ap-msg"></div>
  <audio id="ap-audio" preload="auto"></audio>
</div>`);
    const box = $('ap'), a = $('ap-audio');
    box.addEventListener('click', onClick);
    $('ap-test').onchange = () => pick(Number($('ap-test').value), 1);
    $('ap-part').onchange = () => pick(st.test, Number($('ap-part').value));
    $('ap-rate').onchange = () => { const r = Number($('ap-rate').value); a.defaultPlaybackRate = r; a.playbackRate = r; log(`Audio: tốc độ ${r}×.`); };
    const seek = $('ap-seek');
    seek.addEventListener('input', () => { st.dragging = true; $('ap-time').textContent = `${fmt(seek.value / 1000 * (a.duration || 0))} / ${fmt(a.duration)}`; });
    seek.addEventListener('change', () => { st.dragging = false; if (st.mode === 'review' && a.duration) userSeek(seek.value / 1000 * a.duration, 'kéo thanh'); });
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('seeking', onSeeking);
    a.addEventListener('seeked', onSeeked);
    a.addEventListener('playing', onPlaying);
    a.addEventListener('pause', syncButtons);
    a.addEventListener('play', () => onPlayPause('phát'));
    a.addEventListener('pause', () => onPlayPause('tạm dừng'));
    document.addEventListener('visibilitychange', onVisible);
    a.addEventListener('waiting', () => { if (st.loaded) note('Đang tải…', 'wait'); });
    a.addEventListener('canplay', () => clearNote('wait'));
    a.addEventListener('ended', onEnded);
    a.addEventListener('error', onMidError);
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', onSwMessage);
    if (window.ResizeObserver) new ResizeObserver(() => document.documentElement.style.setProperty('--ap-h', box.hidden ? '0px' : box.offsetHeight + 'px')).observe(box);
  }
  const audio = () => $('ap-audio');

  // ---------- Mở thanh audio ----------
  // Ôn tập: quyển + Test + Part (Part dùng cho quyển chia theo Part, hoặc nhảy tới mốc đã đánh dấu nếu audio theo cả Test).
  function openBook(book, opts = {}) {
    buildDom();
    stop('đổi');
    Object.assign(st, { open: true, mode: 'review', book, data: bookAudio(book), test: opts.test || 1, part: opts.part || 1, list: [], idx: 0 });
    show();
    setCur(st.test, st.part);
    if (opts.autoplay) playClick();
  }
  // Nghe một file từ Thư viện (để nghe thử track CD, kiểm cách gắn).
  function openFile(r) {
    buildDom();
    stop('đổi');
    Object.assign(st, { open: true, mode: 'review', book: r.book, data: bookAudio(r.book), test: r.test || 1, part: r.part || 1, list: [], idx: 0 });
    show();
    setCur(st.test, st.part, r);
    playClick();
  }
  // Làm đề Listening Test t: chỉ Phát/Tạm dừng, phát nối Part 1 → 4.
  function openExam(book, test) {
    buildDom();
    stop('đổi');
    const data = bookAudio(book);
    const list = [];
    if (data.byTest) list.push({ test, part: null, file: data.get(test) });
    else for (let p = 1; p <= 4; p++) list.push({ test, part: p, file: data.get(test, p) });
    Object.assign(st, { open: true, mode: 'exam', book, data, test, part: 1, list, idx: 0 });
    show();
    const have = list.filter((x) => x.file);
    const first = list.findIndex((x) => x.file);
    st.idx = Math.max(0, first);
    setCur(test, list[st.idx] && list[st.idx].part, list[st.idx] && list[st.idx].file, true);
    const miss = list.filter((x) => !x.file).map((x) => (x.part ? `Part ${x.part}` : 'cả Test'));
    if (data.none) note(`Cam ${book} chưa có file audio nào trong thư viện. Phần Listening này làm không có audio.`, 'info');
    else if (!have.length) note(`Test ${test} chưa có audio (${miss.join(', ')}).`, 'info');
    else if (miss.length) note(`Test ${test} thiếu audio ${miss.join(', ')}: chỉ phát được phần có.`, 'info');
    else note('Làm đề: chỉ Phát và Tạm dừng, không tua. Bấm Phát khi sẵn sàng.', 'hint');
  }
  function show() {
    const box = $('ap');
    box.hidden = false;
    box.classList.toggle('exam', st.mode === 'exam');
    document.body.classList.add('ap-on');
    $('ap-badge').textContent = st.mode === 'exam' ? 'Làm đề' : 'Ôn tập';
    $('ap-badge').className = 'badge ' + (st.mode === 'exam' ? 'c-low' : 'c-high');
    $('ap-close').hidden = st.mode === 'exam';
    $('ap-seek').disabled = st.mode === 'exam';
    const a = audio();
    if (st.mode === 'exam') { a.defaultPlaybackRate = 1; a.playbackRate = 1; }
    else { const r = Number($('ap-rate').value) || 1; a.defaultPlaybackRate = r; a.playbackRate = r; }
    clearLoop();
    fillSelectors();
    document.documentElement.style.setProperty('--ap-h', box.offsetHeight + 'px');
  }
  function close() {
    if (!$('ap') || !st.open) return;
    stop('đóng');
    st.open = false;
    $('ap').hidden = true;
    document.body.classList.remove('ap-on');
    document.documentElement.style.setProperty('--ap-h', '0px');
  }

  function fillSelectors() {
    if (st.mode === 'exam') return;
    const d = st.data;
    $('ap-test').innerHTML = [1, 2, 3, 4].map((t) => {
      const any = d.byTest ? d.get(t) : [1, 2, 3, 4].some((p) => d.get(t, p));
      return `<option value="${t}"${t === st.test ? ' selected' : ''}>${t}${any ? '' : ' (chưa có audio)'}</option>`;
    }).join('');
    const f = d.byTest ? d.get(st.test) : null;
    const mk = f ? marksOf(f.id) : {};
    $('ap-part').innerHTML = [1, 2, 3, 4].map((p) => {
      let suf = '';
      if (d.byTest) suf = p === 1 || mk[p] != null ? '' : ' (chưa đánh dấu)';
      else if (!d.get(st.test, p)) suf = ' (chưa có audio)';
      return `<option value="${p}"${p === st.part ? ' selected' : ''}>${p}${suf}</option>`;
    }).join('');
    const m = $('ap-mark');
    m.hidden = !(d.byTest && f && st.part > 1);
    m.textContent = `Part ${st.part} bắt đầu ở đây`;
  }

  // Chọn Test/Part ở chế độ ôn tập. Quyển chia theo Part: đổi file. Audio theo cả Test: cùng file, nhảy tới mốc đã đánh dấu.
  function pick(test, part) {
    const d = st.data, a = audio();
    const wasPlaying = st.loaded && !a.paused;
    if (d.byTest && st.cur && st.cur.file && test === st.test && d.get(test) === st.cur.file) {
      st.part = part;
      fillSelectors();
      const t = part === 1 ? 0 : marksOf(st.cur.file.id)[part];
      if (t == null) { note(`Chưa đánh dấu chỗ bắt đầu Part ${part} trong file cả Test. Nghe tới đầu Part ${part} rồi bấm "Part ${part} bắt đầu ở đây".`, 'info'); return; }
      st.cur.label = label(test, part);
      $('ap-title').textContent = st.cur.label;
      if (st.loaded) userSeek(t, `tới Part ${part}`); else st.resumeAt = t;
      return;
    }
    stop('đổi');
    st.test = test; st.part = part;
    setCur(test, part);
    if (wasPlaying) playClick();
  }
  function label(test, part, r) {
    const d = st.data;
    let s = `Cam ${st.book} · Test ${test}`;
    if (part && !(d.byTest && st.mode === 'exam')) s += ` · Part ${part}`;
    if (st.mode === 'exam' && st.list.length > 1) s += ` (${st.list.filter((x) => x.file).indexOf(st.list[st.idx]) + 1}/${st.list.filter((x) => x.file).length})`;
    return s + (r && r.scope === 'track' ? ` · track ${r.track}` : '');
  }
  function setCur(test, part, file, keepNote) {
    const d = st.data;
    file = file || (d.byTest ? d.get(test) : d.get(test, part));
    st.test = test; st.part = part || 1;
    st.cur = { file, test, part, label: label(test, part, file) };
    st.loaded = false; st.method = null; st.resumeAt = null; st.lastTime = 0; st.prog = false; st.seekT = null; st.midErr = false;
    const a = audio();
    a.removeAttribute('src'); try { a.load(); } catch (_) {}
    $('ap-title').textContent = st.cur.label;
    $('ap-play').disabled = !file;
    $('ap-drive').hidden = !file;
    if (file) $('ap-drive').href = `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`;
    if (d.byTest && file && part > 1 && st.mode === 'review') { const t = marksOf(file.id)[part]; if (t != null) st.resumeAt = t; }
    fillSelectors();
    syncButtons(); onTime();
    if (keepNote) return;
    clearNote();
    if (d.none) note(`Cam ${st.book} chưa có file audio nào trong thư viện.`, 'info');
    else if (!file) note(`Chưa có audio cho Test ${test}${d.byTest ? '' : ` Part ${part}`}. Các ô thiếu của quyển: ${d.missing.join(' ') || 'không'}.`, 'info');
    else if (d.track && d.lowConf) note('Track CD: app gắn Test/Part theo thứ tự track, chưa xác nhận. Nghe đầu track 1 (phải là Test 1 Part 1) và track 5 (Test 2 Part 1), rồi xác nhận hoặc chỉnh lệch track ở Thư viện.', 'info');
    else if (d.byTest && part > 1 && st.resumeAt == null) note(`Audio của quyển này là 1 file cả Test. Chưa đánh dấu chỗ bắt đầu Part ${part}: phát từ đầu Test.`, 'info');
  }

  // ---------- Thông báo trong thanh ----------
  // Dòng trạng thái tạm (đang mở, đang tải) nằm riêng (#ap-st), không đè lên thông báo (ô thiếu, track, lỗi, token) ở #ap-msg.
  function note(html, kind = 'info', plain = true) {
    const el = kind === 'wait' ? $('ap-st') : $('ap-msg');
    el.dataset.kind = kind;
    el.innerHTML = plain ? esc(html) : html;
  }
  function clearNote(kind) {
    if (kind === 'wait') { $('ap-st').innerHTML = ''; return; }
    const el = $('ap-msg'); if (!kind || el.dataset.kind === kind) { el.innerHTML = ''; el.dataset.kind = ''; }
    if (!kind) $('ap-st').innerHTML = '';
  }

  // ---------- Phát ----------
  // Trình duyệt iPhone chỉ cho phát khi có thao tác bấm. Lần bấm đầu phát một đoạn im lặng rất ngắn để "mở khóa" thẻ audio,
  // sau đó app được tự phát (đổi Part, phát tiếp sau khi tải xong theo cách 2).
  let SILENT = null;
  function silentWav() {
    if (SILENT) return SILENT;
    const n = 800, buf = new Uint8Array(44 + n), dv = new DataView(buf.buffer);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); w(36, 'data'); dv.setUint32(40, n, true);
    buf.fill(128, 44);
    let s = ''; for (const b of buf) s += String.fromCharCode(b);
    return (SILENT = 'data:audio/wav;base64,' + btoa(s));
  }
  // Đoạn im lặng không phải audio thật: mọi sự kiện của nó (playing, ended, error...) bỏ qua (m4-2: trước đây nó làm nhật ký
  // ghi "null, có tiếng sau 85 ms", và ở làm đề có thể bị coi là hết Part).
  const isSilent = () => !!SILENT && audio().getAttribute('src') === SILENT;
  function unlock() {
    if (st.unlocked) return;
    st.unlocked = true;
    const a = audio();
    try { a.src = silentWav(); const p = a.play(); if (p) p.catch(() => {}); } catch (_) {}
  }

  function playClick() {
    const a = audio();
    if (!st.cur || !st.cur.file) return;
    st.src = 'app'; st.srcT = performance.now();
    if (st.hidePaused != null) { st.hidePaused = null; clearNote('info'); }
    if (st.loaded) {
      if (!a.paused) { a.pause(); return; }
      const fresh = (() => { const x = loadAuth(); return x && x.expiresAt > Date.now() + 5 * 60_000; })();
      if (fresh || st.method === '2') { a.play().catch(playErr); return; }
      // Token sắp hết: gia hạn ngay trong thao tác bấm (trình duyệt chỉ cho mở cửa sổ gia hạn lúc này), rồi phát tiếp.
      const wait = window.ensureToken();
      const pos = a.currentTime;
      wait.then(() => window.authSynced()).then(() => a.play().catch(playErr), (e) => note(e.message, 'err'));
      return;
    }
    if (st.pending) return;
    const wait = window.ensureToken();   // gọi trước mọi await để cửa sổ gia hạn không bị chặn
    unlock();
    st.tClick = performance.now();
    $('ap-play').textContent = '… Đang mở'; $('ap-play').disabled = true;
    st.pending = wait.then(() => { st.tokenMs = Math.round(performance.now() - st.tClick); return window.authSynced(); })
      .then(() => start(st.resumeAt || 0, true), (e) => { note(e.message, 'err'); })
      .finally(() => { st.pending = null; syncButtons(); });
  }
  function playErr(e) {
    if (e && e.name === 'NotAllowedError') note('Trình duyệt chặn tự phát. Bấm Phát.', 'info');
  }

  // Thử lần lượt các cách phát cho file hiện tại. Nhớ cách chạy được theo định dạng file.
  async function start(resumeAt, autoplay) {
    const gen = ++st.gen;
    const f = st.cur.file;
    const kind = extOf(f.name) || 'khác';
    const mem = loadJSON(METHOD_KEY, {});
    const m = mem[kind] || { failed: {} };
    m.failed = m.failed || {};
    // Luôn theo thứ tự ưu tiên 1b → 2 (bỏ các cách đã hỏng trên máy này). Cách đã nhớ không khóa cứng: trước đây Edge mở bằng
    // Ctrl+F5 (không có service worker) thì nhớ "cách 2" và không bao giờ thử lại 1b.
    let order = ORDER.filter((x) => !m.failed[x]);
    const skip = [];
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) { order = order.filter((x) => x !== '1b'); skip.push('1b (service worker chưa điều khiển trang, tải lại app 1 lần)'); }
    const can = audio().canPlayType(mimeOf(f));
    if (!can) note(`Trình duyệt này có thể không phát được định dạng ${kind} (${mimeOf(f)}). Vẫn thử.`, 'info');
    const tried = [];
    for (const meth of order) {
      if (gen !== st.gen) return;
      note(`Đang mở bằng ${NAME[meth]}…`, 'wait');
      const r = await tryMethod(meth, f, resumeAt, autoplay, gen);
      if (gen !== st.gen || r.aborted) return;
      clearNote('wait');
      if (r.ok) {
        const changed = m.use !== meth;
        m.use = meth; mem[kind] = m; saveJSON(METHOD_KEY, mem);
        st.method = meth;
        if ($('ap-tech')) $('ap-tech').textContent = techText();
        if (changed || tried.length) log(`Audio: định dạng ${kind} trên máy này dùng ${NAME[meth]}${tried.length ? `; cách không chạy: ${tried.join('; ')}` : ''}${skip.length ? `; bỏ qua ${skip.join(', ')}` : ''}.`);
        return;
      }
      if (r.auth) { authStop(resumeAt); return; }
      if (r.net) {   // lỗi mạng / Drive: không phải lỗi của cách phát, không đánh dấu cách này hỏng
        note(`Không tải được audio: ${r.why}. <button class="small" id="ap-retry">Thử lại</button>`, 'err', false);
        $('ap-retry').onclick = () => { clearNote(); st.tClick = performance.now(); start(resumeAt, true); };
        log(`Audio ${f.name}: ${NAME[meth]} lỗi mạng/Drive: ${r.why}.`);
        return;
      }
      tried.push(`${meth}: ${r.why}`);
      m.failed[meth] = r.why;
      if (m.use === meth) delete m.use;
      mem[kind] = m; saveJSON(METHOD_KEY, mem);
      log(`Audio ${f.name}: ${NAME[meth]} không chạy (${r.why}), thử cách sau.`);
    }
    note(`Không phát được trong app (${tried.join('; ') || 'không còn cách nào để thử'}). <a href="https://drive.google.com/file/d/${encodeURIComponent(f.id)}/view" target="_blank" rel="noopener">Mở bằng trình phát Drive</a> (cách 3: không lặp đoạn, không đổi tốc độ). Muốn thử lại các cách trong app: thẻ Đề › Kiểm tra kỹ thuật › "Thử lại các cách phát audio".`, 'err', false);
    log(`Audio ${f.name}: không cách nào trong app chạy (${tried.join('; ')}). Còn cách 3: trình phát Drive.`);
    syncButtons();
  }

  // Một lần thử: gắn nguồn, chờ trình phát đọc được thông tin file (loadedmetadata), lỗi thì báo lý do.
  function tryMethod(meth, f, resumeAt, autoplay, gen) {
    return new Promise(async (resolve) => {
      const a = audio();
      st.tag = Math.random().toString(36).slice(2, 10);
      st.calls = [];
      let src;
      if (meth === '1b') {
        src = new URL('ap/' + encodeURIComponent(f.id) + '?' + new URLSearchParams({ size: f.size || '', mime: mimeOf(f), n: st.tag }), location.href).href;
      } else {
        const r = await download(f, gen);
        if (r.url == null) { resolve(r); return; }
        src = r.url;
      }
      if (gen !== st.gen) { resolve({ aborted: true }); return; }
      let done = false, timer = null;
      const finish = (r) => {
        if (done) return; done = true; clearTimeout(timer);
        a.removeEventListener('loadedmetadata', onMeta); a.removeEventListener('error', onErr);
        resolve(r);
      };
      const onMeta = () => {
        if (a.src !== src) return;
        st.loaded = true;
        if (resumeAt) { st.prog = true; a.currentTime = resumeAt; }
        finish({ ok: true });
      };
      const onErr = () => {
        if (a.src !== src) return;
        const code = a.error ? a.error.code : '?';
        const c401 = st.calls.some((c) => c.status === 401);
        const bad = st.calls.find((c) => (c.status && c.status >= 500) || (c.err && !c.cancelled && c.status !== 401));
        if (c401) finish({ auth: true });
        else if (bad) finish({ net: true, why: bad.err || `Drive trả ${bad.status}` });
        else finish({ why: `trình phát báo lỗi mã ${code}${a.error && a.error.message ? ' ' + a.error.message.slice(0, 60) : ''}` });
      };
      a.addEventListener('loadedmetadata', onMeta);
      a.addEventListener('error', onErr);
      timer = setTimeout(() => finish({ why: `quá ${START_TIMEOUT / 1000} s chưa đọc được file` }), START_TIMEOUT);
      st.attemptT = performance.now();
      a.src = src;
      const rate = st.mode === 'exam' ? 1 : (Number($('ap-rate').value) || 1);
      a.defaultPlaybackRate = rate; a.playbackRate = rate;
      try { a.load(); } catch (_) {}
      if (autoplay) { const p = a.play(); if (p) p.catch((e) => { if (e.name === 'NotAllowedError') { note('Trình duyệt chặn tự phát. Bấm Phát.', 'info'); } }); }
    });
  }

  // Cách 2: tải cả file (có thử lại khi Drive lỗi tạm thời), giữ trong bộ nhớ của phiên này.
  async function download(f, gen) {
    const hit = blobs.get(f.id);
    if (hit) { blobs.delete(f.id); blobs.set(f.id, hit); return { url: hit.url }; }
    const t0 = performance.now();
    const rec = { start: Date.now(), off: 0, phase: 'cả file' };
    st.calls.push(rec);
    let res;
    for (let k = 0; ; k++) {
      const t = (loadAuth() || {}).token;
      try { res = await fetch(DRIVE + 'files/' + encodeURIComponent(f.id) + '?alt=media', { headers: { Authorization: 'Bearer ' + t }, cache: 'no-store' }); }
      catch (e) { rec.err = e.message; return { net: true, why: 'lỗi mạng: ' + e.message }; }
      rec.hdr = Date.now(); rec.status = res.status;
      if (RETRY_STATUS.has(res.status) && k < RETRY_WAIT.length) { rec.retries = k + 1; (rec.codes || (rec.codes = [])).push(res.status); await sleep(RETRY_WAIT[k] * (0.8 + Math.random() * 0.4)); continue; }
      break;
    }
    if (res.status === 401) { const x = loadAuth(); if (x) { x.expiresAt = 0; saveAuth(x); } return { auth: true }; }
    if (!res.ok) return { net: true, why: `Drive trả ${res.status}${rec.retries ? ` (đã thử lại ${rec.retries} lần)` : ''}` };
    const total = Number(res.headers.get('content-length')) || Number(f.size) || 0;
    const reader = res.body.getReader();
    const parts = []; let got = 0, lastUi = 0;
    for (;;) {
      if (gen !== st.gen) { reader.cancel().catch(() => {}); return { aborted: true }; }
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      if (performance.now() - lastUi > 250) { lastUi = performance.now(); note(`Đang tải cả file ${mb(got)}${total ? ' / ' + mb(total) : ''} (${NAME['2']})…`, 'wait'); }
    }
    rec.len = got; rec.end = Date.now();
    const url = URL.createObjectURL(new Blob(parts, { type: mimeOf(f) }));
    blobs.set(f.id, { url, size: got });
    while (blobs.size > BLOB_KEEP) { const [k, v] = blobs.entries().next().value; if (k === f.id) break; URL.revokeObjectURL(v.url); blobs.delete(k); }
    log(`Audio ${f.name}: tải cả file ${mb(got)} trong ${Math.round(performance.now() - t0)} ms (${NAME['2']}).`);
    return { url };
  }

  // ---------- Token hết hạn ----------
  function authStop(pos) {
    const a = audio();
    if ($('ap-msg').dataset.kind === 'auth') return;
    if (pos == null) pos = st.loaded ? (a.currentTime || 0) : (st.resumeAt ?? a.currentTime ?? 0);
    st.midErr = false;
    try { a.pause(); } catch (_) {}
    st.loaded = false;
    st.resumeAt = pos;
    const x = loadAuth(); if (x && x.expiresAt > 0) { x.expiresAt = 0; saveAuth(x); }   // để nút bấm gia hạn thật, như PDF
    clearNote('wait');
    note(`Token đã hết hạn nên dừng audio ở ${fmt(pos)}. <button class="small" id="ap-reauth">Gia hạn và nghe tiếp</button>`, 'auth', false);
    log(`Audio ${st.cur.file.name}: token hết hạn (401), dừng ở ${fmt(pos)}, chờ Minh bấm gia hạn.`);
    $('ap-reauth').onclick = () => {
      const wait = window.ensureToken();
      st.tClick = performance.now();
      wait.then(() => window.authSynced()).then(() => { clearNote(); log('Đã gia hạn token, nghe tiếp audio.'); return start(pos, true); }, (e) => note(e.message, 'err'));
    };
    syncButtons();
  }

  // ---------- Các lần gọi Drive do service worker báo về (cách 1b) ----------
  function onSwMessage(e) {
    const d = e.data;
    if (!d || d.type !== 'ap-call' || d.tag !== st.tag) return;
    const i = st.calls.findIndex((c) => c.rid === d.rid);
    if (i >= 0) Object.assign(st.calls[i], d); else st.calls.push(d);
    if (d.status === 401 && (st.loaded || st.midErr)) authStop();
  }
  function callSummary() {
    let cs = st.calls;
    const memN = cs.filter((c) => c.mem).length;
    cs = cs.filter((c) => !c.mem);
    if (!cs.length) return 'không gọi Drive lần nào' + (memN ? ` (${memN} lần lấy từ bộ nhớ đọc trước)` : '');
    const w = cs.filter((c) => c.hdr).map((c) => c.hdr - c.start);
    const bytes = cs.reduce((s, c) => s + (c.len || 0), 0);
    const rt = cs.filter((c) => c.retries);
    return `${cs.length} lần gọi Drive, chờ header ${w.length ? `nhỏ/tb/lớn ${Math.min(...w)}/${Math.round(w.reduce((s, x) => s + x, 0) / w.length)}/${Math.max(...w)} ms` : '?'}, đã tải ${mb(bytes)}` +
      (rt.length ? `, tự thử lại ${rt.length} lần gọi (mã ${[...new Set(rt.flatMap((c) => c.codes || []))].join(', ')})` : '') +
      (memN ? `, ${memN} lần lấy từ bộ nhớ đọc trước` : '');
  }

  // m4-2: bảng từng lần gọi (cách 1b) tới lúc có tiếng: dải byte, KB, mốc ms tính từ lúc bấm, nguồn (Drive / bộ nhớ đọc trước).
  // "Đợt" = nhóm lần gọi chạy chồng thời gian; số đợt = số lần phải chờ Drive nối tiếp nhau.
  function callDetail(t0) {
    const cs = st.calls.filter((c) => c.start).slice().sort((x, y) => x.start - y.start);
    if (!cs.length) return;
    let wave = 0, waveEnd = -Infinity;
    const rows = cs.map((c) => {
      const hdr = c.hdr || c.end;
      if (c.mem) return { c, w: '-' };
      if (c.start >= waveEnd) { wave++; waveEnd = hdr || Infinity; } else if (hdr) waveEnd = Math.min(waveEnd, hdr);
      return { c, w: String(wave) };
    });
    const r = (v) => (v == null ? '-' : String(Math.round(v - t0)));
    const kb = (c) => (c.want != null ? Math.round(c.want / 1024) : c.len != null ? Math.round(c.len / 1024) : '?');
    log(`  Chi tiết ${cs.length} lần xin dữ liệu tới lúc có tiếng (${wave} đợt chờ Drive nối tiếp; mốc ms tính từ lúc bấm):`);
    log('     #  đợt  dải trình phát xin        KB xin  bắt đầu  có header     xong  nguồn');
    rows.forEach(({ c, w }, i) => log('    ' + [String(i + 1).padStart(2), w.padStart(4), (c.range || '(không Range)').padEnd(26), String(kb(c)).padStart(6),
      r(c.start).padStart(8), r(c.hdr).padStart(10), r(c.end).padStart(8),
      ' ' + (c.mem ? 'bộ nhớ đọc trước' : (c.ra ? `Drive, đọc trước ${Math.round(c.ra / 1024)} KB` : 'Drive') + (c.status ? ` ${c.status}` : '') + (c.err ? `, ${c.err}` : '') + (c.cancelled ? ', trình phát hủy' : ''))].join(' ')));
  }

  // ---------- Sự kiện thẻ audio ----------
  function onPlaying() {
    if (isSilent()) return;
    if (isHidden()) { pauseForHide('bắt đầu phát lúc app đang ẩn'); }
    syncButtons(); clearNote('wait'); clearNote('hint');
    if (st.tClick != null && st.method) {
      const ms = Math.round(performance.now() - st.tClick);
      const f = st.cur.file;
      log(`Audio ${st.cur.label} (${f.name}, ${f.size ? mb(Number(f.size)) : '?'}): ${NAME[st.method] || st.method}, có tiếng sau ${ms} ms kể từ lúc bấm` +
        `${st.tokenMs >= 50 ? ` (gồm ${st.tokenMs} ms chờ gia hạn token)` : ''}; ${callSummary()}.`);
      if (st.method === '1b') callDetail(Date.now() - ms);
      st.tClick = null; st.tokenMs = 0;
    }
    mediaSession();
  }
  function onTime() {
    const a = audio();
    if (!$('ap')) return;
    const t = a.currentTime || 0, dur = a.duration || 0;
    if (!a.paused && !a.seeking && t > st.lastTime && t - st.lastTime < 1.5) st.played += t - st.lastTime;
    if (!a.seeking) st.lastTime = t;
    if (st.mode === 'review' && st.loop.b != null && t >= st.loop.b) { st.prog = true; a.currentTime = st.loop.a; }
    if (!st.dragging) {
      $('ap-time').textContent = `${fmt(t)} / ${fmt(dur)}`;
      $('ap-seek').value = dur ? Math.round(t / dur * 1000) : 0;
    }
  }
  function onSeeking() {
    const a = audio();
    if (st.prog || isSilent()) return;
    // Làm đề: không cho tua (kể cả tua từ màn hình khóa / tai nghe). Đưa về chỗ cũ.
    if (st.mode === 'exam' && Math.abs(a.currentTime - st.lastTime) > 1) {
      st.prog = true; a.currentTime = st.lastTime;
      note('Làm đề: không tua được.', 'info');
    }
  }
  function onSeeked() {
    if (st.prog) { st.prog = false; if (st.seekT == null) return; }
    if (st.seekT != null) {
      const ms = Math.round(performance.now() - st.seekT);
      st.seeks.push(ms);
      log(`Audio: tua (${st.seekWhy}) tới ${fmt(st.seekTo)}, có dữ liệu sau ${ms} ms (${NAME[st.method] || st.method}).`);
      st.seekT = null;
    }
  }
  function userSeek(t, why) {
    const a = audio();
    if (st.mode !== 'review' || !st.loaded) return;
    t = Math.max(0, Math.min((a.duration || t) - 0.25, t));
    st.seekT = performance.now(); st.seekTo = t; st.seekWhy = why;
    st.prog = true;
    a.currentTime = t;
    onTime();
  }
  function onEnded() {
    if (isSilent()) return;
    syncButtons();
    if (st.mode !== 'exam' || !st.loaded) return;
    const next = st.list.findIndex((x, i) => i > st.idx && x.file);
    if (next < 0) { note(`Hết audio Test ${st.test}.`, 'info'); log(`Audio làm đề Cam ${st.book} Test ${st.test}: phát hết.`); return; }
    const skipped = st.list.slice(st.idx + 1, next).filter((x) => !x.file).map((x) => `Part ${x.part}`);
    summary('hết file');
    st.idx = next;
    setCur(st.test, st.list[next].part, st.list[next].file, true);
    if (skipped.length) note(`Bỏ qua ${skipped.join(', ')} (chưa có audio).`, 'info'); else clearNote('info');
    st.tClick = performance.now();
    start(0, true);
  }
  function onMidError() {
    const a = audio();
    if (!st.loaded || !a.error || isSilent()) return;
    // Lỗi sau khi đã phát được (mất mạng, token hết hạn khi trình duyệt xin đoạn mới...).
    const pos = a.currentTime || st.lastTime, code = a.error.code, gen = st.gen;
    st.loaded = false; st.resumeAt = pos;
    // Cách 1b: tin báo "Drive trả 401" của service worker có thể tới sau sự kiện lỗi của thẻ audio (thấy trong test e2e),
    // nên chờ một chút rồi mới kết luận là lỗi mạng hay token hết hạn.
    setTimeout(() => {
      if (gen !== st.gen || $('ap-msg').dataset.kind === 'auth') return;
      if (st.calls.some((c) => c.status === 401) || !((loadAuth() || {}).expiresAt > Date.now())) { authStop(pos); return; }
      st.midErr = true;
      note(`Audio dừng ở ${fmt(pos)}: trình phát báo lỗi mã ${code}. <button class="small" id="ap-retry">Phát tiếp</button>`, 'err', false);
      log(`Audio ${st.cur.file.name}: lỗi khi đang phát ở ${fmt(pos)} (mã ${code}, ${NAME[st.method]}).`);
      $('ap-retry').onclick = () => { clearNote(); st.midErr = false; st.tClick = performance.now(); start(pos, true); };
      syncButtons();
    }, st.method === '1b' ? 700 : 0);
    syncButtons();
  }

  // ---------- Lặp đoạn A-B, mốc Part ----------
  function clearLoop() { st.loop = { a: null, b: null }; if ($('ap-A')) { $('ap-A').textContent = 'A'; $('ap-B').textContent = 'B'; $('ap-noloop').hidden = true; } }
  function setA() { const a = audio(); if (!st.loaded) return; st.loop = { a: a.currentTime, b: null }; $('ap-A').textContent = `A ${fmt(st.loop.a)}`; $('ap-B').textContent = 'B'; $('ap-noloop').hidden = false; }
  function setB() {
    const a = audio(); if (!st.loaded) return;
    if (st.loop.a == null || a.currentTime <= st.loop.a + 0.5) { note('Bấm A ở chỗ bắt đầu đoạn trước, rồi bấm B ở chỗ kết thúc.', 'info'); return; }
    st.loop.b = a.currentTime;
    $('ap-B').textContent = `B ${fmt(st.loop.b)}`;
    log(`Audio: lặp đoạn ${fmt(st.loop.a)}–${fmt(st.loop.b)}.`);
    userSeek(st.loop.a, 'lặp A-B');
  }
  function markPart() {
    const a = audio(), f = st.cur && st.cur.file;
    if (!f || !st.loaded || st.part < 2) return;
    const all = loadJSON(MARK_KEY, {});
    all[f.id] = Object.assign(all[f.id] || {}, { [st.part]: Math.round(a.currentTime * 10) / 10 });
    saveJSON(MARK_KEY, all);
    log(`Audio ${f.name}: Part ${st.part} bắt đầu ở ${fmt(a.currentTime)}.`);
    st.cur.label = label(st.test, st.part); $('ap-title').textContent = st.cur.label;   // m4-2: tiêu đề đổi theo Part vừa đánh dấu
    fillSelectors();
    note(`Đã lưu: Part ${st.part} bắt đầu ở ${fmt(a.currentTime)}.`, 'info');
  }
  function stepPart(dir) {
    // m4-2: ⏮ khi đã nghe quá 3 s trong Part thì về đầu Part đang nghe (như máy nghe nhạc), không nạp lại file.
    if (dir < 0 && st.loaded && st.cur && st.cur.file) {
      const a = audio();
      const begin = st.data.byTest ? (st.part === 1 ? 0 : marksOf(st.cur.file.id)[st.part]) : 0;
      if (begin != null && a.currentTime - begin > 3) { userSeek(begin, 'về đầu Part'); return; }
    }
    const p = st.part + dir;
    if (p >= 1 && p <= 4) { $('ap-part').value = p; pick(st.test, p); return; }
    const t = st.test + dir;
    if (t >= 1 && t <= 4) { $('ap-test').value = t; pick(t, dir > 0 ? 1 : 4); }
  }

  // ---------- Nút ----------
  function onClick(e) {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const a = audio();
    switch (b.dataset.a) {
      case 'play': playClick(); break;
      case 'close': close(); break;
      case 'back': userSeek((a.currentTime || 0) - 5, 'lùi 5 s'); break;
      case 'fwd': userSeek((a.currentTime || 0) + 5, 'tiến 5 s'); break;
      case 'prevpart': if (st.mode === 'review') stepPart(-1); break;
      case 'nextpart': if (st.mode === 'review') stepPart(+1); break;
      case 'A': setA(); break;
      case 'B': setB(); break;
      case 'noloop': clearLoop(); break;
      case 'mark': markPart(); break;
    }
  }
  function syncButtons() {
    const a = audio(), p = $('ap-play');
    if (!p) return;
    if (st.pending) return;
    p.disabled = !st.cur || !st.cur.file;
    p.textContent = st.loaded && !a.paused ? '⏸ Tạm dừng' : '▶ Phát';
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = st.loaded && !a.paused ? 'playing' : 'paused'; } catch (_) {}
  }

  // Màn hình khóa / tai nghe. m4-4 (Minh chốt 15/10): rời app (khóa màn hình, chuyển app/tab) thì audio tự tạm dừng, quay lại
  // bấm Phát để nghe tiếp đúng chỗ. Lý do: iPhone (app đã cài) tạm dừng rồi phát lại khi app ở nền thì trình phát đứng yên, mất
  // tiếng (thử 15/10 cả 3 cách: app xử lý, để iOS xử lý, nạp lại file; đều hỏng). Nên nút Phát ở màn hình khóa không làm gì khi app
  // đang ẩn; khi app đang hiện (vd tai nghe) thì vẫn phát. Tua chỉ ở ôn tập.
  function mediaSession() {
    if (!('mediaSession' in navigator) || !st.cur) return;
    const ms = navigator.mediaSession, a = audio();
    const set = (k, fn) => { try { ms.setActionHandler(k, fn); } catch (_) {} };
    try { ms.metadata = new MediaMetadata({ title: st.cur.label, artist: 'Luyện IELTS' }); } catch (_) {}
    set('pause', () => { st.src = 'màn hình khóa / tai nghe'; st.srcT = performance.now(); a.pause(); });
    set('play', () => {
      if (isHidden()) { log('Audio: bấm Phát ở màn hình khóa lúc app đang ẩn: bỏ qua (mở app rồi bấm Phát).'); return; }
      st.src = 'tai nghe'; st.srcT = performance.now();
      if (st.hidePaused != null) { st.hidePaused = null; clearNote('info'); }
      a.play().catch(() => {});
    });
    const rv = st.mode === 'review';
    set('seekbackward', rv ? () => userSeek(a.currentTime - 5, 'lùi 5 s (màn hình khóa)') : null);
    set('seekforward', rv ? () => userSeek(a.currentTime + 5, 'tiến 5 s (màn hình khóa)') : null);
    set('seekto', rv ? (d) => userSeek(d.seekTime, 'tua (màn hình khóa)') : null);
  }
  // Nhật ký mỗi lần Phát/Tạm dừng do người bấm (trong app, màn hình khóa, tai nghe), hoặc xảy ra lúc app đang ẩn.
  function onPlayPause(what) {
    const a = audio();
    if (isSilent() || !st.cur || !st.cur.file) return;
    const recent = st.src && performance.now() - st.srcT < 1500;
    if (!recent && !isHidden()) return;
    if (!st.loaded || a.readyState === 0) return;
    if (!recent && what === 'tạm dừng' && st.hidePaused != null) return;   // đã ghi "tạm dừng do rời app"
    log(`Audio: ${what} ở ${fmt(a.currentTime)} (nguồn: ${recent ? st.src : 'hệ thống'}; app đang ${isHidden() ? 'ẩn' : 'hiện'}).`);
    if (recent) st.src = null;
  }
  // Rời app thì tạm dừng, nhớ vị trí. Quay lại thì để dừng, hiện hướng dẫn bấm Phát.
  function pauseForHide(why) {
    const a = audio();
    if (isSilent() || !st.cur || !st.cur.file) return;
    st.hidePaused = a.currentTime || 0;
    st.src = null;
    a.pause();
    log(`Audio: tạm dừng do rời app (${why}) ở ${fmt(st.hidePaused)}${st.mode === 'exam' ? ', đang làm đề' : ''}.`);
    note(`Đã tạm dừng khi rời app ở ${fmt(st.hidePaused)}. Bấm Phát để nghe tiếp.`, 'info');
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; } catch (_) {}
  }
  function onVisible() {
    const a = audio();
    if (!$('ap') || !st.open) return;
    if (isHidden()) { if (st.loaded && !a.paused) pauseForHide('khóa màn hình / chuyển app / chuyển tab'); return; }
    if (st.hidePaused != null) log(`Audio: quay lại app, vẫn tạm dừng ở ${fmt(a.currentTime)}, chờ bấm Phát.`);
  }

  // Dừng file hiện tại và ghi tóm tắt (nghe bao lâu, gọi Drive mấy lần, tua mấy lần).
  function summary(why) {
    if (!st.cur || !st.cur.file || (!st.loaded && !st.played)) return;
    const s = st.seeks;
    log(`Dừng audio ${st.cur.label} (${why}): nghe ${Math.round(st.played)} s, ${NAME[st.method] || st.method || '?'}; ${callSummary()}` +
      (s.length ? `; tua ${s.length} lần, có dữ liệu sau tb ${Math.round(s.reduce((x, y) => x + y, 0) / s.length)} ms, chậm nhất ${Math.max(...s)} ms` : '') + '.');
    st.played = 0; st.seeks = [];
  }
  function stop(why) {
    if (!$('ap')) return;
    summary(why);
    st.gen++;
    const a = audio();
    try { a.pause(); } catch (_) {}
    a.removeAttribute('src'); try { a.load(); } catch (_) {}
    st.loaded = false; st.pending = null; st.tClick = null; st.lastTime = 0; st.played = 0; st.seeks = []; st.prog = false; st.seekT = null; st.midErr = false; st.hidePaused = null;
    clearNote('wait');
    clearLoop();
    syncButtons();
  }

  // ---------- Kiểm tra kỹ thuật (thẻ Đề) ----------
  function techText() {
    const mem = loadJSON(METHOD_KEY, {});
    const ks = Object.keys(mem);
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller ? 'service worker đang điều khiển trang' : 'service worker CHƯA điều khiển trang (cách 1b chưa dùng được, tải lại app)';
    return `Audio trên máy này: ${ks.length ? ks.map((k) => `${k} → ${mem[k].use ? NAME[mem[k].use] : 'chưa có cách chạy'}${mem[k].failed && Object.keys(mem[k].failed).filter((x) => ORDER.includes(x)).length ? ` (không chạy: ${Object.keys(mem[k].failed).filter((x) => ORDER.includes(x)).join(', ')})` : ''}`).join('; ') : 'chưa phát lần nào'}. ${sw}.`;
  }
  function initTech() {
    const btn = $('ap-reset'), out = $('ap-tech');
    if (!btn) return;
    out.textContent = techText();
    btn.onclick = () => { localStorage.removeItem(METHOD_KEY); log('Audio: xóa cách phát đã nhớ, lần phát sau thử lại từ cách 1b.'); out.textContent = techText(); };
    const d = document.querySelector('#exam-card details.tech');
    if (d) d.addEventListener('toggle', () => { out.textContent = techText(); });
  }

  window.AudioPlayer = { openBook, openFile, openExam, close, isOpen: () => st.open, bookAudio, _st: st };
  document.addEventListener('DOMContentLoaded', initTech);
  if (document.readyState !== 'loading') initTech();
})();
