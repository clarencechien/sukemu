/* 拍照 / 上傳 / 貼上 → 查本機紀錄(hash 去重,翻過不再打 API)
   → P1(視覺趟)→ 疊回原圖 → 存 IndexedDB → P2(在地化)就地更新並回存。
   進度分段(handoff §5):上傳中 → 讀取版面・翻譯 → 在地化。
   影像在裝置端縮到長邊 2048 再上傳;顯示用原圖 object URL,座標是正規化百分比所以不受影響。 */

import { api, ApiError } from '../api';
import { docStore, recordIds } from '../db';
import { refreshHistory } from './history';
import { refreshUsage } from './login';
import type { Viewer } from './viewer';

const MAX_EDGE = 2048;
const THUMB_W = 240;
const $ = (id: string) => document.getElementById(id)!;

export function initCapture(viewer: Viewer) {
  const fileEl = $('file') as HTMLInputElement;
  const progress = $('progress');
  const progressText = $('progressText');
  let busy = false;
  let hideTimer: ReturnType<typeof setTimeout>;

  const show = (msg: string) => {
    clearTimeout(hideTimer);
    progress.dataset.err = 'false';
    progressText.textContent = msg;
    progress.classList.remove('hidden');
  };
  const info = (msg: string) => {
    show(msg);
    hideTimer = setTimeout(() => progress.classList.add('hidden'), 2600);
  };
  const fail = (msg: string) => {
    clearTimeout(hideTimer);
    progress.dataset.err = 'true';
    progressText.textContent = msg;
    progress.classList.remove('hidden');
    hideTimer = setTimeout(() => progress.classList.add('hidden'), 5000);
  };
  const done = () => progress.classList.add('hidden');

  ($('shoot') as HTMLButtonElement).onclick = () => fileEl.click();
  fileEl.onchange = () => {
    const f = fileEl.files?.[0];
    if (f) handle(f, f.name);
    fileEl.value = '';
  };
  addEventListener('paste', e => {
    if (document.body.dataset.screen !== 'app') return;
    const item = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'));
    const f = item?.getAsFile();
    if (f) handle(f, '貼上的圖片');
  });

  async function handle(file: File, name: string) {
    if (busy) return;
    busy = true;
    try {
      show('上傳中');
      const { b64, mime, url, blob, thumb } = await prep(file);

      // 同一張圖翻過就直接開紀錄,不重新上傳翻譯
      const hash = await sha256(blob);
      try {
        const hit = await docStore.findByHash(hash);
        if (hit) {
          const result = { name: hit.name, lang: hit.lang, blocks: hit.blocks };
          recordIds.set(result, hit.id!);
          viewer.addDoc({ src: url, result });
          info('這張已翻過,直接從紀錄開啟');
          return;
        }
      } catch {
        /* IndexedDB 不可用時照常走翻譯 */
      }

      show('讀取版面・翻譯');
      const { result, usage: u1 } = await api.p1(b64, mime, name);
      if (!result.blocks.length) {
        fail('沒有偵測到可翻譯的文字');
        return;
      }
      viewer.addDoc({ src: url, result });

      // P1 一成功就先存,P2 失敗也留得住結果
      let id: number | undefined;
      try {
        id = await docStore.save({
          hash,
          at: new Date().toISOString(),
          name: result.name,
          lang: result.lang,
          blocks: result.blocks,
          image: blob,
          thumb,
        });
        recordIds.set(result, id);
        refreshHistory();
      } catch {
        /* 存不進去(私密模式等)不影響翻譯流程 */
      }

      show('在地化');
      const { edits, usage: u2 } = await api.p2(result.lang, result.blocks);
      viewer.applyEdits(result, edits);
      if (id != null) docStore.updateBlocks(id, result.blocks).catch(() => {});
      const twd = (u1?.twd ?? 0) + (u2?.twd ?? 0);
      if (twd > 0) info(`完成 · 本次約 NT$${twd.toFixed(2)}`);
      else done();
      refreshUsage();
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 401) {
        fail('示範模式無法翻譯 — 請回登入頁以受邀 Email 登入');
      } else {
        fail(ex instanceof Error ? ex.message : '處理失敗,請再試一次');
      }
    } finally {
      busy = false;
    }
  }
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function prep(
  file: File,
): Promise<{ b64: string; mime: string; url: string; blob: Blob; thumb: Blob }> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('無法讀取圖片'));
    img.src = url;
  });

  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  let blob: Blob = file;
  let mime = file.type || 'image/jpeg';
  if (scale < 1 || !['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.naturalWidth * scale);
    cv.height = Math.round(img.naturalHeight * scale);
    cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
    blob = await new Promise<Blob>((res, rej) =>
      cv.toBlob(b => (b ? res(b) : rej(new Error('影像壓縮失敗'))), 'image/jpeg', 0.92),
    );
    mime = 'image/jpeg';
  }

  const tc = document.createElement('canvas');
  const ts = THUMB_W / img.naturalWidth;
  tc.width = THUMB_W;
  tc.height = Math.max(1, Math.round(img.naturalHeight * ts));
  tc.getContext('2d')!.drawImage(img, 0, 0, tc.width, tc.height);
  const thumb = await new Promise<Blob>((res, rej) =>
    tc.toBlob(b => (b ? res(b) : rej(new Error('縮圖產生失敗'))), 'image/jpeg', 0.8),
  );

  const b64 = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res((r.result as string).split(',')[1]);
    r.onerror = () => rej(new Error('影像編碼失敗'));
    r.readAsDataURL(blob);
  });
  return { b64, mime, url, blob, thumb };
}
