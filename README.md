# sukemu すけむ

拍一張照或上傳一張圖,sukemu 把上面的外文翻成台灣正體中文,用一層透明標註疊回原圖上——不重繪、不遮蔽,按住就能看原圖。

**透ける**(sukeru,穿透、透明)+ mu。與 [manemu](https://manemu.ai-apps.work/) 同一個命名家族與產品家族(manemu 是紅,sukemu 是青)。

規格見 [`docs/handoff.md`](docs/handoff.md);互動原型(規格書)見 [`docs/mockup/acetate-lens.html`](docs/mockup/acetate-lens.html)。

## 部署(Cloudflare Workers)

```bash
npm install
npx wrangler r2 bucket create sukemu     # 一次性
npx wrangler secret put GEMINI_API_KEY   # 開發者只需要維護這把 key
npm run deploy                           # build + wrangler deploy
```

- **白名單**:R2 `config/allowlist.json`(JSON 字串陣列)。物件不存在時第一次請求會自動以預設名單 `["clarence.chien@gmail.com"]` 建立。修改:
  ```bash
  echo '["clarence.chien@gmail.com","someone@example.com"]' > /tmp/allowlist.json
  npx wrangler r2 object put sukemu/config/allowlist.json --file /tmp/allowlist.json
  ```
- **等候名單**:不在名單的登入自動記到 R2 `config/waitlist.json`。
- **模型**:`wrangler.jsonc` 的 `GEMINI_MODEL` / `GEMINI_MODEL_P2`(P2 輸入小,值得換 Pro 級,見 handoff §13)。

## 本機開發

```bash
npm run dev:worker   # wrangler dev(API + 本機模擬 R2),port 8787
npm run dev          # vite dev server,/api 代理到 8787
```

真的打 Gemini 需要 `.dev.vars`(不進版控):`GEMINI_API_KEY=...`

## 架構

- **前端** Vanilla TS + Vite,無框架;登入頁與 manemu 同構,深色青色系(`#41C9FF`)
- **Worker**(`worker/`)Workers Assets 服靜態檔 + `/api/*`:
  - `POST /api/login` — Email 比對 R2 白名單,發 HttpOnly cookie(M1 寫死版;M4 換 Google OIDC + Turnstile)
  - `POST /api/p1` — 視覺趟:Gemini REST `generateContent`,media_resolution HIGH,回座標 + 原文 + 初譯(結構化輸出)
  - `POST /api/p2` — 文字趟:只餵 P1 的 JSON,在地化 + 譯註;失敗重試不用重付影像 token
- **資料契約** `src/types.ts`(`Block` / `Result`),欄位名前後端共用,不可改;座標一律正規化百分比

## 視覺紀律

橘紅(`--hot`)只給譯文,不做按鈕、標題、裝飾——使用者要能一眼分辨「哪些字是 sukemu 加上去的」。品牌與 HUD 用青(`--cool`)。

## 尚未做(依 handoff 里程碑)

- OpenCC `cn→twp` 收尾(目前靠 P2 prompt 保證台灣正體)
- 結果保存 IndexedDB、Durable Object 配額、R2 影像暫存生命週期(目前影像不落地,直接 inline 給 Gemini)
- Google OIDC + Turnstile(M4)、PWA(M5)、分塊高解析與 Meta 注入(M6)
