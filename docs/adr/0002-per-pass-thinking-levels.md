# ADR 0002 — 兩趟各自決定 thinking 檔位:P1 預設、P2 minimal

- 狀態:**已採用**
- 日期:2026-08-14
- 相關:[ADR 0001](0001-fast-accurate-model-modes.md)(模型檔位)、
  [`../gemini-api-lessons.md`](../gemini-api-lessons.md)(完整實驗數據)、`docs/handoff.md` §5(兩趟制)、§13

## 脈絡

thinking token 依**輸出價**計費(官方 pricing 頁明載),而本專案成本的八成以上就是輸出。
姊妹專案的通用教訓是「機械性任務一律關思考」,但 handoff §5 又明寫 P1 要開 thinking。
兩句話都對——**因為它們講的是不同的趟**。

sukemu 的兩段式設計(P1 吃圖做版面定位 / P2 只吃 JSON 做在地化)剛好讓
「該想的」與「機械的」可以分開計價,所以這個決策的單位不是專案,是**趟**。

## 決策

| 趟 | 任務形狀 | thinking | 設定 |
|---|---|---|---|
| P1 視覺趟 | bounding box 空間定位 = reasoning-shaped | **維持模型預設** | 不送 `thinkingConfig` |
| P2 文字趟 | JSON 進 JSON 出的改寫 = 機械任務 | **minimal** | var `P2_THINKING_LEVEL`(預設 `minimal`,`off` = 回模型預設) |

旋鈕一律用 3.x 官方的 `thinkingConfig.thinkingLevel`,不用已淘汰的 `thinkingBudget`
(兩者同時給會 400);並沿用既有的「未知 generationConfig 欄位 → 400 → 拿掉重試」防禦,
因為部分模型缺特定檔位(3.7-flash 沒有 `minimal`)。

## 理由

兩趟都跑了同料 A/B(3.6-flash,2026-08-14),結論相反:

**P2 → minimal(採用)**:12.0s / 2,256 tok / NT$0.56 降到 **2.8s / 424 tok / NT$0.13(-81%)**,
而且 minimal 的修訂**更多更細**(4 筆 → 17 筆:價格加空格、語序在地化),id 全數有效。
機械任務付 medium 的思考稅買不到東西。

**P1 → 維持預設(拒絕降檔)**:minimal 快 3.6 倍、便宜 3.8 倍,數字上甚至「更穩定」
(框數 11/11/11 vs default 的 11/20/20,組內 IoU 0.779 vs 0.714)——**但把框疊回照片就看得出來,
minimal 的框橫向漂移、跨欄、下墜,只是每次都用同樣的方式歪掉。**
另外 low / minimal 一律讓座標掉回 0–1000 訓練慣例(default / high 不會),
是「少想了」的直接症狀。`high` 沒有比 default 準(IoU 落在同一區間)卻不便宜,所以也不升。

## 後果

**得到**

- P2 成本降八成、延遲從 12s 降到 2.8s;整體單張從 ~17s 降到 ~13s
- 兩趟的 thinking 各自可調(`P2_THINKING_LEVEL`),換模型時不必動程式

**接受的代價**

- P1 仍是延遲與成本的大頭(~11s、佔成本八成),而且**這條路已經確認走不通**——
  要達成 handoff §12 的 10 秒目標,得從縮短 P1 輸出(座標精度、欄位精簡)下手,不是降 thinking
- P1 的分割 granularity 本來就不穩(同設定重跑會在 11 塊與 20 塊之間搖擺),
  這與 thinking 無關,是模型對「品名+價格要不要合併」的判斷會變

**再動之前必須做的**

換模型或重新考慮檔位時,重跑 `scripts/p1-thinking.mjs` 與 `scripts/p1-stability.mjs`,
且**務必包含同設定重複 3 次的變異基準**——否則 n=1 的比較會給出相反的結論(見 lessons 的方法論教訓)。
