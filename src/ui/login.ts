/* 登入頁。兩種模式由 /api/config 決定:
   - oidc:表單原生 POST /auth/login → Google 授權(Turnstile 有設就顯示);與 manemu 同機制
   - dev:未設定 GOOGLE_CLIENT_ID 時的開發用 Email 直登(比對白名單)
   不在名單者:OIDC 回跳 /?waitlist=1、dev 回 403 waitlist → 顯示等候名單卡。 */

import { api, ApiError, type Me } from '../api';

const $ = (id: string) => document.getElementById(id)!;
const enterApp = () => {
  document.body.dataset.screen = 'app';
};

function applyMe(me: Me) {
  const usage = $('usage');
  usage.textContent = me.limitImages > 0 ? `${me.usedImages}/${me.limitImages} 張` : `${me.usedImages} 張`;
  if (me.isAdmin) $('adminBtn').classList.remove('hidden');
  enterApp();
}

/** 翻譯完成後更新頂列用量 */
export function refreshUsage() {
  api.me().then(me => {
    $('usage').textContent = me.limitImages > 0 ? `${me.usedImages}/${me.limitImages} 張` : `${me.usedImages} 張`;
  }).catch(() => {});
}

export function initLogin() {
  const form = $('ssoForm') as HTMLFormElement;
  const emailEl = $('email') as HTMLInputElement;
  const btn = $('ssoBtn') as HTMLButtonElement;
  const waitNotice = $('waitNotice');
  const err = $('loginErr');
  let oidc = false;

  // OIDC 回跳:不在名單 → 顯示等候名單卡
  if (new URLSearchParams(location.search).get('waitlist') === '1') {
    waitNotice.classList.remove('hidden');
    history.replaceState(null, '', '/');
  }

  api.config().then(cfg => {
    if (cfg.mode !== 'oidc') return; // dev 模式維持 Email 直登
    oidc = true;
    emailEl.classList.add('hidden');
    emailEl.required = false;
    form.method = 'POST';
    form.action = '/auth/login';
    btn.textContent = '使用 Google 登入';
    if (cfg.turnstileSiteKey) {
      $('tsWidget').innerHTML = `<div class="cf-turnstile" data-sitekey="${cfg.turnstileSiteKey}" data-theme="dark"></div>`;
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      s.async = true;
      document.head.appendChild(s);
    }
  }).catch(() => {});

  form.addEventListener('submit', async e => {
    if (oidc) return; // 原生 POST /auth/login → 302 Google
    e.preventDefault();
    btn.disabled = true;
    err.classList.add('hidden');
    waitNotice.classList.add('hidden');
    try {
      await api.login(emailEl.value);
      api.me().then(applyMe).catch(enterApp);
    } catch (ex) {
      if (ex instanceof ApiError && ex.waitlist) {
        waitNotice.classList.remove('hidden');
      } else {
        err.textContent = ex instanceof Error ? ex.message : '登入失敗,請再試一次';
        err.classList.remove('hidden');
      }
    } finally {
      btn.disabled = false;
    }
  });

  ($('demoBtn') as HTMLButtonElement).onclick = enterApp;
  ($('adminBtn') as HTMLButtonElement).onclick = () => (location.href = '/admin');

  // 已有有效 session 就直接進 App
  api.me().then(applyMe).catch(() => {});
}
