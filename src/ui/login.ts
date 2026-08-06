/* 登入頁。M1 寫死版:輸入 Email → Worker 比對 R2 白名單,發 HttpOnly cookie。
   不在名單者自動記入等候名單並顯示 #waitNotice(與 manemu 同機制)。
   M4 換成 Google OIDC + Turnstile,只換「email 怎麼來」,白名單流程不動。 */

import { api, ApiError } from '../api';

const enterApp = () => {
  document.body.dataset.screen = 'app';
};

export function initLogin() {
  const form = document.getElementById('ssoForm') as HTMLFormElement;
  const emailEl = document.getElementById('email') as HTMLInputElement;
  const btn = document.getElementById('ssoBtn') as HTMLButtonElement;
  const waitNotice = document.getElementById('waitNotice')!;
  const err = document.getElementById('loginErr')!;

  form.addEventListener('submit', async e => {
    e.preventDefault();
    btn.disabled = true;
    err.classList.add('hidden');
    waitNotice.classList.add('hidden');
    try {
      await api.login(emailEl.value);
      enterApp();
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

  (document.getElementById('demoBtn') as HTMLButtonElement).onclick = enterApp;

  // 已有有效 cookie 就直接進 App
  api.me().then(enterApp).catch(() => {});
}
