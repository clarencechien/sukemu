/* 模型檔位切換(ADR 0001 + 後記)。
   /api/config 的 allowModeToggle=false 時(現況:快速模式實測不合格)
   隱藏切換鈕、鎖定伺服器預設檔位,localStorage 裡的舊選擇一併忽略。
   lite 修好後把 var MODE_TOGGLE 打開,這裡不用改。 */

import { api, type ModelMode } from '../api';

const KEY = 'sukemu.modelMode';
let mode: ModelMode = (localStorage.getItem(KEY) as ModelMode) || 'accurate';
let locked = false;

export const modelMode = () => mode;

export function initMode() {
  const btn = document.getElementById('modeBtn') as HTMLButtonElement;
  const paint = () => {
    btn.textContent = mode === 'accurate' ? '⚖ 精準' : '⚡ 快速';
    btn.dataset.mode = mode;
    btn.title =
      mode === 'accurate'
        ? '精準模式:框準度優先,成本較高。點擊切回快速'
        : '快速模式:成本優先。框歪了就切到精準再翻一次';
  };

  api.config().then(cfg => {
    if (!cfg.allowModeToggle) {
      locked = true;
      mode = cfg.defaultModelMode;
      btn.classList.add('hidden');
      paint();
      return;
    }
    if (!localStorage.getItem(KEY)) mode = cfg.defaultModelMode;
    paint();
  }).catch(() => {});

  btn.onclick = () => {
    if (locked) return;
    mode = mode === 'accurate' ? 'fast' : 'accurate';
    localStorage.setItem(KEY, mode);
    paint();
  };
  paint();
}
