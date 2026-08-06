# Cloudflare 安全基線(ai-apps.work)

> **這份文件的用途**:每一個新的 `*.ai-apps.work` / Cloudflare Workers 專案,**安全都從這份開始**。
> 它把 `sukemu` 這個「已審過、可賣錢」的專案當成基線範本,列出:
> 1. 一份可直接照抄的**安全控制清單**(sukemu 有的 / 故意沒有的)
> 2. **正式站(要賣錢)** vs **demo/poc** 兩種標準
> 3. Cloudflare **zone 層級**一次補 headers 的做法(與它的陷阱)
> 4. 最近一次(2026-08-06)全站 audit 的**發現與結論**
>
> 維護:每次做完安全相關改動、或掃過新的站,回來更新「Audit 紀錄」一節。

---

## 0. 兩種標準:先分清楚這個站要賣錢還是 demo

| | 💰 正式站(sukemu / manemu…) | 🟡 demo / poc |
|---|---|---|
| 登入 gating | **必備**,server 端強制 | 通常不需要 |
| 非 admin 擋 `/admin` | **必備** | N/A |
| SESSION_SECRET | **必設**(缺就關門) | 可用 dev 值 |
| 安全 headers(CSP/XFO/nosniff) | **必備** | 建議(可用 zone 規則一次補) |
| Turnstile / bot 防護 | **建議** | 不需要 |
| 未用的舊站 | — | **掉了就刪**(減少攻擊面) |

判斷法則:**只要這個站背後會碰到「別人的資料、你的成本(API 花費)、或收費」,就套正式站那一欄。** 其餘走 demo 欄。

---

## 1. 安全控制清單(以 sukemu 為基線)

`✅ 有` = sukemu 已實作,新專案照抄。 `⚙️ 選配` = sukemu 留了開關但預設沒開。 `❌ 沒有` = sukemu 沒做(通常有原因)。

### 1.1 身分驗證(Auth)

| 控制 | sukemu | 檔案 / 說明 | 正式必備 |
|---|:--:|---|:--:|
| Google OIDC,全 server-side(authorization code) | ✅ | `worker/index.ts` `/auth/login` `/auth/callback` | ✔ |
| id_token 用 JWKS(RS256)驗簽,不信任 client | ✅ | `worker/auth.ts` `verifyGoogleIdToken` | ✔ |
| 逐項檢查 `exp` / `iss` / `aud` / `nonce` / `email_verified` | ✅ | 同上 | ✔ |
| 驗簽方法寫死 RS256(不吃 header `alg` → 無 alg-confusion / `alg:none`) | ✅ | 同上 | ✔ |
| OAuth `state` + `nonce` 防 CSRF/replay(存簽章 cookie) | ✅ | `sk_oauth` cookie | ✔ |
| 開發用 Email 直登**只在未設 OIDC 時**開放 | ✅ | `/api/login`,設了 `GOOGLE_CLIENT_ID` 即自動 403 | ✔ |

### 1.2 Session

| 控制 | sukemu | 說明 | 正式必備 |
|---|:--:|---|:--:|
| HMAC-SHA256 簽章的 session cookie | ✅ | `worker/auth.ts` `sign` / `verify` | ✔ |
| Cookie flags:`HttpOnly; Secure; SameSite=Lax; Path=/` | ✅ | `cookieSet` | ✔ |
| **正式環境缺 `SESSION_SECRET` 時 fail-closed** | ✅ | 已設 OIDC 卻缺 secret → `sign` 報錯、`verify` 一律當未登入(PR #14) | ✔ |
| session 有 `exp`,過期即失效 | ✅ | 7 天 | ✔ |

> ⚠️ **這是最容易忘的一條**:`SESSION_SECRET` 沒設會退回眾所皆知的 `dev-insecure-secret`,任何人都能偽造 admin session。sukemu 現在會在正式環境**關門**逼你補上。新專案務必 `wrangler secret put SESSION_SECRET`。

### 1.3 存取控制(Access control)

| 控制 | sukemu | 說明 | 正式必備 |
|---|:--:|---|:--:|
| `/api/*` 一律先驗 session 再處理 | ✅ | `worker/index.ts` route() | ✔ |
| 白名單 gating(不在名單 → 403 + 進等候名單) | ✅ | `resolveUser` / R2 `allowlist.json` | ✔ |
| **Admin 面板只認 `ADMIN_EMAILS`**,與白名單分離 | ✅ | 白名單把人設成 `admin` 級只是「無限額度」,**進不了 `/admin`** | ✔ |
| `/api/admin/*` server 端二次擋 `isAdmin` | ✅ | `api()` 內 `if (!user.isAdmin) 403` | ✔ |
| admin 靜態頁(`/admin`、`admin.js`)可公開讀取沒關係 | ✅ | 頁面不含機密,資料全靠背後受保護 API;client 端 isAdmin 只是 UI 遮罩 | ✔ |
| 每次請求即時重算分級(改名單立即生效,免重登/重部署) | ✅ | R2 熱更新 | — |

### 1.4 輸入 / 成本保險絲

| 控制 | sukemu | 說明 | 正式必備 |
|---|:--:|---|:--:|
| 上傳大小上限 | ✅ | `MAX_IMAGE_B64` 14MB → 413 | ✔ |
| 每人每日配額(Durable Object 計數) | ✅ | `worker/quota.ts`,失敗不扣額 | ✔(有 API 成本時) |
| 依實際 token 數估算成本、逐人累計 | ✅ | `estCostTwd` | — |
| 外部 API 錯誤不把 raw 訊息全丟回 client | ⚙️ | 目前 500 會回 `err.message`(輕微資訊揭露,不含金鑰) | 建議收斂 |

### 1.5 安全 Headers / CSP

| 控制 | sukemu | 說明 | 正式必備 |
|---|:--:|---|:--:|
| `Content-Security-Policy`(app 專屬) | ✅ | `SEC_HEADERS`,含 `frame-ancestors 'none'` | ✔ |
| `X-Frame-Options: DENY` | ✅ | 同上 | ✔ |
| `X-Content-Type-Options: nosniff` | ✅ | 同上 | ✔ |
| `Referrer-Policy: strict-origin-when-cross-origin` | ✅ | 同上 | ✔ |
| 靜態頁也先過 worker 才套 headers | ✅ | `wrangler.jsonc` `run_worker_first: true` | ✔ |
| CORS 預設同源(不開 `ACAO: *`) | ✅ | `sameOrigin` 檢查 | ✔ |

> **CSP 不能一刀切**:每個 app 的 `script-src`/`connect-src` 不同(sukemu 要 `challenges.cloudflare.com`、manemu 要 `wss:`)。CSP **維持各 app 自己在 worker 裡設**;只有 `XFO`/`nosniff`/`Referrer-Policy` 這種全站一致的,才適合用 zone 規則一次補(見 §3)。

### 1.6 部署 / 網路面

| 控制 | sukemu | 說明 | 正式必備 |
|---|:--:|---|:--:|
| 關掉 `workers.dev`(避免繞過 WAF 的後門網域) | ✅ | `wrangler.jsonc` `workers_dev: false` | ✔ |
| 關掉 preview URL | ✅ | `preview_urls: false` | ✔ |
| 只 commit 設定、secret 走 `wrangler secret` | ✅ | `.dev.vars` 在 `.gitignore`,repo 無金鑰 | ✔ |
| `CANONICAL_HOST` 縱深(非正式 host 一律 301/403) | ⚙️ | 程式支援但預設空;因 workers.dev 已關,實務影響小 | 選配 |

### 1.7 前端(XSS)

| 控制 | sukemu | 說明 | 正式必備 |
|---|:--:|---|:--:|
| 模型/使用者衍生文字一律走 `textContent`,不進 `innerHTML` | ✅ | `src/ui/viewer.ts` 等;`innerHTML` 只組靜態骨架 | ✔ |
| admin 頁輸出全部 `esc()` 跳脫 | ✅ | `public/admin.js` | ✔ |

### 1.8 sukemu 故意「沒有」的(有理由的取捨)

- **Turnstile 在 sukemu 是關的**(`TURNSTILE_SITE_KEY` 空)。設計上「site key + secret 兩者齊備才啟用」,只設一半會 100% 斷線,故 fail-open。manemu 有開。→ 要擋 bot 濫用時再補齊兩把值。
- **fast 模型檔位關閉**(`MODE_TOGGLE=off`):品質問題,非安全。
- **無 rate limit(除 Turnstile 外)**:登入走 OAuth 無密碼可爆破,影響小;高流量再考慮 CF Rate Limiting。

---

## 2. 新專案安全快速起手式(把 demo 拉上正式的 checklist)

照順序做完就達到基線:

- [ ] `wrangler.jsonc`:`workers_dev: false`、`preview_urls: false`
- [ ] `wrangler secret put SESSION_SECRET`(**別用 dev 值**)
- [ ] `wrangler secret put GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`(OIDC)
- [ ] `ADMIN_EMAILS` 設對人;確認白名單與 admin 面板權限**分離**
- [ ] `/api/*` 全部先驗 session;`/api/admin/*` 二次擋 `isAdmin`
- [ ] worker 輸出 CSP + `XFO:DENY` + `nosniff` + `Referrer-Policy`(抄 sukemu `SEC_HEADERS`,CSP 依 app 調)
- [ ] 上傳/輸入大小上限;有 API 成本就上每人配額
- [ ] 前端所有動態文字走 `textContent`,不用 `innerHTML` 拼
- [ ] 確認 repo 無 commit 金鑰,`.dev.vars` 在 `.gitignore`
- [ ] 部署後**實測**:未登入打 `/api/me` / `/api/admin/data` 應 401/403;用 `dev-insecure-secret` 偽造 cookie 應被拒
- [ ] (選配)Turnstile 兩把值都設;`CANONICAL_HOST` 設成正式網域

---

## 3. Cloudflare zone 層級一次補 headers(不是 WAF)

加 header 的功能叫 **Transform Rules → Modify Response Header**(免費、zone 層級,一條規則套滿整個 `ai-apps.work` 底下所有子網域)。WAF 是拿來擋攻擊流量的,不是加 header 的地方。

**只全域化「每個 app 都一樣」的那幾個**(CSP 不要,見 §1.5):

路徑:Dashboard → `ai-apps.work` zone → **Rules → Transform Rules → Modify Response Header → Create**

```
表達式:  (http.host wildcard "*.ai-apps.work")
         and not (http.host in {"sukemu.ai-apps.work" "manemu.ai-apps.work"})
動作:    Set static  X-Frame-Options            = DENY
         Set static  X-Content-Type-Options      = nosniff
         Set static  Referrer-Policy             = strict-origin-when-cross-origin
```
> 排除付費站,是因為它們的 worker 已自帶完整 headers,讓 app 自己的值權威。

HSTS 另外開:**SSL/TLS → Edge Certificates → Enable HSTS**(zone 一次全開)。

### ⚠️ 三個陷阱
1. **CSP 不能放進這條全域規則** —— 每個 app 需求不同,全域塞一份不是弄壞 demo 就是寬鬆到沒用。CSP 各 app 自理。
2. **`*.workers.dev` 不吃 zone 規則** —— 那是 Cloudflare 自己的網域,連 Transform Rules 都不能設,只能在**程式碼裡**加 header(`auth`、`bubbobgpt`、`drop-*`、`holy-cake` 都在這)。
3. **`sw-tech.tk` 是另一個 zone** —— 要在它自己 zone 底下另設一條。

---

## 4. Audit 紀錄

### 2026-08-06 — 全 `*.ai-apps.work` + 周邊站首次 audit

方法:參考 Cloudflare 官方 [security-audit-skill](https://github.com/cloudflare/security-audit-skill) 六階段;sukemu 做完整原始碼審查,其餘做線上 recon。

**結論:兩個付費站(sukemu / manemu)該擋的洞都擋住了;其餘站無可利用漏洞,只有 demo 級 header 提醒。**

| 站台 | 定位 | 結果 | 判定 |
|---|---|---|---|
| sukemu | 💰付費 | 原始碼審過;加固 `SESSION_SECRET` fail-closed(PR #14);偽造 session 被拒 | ✅ prod-ready |
| manemu | 💰付費 | 線上驗:`/api/me`、`/api/admin/*` 皆 401;偽造 session 被拒;有 Turnstile + 完整 headers | ✅ prod-ready |
| kvsplayer | poc | `/api/*` 一律 403、`/admin` 302,有 gating | ✅ 沒裸奔 |
| rainwalker / ytplayer / bubbob | poc | 靜態頁,無對外 API | 🟡 demo,缺安全 headers |
| snapdeck / vendorzoo | poc | 200-everything 是 SPA catch-all(`text/html`),**非真洩漏** | 🟡 demo,缺安全 headers |
| bruce | poc | 靜態落地頁;worker 名叫 `bruce-proxy` 但**不是開放代理**(SSRF 試過無效) | 🟡 demo |
| auth.sw-tech.workers.dev | 後端? | 每條路徑回 `Not Found`,無暴露端點 | ✅ 無外露 |
| bubbobgpt / drop-* (workers.dev) | poc | 靜態 / SPA catch-all,非真洩漏 | 🟡 demo |
| holy-cake-2b64 (workers.dev) | URL-fetch proxy | **有 host 白名單,SSRF 被擋** | ✅ 不可利用 |
| explorer.sw-tech.tk | 3 年舊物 | **502 掛了** | 🗑️ 建議刪 |

**這次做的修正**
- `worker/auth.ts`:正式環境(已設 `GOOGLE_CLIENT_ID`)缺 `SESSION_SECRET` 時 fail-closed,不再靜默用 dev 值簽章 → PR #14(已 merge/部署)。

**建議待辦(非阻擋)**
- demo 批用一條 zone Transform Rule 補 `XFO`/`nosniff`/`Referrer-Policy`(§3)。
- `ytplayer` / `bruce` 的 `ACAO: *`:純靜態無妨,日後若加讀私有資料的 API 要收掉。
- 刪掉死站 `explorer.sw-tech.tk`。
- sukemu 若要更嚴:補齊 Turnstile 兩把值、`CANONICAL_HOST` 設成 `sukemu.ai-apps.work`。
- 各 app 的 500 回應改成籠統訊息,不回 raw `err.message`。

**驗證用的線上檢查(可重跑)**
```bash
# 未登入應 401/403
curl -s -o /dev/null -w "%{http_code}\n" https://<host>/api/me
curl -s -o /dev/null -w "%{http_code}\n" https://<host>/api/admin/data
# 用 dev 值偽造 cookie 應被拒(正式站)—— 見 scripts 或本次 audit 對話
```

---

<!-- 下一次 audit:複製上面「YYYY-MM-DD — …」區塊,更新表格與待辦。 -->
