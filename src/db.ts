/* 結果保存(handoff §4 決策):裝置端 IndexedDB,伺服器不留譯文。
   每筆記錄 = 影像(裝置端壓縮版)+ 縮圖 + 譯文 blocks + 影像內容 hash。
   hash 用來去重:同一張圖再上傳時直接開啟紀錄,不重新翻譯。 */

import type { Block, Result } from './types';

export type DocRecord = {
  id?: number;
  /** 壓縮後影像的 SHA-256,上傳前先查,翻過就不再打 API */
  hash: string;
  /** ISO 時間 */
  at: string;
  name: string;
  lang: string;
  blocks: Block[];
  /** 裝置端壓縮後的影像(與上傳給 Gemini 的同一份) */
  image: Blob;
  /** 清單縮圖 */
  thumb: Blob;
};

const DB_NAME = 'sukemu';
const STORE = 'docs';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('hash', 'hash');
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function tx<T>(dbMode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    db =>
      new Promise<T>((res, rej) => {
        const r = fn(db.transaction(STORE, dbMode).objectStore(STORE));
        r.onsuccess = () => res(r.result as T);
        r.onerror = () => rej(r.error);
      }),
  );
}

export const docStore = {
  save: (rec: Omit<DocRecord, 'id'>) => tx<number>('readwrite', s => s.add(rec)),
  async updateBlocks(id: number, blocks: Block[]) {
    const rec = await tx<DocRecord | undefined>('readonly', s => s.get(id));
    if (!rec) return;
    rec.blocks = blocks;
    await tx('readwrite', s => s.put(rec));
  },
  async findByHash(hash: string) {
    const hits = await tx<DocRecord[]>('readonly', s => s.index('hash').getAll(hash));
    return hits[0] ?? null;
  },
  async list() {
    const all = await tx<DocRecord[]>('readonly', s => s.getAll());
    return all.sort((a, b) => b.at.localeCompare(a.at));
  },
  remove: (id: number) => tx<void>('readwrite', s => s.delete(id)),
};

/** 畫面上的 Result ↔ 紀錄 id 的對應(重開或存檔後建立) */
export const recordIds = new WeakMap<Result, number>();

/* 譯文就地編輯 → 去彈跳回存本機 */
const timers = new WeakMap<Result, ReturnType<typeof setTimeout>>();
export function persistEdits(result: Result) {
  const id = recordIds.get(result);
  if (id == null) return;
  clearTimeout(timers.get(result));
  timers.set(
    result,
    setTimeout(() => {
      docStore.updateBlocks(id, result.blocks).catch(() => {});
    }, 600),
  );
}
