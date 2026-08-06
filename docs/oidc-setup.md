# Google OIDC — 一次性設定

與 manemu 同一套機制(全 server-side OAuth + HMAC session cookie + R2 白名單熱更新)。
照順序做完,之後 push 即部署。

> 部署後平常會調的旋鈕(名單、配額、模型檔位、價格)在 [`config.md`](config.md);
> 模型檔位的決策理由在 [`adr/0001-fast-accurate-model-modes.md`](adr/0001-fast-accurate-model-modes.md)。

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
之後的名單管理見 [`config.md`](config.md)。

## 4. 網域與安全(建議)

- `wrangler.jsonc` 的 `CANONICAL_HOST` 填正式網域(例 `sukemu.ai-apps.work`)→
  workers.dev 等非正式 host 一律 301/403(WAF 繞過洞封死)。留空 = 不檢查。
- **Turnstile(可選)**:Cloudflare Dashboard → Turnstile → 新增 widget →
  site key 填 `TURNSTILE_SITE_KEY` var、`npx wrangler secret put TURNSTILE_SECRET`。
  兩者設好後登入頁自動出現驗證、Worker 端強制驗;沒設就略過。
- Rate Limiting(Free 1 條)花在 `/auth/*`;Bot Fight Mode、Always Use HTTPS 免費全開。

## 5. 驗收

- [ ] 開正式網域 → 登入頁顯示「使用 Google 登入」(不是 Email 輸入框)
- [ ] 用名單內的 Google 帳號登入 → 進 App
- [ ] 用名單外的帳號登入 → 回登入頁並顯示等候名單卡,`/admin` 看得到該筆
- [ ] 用 admin 帳號開 `/admin` → 看得到名單;用非 admin 帳號開 → 「沒有管理權限」
- [ ] 設了 `CANONICAL_HOST` 後,workers.dev 網址被 301/403
