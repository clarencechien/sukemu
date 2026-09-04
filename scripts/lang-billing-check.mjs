#!/usr/bin/env node
// 兩件事的回歸檢查:模型輸出的 lang 白名單,以及「200 但解析失敗」要入帳。
//
//   node scripts/lang-billing-check.mjs
//
// 驗證範圍:純函式層。lang 那半驗的是 safeLang 的形狀判斷;計費那半用假的 fetch
// 餵 generateJSON 各種 200 回應,檢查它有沒有把 usage 帶在錯誤上丟出來。
// **不驗併發,也不驗 DO 真的有加帳** —— 那要 Durable Object 的 input gate,
// Node 重現不了。跟 quota-reservecheck.mjs 同一句但書。

import { safeLang, BilledError } from '../worker/gemini.ts';

let bad = 0;
const ok = (cond, name, extra = '') => {
  if (!cond) bad++;
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
};

console.log('--- safeLang:模型輸出的語言代碼 ---');
for (const [input, want] of [
  ['en', 'EN'], ['JA', 'JA'], ['zho', 'ZHO'], [' de ', 'DE'],
  ['<img src=x onerror=alert(1)>', '??'],
  ['<b>EN</b>', '??'],
  ['EN"><a href=//evil>x</a>', '??'],
  ['E', '??'], ['ENGLISH', '??'], ['', '??'], [null, '??'], [undefined, '??'],
  [{ toString: () => '<script>' }, '??'],
  [123, '??'],
]) {
  const got = safeLang(input);
  ok(got === want, `safeLang(${JSON.stringify(String(input ?? '')).slice(0, 34)}) → ${got}`, want === got ? '' : `期望 ${want}`);
}

console.log('\n--- 200 但解析失敗:usage 要跟著錯誤走 ---');
const { generateJSON } = await import('../worker/gemini.ts');
const env = { GEMINI_API_KEY: 'k' };
const reply = (body) => {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
};
const usage = { promptTokenCount: 1200, candidatesTokenCount: 800, thoughtsTokenCount: 300 };

for (const [name, body, wantBilled] of [
  ['輸出被截斷(半截 JSON)', { candidates: [{ content: { parts: [{ text: '{"lang":"EN","blo' }] } }], usageMetadata: usage }, true],
  ['safety block(空 candidates)', { candidates: [], usageMetadata: usage }, true],
  ['夾雜前言', { candidates: [{ content: { parts: [{ text: '好的,結果如下:{"lang":"EN"}' }] } }], usageMetadata: usage }, true],
  ['正常', { candidates: [{ content: { parts: [{ text: '{"lang":"EN"}' }] } }], usageMetadata: usage }, false],
]) {
  reply(body);
  let err = null, res = null;
  try { res = await generateJSON(env, 'gemini-3.5-flash', [], {}); } catch (e) { err = e; }
  if (wantBilled) {
    const billed = err instanceof BilledError;
    const carried = billed && err.usage.inTok === 1200 && err.usage.outTok === 1100;
    ok(billed && carried, name,
       billed ? `BilledError,usage in=${err.usage.inTok} out=${err.usage.outTok} model=${err.model}`
              : `丟的是 ${err?.constructor?.name ?? '沒有丟'} —— usage 消失了`);
  } else {
    ok(!err && res.usage.outTok === 1100, name, err ? String(err.message).slice(0, 60) : `usage out=${res.usage.outTok}`);
  }
}

console.log(bad ? `\n${bad} 個案例失敗` : '\n全部通過');
process.exit(bad ? 1 : 0);
