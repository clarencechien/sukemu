/* 拍照 / 上傳 / 貼上 → P1(視覺趟)→ 疊回原圖 → P2(在地化)就地更新。
   進度分段(handoff §5):上傳中 → 讀取版面・翻譯 → 在地化。
   影像在裝置端縮到長邊 2048 再上傳;顯示用原圖 object URL,座標是正規化百分比所以不受影響。 */

import { api, ApiError } from '../api';
import type { Viewer } from './viewer';

const MAX_EDGE = 2048;
const $ = (id: string) => document.getElementById(id)!;

export function initCapture(viewer: Viewer) {
  const fileEl = $('file') as HTMLInputElement;
  const progress = $('progress');
  const progressText = $('progressText');
  let busy = false;
  let failTimer: ReturnType<typeof setTimeout>;

  const show = (msg: string) => {
    clearTimeout(failTimer);
    progress.dataset.err = 'false';
    progressText.textContent = msg;
    progress.classList.remove('hidden');
  };
  const fail = (msg: string) => {
    progress.dataset.err = 'true';
    progressText.textContent = msg;
    progress.classList.remove('hidden');
    failTimer = setTimeout(() => progress.classList.add('hidden'), 5000);
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
      const { b64, mime, url } = await prep(file);
      show('讀取版面・翻譯');
      const result = await api.p1(b64, mime, name);
      if (!result.blocks.length) {
        fail('沒有偵測到可翻譯的文字');
        return;
      }
      viewer.addDoc({ src: url, result });
      show('在地化');
      const edits = await api.p2(result.lang, result.blocks);
      viewer.applyEdits(result, edits);
      done();
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

async function prep(file: File): Promise<{ b64: string; mime: string; url: string }> {
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

  const b64 = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res((r.result as string).split(',')[1]);
    r.onerror = () => rej(new Error('影像編碼失敗'));
    r.readAsDataURL(blob);
  });
  return { b64, mime, url };
}
