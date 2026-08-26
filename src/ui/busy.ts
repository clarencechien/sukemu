/* 「App 正在做事」的共用訊號。
   目前只有翻譯流程會設,用途是讓 PWA 自動更新不要在翻到一半時重載頁面
   (結果還沒寫進 IndexedDB,重載就沒了)。 */

let busy = false;
const waiters: (() => void)[] = [];

export const isBusy = () => busy;

export function setBusy(v: boolean) {
  busy = v;
  if (!v) for (const fn of waiters.splice(0)) fn();
}

/** 現在閒著就馬上跑,正忙就等這件事做完 */
export function whenIdle(fn: () => void) {
  if (busy) waiters.push(fn);
  else fn();
}
