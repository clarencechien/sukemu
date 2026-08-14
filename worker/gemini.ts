/* Gemini 呼叫(handoff §5 兩趟制)。
   陷阱:CF Workers 沒有 Node 內建模組,一律走 REST(generateContent),不用官方 Node SDK。
   P1 視覺趟:media_resolution HIGH,回座標+原文+初譯,不產譯註。
   P2 文字趟:只餵 P1 的 JSON,在地化+譯註;失敗重試不用重付影像 token。 */

import type { Env } from './index';

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

const NUM = { type: 'NUMBER' } as const;
const STR = { type: 'STRING' } as const;

export const P1_SCHEMA = {
  type: 'OBJECT',
  properties: {
    lang: { ...STR, description: '來源語言代碼,大寫,如 EN、JA、KO' },
    blocks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          x: NUM, y: NUM, w: NUM, h: NUM, fs: NUM, c: NUM, en: STR, zh: STR,
          v: { type: 'BOOLEAN', description: '直排文字(直書)時為 true' },
        },
        required: ['x', 'y', 'w', 'h', 'fs', 'c', 'en', 'zh'],
      },
    },
  },
  required: ['lang', 'blocks'],
};

export const P2_SCHEMA = {
  type: 'OBJECT',
  properties: {
    blocks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          i: { type: 'INTEGER' },
          t: { ...STR, description: '該塊原文(en)開頭 8 個字元,用於對位驗證' },
          zh: STR,
          nt: STR,
        },
        required: ['i', 't'],
      },
    },
  },
  required: ['blocks'],
};

export const P1_PROMPT = `你是圖片版面分析與翻譯引擎。找出圖中所有非中文的文字塊,對每一塊回傳:
- x, y, w, h:文字塊外框。**一律用相對整張圖的百分比,0–100 的數字**,x, y 為左上角,
  w, h 為寬高。**不要用 0–1000 標註、不要用像素、不要用 0–1 小數、不要回傳 x2/y2**
- fs:建議字級,單位 u(u = 圖片寬度的 1/100),約等於該塊單行字高;一般照片多在 1–6 之間
- c:版面信心 0–1(座標與斷塊是否可靠;傾斜、變形、被遮蔽時調低)
- en:該塊原文(合併為一行)
- zh:台灣正體中文初譯

規則:
- 同一視覺段落合成一塊,不要逐行切碎;裝飾性或無意義的字樣略過
- 直排文字(直書,由上而下閱讀):照常辨識與翻譯,並回傳 v: true;
  x, y, w, h 仍為該塊實際外框(通常窄而高),fs 以單一字元的大小估
- 只做初譯,不要加任何譯註或說明`;

export const P2_PROMPT = `你是台灣在地化編輯。輸入是一張圖片的文字塊翻譯清單(JSON;i 為索引,en 為原文,zh 為初譯)。

任務:
1. 把 zh 修成道地台灣正體中文:去除翻譯腔、改用台灣慣用詞、全形標點、術語全篇一致
2. 對需要背景知識、雙關語、文化脈絡或譯法取捨說明的塊,寫一句簡短譯註 nt(台灣正體中文)

只回傳「zh 有修改」或「有 nt」的塊;完全不需要動的塊不要回傳。
每一塊都要帶 t = 該塊原文 en 的開頭 8 個字元(對位驗證用,照抄即可)。`;

export type TokenUsage = { inTok: number; outTok: number };

/** 模型檔位(ADR 0001 + 後記):fast 省錢、accurate 品質。
    2026-08-06 實測 fast(flash-lite)框漂移 + 多語標籤譯文串接,不合格——
    MODE_TOGGLE=off 時無視 client 要求、一律走預設檔位(UI 同步隱藏切換鈕)。 */
export type ModelMode = 'fast' | 'accurate';

export const modeToggleEnabled = (env: Env) => env.MODE_TOGGLE !== 'off';

export const resolveMode = (env: Env, requested?: string): ModelMode => {
  const pick = modeToggleEnabled(env) && requested ? requested : env.DEFAULT_MODE;
  return pick === 'fast' ? 'fast' : 'accurate';
};

/** 模式 → 模型。P2 可用 *_MODEL_P2 單獨覆寫(P2 只佔 8–19% 成本,值得獨立調) */
function modelFor(env: Env, mode: ModelMode, pass: 'p1' | 'p2'): string {
  if (mode === 'accurate') {
    return (pass === 'p2' ? env.ACCURATE_MODEL_P2 : '') || env.ACCURATE_MODEL || 'gemini-3.6-flash';
  }
  return (pass === 'p2' ? env.FAST_MODEL_P2 : '') || env.FAST_MODEL || 'gemini-3.5-flash-lite';
}

async function generateJSON(
  env: Env,
  model: string,
  parts: Part[],
  schema: object,
  opts: { highRes?: boolean; thinkingLevel?: string } = {},
): Promise<{ data: unknown; usage: TokenUsage }> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY 未設定:wrangler secret put GEMINI_API_KEY');
  }
  const config: Record<string, unknown> = {
    responseMimeType: 'application/json',
    responseSchema: schema,
  };
  if (opts.highRes) config.mediaResolution = 'MEDIA_RESOLUTION_HIGH';
  // 3.x 官方旋鈕是 thinkingLevel(minimal/low/medium/high);不要用 thinkingBudget,
  // 兩者同時給會 400。部分模型沒有某些檔位(3.7-flash 無 minimal)→ 靠下面的 400 fallback
  if (opts.thinkingLevel) config.thinkingConfig = { thinkingLevel: opts.thinkingLevel };

  const call = (generationConfig: Record<string, unknown>) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts }], generationConfig }),
    });

  let res = await call(config);
  if (res.status === 400 && (opts.highRes || opts.thinkingLevel)) {
    // 未知/不支援的 generationConfig 欄位 → 400 → 拿掉選配欄位重試一次(通用防禦)
    const { mediaResolution: _m, thinkingConfig: _t, ...rest } = config;
    console.warn(`[gemini] ${model} 拒絕選配欄位,退階重試`);
    res = await call(rest);
  }
  // 錯誤訊息帶上模型名:換檔位後出問題時,要一眼看出是哪個模型在報錯
  if (!res.ok) throw new Error(`Gemini ${res.status}(${model}):${(await res.text()).slice(0, 300)}`);

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  const um = data.usageMetadata ?? {};
  // thinking token 依輸出價計費,併入 outTok
  const usage: TokenUsage = {
    inTok: um.promptTokenCount ?? 0,
    outTok: (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0),
  };
  return { data: JSON.parse(text), usage };
}

/* 各模型單價(USD / 百萬 token):[輸入, 輸出],輸出價含 thinking token。
   2026-08-14 對官方 pricing 頁核實。換 FAST_MODEL / ACCURATE_MODEL 時自動換價——
   不要把單價寫死成單一組,否則換了模型卻沿用舊價,帳會算錯(此坑已踩過)。
   價目調整或新模型:用 var MODEL_PRICES 覆寫/補充,不必改碼。
   注意:3.6/3.7-flash 至 2026-12-31 促銷半價($0.75/$3.75)——這裡刻意列「牌價」,
   保險絲與成本試算寧可高估;要對齊實際帳單可用 MODEL_PRICES 覆寫成促銷價。 */
const DEFAULT_PRICES: Record<string, [number, number]> = {
  'gemini-3.7-flash': [1.5, 7.5], // 無 minimal 思考檔;翻譯行為零數據,換用前先跑 ab-models.mjs
  'gemini-3.6-flash': [1.5, 7.5],
  'gemini-3.5-flash': [1.5, 9.0],
  'gemini-3.5-flash-lite': [0.3, 2.5],
  'gemini-3.1-flash-lite': [0.25, 1.5],
  'gemini-3-flash-preview': [0.5, 3.0],
  'gemini-3.1-pro-preview': [2.0, 12.0],
};

/** token 用量 → 估算成本 TWD(見 docs/config.md「價格」) */
export function estCostTwd(env: Env, model: string, usage: TokenUsage): number {
  let table = DEFAULT_PRICES;
  try {
    table = { ...DEFAULT_PRICES, ...JSON.parse(env.MODEL_PRICES || '{}') };
  } catch {
    /* 格式錯就用內建表 */
  }
  // 查不到的模型退回內建表最貴的一組,寧可高估也不要低報成本
  const [pin, pout] = table[model] ?? [1.5, 9.0];
  const rate = Number(env.USD_TWD || 31.5);
  return +(((usage.inTok * pin + usage.outTok * pout) / 1e6) * rate).toFixed(4);
}

const clampPct = (n: number) => Math.min(100, Math.max(0, n || 0));

/* 座標規格防呆:prompt 要求 0–100 百分比,但模型(尤其 lite 檔)常掉回
   訓練慣例——Gemini 空間標註是 0–1000,也見過像素與 0–1 小數。
   直接夾到 100 會把框撐成滿版、fs 放大幾百倍(實測快速模式整版橘色)。
   這裡從數值範圍推回原始規格再換算;iw/ih 是上傳影像的實際尺寸(像素模式要用)。 */
export function normalizeBlocks(
  raw: Record<string, unknown>[],
  iw?: number,
  ih?: number,
): { blocks: { x: number; y: number; w: number; h: number; fs: number; c: number; en: string; zh: string; v?: true }[]; scaleApplied: string | null } {
  const n = (v: unknown) => Number(v) || 0;
  let extent = 0;
  for (const b of raw) extent = Math.max(extent, n(b.x) + n(b.w), n(b.y) + n(b.h));

  let sx = 1;
  let sy = 1;
  let scaleApplied: string | null = null;
  if (extent > 120) {
    if (iw && ih && extent > 1050) {
      sx = iw / 100; sy = ih / 100; scaleApplied = 'px';        // 像素 → %
    } else {
      sx = 10; sy = 10; scaleApplied = '0-1000';                // 0–1000 → %
    }
  } else if (extent > 0 && extent <= 1.2) {
    sx = 0.01; sy = 0.01; scaleApplied = '0-1';                 // 0–1 小數 → %
  }

  const ar = iw && ih ? ih / iw : 1; // fs 上限要用:框高 h% 換成 u(寬基準)= h × ih/iw
  const blocks = raw.map(b => {
    const v = b.v === true;
    const w = clampPct(n(b.w) / sx);
    const h = clampPct(n(b.h) / sy);
    // fs 與 x 同一個寬基準單位,套同一個換算;再用外框幾何夾住:
    // 橫排單行字高不會超過框高(h×ih/iw u),直排單字寬不會超過框寬(w u)
    let fs = n(b.fs) / sx;
    const cap = Math.max(0.8, v ? w : h * ar);
    if (!Number.isFinite(fs) || fs <= 0) fs = cap * 0.8;
    fs = Math.max(0.6, Math.min(fs, cap, 14));
    return {
      x: +clampPct(n(b.x) / sx).toFixed(2),
      y: +clampPct(n(b.y) / sy).toFixed(2),
      w: +w.toFixed(2),
      h: +h.toFixed(2),
      fs: +fs.toFixed(2),
      c: Math.min(1, Math.max(0, n(b.c))),
      en: String(b.en ?? ''),
      zh: String(b.zh ?? ''),
      ...(v ? { v: true as const } : {}),
    };
  });
  return { blocks, scaleApplied };
}

export async function runP1(env: Env, image: string, mime: string, mode: ModelMode, iw?: number, ih?: number) {
  const model = modelFor(env, mode, 'p1');
  // P1(bounding box 空間定位)是 reasoning-shaped:thinking 維持模型預設,
  // 要降級先跑 ab-models.mjs 同料 A/B(handoff §3 品質優先)
  const { data, usage } = await generateJSON(
    env,
    model,
    [{ inline_data: { mime_type: mime, data: image } }, { text: P1_PROMPT }],
    P1_SCHEMA,
    { highRes: true },
  );
  const out = data as { lang?: string; blocks?: Record<string, unknown>[] };
  const { blocks, scaleApplied } = normalizeBlocks(out.blocks ?? [], iw, ih);
  if (scaleApplied) console.log(`[p1] ${model} 座標不是 0–100 百分比,已按 ${scaleApplied} 規格換算`);
  return { lang: String(out.lang ?? '??').toUpperCase(), blocks, usage, model, mode };
}

const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();

export async function runP2(env: Env, lang: string, blocks: { en: string; zh: string }[], mode: ModelMode) {
  const model = modelFor(env, mode, 'p2');
  const input = JSON.stringify({
    lang,
    blocks: blocks.map((b, i) => ({ i, en: b.en, zh: b.zh })),
  });
  // P2(JSON 進 JSON 出的在地化改寫)是機械任務:thinking 降到 minimal。
  // 同料 A/B(2026-08-14,白板菜單 20 塊):medium 12.0s/2256 tok vs minimal
  // 2.8s/424 tok(-81%),minimal 的修訂反而更多更細,id 全部有效。
  // "off" 可完全不送 thinkingConfig(回到模型預設)。
  const thinkingLevel = env.P2_THINKING_LEVEL === 'off' ? undefined : env.P2_THINKING_LEVEL || 'minimal';
  const { data, usage } = await generateJSON(env, model, [{ text: `${P2_PROMPT}\n\n${input}` }], P2_SCHEMA, {
    thinkingLevel,
  });
  const out = data as { blocks?: { i?: unknown; t?: unknown; zh?: unknown; nt?: unknown }[] };

  /* index-keyed batch JSON 的「id 對滑」防線(姊妹專案 ytplayer 實測踩雷:
     譯文通順但對到錯的塊,自動指標測不到):
     1. i 必須在範圍內且不重複
     2. t(原文前 8 字的回聲)要對得上 blocks[i].en——對不上就丟棄該筆修訂,寧缺勿錯 */
  const seen = new Set<number>();
  let dropped = 0;
  const edits: { i: number; zh?: string; nt?: string }[] = [];
  for (const e of out.blocks ?? []) {
    const i = Number(e.i);
    if (!Number.isInteger(i) || i < 0 || i >= blocks.length || seen.has(i)) {
      dropped++;
      continue;
    }
    if (typeof e.t === 'string' && e.t) {
      const echo = squash(e.t).slice(0, 6);
      if (echo && !squash(blocks[i].en).includes(echo)) {
        dropped++;
        continue;
      }
    }
    seen.add(i);
    edits.push({
      i,
      ...(typeof e.zh === 'string' && e.zh ? { zh: e.zh } : {}),
      ...(typeof e.nt === 'string' && e.nt ? { nt: e.nt } : {}),
    });
  }
  if (dropped) console.warn(`[p2] ${model} 丟棄 ${dropped} 筆對位失敗的修訂(id 對滑防線)`);
  return { edits, usage, model, mode };
}
