/* 翻譯紀錄面板:瀏覽本機 IndexedDB 裡翻過的內容,點開重看、可刪除。
   紀錄只存在裝置上(§9 立場:譯文不落地伺服器)。 */

import { docStore, recordIds, type DocRecord } from '../db';
import type { Viewer } from './viewer';

const $ = (id: string) => document.getElementById(id)!;

let doRefresh: () => void = () => {};
/** 新增紀錄後呼叫;面板開著才重畫 */
export const refreshHistory = () => doRefresh();

export function initHistory(viewer: Viewer) {
  const panel = $('histPanel');
  const list = $('histList');
  const count = $('histCount');
  let urls: string[] = [];

  const close = () => {
    panel.classList.add('hidden');
    urls.forEach(u => URL.revokeObjectURL(u));
    urls = [];
  };
  ($('histBtn') as HTMLButtonElement).onclick = () => {
    panel.classList.remove('hidden');
    render();
  };
  ($('histClose') as HTMLButtonElement).onclick = close;
  panel.addEventListener('click', e => {
    if (e.target === panel) close();
  });

  async function render() {
    let recs: DocRecord[] = [];
    try {
      recs = await docStore.list();
    } catch {
      /* 私密模式等情況拿不到 IndexedDB,顯示空清單 */
    }
    count.textContent = recs.length ? `${recs.length} 筆・只存在此裝置` : '';
    urls.forEach(u => URL.revokeObjectURL(u));
    urls = [];
    if (!recs.length) {
      list.innerHTML = '<div class="histEmpty">還沒有翻譯紀錄——拍一張看看。<br>紀錄只存在這台裝置上。</div>';
      return;
    }
    list.innerHTML = '';
    recs.forEach(rec => {
      const u = URL.createObjectURL(rec.thumb);
      urls.push(u);
      const when = new Date(rec.at).toLocaleString('zh-TW', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const item = document.createElement('div');
      item.className = 'histItem';
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      // rec.lang 來自模型,而且這是**重播**:注入過一次的紀錄存進 IndexedDB 之後,
      // 每次從「紀錄」開啟都會再注入一次。所以這裡不拼字串 —— .m 那格改填 textContent。
      item.innerHTML = `<img alt="" src="${u}"><div class="histTx"><div class="t"></div>
        <div class="m"></div></div>
        <button class="histDel">刪除</button>`;
      (item.querySelector('.t') as HTMLElement).textContent = rec.blocks[0]?.zh || rec.name;
      (item.querySelector('.m') as HTMLElement).textContent =
        `${rec.lang} · ${rec.blocks.length} 塊 · ${when}`;
      item.onclick = e => {
        if ((e.target as HTMLElement).closest('.histDel')) {
          if (confirm('刪除這筆紀錄?')) docStore.remove(rec.id!).then(render);
          return;
        }
        openRecord(rec);
        close();
      };
      list.appendChild(item);
    });
  }

  function openRecord(rec: DocRecord) {
    const result = { name: rec.name, lang: rec.lang, blocks: rec.blocks };
    recordIds.set(result, rec.id!);
    viewer.addDoc({ src: URL.createObjectURL(rec.image), result });
  }

  doRefresh = () => {
    if (!panel.classList.contains('hidden')) render();
  };
}
