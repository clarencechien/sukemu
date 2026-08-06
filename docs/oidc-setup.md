# Google OIDC・配額・價格 — 一次性設定

與 manemu 同一套機制(全 server-side OAuth + HMAC session cookie + R2 白名單熱更新)。
照順序做完,之後 push 即部署,日常只需要維護 GEMINI_API_KEY 與名單。

## 1. Google OAuth Client

1. [GCP Console](https://console.cloud.google.com/) → 建專案(或用現有的,manemu 同專案亦可)
2. **APIs & Services → OAuth consent screen**:
   - User type 選 **External**,填 app 名稱(sukemu)、支援 email
   - Scopes 只需要 `openid`、`email`(不用申請敏感 scope,不用送審)
   - 封測期間 Publishing status 維持 **Testing** 也可以——但要把測試者 email 加進 Test users;
     或直接 **Publish**(只要 email scope 不需要 Google 審查)
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type:**Web application**
   - Authorized redirect URIs:`https://<你的網域>/auth/callback`(例:`https://sukemu.ai-apps.work/auth/callback`)
4. 記下 **Client ID** 與 **Client secret**

## 2. Secrets(wrangler secret put,共 4 把)

```bash
npx wrangler secret put GEMINI_API_KEY        # Google AI Studio 的 API key
npx wrangler secret put GOOGLE_CLIENT_ID      # 上一步的 Client ID
npx wrangler secret put GOOGLE_CLIENT_SECRET  # 上一步的 Client secret
npx wrangler secret put SESSION_SECRET        # 隨機 32+ 字元:openssl rand -hex 32
```

> **沒設 GOOGLE_CLIENT_ID 時**,Worker 自動退回「開發用 Email 直登」(輸入 email 比對白名單,
> 不經 Google)。本機 `wrangler dev` 就是這個模式,方便開發;正式環境設好 secrets 後
> 登入頁自動變成「使用 Google 登入」。

## 3. R2 與部署

```bash
npx wrangler r2 bucket create sukemu   # 已建過就跳過
npm run deploy
```

白名單 `config/allowlist.json` 不存在時,第一次請求會自動以 `["clarence.chien@gmail.com"]` 建立。

## 4. 網域與安全(建議)

- `wrangler.jsonc` 的 `CANONICAL_HOST` 填正式網域(例 `sukemu.ai-apps.work`)→
  workers.dev 等非正式 host 一律 301/403(WAF 繞過洞封死)。留空 = 不檢查。
- **Turnstile(可選)**:Cloudflare Dashboard → Turnstile → 新增 widget →
  site key 填 `TURNSTILE_SITE_KEY` var、`npx wrangler secret put TURNSTILE_SECRET`。
  兩者設好後登入頁自動出現驗證、Worker 端強制驗;沒設就略過。
- Rate Limiting(Free 1 條)花在 `/auth/*`;Bot Fight Mode、Always Use HTTPS 免費全開。

## 5. 名單・分級・調額度

**管理頁 `/admin`**(僅 `ADMIN_EMAILS` 內的帳號):
- **等候名單**:不在名單的人登入 → 自動記錄 → 一鍵「核准(選級別)」或「忽略」,核准後對方下一次操作立即生效
- **已核准名單**:改級別、填自訂張數、移除;並顯示每人**今日已用張數與估算成本(NT$)**

**分級**(var `QUOTA_TIERS`,單位:張/日,0 = 無上限):

```json
{"admin": 0, "pro": 200, "beta": 30, "trial": 5}
```

- `ADMIN_EMAILS`(逗號分隔)裡的帳號一律 admin 級,不可從 UI 移除(防手滑鎖死自己)
- 名單值可以是級別名或直接給張數:`{"a@x.com": "pro", "b@x.com": 100}`
- 資料就是 R2 的 `config/allowlist.json` / `config/waitlist.json`,手動 `wrangler r2 object put` 也等價
- 計數在每人一個的 Durable Object,**UTC 00:00(台灣早上 08:00)重置**;P1 成功才扣額度,失敗不計

## 6. 價格:一張多少錢?

每次 Gemini 回應都帶 `usageMetadata`,Worker 用**實際 token 數**計算成本並累計到 DO:
- 每次翻譯完成,前端提示「完成 · 本次約 NT$X」
- `/admin` 的「今日」欄顯示每人當日累計張數與 NT$

**估算公式**:`成本 = (inTok × 輸入單價 + outTok × 輸出單價) ÷ 1M × 匯率`,
其中 `outTok = 回應 token + thinking token`——**thinking 依輸出價計費,是成本大宗**。

### 單價表(2026-08 官方價目,USD / 百萬 token)

單價按模型內建在 `worker/gemini.ts`,**換 `GEMINI_MODEL` 會自動換價**。
官方調價或出新模型時用 var `MODEL_PRICES` 覆寫即可,不必改碼:
`"MODEL_PRICES": "{\"gemini-3.6-flash\":[1.5,7.5]}"`

| 模型 | 輸入 | 輸出(含 thinking) |
|---|---|---|
| `gemini-3.6-flash` | $1.50 | $7.50 |
| `gemini-3.5-flash` | $1.50 | $9.00 |
| `gemini-3.5-flash-lite` | $0.30 | $2.50 |
| `gemini-3.1-flash-lite` | $0.25 | $1.50 |
| `gemini-3-flash-preview` | $0.50 | $3.00 |
| `gemini-3.1-pro-preview` | $2.00 | $12.00 |

> **沒有 `gemini-3.6-flash-lite`**——3.6 只出 Flash,lite 檔位停在 3.5。

### 模型檔位(ADR 0001)

兩個模式,模型都在 `wrangler.jsonc` vars,**預設 `fast`**:

| 模式 | var | 模型 | 一般菜單 |
|---|---|---|---|
| ⚡ 快速(預設) | `FAST_MODEL` | `gemini-3.5-flash-lite` | ≈ NT$0.51 |
| ⚖ 精準 | `ACCURATE_MODEL` | `gemini-3.6-flash` | ≈ NT$1.37 |

- 全域切換:改 `DEFAULT_MODE` 為 `"accurate"` 重新部署
- 單張切換:App 頂列的檔位鈕,切了之後同一張圖會**重翻**(不吃舊快取),選擇記在瀏覽器
- P2 想單獨用別的模型:設 `FAST_MODEL_P2` / `ACCURATE_MODEL_P2`

### 一張多少錢(匯率 31.5)

token 用量為估計值,實際以 app 提示與 `/admin` 顯示為準。

| 情境 | 3.5 Flash | 3.6 Flash(精準) | 3.5 Flash-Lite(快速) | 3.1 Flash-Lite |
|---|---|---|---|---|
| 簡單招牌(2–3 塊) | NT$0.76 | NT$0.56 | NT$0.20 | NT$0.13 |
| 一般菜單(~11 塊) | NT$1.89 | NT$1.37 | NT$0.51 | NT$0.32 |
| 複雜資訊圖(30+ 塊) | NT$5.43 | NT$3.86 | NT$1.48 | NT$0.91 |

**成本結構:P1 佔 80–92%,其中八成以上是輸出+thinking;影像輸入不到一成。**
所以:
- 「分塊高解析度」(M6)主要付的是**延遲**不是錢
- 要壓成本,方向是縮短 P1 輸出或換 P1 的模型,**不是**降影像解析度
- 換 P2 的模型省很有限(P2 只佔 8–19%)

### 換模型前先跑 A/B

P1 是框準度那一趟,換小模型省錢但可能毀掉整個產品(handoff §12 的第一驗收項)。
`scripts/ab-models.mjs` 用同一張圖跑多個模型,印出延遲、token、成本與框數量:

```bash
GEMINI_API_KEY=xxx node scripts/ab-models.mjs 照片.jpg
GEMINI_API_KEY=xxx node scripts/ab-models.mjs 照片.jpg gemini-3.6-flash gemini-3.5-flash-lite
```

輸出會存成 `ab-<模型>.json`,把座標貼回前端假資料就能目視比對框準度。
