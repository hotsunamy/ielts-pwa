// Service worker: chỉ lưu vỏ app (HTML, CSS, JS, icon) để mở nhanh và cài được.
// Không đụng tới request gửi Google/Drive. Cache PDF (ielts-pdf-*) do pdfsource.js quản lý, không xóa ở đây.
const VERSION = 'm3-3';
const VENDOR = 'vendor-pdfjs-4.10.38';   // cache riêng, không bị xóa khi đổi VERSION
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'config.js', 'recognize.js', 'library.js', 'sections.js', 'pdfindex.js', 'pdfsource.js', 'viewer.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== VENDOR && !k.startsWith('ielts-pdf-')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Mạng trước, mất mạng thì dùng bản đã lưu. Bỏ qua mọi request khác origin.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Thư viện pdf.js đặt trong vendor/ có số phiên bản trong đường dẫn, không đổi nữa: lấy cache trước, khỏi tải lại 1,8 MB.
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.open(VENDOR).then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }))));
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
