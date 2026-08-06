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
  P1 成功才扣額度,失敗不計

---

# 二、模型檔位

決策理由見 [ADR 0001](adr/0001-fast-accurate-model-modes.md)。兩個模式,模型都在
`wrangler.jsonc` vars,**預設 `fast`**:

| 模式 | var | 模型 | 一般菜單 |
|---|---|---|---|
| ⚡ 快速(預設) | `FAST_MODEL` | `gemini-3.5-flash-lite` | ≈ NT$0.51 |
| ⚖ 精準 | `ACCURATE_MODEL` | `gemini-3.6-flash` | ≈ NT$1.37 |

- **全域切換**:改 `DEFAULT_MODE` 為 `"accurate"` 重新部署
- **單張切換**:App 頂列的檔位鈕,切了之後同一張圖會**重翻**(不吃舊快取),選擇記在瀏覽器
- **P2 想單獨用別的模型**:設 `FAST_MODEL_P2` / `ACCURATE_MODEL_P2`
  (不設 = 同該模式的主模型;P2 只佔 8–19% 成本,獨立調的效益有限)

## 換檔位前先跑 A/B

P1 是框準度那一趟,換小模型省錢但可能毀掉整個產品(handoff §12 的第一驗收項)。
`scripts/ab-models.mjs` 用同一張圖跑多個模型,印出延遲、token、成本與框數量:

```bash
GEMINI_API_KEY=xxx node scripts/ab-models.mjs 照片.jpg
GEMINI_API_KEY=xxx node scripts/ab-models.mjs 照片.jpg gemini-3.6-flash gemini-3.5-flash-lite
```

輸出會存成 `ab-<模型>.json`,把座標貼回 `src/data/samples.ts` 就能目視比對框準度。

---

# 三、價格

每次 Gemini 回應都帶 `usageMetadata`,Worker 用**實際 token 數**計算成本並累計到 DO:

- 每次翻譯完成,前端提示「完成 · 本次約 NT$X」
- `/admin` 的「今日」欄顯示每人當日累計張數與 NT$

**估算公式**:`成本 = (inTok × 輸入單價 + outTok × 輸出單價) ÷ 1M × 匯率`,
其中 `outTok = 回應 token + thinking token`——**thinking 依輸出價計費,是成本大宗**。

## 單價表(2026-08 官方價目,USD / 百萬 token)

單價按模型內建在 `worker/gemini.ts`,**換模型會自動換價**。
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
