// Mốc 2: nhận diện file theo handover mục 4.3. Hàm thuần, không gọi mạng, chạy được cả trong trình duyệt lẫn Node (để test).
// Không chứa tên file hay nội dung Cambridge nào, chỉ có quy tắc.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Recognize = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const AUDIO_EXT = new Set(['mp3', 'm4a', 'wav', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma']);

  // Từ khóa mặc định. Minh thêm được từ khóa riêng (opts.keywords), xem mergeKeywords.
  const DEFAULT_KW = {
    book: ['cambridge', 'cam', 'ielts', 'c', 'no'],
    test: ['test', 'tests', 't'],
    part: ['part', 'section', 'sec', 's', 'audio'],
    track: ['track', 'audiotrack', 'tr'],
    cd: ['cd', 'disc', 'disk'],
    key: ['key', 'keys', 'answer', 'answers'],
  };

  // ---------- Chuẩn hóa ----------
  const CN_DIGIT = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  function cnToInt(s) {
    if (!s.includes('十')) { let n = 0; for (const ch of s) n = n * 10 + CN_DIGIT[ch]; return n; }
    const [a, b] = s.split('十');
    return (a ? CN_DIGIT[a] : 1) * 10 + (b ? CN_DIGIT[b] : 0);
  }
  // Từ khóa tiếng Trung đổi sang từ khóa Latin trước khi tách từ.
  const CJK_MAP = [
    [/第\s*(\d+)\s*套/g, ' test $1 '],
    [/第\s*(\d+)\s*(部分|节|篇|段)/g, ' part $1 '],
    [/剑桥雅思|剑桥|剑雅|剑/g, ' cambridge '],
    [/雅思/g, ' ielts '],
    [/听力/g, ' listening '],
    [/阅读/g, ' reading '],
    [/写作/g, ' writing '],
    [/口语/g, ' speaking '],
    [/答案|解析/g, ' key '],
    [/曲目|音轨/g, ' track '],
  ];

  function splitExt(name) {
    const m = /^(.*)\.([A-Za-z0-9]{1,5})$/.exec(name);
    return m ? { stem: m[1], ext: m[2].toLowerCase() } : { stem: name, ext: '' };
  }

  // Trả về mảng từ đã chuẩn hóa. Dải số (1-13, 2026-09-06) thành từ "range".
  function tokenize(str) {
    let s = String(str).normalize('NFKC');                 // số toàn chiều rộng -> số thường
    s = s.replace(/[đĐ]/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC'); // bỏ dấu
    s = s.toLowerCase();
    s = s.replace(/[零〇一二两三四五六七八九十]+/g, (m) => String(cnToInt(m)));
    for (const [re, rep] of CJK_MAP) s = s.replace(re, rep);
    s = s.replace(/\d+\s*-\s*\d+(?:\s*-\s*\d+)*/g, ' range ');
    s = s.replace(/[^a-z0-9㐀-鿿]+/g, ' ');         // _ - . ( ) + khoảng trắng như nhau
    s = s.replace(/([a-z㐀-鿿])(\d)/g, '$1 $2').replace(/(\d)([a-z㐀-鿿])/g, '$1 $2');
    return s.trim().split(/\s+/).filter(Boolean);
  }

  const isNum = (t) => /^\d+$/.test(t);

  function mergeKeywords(extra) {
    const kw = {};
    for (const k of Object.keys(DEFAULT_KW)) {
      const add = (extra && extra[k]) || [];
      kw[k] = new Set([...DEFAULT_KW[k], ...add.flatMap((w) => tokenize(w))]);
    }
    return kw;
  }

  // Số đứng ngay sau một từ khóa (cho phép xen từ khóa cùng nhóm, vd "ielts cambridge 13").
  function numsAfter(toks, set, chain) {
    const out = [];
    for (let i = 0; i < toks.length; i++) {
      if (!set.has(toks[i])) continue;
      let j = i + 1;
      if (chain) while (j < toks.length && set.has(toks[j]) && toks[j] !== 'c') j++;
      if (j < toks.length && isNum(toks[j])) out.push(parseInt(toks[j], 10));
    }
    return out;
  }
  function single(nums) {
    const u = [...new Set(nums)];
    return u.length === 1 ? u[0] : null;
  }

  // Quyển từ một chuỗi (tên file hoặc tên thư mục).
  function bookFrom(toks, kw, maxBook) {
    const nums = numsAfter(toks, kw.book, true);
    const inRange = [...new Set(nums.filter((n) => n >= 1 && n <= maxBook))];
    if (inRange.length === 1) return { book: inRange[0] };
    if (inRange.length > 1) return { ambiguous: inRange };
    if (nums.length) return { outOfRange: nums[0] };
    return {};
  }

  // Đi từ thư mục gần nhất lên gốc, lấy quyển đầu tiên tìm được.
  function bookFromFolders(folderToks, kw, maxBook) {
    for (const t of folderToks) {
      const r = bookFrom(t, kw, maxBook);
      if (r.book) return r.book;
    }
    return null;
  }
  function cdFromFolders(folderToks, kw) {
    for (const t of folderToks) {
      const c = single(numsAfter(t, kw.cd, false));
      if (c) return c;
    }
    return null;
  }
  function testFromFolders(folderToks, kw) {
    // Chỉ thư mục gần nhất, và chỉ khi có đúng một số Test (bỏ "CD3 - Test 1 + 2").
    const t = folderToks[0] || [];
    const all = t.filter(isNum);
    const n = numsAfter(t, kw.test, false);
    return n.length === 1 && all.length === 1 ? n[0] : null;
  }

  // ---------- Nhận diện từng file ----------
  function analyzeAudio(f, kw, maxBook) {
    const toks = tokenize(splitExt(f.name).stem);
    const folderToks = (f.folders || []).map(tokenize);
    const r = { kind: 'audio', toks };

    const fb = bookFrom(toks, kw, maxBook);
    if (fb.book) { r.book = fb.book; r.bookSrc = 'name'; }
    else {
      const b = bookFromFolders(folderToks, kw, maxBook);
      if (b) { r.book = b; r.bookSrc = 'folder'; }
    }

    const hasSection = toks.includes('section') || toks.includes('sec');
    const hasPartWord = toks.includes('part');
    const notes = [];
    let test = null, part = null;
    if (hasSection && hasPartWord) {
      // Kiểu "剑18 section4 part2": section = Test, part = Part (Minh đã xác nhận 12/10).
      test = single(numsAfter(toks, new Set(['section', 'sec']), false));
      part = single(numsAfter(toks, new Set(['part']), false));
      notes.push('section=Test, part=Part');
    } else {
      test = single(numsAfter(toks, kw.test, false));
      part = single(numsAfter(toks, kw.part, false));
    }
    if (test == null && part != null) test = testFromFolders(folderToks, kw);

    let track = single(numsAfter(toks, kw.track, false));
    if (track == null && toks.length === 1 && isNum(toks[0])) track = parseInt(toks[0], 10);

    if (test != null && part != null) { r.scope = 'part'; r.test = test; r.part = part; }
    else if (test != null && track == null) { r.scope = 'test'; r.test = test; }
    else if (track != null) {
      r.scope = 'track'; r.track = track;
      r.cd = single(numsAfter(toks, kw.cd, false)) || cdFromFolders(folderToks, kw);
    }
    r.notes = notes;
    return r;
  }

  function analyzePdf(f, kw, maxBook) {
    const toks = tokenize(splitExt(f.name).stem);
    const folderToks = (f.folders || []).map(tokenize);
    const r = { kind: 'pdf', toks, notes: [] };

    let withAnswers = false;
    for (let i = 0; i < toks.length - 1; i++) if (toks[i] === 'with' && /^answers?$/.test(toks[i + 1])) withAnswers = true;
    let isKey = !withAnswers && toks.some((t) => kw.key.has(t));
    for (let i = 0; i < toks.length - 1; i++) if (toks[i] === 'dap' && toks[i + 1] === 'an') isKey = !withAnswers;
    const skills = ['listening', 'reading', 'writing', 'speaking'].filter((s) => toks.includes(s));

    if (withAnswers) r.scope = 'book+answers';
    else if (isKey) {
      r.scope = 'key';
      if (skills.length === 1) r.notes.push(`key chỉ ${skills[0][0].toUpperCase()}${skills[0].slice(1)}`);
    } else if (skills.length && !toks.includes('full')) {
      r.scope = 'book(partial)';
      r.notes.push('bản rút gọn ' + skills.map((s) => s[0].toUpperCase() + s.slice(1)).join('/'));
    } else r.scope = 'book';

    const parentBook = bookFromFolders(folderToks, kw, maxBook);
    const fb = bookFrom(toks, kw, maxBook);
    if (fb.book) { r.book = fb.book; r.bookSrc = 'name'; r.conf = 'high'; }
    else if (toks.length === 1 && isNum(toks[0])) {
      const n = parseInt(toks[0], 10);
      if (parentBook && parentBook === n) { r.book = n; r.bookSrc = 'name+folder'; r.conf = 'medium'; r.notes.push(`tên chỉ có số ${n}, thư mục cha khớp`); }
      else if (parentBook) { r.book = parentBook; r.bookSrc = 'folder'; r.conf = 'low'; r.notes.push(`tên chỉ có số ${n}, thư mục cha là quyển ${parentBook}, cần xác nhận`); }
    } else if (fb.outOfRange != null && parentBook) {
      r.book = parentBook; r.bookSrc = 'folder'; r.conf = 'low';
      r.notes.push(`tên có số ${fb.outOfRange} ngoài 1-${maxBook}, gợi ý quyển ${parentBook} theo thư mục cha, cần xác nhận`);
    } else if (parentBook) {
      r.book = parentBook; r.bookSrc = 'folder'; r.conf = 'medium'; r.notes.push('quyển lấy từ thư mục cha');
    }
    return r;
  }

  // ---------- Nhận diện cả danh sách ----------
  // files: [{id, name, mimeType, size, folders: [tên thư mục gần nhất, ..., thư mục ngay dưới gốc]}]
  // opts: {maxBook, keywords, books: {[book]: {trackOffset}}}
  function recognizeAll(files, opts = {}) {
    const maxBook = opts.maxBook || 21;
    const kw = mergeKeywords(opts.keywords);
    const bookCfg = opts.books || {};
    const out = [];

    for (const f of files) {
      const { ext } = splitExt(f.name);
      const mime = f.mimeType || '';
      let r;
      if (ext === 'pdf' || mime === 'application/pdf') r = analyzePdf(f, kw, maxBook);
      else if (AUDIO_EXT.has(ext) || mime.startsWith('audio/')) r = analyzeAudio(f, kw, maxBook);
      else continue;
      out.push(Object.assign({ id: f.id, name: f.name, size: f.size, folders: f.folders || [] }, r));
    }

    const audio = out.filter((r) => r.kind === 'audio');

    // Số Test nối tiếp (Cam 12: Test 5-8): nếu mọi Test của quyển > 4 thì trừ bội số của 4.
    const byBook = groupBy(audio.filter((r) => r.book && (r.scope === 'part' || r.scope === 'test')), (r) => r.book);
    for (const list of byBook.values()) {
      const min = Math.min(...list.map((r) => r.test));
      if (min > 4) {
        const shift = 4 * Math.floor((min - 1) / 4);
        for (const r of list) { r.notes.push(`Test ${r.test} -> ${r.test - shift} (số Test nối tiếp, trừ ${shift})`); r.test -= shift; r.shifted = true; }
      }
    }

    // Track CD: gắn theo thứ tự, 16 track = Test 1-4 x Part 1-4 (CD1 là Test 1-2). Có ô "lệch N track" theo quyển.
    const tracks = groupBy(audio.filter((r) => r.book && r.scope === 'track'), (r) => r.book);
    for (const [book, list] of tracks) {
      const offset = Number((bookCfg[book] || {}).trackOffset) || 0;
      const cds = [...new Set(list.map((r) => r.cd || 0))].sort((a, b) => a - b);
      let cum = 0;
      for (const cd of cds) {
        const onCd = list.filter((r) => (r.cd || 0) === cd);
        for (const r of onCd) {
          r.trackIndex = cum + r.track - offset;
          const cdLabel = cd ? `CD${cd} ` : '';
          if (r.trackIndex >= 1 && r.trackIndex <= 16) {
            r.test = Math.floor((r.trackIndex - 1) / 4) + 1;
            r.part = ((r.trackIndex - 1) % 4) + 1;
            r.notes.push(`suy theo thứ tự track (${cdLabel}track ${r.track}${offset ? `, lệch ${offset}` : ''}), chưa nghe kiểm chứng`);
          } else {
            r.notes.push(`track ${r.trackIndex < 1 ? 'nằm trước Test 1 (có thể là track giới thiệu)' : 'vượt quá 16'} (${cdLabel}track ${r.track}${offset ? `, lệch ${offset}` : ''})`);
          }
        }
        cum += Math.max(...onCd.map((r) => r.track));
      }
    }

    // Mức chắc chắn cho audio.
    for (const r of audio) {
      if (!r.book || r.test == null || (r.scope === 'track' && r.part == null)) { r.conf = 'unassigned'; continue; }
      if (r.scope === 'track') r.conf = 'low';
      else if (r.shifted) r.conf = 'medium';
      else r.conf = 'high';
    }
    for (const r of out) if (r.kind === 'pdf' && !r.book) r.conf = 'unassigned';

    // Quyển có >1 PDF sách.
    const books = groupBy(out.filter((r) => r.kind === 'pdf' && r.book && r.scope.startsWith('book')), (r) => r.book);
    for (const list of books.values()) if (list.length > 1) for (const r of list) { r.multiBook = true; r.notes.push('quyển có >1 PDF sách, cần chọn'); }

    return out;
  }

  // Ô audio mỗi quyển: 16 ô (Test x Part) nếu theo Part/track, 4 ô nếu theo Test.
  function audioCells(results) {
    const books = new Map();
    for (const r of results) {
      if (r.kind !== 'audio' || r.conf === 'unassigned' || r.ignored) continue;
      if (!books.has(r.book)) books.set(r.book, { book: r.book, cells: new Map(), scopes: new Set() });
      const b = books.get(r.book);
      const cell = r.scope === 'test' ? `T${r.test}` : `T${r.test}P${r.part}`;
      b.scopes.add(r.scope === 'test' ? 'test' : 'part');
      if (!b.cells.has(cell)) b.cells.set(cell, []);
      b.cells.get(cell).push(r);
    }
    for (const b of books.values()) {
      const byTest = b.scopes.size === 1 && b.scopes.has('test');
      b.expected = byTest ? 4 : 16;
      b.filled = b.cells.size;
      b.dups = [...b.cells.values()].filter((l) => l.length > 1).length;
      b.missing = [];
      for (let t = 1; t <= 4; t++) {
        if (byTest) { if (!b.cells.has(`T${t}`)) b.missing.push(`T${t}`); }
        else for (let p = 1; p <= 4; p++) if (!b.cells.has(`T${t}P${p}`)) b.missing.push(`T${t}P${p}`);
      }
      b.complete = b.filled === b.expected && b.dups === 0 && b.scopes.size === 1;
    }
    return books;
  }

  function groupBy(arr, fn) {
    const m = new Map();
    for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
    return m;
  }

  return { tokenize, splitExt, recognizeAll, audioCells, DEFAULT_KW, AUDIO_EXT };
});
