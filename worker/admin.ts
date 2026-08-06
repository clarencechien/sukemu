/* Admin API(仿 manemu app/src/admin.mjs):名單/等候名單/額度管理 + 今日用量。
   僅 ADMIN_EMAILS 內的帳號可用,閘門在 index.ts(session + isAdmin)。
   資料就是 R2 的兩個 JSON,想用 wrangler r2 object put 手動改也等價。 */

import { CONFIG_KEYS, readAllow, readJson, writeJson } from './auth';
import type { Usage } from './quota';
import type { Env } from './index';

const bad = (msg: string, status = 400) => Response.json({ ok: false, error: msg }, { status });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleAdmin(req: Request, env: Env, path: string): Promise<Response> {
  if (path === '/api/admin/data' && req.method === 'GET') {
    const [allow, wait] = await Promise.all([
      readAllow(env),
      readJson<{ email: string; at: string }[]>(env, CONFIG_KEYS.wait, []),
    ]);
    let tiers: Record<string, number> = {};
    try {
      tiers = JSON.parse(env.QUOTA_TIERS || '{}');
    } catch {}
    // 每人今日用量(張數 + 估算成本)——名單通常很短,逐一問 DO 可接受
    const usage: Record<string, Usage> = {};
    await Promise.all(
      Object.keys(allow).map(async email => {
        try {
          const stub = env.QUOTA.get(env.QUOTA.idFromName(email));
          usage[email] = await (await stub.fetch('https://do/usage')).json<Usage>();
        } catch {}
      }),
    );
    return Response.json({
      allowlist: allow,
      waitlist: [...wait].sort((a, b) => (a.at < b.at ? -1 : 1)),
      tiers,
      defaultTier: env.DEFAULT_TIER || 'beta',
      admins: (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
      usage,
    });
  }

  if (path === '/api/admin/allow' && req.method === 'POST') {
    const { email, tier } = (await req.json()) as { email?: string; tier?: string };
    const lower = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(lower)) return bad('email 格式不對');
    const value = String(tier || env.DEFAULT_TIER || 'beta').trim();
    if (!/^[\w-]+$/.test(value)) return bad('級別只能是英數字或每日張數');
    const allow = await readAllow(env);
    allow[lower] = /^\d+$/.test(value) ? Number(value) : value;
    await writeJson(env, CONFIG_KEYS.allow, allow);
    // 核准後從等候名單移除
    const wait = await readJson<{ email: string; at: string }[]>(env, CONFIG_KEYS.wait, []);
    const next = wait.filter(e => e.email.toLowerCase() !== lower);
    if (next.length !== wait.length) await writeJson(env, CONFIG_KEYS.wait, next);
    return Response.json({ ok: true, email: lower, tier: allow[lower] });
  }

  if (path === '/api/admin/remove' && req.method === 'POST') {
    const { email } = (await req.json()) as { email?: string };
    const lower = String(email || '').trim().toLowerCase();
    const allow = await readAllow(env);
    if (!(lower in allow)) return bad('名單裡沒有這個 email', 404);
    delete allow[lower];
    await writeJson(env, CONFIG_KEYS.allow, allow);
    return Response.json({ ok: true });
  }

  if (path === '/api/admin/waitlist-remove' && req.method === 'POST') {
    const { email } = (await req.json()) as { email?: string };
    const lower = String(email || '').trim().toLowerCase();
    const wait = await readJson<{ email: string; at: string }[]>(env, CONFIG_KEYS.wait, []);
    await writeJson(env, CONFIG_KEYS.wait, wait.filter(e => e.email.toLowerCase() !== lower));
    return Response.json({ ok: true });
  }

  return bad('not found', 404);
}
