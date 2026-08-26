# sukemu すけむ

拍一張照或上傳一張圖,sukemu 把上面的外文翻成台灣正體中文,用一層透明標註疊回原圖上——不重繪、不遮蔽,按住就能看原圖。

**透ける**(sukeru,穿透、透明)+ mu。與 [manemu](https://manemu.ai-apps.work/) 同一個命名家族與產品家族(manemu 是紅,sukemu 是青)。

| 文件 | 內容 |
|---|---|
| [`docs/handoff.md`](docs/handoff.md) | 產品規格與決策(來源文件) |
| [`docs/mockup/acetate-lens.html`](docs/mockup/acetate-lens.html) | 互動原型 = 互動與視覺的規格書 |
| [`docs/oidc-setup.md`](docs/oidc-setup.md) | 一次性部署設定(OAuth、secrets、網域與安全、疑難排解) |
| [`docs/cf-security-baseline.md`](docs/cf-security-baseline.md) | **安全基線**:新專案從這開始;控制清單、正式/demo 標準、audit 紀錄 |
| [`docs/config.md`](docs/config.md) | 平常在調的旋鈕:名單、配額、模型檔位、價格 |
| [`docs/gemini-api-lessons.md`](docs/gemini-api-lessons.md) | Gemini API 教訓摘要與落地狀態(thinking 稅、id 對滑、保險絲) |
| [`docs/adr/`](docs/adr/) | 架構決策紀錄 |

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

**Turnstile 是選用的,但要設就得成對**(`TURNSTILE_SITE_KEY` var + `TURNSTILE_SECRET` secret)。只設一邊時 Worker 會自動停用挑戰並留 log 警告——因為前端渲染不出元件、後端卻要求 token,會讓登入 100% 失敗。詳見 [`docs/oidc-setup.md`](docs/oidc-setup.md) 的疑難排解。

`workers.dev` 與 preview URL 在 `wrangler.jsonc` 已關閉(`workers_dev: false` / `preview_urls: false`)——這兩種網址不經 zone,WAF 與 Rate Limiting 全繞過。對外一律走自訂網域。

## 認證・名單・配額(與 manemu 同機制)

- **Google OIDC** 全 server-side(authorization code + JWKS 驗 id_token),HMAC 簽章 session cookie(7 天)
- **白名單** R2 `config/allowlist.json`,支援 `["a@x.com"]` 或 `{"a@x.com":"pro","b@x.com":100}`(級別名或每日張數),**改檔即生效**;不在名單的登入自動記入等候名單
- **管理頁 `/admin`**(僅 `ADMIN_EMAILS`):等候名單一鍵核准、改額度、看每人今日用量與估算成本(操作見 [`docs/config.md`](docs/config.md))
- **配額(三道錢包保險絲)**:每日張數(分級 `QUOTA_TIERS`)+ 每人每日成本 `DAILY_TWD_LIMIT` + 全站每日 `GLOBAL_DAILY_TWD`(admin 也受限);P1/P2 都檢查,台灣時間早上 8 點重置,成功才扣、失敗不計。第四層在 Google 端:AI Studio Spend 頁的每專案上限請自行設定
- **未登入**只能看介面(登入頁的「看看介面 →」):所有 `/api/*` 一律 401,偽造 session cookie 過不了 HMAC;前端也不會假裝可用——按拍照直接提示登入,不開檔案選擇器

## 模型檔位與價格(TWD)

兩個模式,模型寫在 `wrangler.jsonc`(決策與實測數據見 [ADR 0001](docs/adr/0001-fast-accurate-model-modes.md)):

| 模式 | 模型 | 簡單招牌 | 一般菜單 | 複雜資訊圖 | 現況 |
|---|---|---|---|---|---|
| ⚖ **精準** | `gemini-3.6-flash` | NT$0.56 | NT$1.37 | NT$3.86 | **預設** |
| ⚡ 快速 | `gemini-3.5-flash-lite` | NT$0.20 | NT$0.51 | NT$1.48 | 停用(實測框漂移,`MODE_TOGGLE=off`) |

Worker 用 Gemini 回傳的實際 token 數即時估算:翻完提示「本次約 NT$X」、`/admin` 看每人當日累計。單價表按模型內建,**換模型自動換價**(可用 var `MODEL_PRICES` 覆寫)。**P1 佔 80–92% 的成本,其中八成以上是輸出+thinking**,影像輸入不到一成。換檔位前先用 `scripts/ab-models.mjs` 跑同一張圖比框準度與成本。細節見 [`docs/config.md`](docs/config.md)。

## 本機開發

```bash
npm run dev:worker   # wrangler dev(API + 本機模擬 R2/DO),port 8787
npm run dev          # vite dev server,/api 代理到 8787
npm run build        # tsc(前端 + worker)+ vite build
```

要真的打 Gemini 就建 `.dev.vars`(不進版控):`GEMINI_API_KEY=...`。
不設 `GOOGLE_CLIENT_ID` 時本機走 Email 直登,方便開發。

模型 A/B(需要真 key):

```bash
GEMINI_API_KEY=xxx node scripts/ab-models.mjs 照片.jpg
```

## 架構

- **前端** Vanilla TS + Vite,無框架;登入頁與 manemu 同構,深色青色系(`#41C9FF`)
- **Worker**(`worker/`)Workers Assets 服靜態檔 + API:
  - `auth.ts` — OIDC、HMAC session、白名單分級解析(每次請求重算,名單熱更新)
  - `quota.ts` — `QuotaCounter` DO:每人今日張數 / token / 估算 NT$
  - `admin.ts` — `/api/admin/*`:名單與額度管理(session + admin 雙閘門)
  - `gemini.ts` — `POST /api/p1` 視覺趟(REST `generateContent`、media_resolution HIGH、結構化輸出、thinking 維持預設);`POST /api/p2` 文字趟(只餵 JSON,在地化+譯註,`thinkingLevel: minimal`——A/B 實測 -81% token、快 4 倍;修訂帶原文回聲做對位驗證,防 index-keyed batch 的 id 對滑)
- **資料契約** `src/types.ts`(`Block` / `Result`),欄位名前後端共用,不可改;座標一律正規化百分比;`v?: boolean` 標直排文字(前端以 `writing-mode: vertical-rl` 呈現)
- **座標防呆** 模型常不照 prompt 回 0–100 百分比(lite 檔尤其會掉回 0–1000 的訓練慣例)。`normalizeBlocks()` 從數值範圍推回原始規格(0–1000 / 像素 / 0–1 小數)再換算,並用外框幾何夾住 `fs`——橫排字高 ≤ 框高、直排字寬 ≤ 框寬
- **結果保存** `src/db.ts` 裝置端 IndexedDB(§9:譯文不落地伺服器):每筆存壓縮影像 + 縮圖 + blocks + 影像 hash。上傳前先以「hash + 檔位」查紀錄,**同一張圖同一檔位翻過就直接開啟、不重打 API**;「紀錄」面板可瀏覽、重開、刪除;譯文編輯自動回存
- **PWA**(M5)`public/manifest.json` + `public/sw.js` + `public/icons/`;安裝後 standalone 隱藏網址列。登入頁有安裝按鈕(Android/桌面)與 iOS 加入主畫面指引
  - 快取三分:導覽網路優先、`/assets/` 雜湊檔快取優先、其餘同源 stale-while-revalidate(icons/manifest 才不會卡舊版);`/api/` 不快取
  - **自動更新**:建置時把 `index.html` 的雜湊注入 `sw.js`(`vite.config.ts` 的 `sw-build-id`)——沒這一步 `sw.js` 位元組不變,已安裝的 PWA 永遠收不到新版。回到前景與每 30 分鐘各查一次,新版接管後**在閒置時**自動重載(翻譯進行中會等它做完,避免結果還沒進 IndexedDB 就被沖掉),重載後顯示「已更新到最新版本」
- **型級** `--fs-micro`…`--fs-2xl` 一套階梯定在 `tokens.css`,元件不寫死字級。`--fs-micro`(12px)是硬下限;圖上的疊字不吃這套(它用 `--u` 隨圖寬縮放)
- **無內建示範圖** 空狀態是純 CSS 的 ghost 佔位(虛線板 + 淡色假菜單 + 兩塊疊字示意),零資產、零請求,且會跟著視覺語彙一起變

## 前端互動(原型即規格)

- **A 疊字 / C 註解 / 標點 / 隱藏** 四個模式;C 註解的選取項用 `order:-1` + `sticky` 頂到列首,**不用 `scrollIntoView`**(會造成畫面跳動)
- **按住看原圖** 三種入口:按鈕、長按圖片、按住 `O` 鍵
- **縮放** 桌面用滑桿或雙擊;手機/PWA 三種入口都有:滑桿(緊湊版)、雙指捏合、雙擊,上限 300%,放大後單指平移
- **譯文允許溢出**毛玻璃底——中譯常比原文長,裁掉就讀不到;可讀性靠白色光暈,深淺背景都成立
- 圖片尺寸由 JS 算好寫入 `style.width`,**不用 `max-width:100%`**(在彈性容器裡會與容器寬互相依賴,圖片會塌掉)

## 視覺紀律

橘紅(`--hot`)只給譯文,不做按鈕、標題、裝飾——使用者要能一眼分辨「哪些字是 sukemu 加上去的」。品牌與 HUD 用青(`--cool`)。

## 進度

M1 靜態骨架 → M2 上傳與 P1 → M3 P2 與譯註 → M4 認證與配額 → M5 PWA **已完成**。

尚未做:

- **§12 框準度 IoU 驗收**(十張真實照片人工標註)——最重要的一項,目前只做過模型 A/B 的目視對照
- 精準模式單張約 13 秒,仍超出 §12 的 10 秒目標。P2 降 minimal 已省下 ~4 秒;**剩下的大頭是 P1,而降 P1 thinking 這條路已實測確認走不通**(框會漂移,見 [ADR 0002](docs/adr/0002-per-pass-thinking-levels.md))→ 下一個方向是縮短 P1 輸出(座標精度、欄位精簡),那也同時省錢
- OpenCC `cn→twp` 收尾(目前靠 P2 prompt 保證台灣正體)
- M6 分塊高解析與 Meta 注入(GPS、session 詞彙累積)、直排的透視變形 quad(§11)
- R2 影像暫存生命週期(目前影像不落地,直接 inline 給 Gemini,天然符合「完成即刪」)
