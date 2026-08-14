/* 穩定度實驗:default(medium) vs minimal,各跑 3 次。
   問的是「檔位差異有沒有大過同設定的自然變異」——上一輪 n=1 分不出來。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeBlocks, P1_PROMPT, P1_SCHEMA } from './gem.mjs';
const key = process.env.GEMINI_API_KEY;
const IMG = { file: '/root/.claude/uploads/712b281b-47ec-5f18-bc4d-c24cee20f090/ccbac6fc-8561.jpg', mime: 'image/jpeg', w: 800, h: 600 };
const data = readFileSync(IMG.file).toString('base64');

async function p1(thinkingLevel) {
  const gc = { responseMimeType: 'application/json', responseSchema: P1_SCHEMA, mediaResolution: 'MEDIA_RESOLUTION_HIGH' };
  if (thinkingLevel) gc.thinkingConfig = { thinkingLevel };
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = Date.now();
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: IMG.mime, data } }, { text: P1_PROMPT }] }], generationConfig: gc }),
    });
    if (!res.ok) { await new Promise(r => setTimeout(r, 2000)); continue; }
    const d = await res.json(); const um = d.usageMetadata ?? {};
    const raw = JSON.parse(d.candidates[0].content.parts.map(p => p.text ?? '').join(''));
    const { blocks, scaleApplied } = normalizeBlocks(raw.blocks ?? [], IMG.w, IMG.h);
    const outTok = (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0);
    return { ms: Date.now() - t0, blocks, scaleApplied, outTok,
      twd: ((um.promptTokenCount * 1.5 + outTok * 7.5) / 1e6) * 31.5 };
  }
  return { err: 'retries exhausted' };
}
const norm = s => String(s ?? '').replace(/\s+/g, '').toLowerCase();
const sim = (a, b) => { a = norm(a); b = norm(b); if (!a || !b) return 0; if (a === b) return 1;
  const s = new Set(a); let h = 0; for (const c of b) if (s.has(c)) h++; return h / Math.max(a.length, b.length); };
const iou = (p, q) => { const x1 = Math.max(p.x, q.x), y1 = Math.max(p.y, q.y);
  const x2 = Math.min(p.x + p.w, q.x + q.w), y2 = Math.min(p.y + p.h, q.y + q.h);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); const u = p.w * p.h + q.w * q.h - i; return u > 0 ? i / u : 0; };
function pairIoU(A, B) { const used = new Set(); const v = [];
  for (const r of A) { let best = -1, bi = -1;
    B.forEach((c, i) => { if (used.has(i)) return; const s = sim(r.en, c.en); if (s > best) { best = s; bi = i; } });
    if (best >= 0.6) { used.add(bi); v.push(iou(r, B[bi])); } }
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }

const runs = { 'default(medium)': [], minimal: [] };
for (const cfg of ['default(medium)', 'minimal']) {
  for (let i = 0; i < 3; i++) {
    const r = await p1(cfg === 'minimal' ? 'minimal' : null);
    runs[cfg].push(r);
    console.log(`${cfg.padEnd(16)} #${i + 1}  ${r.err ?? `${(r.ms/1000).toFixed(1)}s  out=${r.outTok}  框=${r.blocks.length}  NT$${r.twd.toFixed(2)}${r.scaleApplied ? '  ⚠座標'+r.scaleApplied : ''}`}`);
  }
}
writeFileSync('p1-stability-raw.json', JSON.stringify(runs, null, 1));

const ok = k => runs[k].filter(r => !r.err);
console.log('\n框數分佈(分割穩定度):');
for (const k of Object.keys(runs)) console.log(`  ${k.padEnd(16)} ${ok(k).map(r => r.blocks.length).join(', ')}`);
console.log('\n組內一致性(同設定兩兩 IoU)vs 組間(default × minimal):');
const within = k => { const a = ok(k); const v = [];
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) v.push(pairIoU(a[i].blocks, a[j].blocks));
  return v; };
const wd = within('default(medium)'), wm = within('minimal');
const between = []; for (const a of ok('default(medium)')) for (const b of ok('minimal')) between.push(pairIoU(a.blocks, b.blocks));
const avg = v => v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : 'n/a';
console.log(`  default 組內  ${avg(wd)}   [${wd.map(v => v.toFixed(2)).join(' ')}]`);
console.log(`  minimal 組內  ${avg(wm)}   [${wm.map(v => v.toFixed(2)).join(' ')}]`);
console.log(`  組間          ${avg(between)}   [${between.map(v => v.toFixed(2)).join(' ')}]`);
const t = k => { const a = ok(k); return { s: (a.reduce((x, r) => x + r.ms, 0) / a.length / 1000).toFixed(1), twd: (a.reduce((x, r) => x + r.twd, 0) / a.length).toFixed(2) }; };
console.log(`\n平均:default ${t('default(medium)').s}s / NT$${t('default(medium)').twd}  ·  minimal ${t('minimal').s}s / NT$${t('minimal').twd}`);
