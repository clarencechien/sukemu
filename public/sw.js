/* 離線殼 + 自動更新(handoff M5)。
   快取策略三分:
     導覽          網路優先(拿得到新版就用新版,離線才退快取殼)
     /assets/ 雜湊  快取優先(檔名帶 hash,內容不可能變)
     其他同源      stale-while-revalidate(先給快取、背景更新)——
                   icons/manifest 這類固定檔名才不會永遠卡在舊版
   /api/ 一律不快取。
   更新流程:skipWaiting + claim 讓新版立刻接管,前端收到 controllerchange
   後在閒置時自動重載(見 src/ui/pwa.ts)。 */
/* __BUILD_ID__ 由 vite.config.ts 的 sw-build-id plugin 在建置時填入 index.html 的雜湊。
   它讓 sw.js 的位元組隨每次改版而變——沒有這行,瀏覽器不會發現有新 SW,
   已安裝的 PWA 就永遠停在舊版。順帶讓快取名逐版更替,舊快取在 activate 被清掉。 */
const BUILD = '__BUILD_ID__';
const CACHE = `sukemu-${BUILD}`;
const SHELL = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** 前端按下「立即更新」時可主動催promote(保留給日後手動更新 UI) */
self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

const putIfOk = (req, res) => {
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy));
  }
  return res;
};

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // 導覽:網路優先,離線退快取殼
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(res => putIfOk('/', res)).catch(() => caches.match('/')),
    );
    return;
  }

  // 雜湊資產:內容不可變,快取優先
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => putIfOk(e.request, res))),
    );
    return;
  }

  // 其他同源(icons、manifest…):先給快取,背景抓新的回填
  e.respondWith(
    caches.match(e.request).then(hit => {
      const fresh = fetch(e.request).then(res => putIfOk(e.request, res)).catch(() => hit);
      return hit || fresh;
    }),
  );
});
