// Mốc 2 (+ mốc 3: nút Mở PDF): quét thư mục CAMBRIDGE trên Drive, nhận diện file, bảng xác nhận và sửa tay.
// Kết quả quét và chỗ sửa tay lưu trong máy (localStorage). m6-1: chỗ sửa tay (ielts.libcfg) đồng bộ giữa các máy qua sync.js; kết quả quét thì không (quét lại được).
'use strict';
(function () {
  const SCAN_KEY = 'ielts.scan';
  const CFG_KEY = 'ielts.libcfg';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
  const MAX_BOOK = 21;
  const CONF_LABEL = { high: 'chắc', medium: 'vừa', low: 'thấp', unassigned: 'chưa gán', manual: 'sửa tay', confirmed: 'đã xác nhận' };
  const KW_GROUPS = [['book', 'Quyển'], ['test', 'Test'], ['part', 'Part / Section'], ['track', 'Track'], ['key', 'Đáp án']];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let results = [];
  let editing = null;            // id file đang sửa
  const openBooks = new Set();   // quyển đang mở, giữ nguyên khi vẽ lại

  function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (_) { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); if (window.Sync) Sync.touched(k); } catch (e) { log('Không lưu được vào máy: ' + e.message); } }
  function getCfg() {
    const c = loadJSON(CFG_KEY, {});
    c.files = c.files || {}; c.books = c.books || {}; c.keywords = c.keywords || {};
    return c;
  }

  // ---------- Quét Drive ----------
  // Đi theo từng tầng thư mục, gộp nhiều thư mục cha vào một truy vấn để ít yêu cầu.
  async function scanDrive() {
    const t0 = performance.now();
    let requests = 0, rows = 0, dupIds = 0, shortcuts = 0;
    const roots = await listAll({
      q: `name = '${CFG.ROOT_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false and 'me' in owners`,
      fields: 'nextPageToken, files(id,name)',
    });
    requests += roots.pages;
    if (!roots.files.length) throw new Error(`Không thấy thư mục ${CFG.ROOT_FOLDER_NAME}`);
    if (roots.files.length > 1) log(`Có ${roots.files.length} thư mục ${CFG.ROOT_FOLDER_NAME}, dùng thư mục đầu tiên.`);
    const root = roots.files[0];

    const folderPath = new Map([[root.id, []]]);
    const files = new Map();
    let frontier = [root.id];
    while (frontier.length) {
      const next = [];
      for (let i = 0; i < frontier.length; i += 25) {
        const chunk = frontier.slice(i, i + 25);
        const r = await listAll({
          q: '(' + chunk.map((id) => `'${id}' in parents`).join(' or ') + ') and trashed = false',
          fields: 'nextPageToken, files(id,name,mimeType,size,parents)',
        });
        requests += r.pages; rows += r.rows; dupIds += r.dups;
        for (const f of r.files) {
          const parent = (f.parents || []).find((p) => chunk.includes(p));
          const ppath = folderPath.get(parent) || [];
          if (f.mimeType === FOLDER_MIME) {
            if (!folderPath.has(f.id)) { folderPath.set(f.id, [...ppath, f.name]); next.push(f.id); }
            continue;
          }
          if (f.mimeType === SHORTCUT_MIME) { shortcuts++; continue; }
          if (files.has(f.id)) { dupIds++; continue; }
          files.set(f.id, { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size ? Number(f.size) : null, path: ppath, folders: [...ppath].reverse() });
        }
      }
      frontier = next;
    }
    const scan = {
      at: Date.now(), rootName: root.name, files: [...files.values()],
      stats: { folders: folderPath.size - 1, requests, rows, dupIds, shortcuts, ms: Math.round(performance.now() - t0) },
    };
    saveJSON(SCAN_KEY, scan);
    return scan;
  }

  // ---------- Nhận diện + áp chỗ sửa tay ----------
  function compute() {
    const scan = loadJSON(SCAN_KEY, null);
    if (!scan) { results = []; return null; }
    const c = getCfg();
    results = Recognize.recognizeAll(scan.files, { maxBook: MAX_BOOK, books: c.books, keywords: c.keywords });
    const byId = new Map(scan.files.map((f) => [f.id, f]));
    for (const r of results) r.path = (byId.get(r.id) || {}).path || [];
    Recognize.applyOverrides(results, c);   // sửa tay + đổi ghi chú tự động theo (rule 14/10)
    return scan;
  }

  function selfCheck(cells) {
    const full = [], partial = [];
    for (const b of [...cells.values()].sort((x, y) => x.book - y.book)) (b.complete ? full : partial).push(b);
    const withAudio = new Set(cells.keys());
    const none = [];
    for (let b = 1; b <= MAX_BOOK; b++) if (!withAudio.has(b)) none.push(b);
    return { full, partial, none };
  }

  // ---------- Vẽ giao diện ----------
  function assignLabel(r) {
    if (r.ignored) return 'bỏ qua';
    if (r.kind === 'pdf') return r.scope || '?';
    if (r.test == null) return r.scope === 'track' ? `track ${r.track}` : '?';
    return r.scope === 'test' ? `Test ${r.test} (cả Test)` : `Test ${r.test} · Part ${r.part}`;
  }

  function fileRow(r) {
    const conf = r.ignored ? 'ignored' : r.conf;
    const folder = r.path.length ? r.path.slice(-2).join(' / ') : '(ngay trong gốc)';
    if (editing === r.id) return editRow(r);
    const notes = (r.notes || []).filter(Boolean);
    return `<div class="frow">
      <div class="fname">${esc(r.name)}<span class="hint">${esc(folder)}</span>${notes.length ? `<span class="hint note${r.ignored || r.conf === 'manual' || r.conf === 'confirmed' || r.isMain !== undefined ? ' done' : ''}">${esc(notes.join('; '))}</span>` : ''}</div>
      <div class="fasg">${esc(assignLabel(r))}${r.isMain ? ' <b>(bản chính)</b>' : ''}</div>
      <span class="badge c-${conf}">${esc(r.ignored ? 'bỏ qua' : CONF_LABEL[conf] || conf)}</span>
      <span class="btns">${r.kind === 'pdf' && !r.ignored ? `<button class="small" data-act="open" data-id="${esc(r.id)}">Mở</button> ` : ''}${r.kind === 'audio' && !r.ignored && r.book && r.test ? `<button class="small" data-act="listen" data-id="${esc(r.id)}">Nghe</button> ` : ''}<button class="small secondary" data-act="edit" data-id="${esc(r.id)}">Sửa</button></span>
    </div>`;
  }

  function editRow(r) {
    const scopes = r.kind === 'pdf' ? ['book', 'book(partial)', 'book+answers', 'key'] : ['part', 'test'];
    const opt = (v, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${v}</option>`;
    const sc = scopes.includes(r.scope) ? r.scope : scopes[0];
    return `<div class="frow editing" data-id="${esc(r.id)}">
      <div class="fname">${esc(r.name)}<span class="hint">Tự động: ${esc(JSON.stringify(r.auto))}</span></div>
      <div class="edit-grid">
        <label>Quyển <input type="number" min="1" max="99" name="book" value="${r.book ?? ''}"></label>
        <label>Kiểu <select name="scope">${scopes.map((s) => opt(s, sc)).join('')}</select></label>
        ${r.kind === 'audio' ? `<label>Test <input type="number" min="1" max="4" name="test" value="${r.test ?? ''}"></label>
        <label>Part <input type="number" min="1" max="4" name="part" value="${r.part ?? ''}"></label>` : ''}
      </div>
      <div class="row">
        <button class="small" data-act="save" data-id="${esc(r.id)}">Lưu</button>
        <button class="small secondary" data-act="ignore" data-id="${esc(r.id)}">Bỏ qua file này</button>
        <button class="small secondary" data-act="reset" data-id="${esc(r.id)}">Về tự động</button>
        <button class="small secondary" data-act="cancel">Hủy</button>
      </div>
    </div>`;
  }

  function bookBlock(b, cells, c) {
    const audio = results.filter((r) => r.kind === 'audio' && r.book === b && (r.conf !== 'unassigned' || r.ignored));
    const pdfs = results.filter((r) => r.kind === 'pdf' && r.book === b);
    const cell = cells.get(b);
    const chips = [];
    if (!cell) chips.push('<span class="chip bad">không có audio</span>');
    else if (cell.complete) chips.push(`<span class="chip ok">audio đủ ${cell.filled}/${cell.expected}</span>`);
    else chips.push(`<span class="chip warn">audio ${cell.filled}/${cell.expected}${cell.dups ? `, trùng ${cell.dups} ô` : ''}</span>`);
    const isTrack = audio.some((r) => r.auto.scope === 'track');
    if (audio.some((r) => r.conf === 'low')) chips.push('<span class="chip warn">track cần xác nhận</span>');
    if (audio.some((r) => r.conf === 'medium')) chips.push('<span class="chip warn">số Test đã quy đổi</span>');
    const books = pdfs.filter((r) => r.scope && r.scope.startsWith('book'));
    const keys = pdfs.filter((r) => r.scope === 'key');
    chips.push(books.length ? `<span class="chip">${books.length} PDF sách</span>` : '<span class="chip bad">chưa có PDF</span>');
    if (keys.length) chips.push(`<span class="chip">${keys.length} file key</span>`);
    if (books.length > 1 && !books.some((r) => r.isMain)) chips.push('<span class="chip warn">chọn PDF chính</span>');
    if (pdfs.some((r) => r.conf === 'low' || r.conf === 'medium')) chips.push('<span class="chip warn">PDF cần xác nhận</span>');

    const bc = c.books[b] || {};
    let controls = '';
    if (isTrack) {
      controls += `<div class="row book-ctl">
        <label>Lệch <input type="number" min="-3" max="5" value="${Number(bc.trackOffset) || 0}" data-act="offset" data-book="${b}" style="width:4em"> track</label>
        <label><input type="checkbox" data-act="confirm" data-book="${b}"${bc.confirmed ? ' checked' : ''}> Đã nghe thử track 1 và 5, xác nhận cả quyển</label>
      </div>`;
    }
    if (books.length > 1) {
      controls += '<div class="book-ctl"><span class="hint">PDF chính của quyển:</span>' + books.map((r) =>
        `<label class="radio"><input type="radio" name="main-${b}" data-act="main" data-book="${b}" value="${esc(r.id)}"${r.isMain ? ' checked' : ''}> ${esc(r.name)}${r.size ? ` (${(r.size / 1e6).toFixed(1)} MB)` : ''}</label>`).join('') + '</div>';
    }
    let missing = '';
    if (cell && !cell.complete && cell.missing.length) missing = `<p class="hint">Ô thiếu: ${esc(cell.missing.join(' '))}</p>`;

    const sorted = [...audio].sort((x, y) => (x.test || 9) - (y.test || 9) || (x.part || 9) - (y.part || 9));
    return `<details data-book="${b}"${openBooks.has(b) ? ' open' : ''}>
      <summary><b>Cam ${b}</b> ${chips.join(' ')}</summary>
      ${controls}${missing}
      ${pdfs.map(fileRow).join('')}
      ${sorted.map(fileRow).join('')}
    </details>`;
  }

  function render() {
    const box = $('lib-result');
    if (!box) return;
    const scan = compute();
    if (!scan) { box.innerHTML = '<p class="hint">Chưa quét. Bấm "Quét Drive".</p>'; return; }
    const c = getCfg();
    const cells = Recognize.audioCells(results);
    const chk = selfCheck(cells);
    const audio = results.filter((r) => r.kind === 'audio');
    const pdf = results.filter((r) => r.kind === 'pdf');
    const others = scan.files.length - results.length;
    const count = (list) => {
      const m = {};
      for (const r of list) { const k = r.ignored ? 'ignored' : r.conf; m[k] = (m[k] || 0) + 1; }
      return Object.entries(m).map(([k, v]) => `${CONF_LABEL[k] || 'bỏ qua'} ${v}`).join(', ');
    };
    const s = scan.stats;
    const unassigned = results.filter((r) => r.conf === 'unassigned' && !r.ignored);
    const outBooks = [...new Set(results.map((r) => r.book).filter((b) => b && (b < 1 || b > MAX_BOOK)))];

    const bookList = [];
    for (let b = 1; b <= MAX_BOOK; b++) bookList.push(b);
    for (const b of outBooks) bookList.push(b);

    box.innerHTML = `
      <p>Quét lúc ${new Date(scan.at).toLocaleString('vi-VN')}: <b>${audio.length}</b> audio, <b>${pdf.length}</b> PDF, ${others} file khác, ${s.folders} thư mục.
      <span class="hint">(${s.requests} lần gọi Drive, ${s.rows} dòng, trùng ID ${s.dupIds}${s.shortcuts ? `, ${s.shortcuts} lối tắt bỏ qua` : ''}, ${(s.ms / 1000).toFixed(1)} giây)</span></p>
      <p class="hint">Audio: ${esc(count(audio))}. PDF: ${esc(count(pdf))}.</p>
      <p class="ok">Đủ ô: ${chk.full.length} quyển (${chk.full.map((b) => b.book).join(', ')}).</p>
      ${chk.partial.length ? `<p class="warn">Thiếu ô: ${chk.partial.map((b) => `Cam ${b.book} (${b.filled}/${b.expected}${b.dups ? `, trùng ${b.dups}` : ''})`).join(', ')}.</p>` : ''}
      ${chk.none.length ? `<p class="warn">Không có audio: ${chk.none.map((b) => 'Cam ' + b).join(', ')}.</p>` : ''}
      ${unassigned.length ? `<details open class="unassigned"><summary><b>Chưa gán (${unassigned.length})</b></summary>${unassigned.map(fileRow).join('')}</details>` : ''}
      <div class="books">${bookList.map((b) => bookBlock(b, cells, c)).join('')}</div>
      <details class="kw"><summary>Từ khóa thêm và cài đặt</summary>
        <p class="hint">Thêm từ khóa riêng, cách nhau bằng dấu phẩy. Ví dụ Test: <code>bài, đề</code>. Từ mặc định vẫn dùng.</p>
        ${KW_GROUPS.map(([k, label]) => `<label class="kwrow">${label} <input data-kw="${k}" value="${esc((c.keywords[k] || []).join(', '))}"></label>`).join('')}
        <div class="row"><button class="small" data-act="kwsave">Lưu từ khóa</button>
        <button class="small secondary" data-act="clearall">Xóa mọi chỗ sửa tay</button></div>
      </details>`;
    if (window.Viewer) Viewer.refreshPicker();
    log(`Nhận diện: ${audio.length} audio (${count(audio)}), ${pdf.length} PDF (${count(pdf)}). Đủ ô ${chk.full.length} quyển; thiếu: ${chk.partial.map((b) => `${b.book} ${b.filled}/${b.expected}`).join(', ') || 'không'}; không audio: ${chk.none.join(', ') || 'không'}.`);
  }

  // ---------- Thao tác ----------
  function setFileOverride(id, ov) {
    const c = getCfg();
    if (ov) c.files[id] = ov; else delete c.files[id];
    saveJSON(CFG_KEY, c);
  }

  function onClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act, id = btn.dataset.id;
    const r = results.find((x) => x.id === id);
    if (act === 'open') { if (window.Viewer) Viewer.open({ file: r, mode: 'review' }); return; }
    if (act === 'listen') { if (window.AudioPlayer) AudioPlayer.openFile(r); return; }   // m4-1: nghe thử (vd track CD)
    if (act === 'edit') { editing = id; render(); return; }
    if (act === 'cancel') { editing = null; render(); return; }
    if (act === 'save') {
      const row = btn.closest('.frow');
      const val = (n) => { const el = row.querySelector(`[name="${n}"]`); return el ? el.value : ''; };
      const num = (n) => (val(n) === '' ? null : parseInt(val(n), 10));
      const ov = { book: num('book'), scope: val('scope'), test: num('test'), part: num('part') };
      if (!ov.book) { alert('Cần nhập số quyển.'); return; }
      if (r.kind === 'audio' && (!ov.test || (ov.scope === 'part' && !ov.part))) { alert('Cần nhập Test (và Part nếu kiểu là part).'); return; }
      if (ov.scope === 'test') ov.part = null;
      setFileOverride(id, ov);
      log(`Sửa tay: ${r.name} -> Cam ${ov.book} ${ov.scope}${ov.test ? ' T' + ov.test : ''}${ov.part ? ' P' + ov.part : ''}`);
      editing = null; render(); return;
    }
    if (act === 'ignore') { setFileOverride(id, { ignored: true }); log(`Bỏ qua file: ${r.name}`); editing = null; render(); return; }
    if (act === 'reset') { setFileOverride(id, null); log(`Về tự động: ${r.name}`); editing = null; render(); return; }
    if (act === 'kwsave') {
      const c = getCfg();
      document.querySelectorAll('[data-kw]').forEach((el) => {
        c.keywords[el.dataset.kw] = el.value.split(',').map((s) => s.trim()).filter(Boolean);
      });
      saveJSON(CFG_KEY, c); log('Đã lưu từ khóa thêm.'); render(); return;
    }
    if (act === 'clearall') {
      if (!confirm('Xóa mọi chỗ sửa tay, lệch track, xác nhận quyển và PDF chính?')) return;
      const c = getCfg(); saveJSON(CFG_KEY, { keywords: c.keywords }); log('Đã xóa mọi chỗ sửa tay.'); render(); return;
    }
  }

  function onChange(e) {
    const el = e.target;
    const act = el.dataset && el.dataset.act;
    if (!act) return;
    const b = Number(el.dataset.book);
    const c = getCfg();
    c.books[b] = c.books[b] || {};
    if (act === 'offset') { c.books[b].trackOffset = parseInt(el.value, 10) || 0; log(`Cam ${b}: lệch ${c.books[b].trackOffset} track.`); }
    if (act === 'confirm') { c.books[b].confirmed = el.checked; log(`Cam ${b}: ${el.checked ? 'đã' : 'bỏ'} xác nhận track.`); }
    if (act === 'main') { c.books[b].mainPdf = el.value; log(`Cam ${b}: chọn PDF chính.`); }
    saveJSON(CFG_KEY, c);
    render();
  }

  function onToggle(e) {
    const d = e.target;
    if (d.tagName !== 'DETAILS' || !d.dataset.book) return;
    const b = Number(d.dataset.book);
    if (d.open) openBooks.add(b); else openBooks.delete(b);
  }

  async function onScan() {
    const btn = $('btn-scan');
    const wait = window.ensureToken();   // gọi trước mọi await để cửa sổ gia hạn không bị chặn
    btn.disabled = true; btn.textContent = 'Đang quét…';
    try {
      await wait;
      const scan = await scanDrive();
      const s = scan.stats;
      log(`Quét xong: ${scan.files.length} file trong ${s.folders} thư mục, ${s.requests} lần gọi, ${(s.ms / 1000).toFixed(1)} giây.`);
      render();
    } catch (e) {
      log('Quét lỗi: ' + e.message);
      $('lib-result').insertAdjacentHTML('afterbegin', `<p class="bad">${esc(e.message)}</p>`);
    } finally {
      btn.disabled = !loadAuth(); btn.textContent = 'Quét Drive';
    }
  }

  // Xuất cùng cột với audio-index.tsv (bỏ cột ID) để Claude so lệch.
  function exportTsv() {
    if (!results.length) { log('Chưa có kết quả để xuất.'); return; }
    const head = ['type', 'book', 'test', 'part', 'scope', 'conf', 'file', 'size', 'path', 'note'];
    const v = (x) => (x == null ? '' : String(x).replace(/[\t\n]/g, ' '));
    const lines = results.map((r) => [r.kind, r.book, r.kind === 'audio' ? r.test : '', r.kind === 'audio' ? r.part : '', r.ignored ? 'ignored' : r.scope,
      r.ignored ? 'ignored' : r.conf, r.name, r.size, [CFG.ROOT_FOLDER_NAME, ...r.path].join('/'), (r.notes || []).join('; ')].map(v).join('\t'));
    const text = [head.join('\t'), ...lines].join('\n');
    navigator.clipboard.writeText(text).then(() => log(`Đã chép ${lines.length} dòng kết quả (TSV).`), () => log('Không chép được vào bộ nhớ tạm.'));
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/tab-separated-values' }));
      a.download = 'ket-qua-nhan-dien.tsv';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (_) {}
  }

  function onAuth(signedIn) {
    const b = $('btn-scan');
    if (b) b.disabled = !signedIn;
    if (window.Viewer) Viewer.refreshPicker();
  }

  function init() {
    const box = $('lib-result');
    box.addEventListener('click', onClick);
    box.addEventListener('change', onChange);
    box.addEventListener('toggle', onToggle, true);
    $('btn-scan').onclick = onScan;
    $('btn-export').onclick = exportTsv;
    onAuth(!!loadAuth());
    render();
  }

  window.Library = { onAuth, init, render, _results: () => results };
  init();
})();
