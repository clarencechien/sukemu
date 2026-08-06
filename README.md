# sukemu すけむ

拍一張照或上傳一張圖,sukemu 把上面的外文翻成台灣正體中文,用一層透明標註疊回原圖上——不重繪、不遮蔽,按住就能看原圖。

**透ける**(sukeru,穿透、透明)+ mu。與 [manemu](https://manemu.ai-apps.work/) 同一個命名家族與產品家族(manemu 是紅,sukemu 是青)。

## 開發

```bash
npm install
npm run dev      # 開發伺服器
npm run build    # tsc --noEmit + vite build
npm run preview  # 預覽 build 結果
```

Vanilla TS + Vite,無框架。目前為 M1 靜態骨架:假資料驅動,無後端;登入頁的 Google 登入為佔位,點擊直接進入示範。

## 結構

- `src/types.ts` — 資料契約(`Block` / `Result`),欄位名前後端共用,不可改
- `src/data/samples.ts` — M1 示範資料(座標為手工標註)
- `src/ui/login.ts` — 登入頁(與 manemu 同構;M4 接 Google OIDC + 受邀名單 + Turnstile)
- `src/ui/viewer.ts` — 疊層譯讀器:A 疊字 / C 註解 / 標點 / 隱藏,按住看原圖,譯文就地編輯
- `src/styles/` — tokens(§8 視覺規格)、base、login、viewer

## 視覺紀律

橘紅(`--hot`)只給譯文,不做按鈕、標題、裝飾——使用者要能一眼分辨「哪些字是 sukemu 加上去的」。品牌與 HUD 用青(`--cool: #41C9FF`)。
