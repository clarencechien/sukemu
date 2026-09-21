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

> **`GOOGLE_CLIENT_ID` 是必設的,沒有「先不設也能上線」這條路。** 沒設時登入頁會顯示
> 「開發用 Email 直登」的畫面,但 `/api/login` 要 **`DEV_LOGIN=1`(只放 `.dev.vars`,
> 不會被部署)且 host 是本機**兩道閘門同時成立才會開 —— 部署出去的站一定拿到
> 403。刻意不拿「有沒有設 OIDC」當判準:那會讓「忘了設 OIDC」等於把零憑證的 admin
> 登入開給全世界(姊妹專案 2026-09-04 實際發生過)。
>
> 本機開發用 `npm run dev:worker`,它帶了 `--host localhost`。**這個旗標不能拿掉**:
> `routes` 設了 `custom_domain: true`,wrangler dev 預設會把 `request.url` 的 hostname
> 與 `Host` header 都改寫成 `sukemu.ai-apps.work`,於是連在 `127.0.0.1` 上也過不了
> 「host 是本機」那道閘門。

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
- `wrangler.jsonc` 的 `CANONICAL_HOST` **已經填好** `sukemu.ai-apps.work` →
  非正式 host 一律 301/403,這是上一條的程式端縱深。自訂網域也寫進了
  `routes`(`custom_domain: true`),部署即宣告,不再只存在 dashboard。
- **Turnstile(已啟用)**:**與 manemu 共用同一個 widget、同一把 secret**。
  現況就是這樣設的,`wrangler.jsonc` 的 `TURNSTILE_SITE_KEY` 與
  `docs/cf-security-baseline.md` §1.8 講的是同一件事。

  > ⚠️ 這一段以前寫的是「不能沿用 manemu 的 widget,要新建一個」——**那是錯的**,
  > 而且照著做會踩坑:新建 widget 拿到新的 site key,但 `TURNSTILE_SECRET`
  > 還是舊那把,於是每次登入都 403,而症狀看起來像「Turnstile 壞了」。

  要沿用就確認那個 widget 的 hostname 清單**包含 `sukemu.ai-apps.work`**,
  否則挑戰在 sukemu 的頁面上根本渲染不出來。
  site key 填 `TURNSTILE_SITE_KEY` var(**是 var 不是 dashboard 設定**,
  在 dashboard 手改會被下次 deploy 蓋掉)、
  `npx wrangler secret put TURNSTILE_SECRET`。
  **兩者要成對設定**:只設其中一個 → Worker 自動停用挑戰(見 §6 疑難排解)。

  共用 secret 的代價,以及對應的防線:secret 一樣就表示**在 manemu 頁面解出來的
  token 也驗得過 sukemu**。token 是單次有效,所以不是「免解題繞過」,但少了站別
  綁定。`worker/index.ts` 的 siteverify 因此會比對回傳的 `hostname`,
  不是只看 `success`。
- Rate Limiting(Free 1 條)花在 `/auth/*`;Bot Fight Mode、Always Use HTTPS 免費全開。

## 5. 疑難排解

**登入按下去,回到登入頁說人機驗證沒過**

登入頁現在會直接說是哪一種(Worker 也會在 log 留同一個代碼),不用再從頭猜:

| 畫面訊息 / `?c=` | 代表 | 處理 |
|---|---|---|
| `notoken`「沒有載入完成就送出」 | widget 根本沒產出 token | 多半是 **widget 的 hostname 清單沒有 `sukemu.ai-apps.work`**(共用 manemu 那個 widget 就要加);其次是擋廣告的擴充套件 / 網路擋掉 `challenges.cloudflare.com` |
| `secret`「site key 與 secret 不是同一個 widget」 | siteverify 回 `invalid-input-secret` | 兩把值要來自**同一個** widget;重設 `TURNSTILE_SECRET` |
| `host` | token 是在別的網域解的 | 共用 secret 的站別綁定擋下了;正常使用不會出現 |
| `stale` | token 逾時或重複使用 | 重新整理再登入 |

`curl https://<網域>/api/config` 的 `turnstileSiteKey` 若是 `null`,代表兩把值沒設齊
(或 `TURNSTILE` 被設成 `off`),Worker 會自動停用挑戰而不是把人鎖在門外。

> **被鎖在門外的逃生門**:`wrangler.jsonc` 加 `"TURNSTILE": "off"` 再部署,
> 兩把值都留著、只是暫時不驗。widget 設定修好後把這行拿掉即可。

**按了登入完全沒反應 / 跳不到 Google**(2026-09-21 修正)

CSP 的 `form-action` **必須列出 `https://accounts.google.com`**。登入表單原生
POST `/auth/login` 之後 Worker 會 302 到 Google,而 Chrome 把 `form-action`
套用到整條重導向鏈 —— 只寫 `'self'` 的話 Google 登入永遠到不了,
而且 console 的訊息會指向 `/auth/login` 這個同源網址,看起來像無關的錯:

```
Refused to send form data to '…/auth/login' because it violates
the following Content Security Policy directive: "form-action 'self'"
```

同理 Turnstile 的挑戰 widget 需要 `blob:` 的 frame/worker(Cloudflare 自家挑戰頁
的 CSP 也這樣寫),`frame-src` / `child-src` / `worker-src` 都要帶 `blob:`。

**手機能開網頁但登入後跳不回來**:檢查 Google OAuth client 的 redirect URI
是否與 `CANONICAL_HOST` 一致(含 `https://` 與 `/auth/callback`)。

**登入成功,但上傳圖片後偶發 400 / 訊息提到 location**(2026-09-21 修正)

Gemini 不支援香港,而 Cloudflare Worker 的 subrequest 是**從使用者連到的那個 colo
出去**的 —— 台灣流量常被導去 HKG,於是回 400「User location is not supported」。
會「偶發」是因為下一次請求可能落到別的 colo。

已處理:撞到這個 400 時自動改道釘在支援地區的 Durable Object 重送
(地區見 var `RELAY_REGIONS`,預設 `apac-ne,enam`;機制見 [`config.md`](config.md) 第四節)。
若仍看到「這條連線的出口地區 Gemini 不支援,改道後仍失敗」,代表列出的地區都沒送成:
先看 Worker log 有沒有 `[gemini] 出口地區不被支援,改道 … 重送`,再考慮把
`RELAY_REGIONS` 換成別的地區。**注意 `GeminiRelay` 是新的 DO class,
部署前確認 `wrangler.jsonc` 的 `migrations` 有 `v2`**(`npm run deploy` 會自動跑)。

## 6. 驗收

- [ ] 開正式網域 → 登入頁顯示「使用 Google 登入」(不是 Email 輸入框)
- [ ] 用名單內的 Google 帳號登入 → 進 App
- [ ] 用名單外的帳號登入 → 回登入頁並顯示等候名單卡,`/admin` 看得到該筆
- [ ] 用 admin 帳號開 `/admin` → 看得到名單;用非 admin 帳號開 → 「沒有管理權限」
- [ ] 設了 `CANONICAL_HOST` 後,workers.dev 網址被 301/403
- [ ] 登入後上傳一張圖 → 翻譯完成並顯示「本次約 NT$X」(不是 400)
