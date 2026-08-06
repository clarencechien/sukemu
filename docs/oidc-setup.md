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

每次 Gemini 回應都帶 `usageMetadata`,Worker 直接用**實際 token 數**計算成本並累計到 DO:
- 每次翻譯完成,前端提示「完成 · 本次約 NT$X」
- `/admin` 的「今日」欄顯示每人當日累計張數與 NT$
- 單價與匯率是 vars,換模型檔位時記得對照官方價目表更新:

| var | 預設 | 說明 |
|---|---|---|
| `PRICE_IN_USD_PER_M` | 0.30 | 輸入單價(USD / 百萬 token) |
| `PRICE_OUT_USD_PER_M` | 2.50 | 輸出單價(**含 thinking token**) |
| `USD_TWD` | 31.5 | 匯率 |

**估算公式**:`成本 = (inTok × 輸入單價 + outTok × 輸出單價) ÷ 1M × 匯率`,
其中 `outTok = 回應 token + thinking token`(thinking 依輸出價計費,是成本大宗)。

**量級參考**(以預設單價估,實際以 admin 頁顯示為準):

| 情境 | P1 in / out | P2 in / out | 估算 |
|---|---|---|---|
| 簡單招牌(2–3 塊) | ~2,000 / ~2,000 | ~300 / ~300 | **≈ NT$0.2** |
| 一般菜單(10 塊上下) | ~2,500 / ~5,000 | ~1,500 / ~1,000 | **≈ NT$0.5** |
| 複雜資訊圖(30+ 塊、thinking 長) | ~3,000 / ~15,000 | ~4,000 / ~3,000 | **≈ NT$1.6** |

成本結構的重點:**影像輸入很便宜(不到一成),八成以上是 P1 的輸出+thinking**。
所以「分塊高解析度」(M6)主要付的是延遲而不是錢;若要壓成本,
方向是縮短 P1 輸出(座標精度、欄位精簡)而不是降影像解析度。
