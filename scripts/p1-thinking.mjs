/* P1 thinking A/B:框準度是重點,不是 token。
   基準 = default(3.6-flash 預設 medium)跑兩次 → 先量自然變異,再看各檔位偏離多少。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeBlocks, P1_PROMPT, P1_SCHEMA } from './gem.mjs';

const key = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-3.6-flash';
const IMAGES = [
  { id: 'menu', file: '/root/.claude/uploads/712b281b-47ec-5f18-bc4d-c24cee20f090/ccbac6fc-8561.jpg', mime: 'image/jpeg', w: 800, h: 600 },
  { id: 'info', file: 'infographic.webp', mime: 'image/webp', w: 1536, h: 864 },
];

async function p1(img, thinkingLevel) {
  const gc = { responseMimeType: 'application/json', responseSchema: P1_SCHEMA, mediaResolution: 'MEDIA_RESOLUTION_HIGH' };
  if (thinkingLevel) gc.thinkingConfig = { thinkingLevel };
  const data = readFileSync(img.file).toString('base64');
  const t0 = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: img.mime, data } }, { text: P1_PROMPT }] }], generationConfig: gc }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { err: `HTTP ${res.status} ${(await res.text()).slice(0, 160)}`, ms };
  const d = await res.json();
  const um = d.usageMetadata ?? {};
  const raw = JSON.parse(d.candidates[0].content.parts.map(p => p.text ?? '').join(''));
  const { blocks, scaleApplied } = normalizeBlocks(raw.blocks ?? [], img.w, img.h);
  const outTok = (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0);
  return { ms, blocks, scaleApplied,
    inTok: um.promptTokenCount ?? 0, outTok, thoughts: um.thoughtsTokenCount ?? 0,
    twd: ((um.promptTokenCount * 1.5 + outTok * 7.5) / 1e6) * 31.5 };
}

// 文字相似度配對(同一塊在不同回合的 en 幾乎一樣,但不保證逐字相同)
const norm = s => String(s ?? '').replace(/\s+/g, '').toLowerCase();
const sim = (a, b) => {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const set = new Set(a);
  let hit = 0;
  for (const c of b) if (set.has(c)) hit++;
  return hit / Math.max(a.length, b.length);
};
const iou = (p, q) => {
  const x1 = Math.max(p.x, q.x), y1 = Math.max(p.y, q.y);
  const x2 = Math.min(p.x + p.w, q.x + q.w), y2 = Math.min(p.y + p.h, q.y + q.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uni = p.w * p.h + q.w * q.h - inter;
  return uni > 0 ? inter / uni : 0;
};
/** 以 ref 為準,對每塊找文字最像的 cand,回傳 IoU 統計 */
function compare(ref, cand) {
  const used = new Set(); const ious = [];
  for (const r of ref) {
    let best = -1, bi = -1;
    cand.forEach((c, i) => { if (used.has(i)) return; const s = sim(r.en, c.en); if (s > best) { best = s; bi = i; } });
    if (best >= 0.6) { used.add(bi); ious.push(iou(r, cand[bi])); } else ious.push(null);
  }
  const m = ious.filter(v => v !== null);
  return {
    matched: m.length, missing: ious.length - m.length, extra: cand.length - used.size,
    meanIoU: m.length ? m.reduce((a, b) => a + b, 0) / m.length : 0,
    poor: m.filter(v => v < 0.5).length,
  };
}

const CONFIGS = [null, 'high', 'low', 'minimal']; // null = 預設(medium)
const results = {};
for (const img of IMAGES) {
  console.log(`\n══ ${img.id} ══`);
  results[img.id] = {};
  for (const cfg of CONFIGS) {
    const label = cfg ?? 'default(medium)';
    const r = await p1(img, cfg);
    results[img.id][label] = r;
    if (r.err) { console.log(`${label.padEnd(16)} 失敗:${r.err}`); continue; }
    console.log(`${label.padEnd(16)} ${(r.ms/1000).toFixed(1)}s  in=${r.inTok} out=${r.outTok}(thoughts ${r.thoughts})  NT$${r.twd.toFixed(2)}  框=${r.blocks.length}${r.scaleApplied ? ' ⚠座標'+r.scaleApplied : ''}`);
  }
  // 基準重跑:量自然變異
  const rerun = await p1(img, null);
  results[img.id]['default#2'] = rerun;
  console.log(`${'default#2'.padEnd(16)} ${(rerun.ms/1000).toFixed(1)}s  out=${rerun.outTok}  框=${rerun.blocks.length}  ← 變異基準`);
}
writeFileSync('p1-thinking-raw.json', JSON.stringify(results, null, 1));

console.log('\n\n框準度(以各圖 default#1 為參考,文字配對後算 IoU)');
console.log('圖    設定             框數  配對  漏  多  平均IoU  IoU<0.5');
console.log('─'.repeat(66));
for (const img of IMAGES) {
  const ref = results[img.id]['default(medium)'];
  if (ref.err) continue;
  for (const [label, r] of Object.entries(results[img.id])) {
    if (r.err || label === 'default(medium)') continue;
    const c = compare(ref.blocks, r.blocks);
    console.log(`${img.id.padEnd(5)} ${label.padEnd(16)} ${String(r.blocks.length).padStart(3)}  ${String(c.matched).padStart(4)} ${String(c.missing).padStart(3)} ${String(c.extra).padStart(3)}   ${c.meanIoU.toFixed(3)}    ${c.poor}`);
  }
}
