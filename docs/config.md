# 設定參考 — 名單、配額、模型檔位、價格

部署後平常會調的旋鈕。一次性的部署設定見 [`oidc-setup.md`](oidc-setup.md)。

---

# 一、名單・分級・調額度

**管理頁 `/admin`**(僅 `ADMIN_EMAILS` 內的帳號):

- **等候名單**:不在名單的人登入 → 自動記錄 → 一鍵「核准(選級別)」或「忽略」,
  核准後對方**下一次操作立即生效**(不用重登入、不用重部署)
- **已核准名單**:改級別、填自訂張數、移除;並顯示每人**今日已用張數與估算成本(NT$)**

**分級**(var `QUOTA_TIERS`,單位:張/日,0 = 無上限):

```json
{"admin": 0, "pro": 200, "beta": 30, "trial": 5}
```

- `ADMIN_EMAILS`(逗號分隔)裡的帳號一律 admin 級,不可從 UI 移除(防手滑鎖死自己)
- 名單值可以是級別名或直接給張數:`{"a@x.com": "pro", "b@x.com": 100}`
- 資料就是 R2 的 `config/allowlist.json` / `config/waitlist.json`,
  手動 `wrangler r2 object put` 也等價
- 計數在每人一個的 Durable Object,**UTC 00:00(台灣早上 08:00)重置**;
  P1 成功才扣**張數**,失敗不扣

> **「失敗不計費」要看是哪一種失敗。** 這句話以前把兩件事混為一談:
>
> | 失敗的樣子 | Google 收不收費 | 我們怎麼算 |
> |---|---|---|
> | 4xx / 5xx(請求被拒、上游掛掉) | **不收** | 放掉預扣,完全不入帳 |
> | HTTP 200 但 JSON 解析失敗 | **收**(prompt + 已生成的 output/thinking token) | 張數不扣,**TWD 照樣入帳** |
>
> 第二種是真的會發生的:輸出被 `MAX_TOKENS` 截斷、safety block 回空 candidates、
> 模型在 JSON 前面夾一段前言。而 P1 的成本八成以上在 output —— 也就是**最貴的那一段
> 已經產生了**。2026-09-04 之前這些的 `usageMetadata` 跟著例外一起被丟掉,三道保險絲
> 對「反覆送會讓模型吐爛 JSON 的圖」這條路徑完全無感。現在 `generateJSON` 會拋
> 帶著 usage 的 `BilledError`,由 `settleFailure()` 入帳。

**錢包保險絲共三道,P1 與 P2 都檢查**(單位對齊計費單位,見
[gemini-api-lessons.md](gemini-api-lessons.md)):

| var | 預設 | 說明 |
|---|---|---|
| `QUOTA_TIERS` | 見上 | 每人每日**張數**(分級;admin 無上限) |
| `DAILY_TWD_LIMIT` | 60 | 每人每日**估算成本**(TWD;0 = 關)——病態圖與簡單圖差 7 倍花費,張數擋不住 |
| `GLOBAL_DAILY_TWD` | 600 | **全站**每日估算成本(TWD;0 = 關);**admin 也受限** |

第四層在 Google 端(程式蓋不到):AI Studio Spend 頁設每專案花費上限。

---

# 二、模型檔位

決策見 [ADR 0001](adr/0001-fast-accurate-model-modes.md)(**含後記:快速檔位實測不合格,
現況預設精準、切換鈕隱藏**)。模型都在 `wrangler.jsonc` vars:

| 模式 | var | 模型 | 一般菜單 | 現況 |
|---|---|---|---|---|
| ⚖ 精準 | `ACCURATE_MODEL` | `gemini-3.6-flash` | ≈ NT$1.37 | **預設** |
| ⚡ 快速 | `FAST_MODEL` | `gemini-3.5-flash-lite` | ≈ NT$0.51 | 停用(框漂移+譯文串接) |

- **`DEFAULT_MODE`**:全域預設檔位
- **`MODE_TOGGLE`**:`"off"` = 鎖定預設(UI 隱藏切換鈕、API 無視 client 要求)。
  日後 lite 世代更新、重跑 A/B 合格後,改回 `"on"` + `DEFAULT_MODE:"fast"` 即恢復雙檔位
- **單張切換**(MODE_TOGGLE 開啟時):App 頂列檔位鈕,切了之後同一張圖會**重翻**(不吃舊快取)
- **P2 想單獨用別的模型**:設 `FAST_MODEL_P2` / `ACCURATE_MODEL_P2`
  (不設 = 同該模式的主模型;P2 只佔 8–19% 成本,獨立調的效益有限)
- **thinking 檔位**(決策見 [ADR 0002](adr/0002-per-pass-thinking-levels.md)):
  `P2_THINKING_LEVEL` 預設 `minimal`(A/B -81% token、快 4 倍、修訂反而更細);`off` = 回模型預設。
  **P1 刻意不設**——實測降檔會讓框橫向漂移、座標掉回 0–1000,`high` 也不比預設準。
  要再動先跑 `scripts/p1-thinking.mjs` + `scripts/p1-stability.mjs`(**必須含變異基準**)

## 換檔位前先跑 A/B

P1 是框準度那一趟,換小模型省錢但可能毀掉整個產品(handoff §12 的第一驗收項)。
`scripts/ab-models.mjs` 用同一張圖跑多個模型,印出延遲、token、成本與框數量:

```bash
GEMINI_API_KEY=xxx node scripts/ab-models.mjs 照片.jpg
GEMINI_API_KEY=xxx node scripts/ab-models.mjs 照片.jpg gemini-3.6-flash gemini-3.5-flash-lite
```

輸出會存成 `ab-<模型>.json`(含正規化百分比座標),疊回原圖目視比對框準度。

---

# 三、價格

每次 Gemini 回應都帶 `usageMetadata`,Worker 用**實際 token 數**計算成本並累計到 DO:

- 每次翻譯完成,前端提示「完成 · 本次約 NT$X」
- `/admin` 的「今日」欄顯示每人當日累計張數與 NT$

**估算公式**:`成本 = (inTok × 輸入單價 + outTok × 輸出單價) ÷ 1M × 匯率`,
其中 `outTok = 回應 token + thinking token`——**thinking 依輸出價計費,是成本大宗**。

## 單價表(牌價,2026-08-14 對官方 pricing 頁核實;USD / 百萬 token)

單價按模型內建在 `worker/gemini.ts`,**換模型會自動換價**。
官方調價或出新模型時用 var `MODEL_PRICES` 覆寫即可,不必改碼:
`"MODEL_PRICES": "{\"gemini-3.6-flash\":[0.75,3.75]}"`

| 模型 | 輸入 | 輸出(含 thinking) | 備註 |
|---|---|---|---|
| `gemini-3.7-flash` | $1.50 | $7.50 | 促銷至 2026-12-31 半價;無 minimal 思考檔;翻譯零數據,先 A/B |
| `gemini-3.6-flash` | $1.50 | $7.50 | 促銷至 2026-12-31 半價($0.75/$3.75) |
| `gemini-3.5-flash` | $1.50 | $9.00 | |
| `gemini-3.5-flash-lite` | $0.30 | $2.50 | |
| `gemini-3.1-flash-lite` | $0.25 | $1.50 | |
| `gemini-3-flash-preview` | $0.50 | $3.00 | |
| `gemini-3.1-pro-preview` | $2.00 | $12.00 | |

> **沒有 `gemini-3.6-flash-lite` / 3.7-lite**——lite 檔位停在 3.5。
> **內建表刻意用牌價**:保險絲寧可高估,單位經濟不能建立在 4.5 個月後失效的促銷價上
> (帳面成本因此比促銷期實付高約一倍);要對齊實際帳單用 `MODEL_PRICES` 覆寫。

匯率在 var `USD_TWD`(預設 31.5)。

## 一張多少錢(匯率 31.5)

token 用量為估計值,實際以 app 提示與 `/admin` 顯示為準。

| 情境 | 3.5 Flash | 3.6 Flash(精準) | 3.5 Flash-Lite(快速) | 3.1 Flash-Lite |
|---|---|---|---|---|
| 簡單招牌(2–3 塊) | NT$0.76 | NT$0.56 | NT$0.20 | NT$0.13 |
| 一般菜單(~11 塊) | NT$1.89 | NT$1.37 | NT$0.51 | NT$0.32 |
| 複雜資訊圖(30+ 塊) | NT$5.43 | NT$3.86 | NT$1.48 | NT$0.91 |

**成本結構:P1 佔 80–92%,其中八成以上是輸出+thinking;影像輸入不到一成。** 所以:

- 「分塊高解析度」(M6)主要付的是**延遲**不是錢
- 要壓成本,方向是縮短 P1 輸出或換 P1 的模型,**不是**降影像解析度
- 換 P2 的模型省很有限
