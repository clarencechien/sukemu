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

## P1 thinking A/B(2026-08-14,3.6-flash)— 結論:**維持預設,不要降**

先跑 4 個檔位 × 2 張圖,再對菜單圖跑 default / minimal 各 3 次量穩定度:

| 檔位 | 延遲 | 輸出 token | 成本 | 框數(3 次) | 座標規格 |
|---|---|---|---|---|---|
| default(medium) | 14.8s | 3,054–4,537 | NT$0.96 | 11 / 20 / 20 | 0–100 ✔ |
| high | 11.0s | 2,601 | NT$0.68 | 10 | 0–100 ✔ |
| low | 5.3s | 1,155(thoughts 0) | NT$0.34 | 20 | **掉回 0–1000** |
| minimal | 4.1s | 764–800(thoughts 0) | NT$0.25 | 11 / 11 / 11 | **掉回 0–1000** |

**方法論教訓:先量同設定的自然變異,否則差異無意義。** default 兩次之間的 IoU 只有
0.571–0.714(它在「品名+價格合併成一塊」與「拆成兩塊」之間搖擺,11 vs 20 塊),
比 minimal 對 default 的 0.875 還低——**n=1 根本分不出檔位差異**,差點得到相反結論。

**一致 ≠ 正確。** minimal 的組內 IoU(0.779)比 default(0.714)還高、框數三次全是 11,
數字上看起來更穩;但把框疊回照片目視,minimal 的框**橫向漂移、跨欄、下墜**,
default 三次都緊貼文字欄。minimal 只是「穩定地歪」。

**降 thinking 會連帶劣化座標規格遵從**:low / minimal 一律掉回 0–1000 訓練慣例
(`normalizeBlocks` 有接住,但這是模型少想了的症狀)。這也回答了先前 flash-lite 的
框漂移——**是 thinking 不足的效應,不只是模型級別**。

**high 沒有更好**(IoU 0.844/0.934,與 default 重跑的 0.909 同一區間)卻不便宜 → 沒有理由升。

→ **P1 維持模型預設 thinking**(handoff §3 品質優先)。要再動先重跑本實驗,
且務必包含「同設定重複 3 次」的變異基準。實驗腳本:`scripts/ab-models.mjs`
(單次多模型)、本次的檔位/穩定度腳本見 commit 訊息連結的 scratchpad 版本。

## 方法論:模型 A/B 的兩個必要控制(本次差點翻車,值得回填 canonical)

**一、先量同設定的自然變異,再談差異。**
第一輪 n=1 時 minimal 對 baseline 的 IoU 是 0.875,看起來完全無損。讓 default 自己重跑一次,
**兩次 default 之間只有 0.571**——變異比訊號大,n=1 的比較毫無意義,而且方向是錯的。
凡是拿「候選 vs 基準」的分數做決策,都要先有「基準 vs 基準」的分數當尺。

**二、一致 ≠ 正確,數字要配目視。**
n=3 之後 minimal 在**所有量化指標上都更好**:框數 11/11/11(default 是 11/20/20)、
組內 IoU 0.779 > 0.714。只看數字會做出錯誤決策。把框疊回照片才看得出來——
minimal 的框橫向漂移、跨欄,它只是**每次都用同樣的方式歪掉**。
高一致性可能來自「穩定地錯」,這與姊妹專案 ytplayer 的「id 對滑」是同一類陷阱:
**輸出看起來很好,但對到錯的東西,任何自動指標都測不出來**。

**三、降 thinking 會連帶劣化格式遵從(新資料點)。**
同一個 3.6-flash,`low` / `minimal` 一律把座標掉回 0–1000 訓練慣例,`default` / `high` 不會。
先前歸咎於「lite 模型比較笨」的框漂移,其實是 **thinking 不足的效應**,不只是模型級別。
→ 推論:任何「模型不照 prompt 的格式指示」的症狀,先檢查 thinking 檔位再換模型。

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

## 待回填 canonical 的新資料點

本輪產生、其他專案用得到的(canonical 在 ytplayer repo,本 session 沒有推送權限):

1. **A/B 必須有變異基準**(上面方法論一)——建議寫進 canonical §2「用同片 A/B」那節,
   它目前只講「要 A/B」,沒講「n=1 不夠」
2. **一致 ≠ 正確**(方法論二)——與 canonical §2 既有的「id 對滑要抽樣人工比對」是同一個母題,
   可以合併成一條更一般的原則:高一致性可能是穩定地錯
3. **thinking 檔位會影響格式遵從**(方法論三)——canonical §6 目前把「座標格式指示會被無視」
   歸給 sukemu/lite,應更正為 thinking 檔位效應,並補上「格式不遵從先查 thinking 再換模型」
4. **P1/P2 反例已成對**:canonical §1 的反例欄位可以更新為「同一專案內兩趟結論相反」的完整案例
   (P2 關思考省 81% 且更好、P1 關思考框會漂),比原本只寫「視覺任務要先 A/B」更有說服力
