// Mốc 1: khung PWA, đăng nhập Google, đọc Drive.
// Không có nội dung Cambridge nào trong code. App chỉ đọc file trong Drive của người đăng nhập.
'use strict';

const CFG = window.APP_CONFIG;
const DRIVE = 'https://www.googleapis.com/drive/v3/';
const AUTH_KEY = 'ielts.auth';
const STATE_KEY = 'ielts.oauthState';
const LOG_KEY = 'ielts.log';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Nhật ký (lưu trong máy để đọc lại sau khi chuyển trang) ----------
function log(msg) {
  const line = `${new Date().toLocaleTimeString('vi-VN')}  ${msg}`;
  let lines = [];
  try { lines = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (_) {}
  lines.push(line);
  lines = lines.slice(-300);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(lines)); } catch (_) {}
  renderLog(lines);
}
function renderLog(lines) {
  if (!lines) { try { lines = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (_) { lines = []; } }
  const el = $('log');
  el.textContent = lines.join('\n');
  el.scrollTop = el.scrollHeight;
}

// ---------- Token ----------
function loadAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (_) { return null; }
}
function saveAuth(a) {
  if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a));
  else localStorage.removeItem(AUTH_KEY);
  renderAuth();
}
function tokenValid(a = loadAuth()) {
  return !!(a && a.token && a.expiresAt > Date.now() + 30_000);
}
function grantedAll(scopeStr) {
  const got = new Set(String(scopeStr || '').split(/\s+/));
  return CFG.SCOPES.filter((s) => !got.has(s));
}
const tokenWaiters = [];
function acceptToken({ access_token, expires_in, scope }, via) {
  const missing = grantedAll(scope);
  const prev = loadAuth();
  saveAuth({ token: access_token, expiresAt: Date.now() + Number(expires_in) * 1000, scope, via, at: Date.now(), email: prev && prev.email });
  while (tokenWaiters.length) tokenWaiters.shift()(true);
  log(`Nhận token qua ${via}, hạn ${Math.round(expires_in / 60)} phút.` +
      (missing.length ? ` THIẾU quyền: ${missing.map(shortScope).join(', ')}` : ' Đủ quyền.'));
}
const shortScope = (s) => s.replace('https://www.googleapis.com/auth/', '');

// ---------- Đăng nhập kiểu cửa sổ (Google Identity Services) ----------
let tokenClient = null;
// Tải thư viện GIS bằng code (m3-2): lỗi thì tự thử lại 2 lần (sau 2 và 5 giây), có mạng lại thì thử tiếp.
// Vẫn hỏng thì các nút đăng nhập / gia hạn chuyển sang kiểu chuyển trang thay vì chỉ báo "chưa sẵn sàng".
const GIS_URL = 'https://accounts.google.com/gsi/client';
const GIS_RETRY = [2000, 5000];
let gisState = 'loading';   // loading | ok | failed
function loadGis(attempt = 1) {
  gisState = 'loading';
  const sc = document.createElement('script');
  sc.src = GIS_URL; sc.async = true;
  const fail = (why) => {
    sc.remove();
    if (attempt <= GIS_RETRY.length) {
      log(`Không tải được thư viện đăng nhập Google (lần ${attempt}: ${why}), tự thử lại sau ${GIS_RETRY[attempt - 1] / 1000} giây.`);
      setTimeout(() => loadGis(attempt + 1), GIS_RETRY[attempt - 1]);
    } else {
      gisState = 'failed';
      log(`Không tải được thư viện đăng nhập Google sau ${attempt} lần (${why}). Nút đăng nhập và gia hạn sẽ dùng kiểu chuyển trang.`);
      renderAuth();
    }
  };
  sc.onload = () => {
    if (window.google && google.accounts && google.accounts.oauth2) { gisState = 'ok'; if (attempt > 1) log(`Tải được thư viện đăng nhập Google ở lần ${attempt}.`); onGisLoaded(); }
    else fail('tải xong nhưng thiếu google.accounts');
  };
  sc.onerror = () => fail('lỗi mạng hoặc bị chặn');
  document.head.appendChild(sc);
}
window.addEventListener('online', () => { if (gisState === 'failed') { log('Có mạng lại, thử tải lại thư viện đăng nhập Google.'); loadGis(1); } });
// Không dùng được cửa sổ đăng nhập (GIS hỏng): chuyển trang. Gọi từ thao tác bấm.
function loginFallback(what) {
  if (gisState === 'loading') { log(`Thư viện đăng nhập Google đang tải lại, bấm ${what} lại sau vài giây.`); return; }
  log(`Thư viện đăng nhập Google không tải được, ${what} bằng kiểu chuyển trang.`);
  loginRedirect();
}
function onGisLoaded() {
  if (!CFG.CLIENT_ID || CFG.CLIENT_ID.startsWith('DAN_')) {
    log('Chưa điền CLIENT_ID trong config.js.');
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.CLIENT_ID,
    scope: CFG.SCOPES.join(' '),
    callback: (resp) => {
      if (resp.error) { log(`Đăng nhập lỗi: ${resp.error} ${resp.error_description || ''}`); return; }
      acceptToken(resp, 'cửa sổ');
    },
    error_callback: (err) => log(`Cửa sổ đăng nhập: ${err.type || 'lỗi'} ${err.message || ''}`),
  });
  log('Đã tải thư viện đăng nhập Google.');
  renderAuth();
}
window.onGisLoaded = onGisLoaded;

function loginPopup(silent) {
  if (!tokenClient) { log('Thư viện đăng nhập chưa sẵn sàng (chưa điền CLIENT_ID hoặc mất mạng).'); return; }
  const a = loadAuth();
  // prompt '' = chỉ hỏi khi cần; lần đầu sẽ hỏi chọn tài khoản và cấp quyền.
  tokenClient.requestAccessToken({ prompt: silent ? '' : 'select_account' , login_hint: a && a.email || undefined });
  log(silent ? 'Đang thử gia hạn token (cửa sổ, không hỏi lại nếu được).' : 'Mở cửa sổ đăng nhập.');
}

// Gọi ngay đầu một thao tác bấm (trước mọi await) để trình duyệt cho phép mở cửa sổ gia hạn.
// Token còn hạn thì trả về ngay; sắp hết hoặc hết thì gia hạn rồi mới chạy tiếp (đã chốt 14/10).
function ensureToken() {
  const a = loadAuth();
  if (a && a.token && a.expiresAt > Date.now() + 5 * 60_000) return Promise.resolve(true);
  if (!a) return Promise.reject(new AuthError('Chưa đăng nhập'));
  if (!tokenClient) {
    if (gisState === 'loading') return Promise.reject(new AuthError('Token hết hạn, thư viện đăng nhập Google đang tải lại, bấm lại sau vài giây'));
    // GIS không tải được: gia hạn bằng chuyển trang (rời trang hiện tại, quay lại app với token mới).
    loginFallback('gia hạn token');
    return Promise.reject(new AuthError('Token hết hạn, đang chuyển sang trang đăng nhập Google để gia hạn'));
  }
  const p = new Promise((resolve, reject) => {
    tokenWaiters.push(resolve);
    setTimeout(() => reject(new AuthError('Gia hạn token quá 60 giây chưa xong')), 60_000);
  });
  loginPopup(true);
  return p;
}
window.ensureToken = ensureToken;

// ---------- Đăng nhập kiểu chuyển trang (OAuth implicit flow) ----------
function redirectUri() { return location.origin + location.pathname; }
function loginRedirect() {
  if (!CFG.CLIENT_ID || CFG.CLIENT_ID.startsWith('DAN_')) { log('Chưa điền CLIENT_ID.'); return; }
  const state = crypto.getRandomValues(new Uint32Array(4)).join('-');
  localStorage.setItem(STATE_KEY, state);
  const a = loadAuth();
  const p = new URLSearchParams({
    client_id: CFG.CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: CFG.SCOPES.join(' '),
    include_granted_scopes: 'true',
    state,
  });
  if (a && a.email) p.set('login_hint', a.email);
  log(`Chuyển sang trang đăng nhập Google (quay về ${redirectUri()}).`);
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p);
}
function handleRedirectReturn() {
  if (!location.hash.includes('access_token=') && !location.hash.includes('error=')) return;
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search); // xóa token khỏi thanh địa chỉ
  const expected = localStorage.getItem(STATE_KEY);
  localStorage.removeItem(STATE_KEY);
  if (h.get('error')) { log(`Đăng nhập chuyển trang lỗi: ${h.get('error')}`); return; }
  if (!expected || h.get('state') !== expected) { log('Bỏ qua token: state không khớp.'); return; }
  acceptToken({ access_token: h.get('access_token'), expires_in: h.get('expires_in'), scope: h.get('scope') }, 'chuyển trang');
}

function logout() {
  const a = loadAuth();
  if (a && a.token && window.google && google.accounts && google.accounts.oauth2) {
    google.accounts.oauth2.revoke(a.token, () => log('Đã thu hồi token.'));
  }
  saveAuth(null);
  $('drive-result').innerHTML = '';
  log('Đã đăng xuất.');
}
function simulateExpiry() {
  const a = loadAuth();
  if (!a) return;
  a.token = 'token-gia-het-han';
  a.expiresAt = Date.now() + 10 * 60_000; // app tưởng còn hạn, Drive sẽ trả 401
  saveAuth(a);
  log('Đã thay token bằng token sai để thử đường xử lý 401. Bấm "Kiểm tra".');
}

// ---------- Drive ----------
class AuthError extends Error {}
async function driveGet(path, params = {}) {
  const a = loadAuth();
  if (!a || !a.token) throw new AuthError('Chưa đăng nhập');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, v);
  const res = await fetch(DRIVE + path + (qs.toString() ? '?' + qs : ''), {
    headers: { Authorization: 'Bearer ' + a.token },
  });
  if (res.status === 401) {
    a.expiresAt = 0; saveAuth(a);
    throw new AuthError('Token hết hạn hoặc bị thu hồi (401)');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error.message; } catch (_) {}
    throw new Error(`Drive trả ${res.status} ${detail}`);
  }
  return res.json();
}

// Đi hết token phân trang, gộp theo ID (handover mục 3).
async function listAll(params) {
  const byId = new Map();
  let pageToken, pages = 0, rows = 0;
  const seenTokens = new Set();
  do {
    const r = await driveGet('files', { ...params, pageSize: 1000, pageToken });
    pages++;
    for (const f of r.files || []) { rows++; byId.set(f.id, f); }
    pageToken = r.nextPageToken;
    if (pageToken && seenTokens.has(pageToken)) { log('Cảnh báo: Drive trả lại token phân trang đã gặp, dừng.'); break; }
    if (pageToken) seenTokens.add(pageToken);
    if (pages > 200) { log('Cảnh báo: quá 200 trang, dừng.'); break; }
  } while (pageToken);
  return { files: [...byId.values()], pages, rows, dups: rows - byId.size };
}

const FOLDER = 'application/vnd.google-apps.folder';

async function checkDrive() {
  const out = $('drive-result');
  out.innerHTML = '<p>Đang kiểm tra…</p>';
  const parts = [];
  const t0 = performance.now();
  try {
    const about = await driveGet('about', { fields: 'user(emailAddress,displayName)' });
    const email = about.user.emailAddress;
    const a = loadAuth(); a.email = email; saveAuth(a);
    parts.push(`<p>Tài khoản: <b>${esc(email)}</b></p>`);
    log(`Tài khoản: ${email}`);

    const roots = await listAll({
      q: `name = '${CFG.ROOT_FOLDER_NAME}' and mimeType = '${FOLDER}' and trashed = false and 'me' in owners`,
      fields: 'nextPageToken, files(id,name,createdTime)',
    });
    if (roots.files.length === 0) {
      parts.push(`<p class="bad">Không thấy thư mục ${esc(CFG.ROOT_FOLDER_NAME)} do tài khoản này sở hữu.</p>`);
      log(`Không thấy thư mục ${CFG.ROOT_FOLDER_NAME}.`);
    } else {
      if (roots.files.length > 1) parts.push(`<p class="warn">Có ${roots.files.length} thư mục tên ${esc(CFG.ROOT_FOLDER_NAME)}, cần chọn một.</p>`);
      for (const root of roots.files) {
        const kids = await listAll({
          q: `'${root.id}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id,name,mimeType)',
          orderBy: 'name',
        });
        const folders = kids.files.filter((f) => f.mimeType === FOLDER);
        const files = kids.files.length - folders.length;
        parts.push(`<p class="ok">Thấy thư mục <b>${esc(root.name)}</b>: ${folders.length} thư mục con, ${files} file.</p>`);
        parts.push('<ul class="plain">' + folders.map((f) => `<li>${esc(f.name)}</li>`).join('') + '</ul>');
        log(`${root.name}: ${folders.length} thư mục con, ${files} file (${kids.pages} trang, trùng ${kids.dups}).`);
        log('Thư mục con: ' + folders.map((f) => f.name).join(' | '));
      }
    }

    const app = await driveGet('files', { spaces: 'appDataFolder', fields: 'files(id,name)', pageSize: 10 });
    parts.push(`<p class="ok">Vùng dữ liệu ẩn của app: đọc được (${(app.files || []).length} file).</p>`);
    log(`Vùng dữ liệu ẩn: đọc được, ${(app.files || []).length} file.`);
    log(`Kiểm tra xong trong ${Math.round(performance.now() - t0)} ms.`);
  } catch (e) {
    const cls = e instanceof AuthError ? 'warn' : 'bad';
    parts.push(`<p class="${cls}">${esc(e.message)}${e instanceof AuthError ? '. Bấm "Thử gia hạn token" hoặc đăng nhập lại.' : ''}</p>`);
    log(`Lỗi: ${e.message}`);
  }
  out.innerHTML = parts.join('');
}

// ---------- Giao diện ----------
let countdown = null;
function renderAuth() {
  const a = loadAuth();
  const ok = tokenValid(a);
  const st = $('auth-status');
  if (!a) st.textContent = 'Chưa đăng nhập.';
  else if (ok) {
    const mins = Math.max(0, Math.round((a.expiresAt - Date.now()) / 60000));
    const missing = grantedAll(a.scope);
    st.innerHTML = `Đã đăng nhập${a.email ? ' (' + esc(a.email) + ')' : ''} qua ${esc(a.via)}. Token còn khoảng ${mins} phút.` +
      (missing.length ? ` <span class="bad">Thiếu quyền: ${esc(missing.map(shortScope).join(', '))}</span>` : '');
  } else st.innerHTML = '<span class="warn">Token đã hết hạn.</span> Bấm "Thử gia hạn token" hoặc đăng nhập lại.';
  $('btn-check').disabled = !a;
  $('btn-refresh').disabled = !a;
  const gisDown = !tokenClient && gisState === 'failed';
  $('btn-refresh').textContent = gisDown ? 'Gia hạn token (chuyển trang)' : 'Thử gia hạn token';
  $('btn-login').textContent = gisDown ? 'Đăng nhập Google (chuyển trang)' : 'Đăng nhập Google';
  $('btn-expire').disabled = !ok;
  $('btn-logout').disabled = !a;
  if (window.Library) window.Library.onAuth(!!a);
  clearTimeout(countdown);
  if (a) countdown = setTimeout(renderAuth, 30_000);
}

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function init() {
  $('mode').textContent = isStandalone() ? 'Đang chạy dạng app đã cài' : 'Đang chạy trong trình duyệt';
  renderLog();
  handleRedirectReturn();
  renderAuth();
  $('btn-login').onclick = () => (tokenClient ? loginPopup(false) : loginFallback('đăng nhập'));
  $('btn-login-redirect').onclick = loginRedirect;
  $('btn-refresh').onclick = () => (tokenClient ? loginPopup(true) : loginFallback('gia hạn token'));
  $('btn-expire').onclick = simulateExpiry;
  $('btn-logout').onclick = logout;
  // Như các nút khác: gọi ensureToken() trước mọi await để cửa sổ gia hạn không bị chặn (m3-2 mục 5).
  $('btn-check').onclick = () => {
    const wait = ensureToken();
    wait.then(checkDrive, (e) => { $('drive-result').innerHTML = `<p class="warn">${esc(e.message)}</p>`; log('Kiểm tra: ' + e.message); });
  };
  $('btn-copy-log').onclick = async () => {
    try { await navigator.clipboard.writeText($('log').textContent); log('Đã chép nhật ký.'); }
    catch (_) { log('Không chép được, hãy bôi đen và chép tay.'); }
  };
  $('btn-clear-log').onclick = () => { localStorage.removeItem(LOG_KEY); renderLog([]); };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => log('Service worker lỗi: ' + e.message));
  }
  log(`Mở app (${isStandalone() ? 'đã cài' : 'trình duyệt'}, ${navigator.userAgent.match(/iPhone|iPad|Android|Mac|Windows/)?.[0] || 'khác'}).`);
  loadGis();
}
init();
