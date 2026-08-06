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
        properties: { x: NUM, y: NUM, w: NUM, h: NUM, fs: NUM, c: NUM, en: STR, zh: STR },
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
        properties: { i: { type: 'INTEGER' }, zh: STR, nt: STR },
        required: ['i'],
      },
    },
  },
  required: ['blocks'],
};

export const P1_PROMPT = `你是圖片版面分析與翻譯引擎。找出圖中所有非中文的文字塊,對每一塊回傳:
- x, y, w, h:文字塊外框,相對整張圖的正規化百分比(0–100),x, y 為左上角
- fs:建議字級,單位 u(u = 圖片寬度的 1/100),約等於該塊單行字高
- c:版面信心 0–1(座標與斷塊是否可靠;傾斜、變形、被遮蔽時調低)
- en:該塊原文(合併為一行)
- zh:台灣正體中文初譯

規則:
- 同一視覺段落合成一塊,不要逐行切碎;裝飾性或無意義的字樣略過
- 直排文字:仍回報座標與原文,c 設 0.5 以下,zh 填「(直排文字,暫不支援)」
- 只做初譯,不要加任何譯註或說明`;

export const P2_PROMPT = `你是台灣在地化編輯。輸入是一張圖片的文字塊翻譯清單(JSON;i 為索引,en 為原文,zh 為初譯)。

任務:
1. 把 zh 修成道地台灣正體中文:去除翻譯腔、改用台灣慣用詞、全形標點、術語全篇一致
2. 對需要背景知識、雙關語、文化脈絡或譯法取捨說明的塊,寫一句簡短譯註 nt(台灣正體中文)

只回傳「zh 有修改」或「有 nt」的塊;完全不需要動的塊不要回傳。`;

async function generateJSON(
  env: Env,
  model: string,
  parts: Part[],
  schema: object,
  highRes: boolean,
): Promise<unknown> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY 未設定:wrangler secret put GEMINI_API_KEY');
  }
  const config: Record<string, unknown> = {
    responseMimeType: 'application/json',
    responseSchema: schema,
  };
  if (highRes) config.mediaResolution = 'MEDIA_RESOLUTION_HIGH';

  const call = (generationConfig: Record<string, unknown>) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts }], generationConfig }),
    });

  let res = await call(config);
  if (res.status === 400 && highRes) {
    // 部分模型版本不接受 mediaResolution,退掉重試一次
    const { mediaResolution: _drop, ...rest } = config;
    res = await call(rest);
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}:${(await res.text()).slice(0, 400)}`);

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  return JSON.parse(text);
}

const clampPct = (n: unknown) => Math.min(100, Math.max(0, Number(n) || 0));

export async function runP1(env: Env, image: string, mime: string) {
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash';
  const out = (await generateJSON(
    env,
    model,
    [{ inline_data: { mime_type: mime, data: image } }, { text: P1_PROMPT }],
    P1_SCHEMA,
    true,
  )) as { lang?: string; blocks?: Record<string, unknown>[] };

  const blocks = (out.blocks ?? []).map(b => ({
    x: clampPct(b.x),
    y: clampPct(b.y),
    w: clampPct(b.w),
    h: clampPct(b.h),
    fs: Number(b.fs) || 1.6,
    c: Math.min(1, Math.max(0, Number(b.c) || 0)),
    en: String(b.en ?? ''),
    zh: String(b.zh ?? ''),
  }));
  return { lang: String(out.lang ?? '??').toUpperCase(), blocks };
}

export async function runP2(env: Env, lang: string, blocks: { en: string; zh: string }[]) {
  const model = env.GEMINI_MODEL_P2 || env.GEMINI_MODEL || 'gemini-3.5-flash';
  const input = JSON.stringify({
    lang,
    blocks: blocks.map((b, i) => ({ i, en: b.en, zh: b.zh })),
  });
  const out = (await generateJSON(
    env,
    model,
    [{ text: `${P2_PROMPT}\n\n${input}` }],
    P2_SCHEMA,
    false,
  )) as { blocks?: { i?: unknown; zh?: unknown; nt?: unknown }[] };

  return (out.blocks ?? [])
    .filter(e => Number.isInteger(Number(e.i)))
    .map(e => ({
      i: Number(e.i),
      ...(typeof e.zh === 'string' && e.zh ? { zh: e.zh } : {}),
      ...(typeof e.nt === 'string' && e.nt ? { nt: e.nt } : {}),
    }));
}
