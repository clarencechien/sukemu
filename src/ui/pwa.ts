/* PWA(handoff M5):SW 註冊與自動更新、安裝入口、iOS 加入主畫面提示。
   安裝後以 standalone 開啟,網址列隱藏。 */

import { whenIdle } from './busy';

/** 背景輪詢間隔:已安裝的 PWA 可能好幾天都不重新導覽,靠這個才會發現新版 */
const UPDATE_EVERY_MS = 30 * 60 * 1000;
const RELOADED_KEY = 'sukemu.justUpdated';

export function initPwa() {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    addEventListener('load', () => setupServiceWorker());
  }
  // 上一輪自動更新後的重載:讓使用者知道畫面為什麼閃了一下
  if (sessionStorage.getItem(RELOADED_KEY)) {
    sessionStorage.removeItem(RELOADED_KEY);
    notify('已更新到最新版本');
  }
  setupInstall();
}

/* ── SW 註冊 + 自動更新 ─────────────────────────
   流程:sw.js 用 skipWaiting + claim 讓新版立刻接管 → 瀏覽器發 controllerchange
   → 這裡在「閒置時」重載頁面,讓已載入的舊 JS/CSS 也換成新版。
   不重載的話,SW 換了但畫面還是舊的 bundle,等於沒更新。 */
async function setupServiceWorker() {
  /* 首次安裝的接管(本來就沒有 controller)不該重載,但這個旗標必須「用完就翻」:
     寫成頁面載入時的固定快照的話,首載那次接管後它永遠是 false,
     之後真的有新版也會被這道守衛擋掉——等於自動更新完全失效(實測踩過)。 */
  let hadController = !!navigator.serviceWorker.controller;
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    if (reloading) return;
    reloading = true;
    // 翻譯進行中就等它做完:結果還沒進 IndexedDB,這時重載會整份丟掉
    whenIdle(() => {
      sessionStorage.setItem(RELOADED_KEY, '1');
      location.reload();
    });
  });

  try {
    // updateViaCache: 'none' —— 連 sw.js 本身都不吃 HTTP 快取,否則會拿到舊的註冊腳本
    const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    const check = () => reg.update().catch(() => {});
    // 回到前景時查一次(PWA 最常見的使用形態:切出去、隔天切回來)
    addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
    setInterval(check, UPDATE_EVERY_MS);
  } catch {
    /* 註冊失敗不影響 app 本體運作 */
  }
}

/* ── 安裝入口 ───────────────────────────────── */
function setupInstall() {
  const btn = document.getElementById('installBtn') as HTMLButtonElement;
  let deferred: (Event & { prompt(): Promise<void> }) | null = null;

  addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e as typeof deferred & Event;
    btn.classList.remove('hidden');
  });
  btn.onclick = async () => {
    await deferred?.prompt();
    deferred = null;
    btn.classList.add('hidden');
  };
  addEventListener('appinstalled', () => btn.classList.add('hidden'));

  // iOS Safari 沒有 beforeinstallprompt,給文字指引
  const standalone =
    matchMedia('(display-mode: standalone)').matches ||
    ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone);
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) {
    document.getElementById('iosHint')!.classList.remove('hidden');
  }
}

/** 借用進度列顯示一則短訊息(沿用既有元件,不另外做 toast) */
function notify(msg: string) {
  const box = document.getElementById('progress');
  const text = document.getElementById('progressText');
  if (!box || !text) return;
  box.dataset.err = 'false';
  text.textContent = msg;
  box.classList.remove('hidden');
  setTimeout(() => box.classList.add('hidden'), 2600);
}
