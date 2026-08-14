# Gemini API 教訓 — sukemu 摘要版

> Canonical 完整版:[ytplayer/docs/gemini-api-lessons.md](https://github.com/clarencechien/ytplayer/blob/main/docs/gemini-api-lessons.md)
> (2026-08-13 v2,已對官方文件核實)。本頁是 sukemu 專屬摘要 + 落地狀態。
> 交叉引用:[`config.md`](config.md)(價格/配額旋鈕)、[ADR 0001](adr/0001-fast-accurate-model-modes.md)(模型檔位)。

## 落地狀態(2026-08-14 盤點後全數處理)

| # | 建議 | 狀態 |
|---|---|---|
| 1 | P2 沒有任何配額檢查(唯一無上限的付費入口) | ✅ `checkBudgets()` 對 P1/P2 同套三道門檻 |
| 2 | P2 id 對滑風險(index-keyed batch JSON) | ✅ 範圍 + 去重 + **t 回聲對位驗證**(原文前 8 字,對不上丟棄該筆) |
| 3 | P2 thinking A/B(機械任務付 medium 稅) | ✅ 實測後預設 `minimal`(見下),var `P2_THINKING_LEVEL` 可調 |
| 4 | 配額單位是張數不是成本 | ✅ `DAILY_TWD_LIMIT`(每人每日 TWD,預設 60)第二道門檻 |
| 5 | 無全站/帳號級日預算 | ✅ 程式端 `GLOBAL_DAILY_TWD`(預設 600,admin 也受限);**AI Studio Spend 頁的每專案上限請自行去設**(供應商端那層程式蓋不到) |
| 6 | 過時註解(`GEMINI_MODEL` 不存在) | ✅ wrangler.jsonc 與 gemini.ts 均已改為 FAST_MODEL / ACCURATE_MODEL |
| 7 | 配額 read-then-act 小 race | 📝 已在 `checkBudgets()` 註解立碑:超額量級是「一兩張圖」,接受;要嚴格就把檢查搬進 DO |

## P2 thinking A/B(2026-08-14,白板菜單 20 塊,3.6-flash)

| | 延遲 | 輸出 token(含 thoughts) | 成本(牌價) | 修訂數 | id 錯誤 |
|---|---|---|---|---|---|
| 預設(medium) | 12.0s | 2,256(thoughts 2,100) | NT$0.562 | 4 | 0 |
| `thinkingLevel: "minimal"` | **2.8s** | **424(thoughts 0,-81%)** | **NT$0.129** | **17** | 0 |

minimal 不只便宜快,修訂反而更多更細(價格加空格、語序在地化)——「機械任務關思考」成立。
**P1 維持模型預設 thinking**:bounding box 空間定位是 reasoning-shaped(handoff §3 品質優先),
要動先跑 `scripts/ab-models.mjs` 同料 A/B。

## 通用教訓(sukemu 視角)

1. **Thinking 稅**:thinking token 以輸出價計費(本 repo `gemini.ts` 已把 thoughtsTokenCount 併入 outTok)。
   3.x 用 `thinkingLevel`(minimal/low/medium/high),`thinkingBudget` 僅向下相容,**兩者同給 → 400**;
   部分模型缺檔位(3.7-flash 無 minimal)→ 已備 400 fallback(拿掉選配欄位重試)
2. **關思考的界線是任務形狀**:P1(視覺定位)不關、P2(JSON 進出改寫)關——不是無腦全關
3. **換模型先同料 A/B**:3.6-flash 在姊妹專案 ytplayer 實測過 batch「id 對滑」(譯文通順但對錯句,
   自動指標測不到);sukemu 的 P2 正是同型任務,故加了 t 回聲對位防線,寧缺勿錯
4. **牌價與促銷**(2026-08-14 核實):`gemini-3.6-flash-lite` / 3.7-lite **不存在**,lite 停在 3.5。
   3.6/3.7-flash 促銷半價($0.75/$3.75)至 2026-12-31——**內建價表刻意用牌價**(保險絲寧可高估、
   單位經濟不能建立在 4.5 個月後失效的價格上);要對齊實際帳單用 `MODEL_PRICES` 覆寫。
   3.7-flash 對翻譯任務零數據且無 minimal 檔,目前不是候選
5. **模型輸出視為敵意輸入**:座標格式指示會被無視(lite 掉回 0–1000 訓練慣例)→
   `normalizeBlocks()` 從值域反推;fs 用外框幾何夾限;P2 修訂做對位驗證
6. **wrangler `vars` 蓋 dashboard 明文變數**:單一事實來源放 git(wrangler.jsonc 已立碑)
7. **HKG colo → location 400**(未處理):台灣流量可能經 HKG 出口,Gemini 不支援香港。
   重試常有效只是因為換了 colo;穩定解是查 `request.cf.colo` 改路由。目前未遇到,遇到再修
8. **供應商端保險絲**:AI Studio Spend 頁每專案上限、prepaid、tier 月上限——程式再錯也燒不破的
   最後一層,開工先設(這層只能在 Google 後台設,不在 repo 裡)
