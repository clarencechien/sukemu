/* 模型檔位切換(ADR 0001)。
   預設值由 Worker 的 DEFAULT_MODE 決定(目前 fast);使用者可就地切成精準,
   把同一張難圖重翻一次,不必重新部署。選擇記在 localStorage。 */

import { api, type ModelMode } from '../api';

const KEY = 'sukemu.modelMode';
let mode: ModelMode = (localStorage.getItem(KEY) as ModelMode) || 'fast';

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

  // 伺服器預設優先於「使用者還沒選過」的情況
  if (!localStorage.getItem(KEY)) {
    api.config().then(cfg => {
      mode = cfg.defaultModelMode;
      paint();
    }).catch(() => {});
  }

  btn.onclick = () => {
    mode = mode === 'accurate' ? 'fast' : 'accurate';
    localStorage.setItem(KEY, mode);
    paint();
  };
  paint();
}
