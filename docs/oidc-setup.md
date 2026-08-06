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

- **workers.dev / preview URL 已在設定碼關死**(`wrangler.jsonc` 的
  `"workers_dev": false`、`"preview_urls": false`)——這兩種網址不經 zone,
  WAF 與 Rate Limiting 全繞過。設定碼層級關掉的好處是:就算 dashboard 被誤開,
  下次部署也會關回來。對外一律走自訂網域。
  > 代價:預覽分支不再有可點的 URL。要臨時開回來就把 `preview_urls` 改成 `true`。
- `wrangler.jsonc` 的 `CANONICAL_HOST` 填正式網域(例 `sukemu.ai-apps.work`)→
  非正式 host 一律 301/403,這是上一條的程式端縱深。留空 = 不檢查。
- **Turnstile(可選)**:Cloudflare Dashboard → Turnstile → 新增 widget,
  **domain 要填 sukemu 自己的網域**(不能沿用 manemu 的 widget)→
  site key 填 `TURNSTILE_SITE_KEY` var、`npx wrangler secret put TURNSTILE_SECRET`。
  **兩者要成對設定**:只設其中一個 → Worker 自動停用挑戰(見 §6 疑難排解)。
- Rate Limiting(Free 1 條)花在 `/auth/*`;Bot Fight Mode、Always Use HTTPS 免費全開。

## 5. 疑難排解

**登入按下去出現「challenge required」/ 一直回登入頁**

先看 `curl https://<網域>/api/config` 的 `turnstileSiteKey`:

| 症狀 | 原因 | 處理 |
|---|---|---|
| `turnstileSiteKey: null` 但你設過 `TURNSTILE_SECRET` | **只設了一半**:前端渲染不出元件、後端卻要求 token | 補上 `TURNSTILE_SITE_KEY` var 後部署;或把 secret 刪掉(`wrangler secret delete TURNSTILE_SECRET`)完全停用 |
| 有 site key,但手機常失敗、桌面正常 | 行動網路較常拿到**需要互動**的挑戰,使用者在勾選完成前就按了登入 | 已修:token 到手前按鈕禁用並顯示「驗證中…」 |
| 兩者都設了仍失敗 | widget 的 domain 設錯(例如沿用 manemu 的 site key) | Turnstile 後台確認 widget 的 domain 是 sukemu 的網域 |

> 現在只設一半時 Worker 會**自動停用**挑戰並在 log 留警告,不會再把登入鎖死;
> 驗證失敗也一律導回 `/?err=challenge` 顯示可重試的訊息,不會停在裸 403 頁。

**手機能開網頁但登入後跳不回來**:檢查 Google OAuth client 的 redirect URI
是否與 `CANONICAL_HOST` 一致(含 `https://` 與 `/auth/callback`)。

## 6. 驗收

- [ ] 開正式網域 → 登入頁顯示「使用 Google 登入」(不是 Email 輸入框)
- [ ] 用名單內的 Google 帳號登入 → 進 App
- [ ] 用名單外的帳號登入 → 回登入頁並顯示等候名單卡,`/admin` 看得到該筆
- [ ] 用 admin 帳號開 `/admin` → 看得到名單;用非 admin 帳號開 → 「沒有管理權限」
- [ ] 設了 `CANONICAL_HOST` 後,workers.dev 網址被 301/403
