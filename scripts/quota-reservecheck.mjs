// worker/quota.ts 的預扣邏輯檢查(沿用 scripts/*.mjs 的慣例;此專案沒有測試框架)。
//   npx tsc worker/quota.ts --outDir /tmp/sukemu-q --module es2022 --target es2022 \
//     --moduleResolution bundler --types @cloudflare/workers-types
//   node scripts/quota-reservecheck.mjs
//
// 由來:2026-09-04 安全檢視。三道錢包保險絲原本是 read → 呼叫 Gemini(13 秒)→
// 事後入帳,競態窗口是整段 Gemini 延遲,所以並行 N 個請求額度就是 N 倍。
//
// ⚠️ 這支能證明什麼、不能證明什麼,講清楚:
//   能:預扣(pending)有被算進上限、撞頂會被擋、settle/release 的帳目正確。
//   不能:重現 Durable Object 的 input gate。真正讓「檢查+預扣」變成原子的是那個 gate
//        —— DO 在 storage await 期間不會遞送其他事件,所以同一顆 DO 的 fetch 天然序列化。
//        下面刻意用序列化的方式呼叫,模擬的就是那個執行模型。
import { QuotaCounter } from '/tmp/sukemu-q/quota.js';

let fail = 0;
const ok = (c, l) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) fail++; };

const fakeState = () => {
  const m = new Map();
  return { storage: { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v) } };
};
const post = (do_, path, body) =>
  do_.fetch(new Request(`https://do${path}`, { method: 'POST', body: JSON.stringify(body) }));

// ---- 張數上限:10 個請求,額度 3 ----
{
  const q = new QuotaCounter(fakeState());
  const results = [];
  for (let i = 0; i < 10; i++) {              // 序列化 = DO input gate 的執行模型
    results.push(await (await post(q, '/reserve', { images: 1, estTwd: 3, limitImages: 3, twdLimit: 0, maxInflight: 0 })).json());
  }
  ok(results.filter((r) => r.ok).length === 3, '額度 3、送 10 個 → 只有 3 個拿到預扣');
  ok(results.filter((r) => !r.ok).every((r) => r.reason === 'images'), '其餘被擋的原因是張數');
}

// ---- 未結算的預扣要算進上限(這就是舊版漏掉的那一段)----
{
  const q = new QuotaCounter(fakeState());
  const a = await (await post(q, '/reserve', { images: 1, estTwd: 3, limitImages: 1, twdLimit: 0, maxInflight: 0 })).json();
  const b = await (await post(q, '/reserve', { images: 1, estTwd: 3, limitImages: 1, twdLimit: 0, maxInflight: 0 })).json();
  ok(a.ok && !b.ok, '第一個還沒結算,第二個就該被擋(舊版會放行:讀到的 count 還是 0)');
  await post(q, '/release', { id: a.id });
  const c = await (await post(q, '/reserve', { images: 1, estTwd: 3, limitImages: 1, twdLimit: 0, maxInflight: 0 })).json();
  ok(c.ok, 'release 之後額度放回來');
}

// ---- TWD 上限 ----
{
  const q = new QuotaCounter(fakeState());
  const a = await (await post(q, '/reserve', { images: 0, estTwd: 40, limitImages: 0, twdLimit: 60, maxInflight: 0 })).json();
  const b = await (await post(q, '/reserve', { images: 0, estTwd: 40, limitImages: 0, twdLimit: 60, maxInflight: 0 })).json();
  ok(a.ok && !b.ok && b.reason === 'twd', 'TWD 上限也看預扣(40 + 40 > 60)');
}

// ---- inflight 上限 ----
{
  const q = new QuotaCounter(fakeState());
  const rs = [];
  for (let i = 0; i < 4; i++) rs.push(await (await post(q, '/reserve', { images: 1, estTwd: 1, limitImages: 0, twdLimit: 0, maxInflight: 3 })).json());
  ok(rs.filter((r) => r.ok).length === 3, '同時進行中最多 3 個');
  ok(rs[3].reason === 'inflight', '第 4 個被 inflight 擋下');
}

// ---- settle 的帳目 ----
{
  const q = new QuotaCounter(fakeState());
  const r = await (await post(q, '/reserve', { images: 1, estTwd: 3, limitImages: 5, twdLimit: 0, maxInflight: 0 })).json();
  const after = await (await post(q, '/settle', { id: r.id, images: 1, inTok: 100, outTok: 200, costTwd: 1.37 })).json();
  ok(after.count === 1 && after.costTwd === 1.37, 'settle 記的是實際數字,不是預扣的估值');
  const u = await (await q.fetch(new Request('https://do/usage'))).json();
  ok(u.count === 1 && u.inTok === 100, '/usage 讀得到結算後的值');
  const nxt = await (await post(q, '/reserve', { images: 1, estTwd: 3, limitImages: 1, twdLimit: 0, maxInflight: 0 })).json();
  ok(!nxt.ok, '結算後額度確實被吃掉(1/1 已滿)');
}

console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
