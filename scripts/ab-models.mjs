#!/usr/bin/env node
/* P1 模型 A/B:同一張圖跑多個模型,比延遲、token、成本與框數量。
   換 P1 模型省錢事小,框歪了整個產品就沒了(handoff §12 第一驗收項),
   所以決定前一定要用真實照片跑過這支。

   用法:
     GEMINI_API_KEY=xxx node scripts/ab-models.mjs 照片.jpg
     GEMINI_API_KEY=xxx node scripts/ab-models.mjs 照片.jpg gemini-3.6-flash gemini-3.5-flash-lite

   每個模型的完整結果會寫成 ab-<模型>.json,座標可貼回 src/data/samples.ts 目視比對。 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const PRICES = {
  'gemini-3.6-flash': [1.5, 7.5],
  'gemini-3.5-flash': [1.5, 9.0],
  'gemini-3.5-flash-lite': [0.3, 2.5],
  'gemini-3.1-flash-lite': [0.25, 1.5],
  'gemini-3-flash-preview': [0.5, 3.0],
  'gemini-3.1-pro-preview': [2.0, 12.0],
};
const USD_TWD = Number(process.env.USD_TWD || 31.5);
// 預設先比兩個正式檔位(ADR 0001),再附兩個備選
const DEFAULT_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-3.5-flash'];

// 與 worker/gemini.ts 保持一致——改了那邊記得同步這裡,否則 A/B 測到的不是正式行為
const P1_PROMPT = `你是圖片版面分析與翻譯引擎。找出圖中所有非中文的文字塊,對每一塊回傳:
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

const NUM = { type: 'NUMBER' };
const STR = { type: 'STRING' };
const P1_SCHEMA = {
  type: 'OBJECT',
  properties: {
    lang: STR,
    blocks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { x: NUM, y: NUM, w: NUM, h: NUM, fs: NUM, c: NUM, en: STR, zh: STR, v: { type: 'BOOLEAN' } },
        required: ['x', 'y', 'w', 'h', 'fs', 'c', 'en', 'zh'],
      },
    },
  },
  required: ['lang', 'blocks'],
};

const key = process.env.GEMINI_API_KEY;
const [file, ...models] = process.argv.slice(2);
if (!key || !file) {
  console.error('用法:GEMINI_API_KEY=xxx node scripts/ab-models.mjs <照片> [模型...]');
  process.exit(1);
}
const MODELS = models.length ? models : DEFAULT_MODELS;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const mime = MIME[file.split('.').pop().toLowerCase()] ?? 'image/jpeg';
const image = (await readFile(file)).toString('base64');

async function run(model) {
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: image } }, { text: P1_PROMPT }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: P1_SCHEMA,
      mediaResolution: 'MEDIA_RESOLUTION_HIGH',
    },
  };
  const t0 = Date.now();
  let res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  if (res.status === 400) {
    // 部分模型不吃 mediaResolution,退掉重試(與 worker 同行為)
    delete body.generationConfig.mediaResolution;
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
  }
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);

  const d = await res.json();
  const text = d.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  const out = JSON.parse(text);
  const um = d.usageMetadata ?? {};
  const inTok = um.promptTokenCount ?? 0;
  const outTok = (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0);
  const [pi, po] = PRICES[model] ?? [1.5, 9.0];
  const twd = ((inTok * pi + outTok * po) / 1e6) * USD_TWD;

  const blocks = out.blocks ?? [];
  const lowConf = blocks.filter(b => b.c < 0.9).length;
  const vert = blocks.filter(b => b.v).length;
  await writeFile(`ab-${model}.json`, JSON.stringify({ model, ms, inTok, outTok, twd, ...out }, null, 2));
  return { model, ms, inTok, outTok, twd, n: blocks.length, lowConf, vert };
}

console.log(`圖:${basename(file)}(${Math.round(image.length * 0.75 / 1024)} KB)\n`);
const rows = [];
for (const m of MODELS) {
  process.stdout.write(`跑 ${m} … `);
  try {
    const r = await run(m);
    rows.push(r);
    console.log(`${(r.ms / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log(`失敗:${e.message}`);
  }
}

console.log('\n模型                         延遲     in      out     成本      框數  待複核  直排');
console.log('─'.repeat(84));
for (const r of rows) {
  console.log(
    r.model.padEnd(26) +
      `${(r.ms / 1000).toFixed(1)}s`.padStart(7) +
      String(r.inTok).padStart(8) +
      String(r.outTok).padStart(8) +
      `NT$${r.twd.toFixed(2)}`.padStart(10) +
      String(r.n).padStart(7) +
      String(r.lowConf).padStart(8) +
      String(r.vert).padStart(6),
  );
}
const base = rows[0];
if (base) {
  console.log(`\n以 ${base.model} 為基準:`);
  for (const r of rows.slice(1)) {
    console.log(
      `  ${r.model.padEnd(26)} 成本 ${(base.twd / r.twd).toFixed(1)}× 便宜 · 速度 ${(base.ms / r.ms).toFixed(1)}× · 框數 ${r.n} vs ${base.n}`,
    );
  }
}
console.log('\n框準度不能只看框數——把 ab-<模型>.json 的座標貼回 src/data/samples.ts 目視比對(handoff §12)。');
