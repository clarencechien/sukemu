# sukemu すけむ

拍一張照或上傳一張圖,sukemu 把上面的外文翻成台灣正體中文,用一層透明標註疊回原圖上——不重繪、不遮蔽,按住就能看原圖。

**透ける**(sukeru,穿透、透明)+ mu。與 [manemu](https://manemu.ai-apps.work/) 同一個命名家族與產品家族(manemu 是紅,sukemu 是青)。

規格見 [`docs/handoff.md`](docs/handoff.md);互動原型(規格書)見 [`docs/mockup/acetate-lens.html`](docs/mockup/acetate-lens.html);**OIDC/配額/價格設定見 [`docs/oidc-setup.md`](docs/oidc-setup.md)**。

## 部署(Cloudflare Workers)

```bash
npm install
npx wrangler r2 bucket create sukemu          # 一次性
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID      # Google OAuth,見 docs/oidc-setup.md
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET        # openssl rand -hex 32
npm run deploy                                # build + wrangler deploy
```

沒設 `GOOGLE_CLIENT_ID` 時自動退回**開發用 Email 直登**(比對白名單、不經 Google)——本機開發與初次部署跑通用;設好後登入頁自動變成「使用 Google 登入」。

## 認證・名單・配額(與 manemu 同機制)

- **Google OIDC** 全 server-side(authorization code + JWKS 驗 id_token),HMAC 簽章 session cookie(7 天)
- **白名單** R2 `config/allowlist.json`,支援 `["a@x.com"]` 或 `{"a@x.com":"pro","b@x.com":100}`(級別名或每日張數),**改檔即生效**;不在名單的登入自動記入等候名單
- **管理頁 `/admin`**(僅 `ADMIN_EMAILS`):等候名單一鍵核准、改額度、看每人今日用量與估算成本
- **配額**:每人一個 Durable Object 計「每日張數」,分級在 var `QUOTA_TIERS`(`{"admin":0,"pro":200,"beta":30,"trial":5}`,0 = 無上限),台灣時間早上 8 點重置;P1 成功才扣,失敗不計

## 價格(TWD)

Worker 用 Gemini 回傳的實際 token 數即時估算:翻完提示「本次約 NT$X」、`/admin` 看每人當日累計。單價表按模型內建,**換 `GEMINI_MODEL` 自動換價**(可用 var `MODEL_PRICES` 覆寫)。

以匯率 31.5 估算,一張的成本:

| 情境 | `gemini-3.5-flash`(預設) | `gemini-3.6-flash` | `gemini-3.5-flash-lite` |
|---|---|---|---|
| 簡單招牌(2–3 塊) | NT$0.76 | NT$0.56 | NT$0.20 |
| 一般菜單(~11 塊) | NT$1.89 | NT$1.37 | NT$0.51 |
| 複雜資訊圖(30+ 塊) | NT$5.43 | NT$3.86 | NT$1.48 |

**P1 佔 80–92% 的成本,其中八成以上是輸出+thinking**,影像輸入不到一成。換模型前先用 `scripts/ab-models.mjs` 跑同一張圖比框準度與成本。細節見 [`docs/oidc-setup.md`](docs/oidc-setup.md) §6。

## 本機開發

```bash
npm run dev:worker   # wrangler dev(API + 本機模擬 R2/DO),port 8787;dev 模式 Email 直登
npm run dev          # vite dev server,/api 代理到 8787
```

真的打 Gemini 需要 `.dev.vars`(不進版控):`GEMINI_API_KEY=...`

## 架構

- **前端** Vanilla TS + Vite,無框架;登入頁與 manemu 同構,深色青色系(`#41C9FF`)
- **Worker**(`worker/`)Workers Assets 服靜態檔 + API:
  - `auth.ts` — OIDC、HMAC session、白名單分級解析(每次請求重算,名單熱更新)
  - `quota.ts` — `QuotaCounter` DO:每人今日張數 / token / 估算 NT$
  - `admin.ts` — `/api/admin/*`:名單與額度管理(session + admin 雙閘門)
  - `gemini.ts` — `POST /api/p1` 視覺趟(REST `generateContent`、media_resolution HIGH、結構化輸出);`POST /api/p2` 文字趟(只餵 JSON,在地化+譯註,重試不重付影像 token)
- **資料契約** `src/types.ts`(`Block` / `Result`),欄位名前後端共用,不可改;座標一律正規化百分比;`v?: boolean` 標直排文字(前端以 `writing-mode: vertical-rl` 呈現)
- **結果保存** `src/db.ts` 裝置端 IndexedDB(§9:譯文不落地伺服器):每筆存壓縮影像 + 縮圖 + blocks + 影像 hash。上傳前先以 hash 查紀錄,**同一張圖翻過就直接開啟、不重打 API**;「紀錄」面板可瀏覽、重開、刪除;譯文編輯自動回存
- **PWA**(M5)`public/manifest.json` + `public/sw.js`(離線殼:導覽網路優先、雜湊資產快取優先、`/api/` 不快取)+ `public/icons/`;安裝後 standalone 隱藏網址列。登入頁有安裝按鈕(Android/桌面)與 iOS 加入主畫面指引

## 視覺紀律

橘紅(`--hot`)只給譯文,不做按鈕、標題、裝飾——使用者要能一眼分辨「哪些字是 sukemu 加上去的」。品牌與 HUD 用青(`--cool`)。

## 尚未做(依 handoff 里程碑)

- OpenCC `cn→twp` 收尾(目前靠 P2 prompt 保證台灣正體)
- R2 影像暫存生命週期(目前影像不落地,直接 inline 給 Gemini,天然符合「完成即刪」)
- 分塊高解析與 Meta 注入(M6)、直排的透視變形 quad(§11)
