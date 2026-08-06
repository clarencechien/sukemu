/* 登入頁。M1 無後端:攔截表單直接進 App(假資料)。
   M4 接上 Google OIDC + 受邀名單 + Turnstile 後,移除攔截、
   讓表單真的 POST /auth/login(與 manemu 同機制),#waitNotice 給不在名單者。 */

const enterApp = () => {
  document.body.dataset.screen = 'app';
  sessionStorage.setItem('sukemu.screen', 'app');
};

export function initLogin() {
  const form = document.getElementById('ssoForm') as HTMLFormElement;
  form.addEventListener('submit', e => {
    e.preventDefault();
    enterApp();
  });
  (document.getElementById('demoBtn') as HTMLButtonElement).onclick = enterApp;

  if (sessionStorage.getItem('sukemu.screen') === 'app') enterApp();
}
